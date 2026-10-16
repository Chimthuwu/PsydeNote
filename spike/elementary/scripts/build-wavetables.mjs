// Precompute every wavetable (built-ins + 379 ESW) into ONE shippable binary,
// plugin/wavetables.bin (todo.md §165 2b step 1/1b). The raw ESW wavs are
// ~584 MB; the DSP only needs <= MAX_FRAMES frames x 2048 samples per table as
// int16, so the shipped artefact is a fraction of that and needs no filesystem.
//
// Layout (little-endian):
//   u32 magic 'FZWT' (0x54575A46) | u32 version (1) | u32 tableCount | u32 frameSize
//   tableCount x { u32 frameCount, u32 firstFrame }   // firstFrame indexes the payload in frames
//   payload: int16[sum(frameCount) * frameSize]       // sample = int16 / 32767
// Tables with more than MAX_FRAMES frames are RESAMPLED (linear blend between
// the two nearest source frames), not truncated. Table index == wtId.
//
// Usage: node scripts/build-wavetables.mjs   (also exported: buildWavetableBin)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WAVETABLES, REMOVED_WAVETABLE_IDS, getBaseWavetableFrames } from '../dsp/wavetables.js';

export const MAX_FRAMES = 64;
export const MAGIC = 0x54575a46;

// Exclude jumpy wavetables (measured avg frame-to-frame discontinuity > 0.3)
// These are tables with sudden hard transitions between frames rather than smooth morphing.
// List generated from discontinuity analysis (see todo.md).
const EXCLUDE_JUMPY_IDS = [6, 7, 9, 11, 14, 16, 25, 30, 33, 44, 70, 90, 94, 104, 127, 152, 153, 176, 185, 198, 210, 236, 247, 320, 331, 340, 359, 368];

function resampleFrames(frames, n) {
  if (frames.length <= n) return frames;
  const out = [];
  for (let i = 0; i < n; i++) {
    const pos = (i * (frames.length - 1)) / (n - 1);
    const a = Math.floor(pos), b = Math.min(frames.length - 1, a + 1), t = pos - a;
    const fa = frames[a], fb = frames[b];
    const f = new Float32Array(fa.length);
    for (let s = 0; s < f.length; s++) f[s] = fa[s] * (1 - t) + fb[s] * t;
    out.push(f);
  }
  return out;
}

export function buildWavetableBin(maxFrames = MAX_FRAMES) {
  // The native side indexes the bin by wtId, so every id MUST keep its slot
  // (see DECISION commit); EXCLUDE_JUMPY_IDS is kept for reference only.
  const filteredTables = WAVETABLES;
  // Removed tables keep their slot but ship one frame (ids are positional).
  const tables = filteredTables.map((wt) => REMOVED_WAVETABLE_IDS.has(wt.id)
    ? getBaseWavetableFrames(wt.id).slice(0, 1)
    : resampleFrames(getBaseWavetableFrames(wt.id), maxFrames));
  const frameSize = tables[0][0].length;
  const total = tables.reduce((n, t) => n + t.length, 0);
  const headerBytes = 16 + tables.length * 8;
  const buf = Buffer.alloc(headerBytes + total * frameSize * 2);
  buf.writeUInt32LE(MAGIC, 0);
  buf.writeUInt32LE(1, 4);
  buf.writeUInt32LE(tables.length, 8);
  buf.writeUInt32LE(frameSize, 12);
  let first = 0, off = headerBytes;
  tables.forEach((t, i) => {
    buf.writeUInt32LE(t.length, 16 + i * 8);
    buf.writeUInt32LE(first, 20 + i * 8);
    first += t.length;
    for (const f of t) {
      if (f.length !== frameSize) throw new Error(`table ${i}: frame size ${f.length} != ${frameSize}`);
      for (let s = 0; s < frameSize; s++, off += 2) {
        buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(f[s] * 32767))), off);
      }
    }
  });
  return { buf, tableCount: tables.length, frameSize, totalFrames: total };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { buf, tableCount, totalFrames } = buildWavetableBin();
  writeFileSync(new URL('../plugin/wavetables.bin', import.meta.url), buf);
  console.log(`wavetables.bin: ${tableCount} tables, ${totalFrames} frames, ${(buf.length / 1048576).toFixed(1)} MB`);
}
