/**
 * Renderer-side glue for the WASAPI loopback backend.
 *
 * The main process spawns `faze-loopback.exe` and forwards raw Float32
 * stereo PCM frames (<=> Uint8Array little-endian) over IPC. This module:
 *   1. Subscribes to those frames.
 *   2. Pumps them via postMessage into an AudioWorkletProcessor that maintains
 *      a small queue and produces studio-rate stereo frames at 128 samples
 *      each.
 *   3. Routes the worklet node's output through a MediaStreamDestination so
 *      the existing MediaRecorder-based pipeline (visualizers, rolling buffer,
 *      WebM/Opus save) keeps working unchanged.
 */

const WORKLET_SRC = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.queue = [];
    // Read offset into queue[0]. Must start at 0 — leaving it undefined makes
    // the first (chunk.length - this.cursor) evaluate to NaN, which reads as
    // "0 samples left" and silently drops the head of the stream.
    this.cursor = 0;
    this.transferablesAllowed = !!(options && options.processorOptions && options.processorOptions.useTransfer);
    this.port.onmessage = (e) => {
      const arr = e.data;        // Float32Array (interleaved stereo)
      this.queue.push(arr);
    };
  }

  process(_inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    const FRAME = 128;
    let i = 0;
    while (i < FRAME) {
      if (this.queue.length === 0) {
        // Under-run: output silence for the rest of this frame.
        outL.fill(0, i);
        outR.fill(0, i);
        return true;
      }
      const chunk = this.queue[0];
      const stereoSamplesLeft = (chunk.length - this.cursor) >> 1;
      if (stereoSamplesLeft === 0) {
        this.queue.shift();
        this.cursor = 0;
        continue;
      }
      const take = Math.min(stereoSamplesLeft, FRAME - i);
      const off = this.cursor || 0;
      for (let j = 0; j < take; j++) {
        const k = (off + j * 2);
        outL[i + j] = chunk[k];
        outR[i + j] = chunk[k + 1];
      }
      this.cursor = off + take * 2;
      i += take;
      if (this.cursor >= chunk.length) {
        this.queue.shift();
        this.cursor = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

/**
 * Make sure an AudioContext is actually running.
 *
 * Electron hands back a running context today, but Chromium's autoplay policy
 * is free to hand back a suspended one — and a suspended context renders
 * nothing, which looks exactly like a broken capture: flat visualizer, and on
 * the loopback backend (whose MediaRecorder is fed by a MediaStreamDestination)
 * silent recordings. Cheap to guarantee, expensive to debug.
 */
export async function resumeContext(ctx: AudioContext): Promise<void> {
  // Read through a function: `ctx.state` changes underneath us, and reading it
  // directly lets TS narrow the type permanently after the first check.
  const running = () => (ctx.state as AudioContextState) === 'running';
  if (running()) return;
  try {
    await ctx.resume();
  } catch {
    /* blocked — fall through to the gesture listener */
  }
  if (running()) return;
  const retry = () => {
    void ctx.resume().catch(() => undefined);
    if (running()) {
      window.removeEventListener('pointerdown', retry);
      window.removeEventListener('keydown', retry);
    }
  };
  window.addEventListener('pointerdown', retry);
  window.addEventListener('keydown', retry);
}

export interface LoopbackStream {
  ctx: AudioContext;
  node: AudioWorkletNode;
  stream: MediaStream;
  /**
   * `performance.now()` of the last PCM frame, or 0 if none has arrived.
   *
   * WASAPI loopback delivers **no packets at all** while the endpoint is idle
   * — measured on this machine: 1 callback over 4 seconds of silence versus
   * 111 over 5 seconds with a tone playing. So "no frames" means "nothing is
   * playing on this device", which is indistinguishable from a broken capture
   * unless the UI says so.
   */
  lastFrameAt(): number;
  dispose(): Promise<void>;
}

export async function startLoopbackStream(sampleRate = 48000): Promise<LoopbackStream> {
  const ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' });
  // Chromium hands back a *suspended* context when there's been no user
  // gesture yet — and we bind as soon as a device is remembered from settings,
  // long before anyone clicks anything. A suspended context renders nothing:
  // the visualizer sits flat AND the MediaStreamDestination feeding
  // MediaRecorder emits silence, so recordings come out empty.
  await resumeContext(ctx);

  const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  // We deliberately don't revoke the URL until disposal — AudioWorklet keeps
  // referencing the module for the lifetime of the node.
  await ctx.audioWorklet.addModule(url);

  const node = new AudioWorkletNode(ctx, 'pcm-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  // Route the worklet into a MediaStreamDestination so MediaRecorder can read it.
  // We do NOT connect to ctx.destination — that would echo audio out the speakers.
  const dest = ctx.createMediaStreamDestination();
  node.connect(dest);

  // Subscribe to main-process PCM frames and post them into the worklet.
  // We transfer the ArrayBuffer so the worklet owns it; the next frame will
  // be a brand-new buffer from main.
  let frames = 0;
  let lastFrame = 0;
  const unsub = window.api.onLoopbackSamples((u8) => {
    // Copy into a fresh, 4-byte-aligned buffer rather than viewing the bytes
    // in place: a Float32Array view demands a byteOffset that's a multiple of
    // 4, and nothing guarantees the offset IPC deserialisation hands us. When
    // that constructor throws it does so inside a listener, once per frame,
    // and the only visible symptom is a stream that never produces audio.
    const usable = u8.byteLength - (u8.byteLength % 4);
    if (usable === 0) return;
    const f32 = new Float32Array(usable / 4);
    new Uint8Array(f32.buffer).set(u8.subarray(0, usable));
    if (frames === 0) {
      console.info(`[loopback] first PCM frame: ${usable} bytes, ctx=${ctx.state}`);
    }
    frames++;
    lastFrame = performance.now();
    node.port.postMessage(f32, [f32.buffer]);
  });

  const dispose = async () => {
    try { unsub(); } catch { /* noop */ }
    try { node.disconnect(); } catch { /* noop */ }
    try { await ctx.close(); } catch { /* noop */ }
    try { URL.revokeObjectURL(url); } catch { /* noop */ }
  };

  return { ctx, node, stream: dest.stream, lastFrameAt: () => lastFrame, dispose };
}
