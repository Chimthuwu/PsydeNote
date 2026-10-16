/**
 * Rolling ring-buffer for encoded audio chunks. Each chunk is a Blob produced
 * by MediaRecorder; we keep them until their combined age exceeds `maxAgeMs`,
 * then drop the oldest.
 *
 * Designed for low memory: ~5 min of 96 kbps Opus is roughly 3.6 MB worth of
 * Blob objects, which the browser keeps in memory.
 */
export interface RollingBuffer {
  push(chunk: Blob): void;
  /** Returns a single concatenated Blob of everything currently buffered. Optionally cropped to a fractional window [start, end]. */
  snapshot(bounds?: [number, number]): Promise<Blob>;
  /** Number of chunks currently held. */
  size(): number;
  /** Approximate buffered duration in seconds (sum of chunk durations). */
  durationSec(): number;
  clear(): void;
}

interface Chunk {
  blob: Blob;
  ts: number; // performance.now() at insertion
  dur: number; // estimated duration of this chunk in seconds
}

export function createRollingBuffer(maxAgeMs: number): RollingBuffer {
  const chunks: Chunk[] = [];

  function prune(now: number) {
    while (chunks.length && now - chunks[0].ts > maxAgeMs) {
      chunks.shift();
    }
  }

  return {
    push(blob: Blob) {
      const now = performance.now();
      // Roughly: 1 second per chunk (MediaRecorder timeslice). If you want a
      // tighter estimate, pass duration via push(dur) — but 1 s is plenty
      // accurate for circular buffer caps.
      chunks.push({ blob, ts: now, dur: 1.0 });
      prune(now);
    },
    async snapshot(bounds?: [number, number]) {
      let activeChunks = chunks;
      if (bounds) {
        const startIdx = Math.floor(bounds[0] * chunks.length);
        const endIdx = Math.ceil(bounds[1] * chunks.length);
        activeChunks = chunks.slice(startIdx, endIdx);
      }
      const blobs = activeChunks.map((c) => c.blob);
      return new Blob(blobs, { type: 'audio/webm' });
    },
    size() {
      return chunks.length;
    },
    durationSec() {
      return chunks.reduce((s, c) => s + c.dur, 0);
    },
    clear() {
      chunks.length = 0;
    },
  };
}
