import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureBackend, CaptureSource, LoopbackDevice } from '../../shared/types';
import { listSources, pickSourceAndCapture } from '../lib/audio-capture';
import { startLoopbackStream, resumeContext, LoopbackStream } from '../lib/loopback-capture';
import { AudioAnalyser } from '../lib/visualizer';
import { pickMimeForRecording } from '../lib/synth';

/**
 * System-audio sampler capture — "what I hear", straight into the sampler.
 *
 * Reuses the recorder's two capture backends (Electron desktopCapturer for
 * screen audio, or the WASAPI loopback helper for a specific output device)
 * but with the recorder's rolling-buffer behaviour stripped out: instead of
 * always-on capture, this hook only records when the user presses Record,
 * and on Stop it decodes the clip into an `AudioBuffer` and hands it to the
 * sampler operator (via `onBuffer`). Nothing is written to disk.
 *
 * The stream is bound lazily on Record (a user gesture, which also satisfies
 * Chromium's autoplay + desktop-capture activation), torn down on Stop, and
 * re-bound on the next Record. While recording we expose a live input level
 * so the user can confirm audio is actually coming through.
 */
export interface SamplerCaptureApi {
  /** Enumerated sources for the current backend (screens for desktop). */
  sources: CaptureSource[];
  /** Enumerated loopback output devices (loopback backend only). */
  devices: LoopbackDevice[];
  recording: boolean;
  /** Live input level 0..1 while recording (0 otherwise). */
  level: number;
  /** Elapsed seconds while recording. */
  elapsed: number;
  error: string | null;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

interface Options {
  backend: CaptureBackend;
  sourceId: string | null;
  loopbackDeviceId: string | null;
  /** Auto-stop after this many seconds (the panel's length chips). */
  maxSeconds: number;
  /** Called with the decoded clip when a recording finishes. */
  onBuffer: (buffer: AudioBuffer) => void;
}

export function useSamplerCapture({
  backend,
  sourceId,
  loopbackDeviceId,
  maxSeconds,
  onBuffer,
}: Options): SamplerCaptureApi {
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [devices, setDevices] = useState<LoopbackDevice[]>([]);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Live handles — React state is snapshotted into closures, so teardown
  // reads these refs (mirrors useCapture's discipline).
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AudioAnalyser | null>(null);
  const loopbackRef = useRef<LoopbackStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const mimeRef = useRef<string>('audio/webm');
  const stopTimerRef = useRef<number | null>(null);
  const startTimeRef = useRef(0);
  const devicesRef = useRef<LoopbackDevice[]>([]);

  const optsRef = useRef({ backend, sourceId, loopbackDeviceId, maxSeconds, onBuffer });
  optsRef.current = { backend, sourceId, loopbackDeviceId, maxSeconds, onBuffer };

  // Enumerate whatever the current backend offers.
  const refresh = useCallback(async () => {
    if (optsRef.current.backend === 'loopback') {
      const list = await window.api.listLoopbackDevices();
      devicesRef.current = list;
      setDevices(list);
    } else {
      const list = await listSources();
      setSources(list);
    }
  }, []);

  useEffect(() => {
    void refresh().catch((e) => setError(e?.message ?? String(e)));
  }, [refresh]);

  // ----- teardown ------------------------------------------------------------
  const teardown = useCallback(async () => {
    // Stop the WASAPI helper in main first so we don't leak frames through IPC.
    try { await window.api.stopLoopback(); } catch { /* noop */ }
    if (loopbackRef.current) {
      try { await loopbackRef.current.dispose(); } catch { /* noop */ }
      loopbackRef.current = null;
    }
    const s = streamRef.current;
    streamRef.current = null;
    if (s) for (const t of s.getTracks()) { try { t.stop(); } catch { /* noop */ } }
    // The loopback path's dispose() already closed its context.
    const ctx = ctxRef.current;
    ctxRef.current = null;
    analyserRef.current = null;
    if (ctx && ctx.state !== 'closed') { try { await ctx.close(); } catch { /* noop */ } }
  }, []);

  const decodeAndSet = useCallback(async () => {
    const ctx = ctxRef.current;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    if (!ctx || chunks.length === 0) return;
    try {
      const blob = new Blob(chunks, { type: mimeRef.current });
      const ab = await blob.arrayBuffer();
      const decoded = await ctx.decodeAudioData(ab);
      optsRef.current.onBuffer(decoded);
    } catch (e) {
      console.error('Sampler decode failed', e);
      setError('Could not decode the captured audio.');
    }
  }, []);

  // ----- stop ----------------------------------------------------------------
  const stop = useCallback(async () => {
    if (stopTimerRef.current != null) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    const rec = recorderRef.current;
    if (rec && rec.state === 'recording') {
      // Wait for onstop (which decodes) before tearing the context down —
      // decodeAudioData needs the context alive.
      await new Promise<void>((resolve) => {
        const orig = rec.onstop;
        rec.onstop = () => {
          const p = orig as (() => Promise<void>) | null;
          Promise.resolve(p?.()).then(() => resolve());
        };
        rec.stop();
      });
    }
    recorderRef.current = null;
    await teardown();
    setRecording(false);
    setElapsed(0);
  }, [teardown]);

  const stopRef = useRef(stop);
  stopRef.current = stop;

  // ----- bind ----------------------------------------------------------------
  const bind = useCallback(async (): Promise<{
    stream: MediaStream;
    ctx: AudioContext;
    analyser: AudioAnalyser;
    loopback: LoopbackStream | null;
  }> => {
    const { backend: b, sourceId: sid, loopbackDeviceId: lid } = optsRef.current;

    if (b === 'loopback') {
      if (!lid) throw new Error('Pick an output device first.');
      let device = devicesRef.current.find((d) => d.id === lid);
      if (!device) {
        const live = await window.api.listLoopbackDevices();
        devicesRef.current = live;
        setDevices(live);
        device = live.find((d) => d.id === lid);
      }
      if (!device) throw new Error('That output device is no longer available. Pick another.');
      const handle = await startLoopbackStream(device.sampleRate || 48000);
      const started = await window.api.startLoopback({
        deviceId: device.id,
        deviceName: device.name,
        sampleRate: device.sampleRate || 48000,
      });
      if (!started.ok) {
        await handle.dispose();
        throw new Error(started.error ?? 'Could not start the WASAPI loopback helper.');
      }
      const analyser = new AudioAnalyser(handle.ctx, handle.node);
      return { stream: handle.stream, ctx: handle.ctx, analyser, loopback: handle };
    }

    // Desktop backend. Chromium terminates the renderer rather than rejecting
    // when a desktop-audio request names a source that can't produce audio —
    // on Windows that's any non-screen source (only screens carry the
    // loopback mixer) and stale ids — so we hard-guard before getUserMedia.
    if (!sid) throw new Error('Pick a capture source first.');
    if (!sid.startsWith('screen:')) {
      throw new Error('Only screens carry audio on Windows — pick a screen.');
    }
    const live = await listSources();
    setSources(live);
    if (!live.some((src) => src.id === sid)) {
      throw new Error('That screen is no longer available. Pick a source again.');
    }
    const stream = await pickSourceAndCapture(sid);
    if (!stream) throw new Error('Could not start capture.');
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await resumeContext(ctx);
    const srcNode = ctx.createMediaStreamSource(stream);
    // Chromium only pulls the part of the graph that reaches a destination;
    // route to ctx.destination through a zeroed gain so the analyser runs
    // without anything coming out of the speakers.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    srcNode.connect(sink);
    sink.connect(ctx.destination);
    const analyser = new AudioAnalyser(ctx, srcNode);
    return { stream, ctx, analyser, loopback: null };
  }, []);

  // ----- start ---------------------------------------------------------------
  const start = useCallback(async () => {
    if (recorderRef.current) return;
    setError(null);
    setLevel(0);
    try {
      const { stream, ctx, analyser, loopback } = await bind();
      streamRef.current = stream;
      ctxRef.current = ctx;
      analyserRef.current = analyser;
      loopbackRef.current = loopback;

      const mime = pickMimeForRecording();
      mimeRef.current = mime;
      const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 96_000 });
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = () => { void decodeAndSet(); };
      rec.start(200); // 200 ms timeslice — fine granularity for the final chunk
      recorderRef.current = rec;
      setRecording(true);
      startTimeRef.current = performance.now();
      setElapsed(0);
      stopTimerRef.current = window.setTimeout(() => {
        void stopRef.current();
      }, Math.max(1, Math.floor(optsRef.current.maxSeconds * 1000)));
    } catch (e: any) {
      setError(e?.message ?? String(e));
      await teardown();
    }
  }, [bind, teardown, decodeAndSet]);

  // ----- live level + elapsed while recording --------------------------------
  useEffect(() => {
    if (!recording) { setLevel(0); return; }
    let raf = 0;
    const tick = () => {
      const rms = analyserRef.current?.sample().rms ?? 0;
      setLevel(Math.min(1, rms));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recording]);

  useEffect(() => {
    if (!recording) { setElapsed(0); return; }
    const id = window.setInterval(() => {
      setElapsed(Math.min(optsRef.current.maxSeconds, (performance.now() - startTimeRef.current) / 1000));
    }, 200);
    return () => window.clearInterval(id);
  }, [recording]);

  // ----- unmount cleanup -----------------------------------------------------
  useEffect(() => {
    return () => { void stopRef.current(); };
  }, []);

  return { sources, devices, recording, level, elapsed, error, refresh, start, stop };
}