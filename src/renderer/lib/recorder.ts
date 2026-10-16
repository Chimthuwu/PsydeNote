import { createRollingBuffer, RollingBuffer } from './ring-buffer';

/**
 * Stateful recorder built on top of MediaRecorder. Encodes the captured
 * stream as Opus in a WebM container and pushes each chunk into a rolling
 * buffer (rolling mode) or just into a single accumulating blob (traditional).
 */

export interface RecorderOptions {
  stream: MediaStream;
  bitrateKbps: number;
  bufferSeconds: number;
  mode: 'rolling' | 'traditional';
}

export interface RecorderHandle {
  start(): void;
  stop(): Promise<Blob>;
  /** Pulls a snapshot of whatever is currently buffered. */
  snapshotBuffer(bounds?: [number, number]): Promise<Blob>;
  bufferedDuration(): number;
  isActive(): boolean;
  // Tracked for the HUD.
  mode: 'rolling' | 'traditional';
}

export function createRecorder(opts: RecorderOptions): RecorderHandle {
  const buffer: RollingBuffer = createRollingBuffer(opts.bufferSeconds * 1000);
  let recorder: MediaRecorder | null = null;
  let traditionalChunks: Blob[] = [];
  let active = false;

  function buildRecorder(): MediaRecorder {
    const mime = pickSupportedMime();
    const rec = new MediaRecorder(opts.stream, {
      mimeType: mime,
      audioBitsPerSecond: opts.bitrateKbps * 1000,
    });
    rec.ondataavailable = (ev: BlobEvent) => {
      if (!ev.data || ev.data.size === 0) return;
      if (opts.mode === 'rolling') {
        buffer.push(ev.data);
      } else {
        traditionalChunks.push(ev.data);
      }
    };
    return rec;
  }

  function start() {
    if (active) return;
    recorder = buildRecorder();
    if (opts.mode === 'rolling') {
      buffer.clear();
    } else {
      traditionalChunks = [];
    }
    // Timeslice of 1000 ms emits chunks ~once a second, balancing granularity
    // and overhead.
    recorder.start(1000);
    active = true;
  }

  async function stop(): Promise<Blob> {
    if (!recorder || !active) return new Blob();
    const rec = recorder;
    return new Promise<Blob>((resolve) => {
      rec.onstop = async () => {
        active = false;
        if (opts.mode === 'traditional') {
          const blob = new Blob(traditionalChunks, { type: 'audio/webm' });
          traditionalChunks = [];
          resolve(blob);
        } else {
          resolve(await buffer.snapshot());
        }
      };
      rec.stop();
    });
  }

  async function snapshotBuffer(bounds?: [number, number]): Promise<Blob> {
    if (opts.mode === 'rolling') return buffer.snapshot(bounds);
    return new Blob(traditionalChunks, { type: 'audio/webm' });
  }

  return {
    start,
    stop,
    snapshotBuffer,
    bufferedDuration: () => buffer.durationSec(),
    isActive: () => active,
    mode: opts.mode,
  };
}

const CANDIDATE_MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

function pickSupportedMime(): string {
  for (const m of CANDIDATE_MIMES) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return 'audio/webm';
}
