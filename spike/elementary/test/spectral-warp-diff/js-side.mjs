// JS side of the differential test — runs dsp/wavetables.js's real
// applySpectralWarp() and dumps the result as raw float32 LE, the exact
// format ../spectral-warp-diff/diff-main.cpp emits. Compared bit-for-bit
// by ../run-diff.mjs.
//
// argv: <out.bin> <mode> <amount> <param2> <allFrames.bin|null> <frameIdx>

import { writeFileSync, readFileSync } from 'node:fs';
import { applySpectralWarp, FRAME_SIZE } from '../../dsp/wavetables.js';

const [outPath, modeS, amountS, param2S, framesPath, frameIdxS] = process.argv.slice(2);
const mode = Number(modeS);
const amount = Number(amountS);
const param2 = Number(param2S);
const frameIdx = Number(frameIdxS ?? '0');

const frame = new Float32Array(FRAME_SIZE);
for (let i = 0; i < FRAME_SIZE; i++) {
  frame[i] = Math.fround((2 * Math.PI * i) / FRAME_SIZE); // exact one-cycle sine, rounded to float32 like the C++ side
}

let allFrames = null;
if (framesPath !== 'null') {
  const buf = readFileSync(framesPath);
  allFrames = [];
  for (let fi = 0; fi < 8; fi++) {
    allFrames.push(new Float32Array(buf.buffer.slice(fi * FRAME_SIZE * 4, (fi + 1) * FRAME_SIZE * 4), 0, FRAME_SIZE));
  }
}

const out = applySpectralWarp(frame, mode, amount, param2, allFrames, frameIdx);
writeFileSync(outPath, Buffer.from(out.buffer, out.byteOffset, out.byteLength));
