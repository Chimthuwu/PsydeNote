// Precompute a low-res preview of every ESW table (8 evenly spaced frames x
// 256 points, int8, base64) -> dsp/esw-preview.json. The plugin webview has no
// filesystem, so the WT graphic (and warp preview) read this instead of the
// wavs. Audio does NOT use it: native C++ decodes the real wavs.
import { writeFileSync } from 'node:fs';
import { WAVETABLES, getBaseWavetableFrames } from '../dsp/wavetables.js';

const FRAMES = 8, POINTS = 256;
const out = {};
for (const wt of WAVETABLES) {
  if (wt.id < 2) continue;
  const all = getBaseWavetableFrames(wt.id);
  const bytes = new Int8Array(FRAMES * POINTS);
  for (let f = 0; f < FRAMES; f++) {
    const src = all[all.length <= 1 ? 0 : Math.round(f * (all.length - 1) / (FRAMES - 1))];
    for (let p = 0; p < POINTS; p++) {
      const v = src[Math.floor(p * src.length / POINTS)];
      bytes[f * POINTS + p] = Math.max(-127, Math.min(127, Math.round(v * 127)));
    }
  }
  out[wt.id] = Buffer.from(bytes.buffer).toString('base64');
}
writeFileSync(new URL('../dsp/esw-preview.json', import.meta.url), JSON.stringify({ frames: FRAMES, points: POINTS, tables: out }));
console.log('esw-preview.json:', Object.keys(out).length, 'tables');
