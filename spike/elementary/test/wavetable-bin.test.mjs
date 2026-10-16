// Verifies scripts/build-wavetables.mjs: header, per-table frame counts, distinct
// tables, and int16 round-trip against the Node loader (todo.md §165 2b step 7d).
import { buildWavetableBin, MAGIC, MAX_FRAMES } from '../scripts/build-wavetables.mjs';
import { WAVETABLES, getBaseWavetableFrames } from '../dsp/wavetables.js';

const { buf, tableCount, frameSize } = buildWavetableBin();
let fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${extra}`); if (!ok) fail++; };

check('header magic/version/count', buf.readUInt32LE(0) === MAGIC && buf.readUInt32LE(4) === 1 && tableCount === WAVETABLES.length, `tables=${tableCount}`);
const payload = 16 + tableCount * 8;
const sig = new Set();
let maxErr = 0, capped = true;
for (const id of [0, 1, 2, 3, 40, 120, 200, 280, 340, 380]) {
  const n = buf.readUInt32LE(16 + id * 8), first = buf.readUInt32LE(20 + id * 8);
  capped = capped && n >= 1 && n <= MAX_FRAMES;
  const src = getBaseWavetableFrames(id);
  const f0 = src[0];
  let h = '';
  for (let s = 0; s < frameSize; s++) {
    const v = buf.readInt16LE(payload + first * frameSize * 2 + s * 2) / 32767;
    maxErr = Math.max(maxErr, Math.abs(v - f0[s]));
    if (s % 97 === 0) h += v.toFixed(3) + ',';
  }
  sig.add(h);
}
check('frame counts within 1..cap', capped);
check('first frame matches loader within int16 rounding', maxErr < 1e-4, `maxErr=${maxErr.toExponential(2)}`);
check('sampled tables are distinct', sig.size >= 9, `distinct=${sig.size}/10`);
process.exit(fail ? 1 : 0);
