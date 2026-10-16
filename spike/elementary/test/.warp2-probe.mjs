/**
 * Warp 2 probe (todo.md §"Warp 2 silences the synth").
 *
 * The bug: `PluginProcessor.cpp` bails with `if (warpMode2 != 0) continue;`
 * BEFORE generating any warped resource. But `dsp/synth.js` builds the resource
 * key unconditionally and asks for the `:w2_` table — and `TableNode::setProperty`
 * returns `InvalidPropertyValue()` for a path that isn't in the SharedResourceMap.
 * A failing property fails the whole `setState` instruction batch, so turning on
 * Warp 2 doesn't just fail to add a warp, it kills every other operator's
 * instruction for that state change: the synth goes SILENT. "Actively destructive"
 * is literal.
 *
 * The fix must make C++ match the JS reference exactly. `generateWavetableFrames`
 * applies Warp 1 to the base frames, THEN applies Warp 2 to THAT result — a
 * second stage, not an alternative one — and a spectral Warp 2 analyses the
 * stage-1 frames (passed as `step1Frames`), not the originals.
 *
 *   node spike/elementary/test/.warp2-probe.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const cpp = readFileSync(resolve(root, 'spike/elementary/plugin/PluginProcessor.cpp'), 'utf8');
const js = readFileSync(resolve(root, 'spike/elementary/dsp/wavetables.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
}

// --- 1. The JS reference: what Warp 2 IS ------------------------------------
check('JS applies Warp 2 as a SECOND STAGE over Warp 1 output',
  /Apply Warp 2[\s\S]{0,120}const step1Frames = frames/.test(js));
check('JS only applies stage 2 when mode2 > 0 AND amount2 > 0',
  /warpMode2 > 0 && warpAmount2 > 0/.test(js));
check('a spectral Warp 2 analyses the STAGE-1 frames, not the base ones',
  /applySpectralWarp\(frame, warpMode2, warpAmount2, warpParam2_2, step1Frames, i\)/.test(js));
check('the resource key carries the w2 segment',
  /:w2_\$\{warpMode2\}/.test(js));

// --- 2. C++ must not bail out ----------------------------------------------
check('C++ no longer bails out on warpMode2', !/if \(warpMode2 != 0\)\s*\n\s*continue;/.test(cpp),
  'this is the line that silences the synth');
check('C++ reads warpAmount2', /stateNum \(state, prefix \+ "warpamount2"/.test(cpp));
check('C++ reads warpparam2_2', /stateNum \(state, prefix \+ "warpparam2_2"/.test(cpp));

// --- 3. C++ must implement stage 2 -----------------------------------------
check('stage 2 runs only when Warp 2 is genuinely active',
  /if \(warp2Active\)/.test(cpp));
check('stage 2 is applied to the stage-1 result, not the raw base',
  /applySpectralWarp \(warped, warpMode2/.test(cpp) && /stage2\[\(size_t\) s\] = warped\[\(size_t\) idx\]/.test(cpp),
  'composition order is not symmetric: resampling an already-resampled frame is not the same');
check('a spectral stage 2 is handed the STAGE-1 frames, not the base ones',
  /applySpectralWarp \(warped, warpMode2, warpAmt2, warpP2_2,\s*&specStage1Frames/.test(cpp));
check('stage 2 reads through a scratch buffer (no in-place resample)',
  /std::vector<float> stage2 \(\(size_t\) kWtFrameSize\)/.test(cpp));
check('Warp 2 works with Warp 1 OFF (the destructive case)',
  /No Warp 1: carry the base frame through untouched/.test(cpp),
  'a Warp-2-only state must not be skipped');
check('stage 1 is gated on warp1Active (not just mode != 0)',
  /warp1Active && phaseWarp/.test(cpp));

// --- 4. The failure mode must stay impossible ------------------------------
// A warp that can't be generated must NOT be requested under a key that doesn't
// exist, because that key fails the whole instruction batch. Assert the
// generator covers every mode the UI can select.
const modes = ['wtIsPhaseDomainWarp (warpMode2)', 'wtIsWaveDomainWarp (warpMode2)', 'wtIsSpectralWarp (warpMode2)'];
check('stage 2 classifies its own mode (phase/wave/spectral)',
  modes.every((m) => cpp.includes(m)), modes.filter((m) => !cpp.includes(m)).join(',') || 'all present');
check('the "either stage active" gate matches what the resource key assumes',
  cpp.includes('if (! warp1Active && ! warp2Active)') && /if \(! warp1Active && ! warp2Active\)\s*continue;/.test(cpp),
  'JS and C++ must agree on which state maps to which key');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);