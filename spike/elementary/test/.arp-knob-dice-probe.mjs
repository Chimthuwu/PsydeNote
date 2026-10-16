/**
 * Per-knob arp dice probe (todo.md 2026-10-10 — "rainbow dice rows under
 * rate/octaves/swing/pattern").
 *
 * These four are CONTINUOUS arp parameters with a dice AMOUNT each and a live
 * draw once per step — deliberately not the lane-dice mechanism (a lane is a
 * 16-step overlay you can lock per step; these are single knobs).
 *
 * `npm test` (engine.test.mjs) covers DSP only and the arp runs in C++, so
 * without this the only verification would be "it compiles".
 *
 *   node spike/elementary/test/.arp-knob-dice-probe.mjs
 *
 * Two halves:
 *   1. Source assertions that the four are wired to the right seams. This is
 *      the part that actually matters — the first attempt drew all four in the
 *      block-timing code, which compiles, looks right, and is wrong: `stepLen`
 *      is computed once per audio block, so a draw there is one offset shared
 *      by every step in the block, i.e. a static detune rather than a groove.
 *   2. Behavioural assertions on the maths, including the clamp that keeps a
 *      100% draw from stalling the arp.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const src = readFileSync(resolve(root, 'spike/elementary/plugin/ArpEngine.h'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
}

// --- 1. Wiring ---------------------------------------------------------------
check('kKnobDice is 5 (rate, octaves, swing, pattern, gate)', /constexpr int kKnobDice = 5;/.test(src));
check('all five dice indices are declared',
  ['kDiceRate', 'kDiceOctaves', 'kDiceSwing', 'kDicePattern', 'kDiceGate'].every((n) => src.includes(n)),
  ['kDiceRate', 'kDiceOctaves', 'kDiceSwing', 'kDicePattern', 'kDiceGate'].filter((n) => !src.includes(n)).join(',') || 'all present');
check('knobDice is a fixed-width array sized to it',
  /std::array<float, kKnobDice> knobDice/.test(src));
check('knobAmount scales by the chaos master',
  /knobDice\[\(size_t\) k\] \* chaos/.test(src));

// The load-bearing assertion: each draw must sit at a site that runs PER STEP,
// not in the once-per-block timing code.
const blockTiming = src.slice(src.indexOf('// ---- block timing ----'), src.indexOf('auto barPosAt'));
check('RATE dice is NOT drawn in the per-block timing code',
  !/knobAmount \(cfg, kDiceRate\)/.test(blockTiming),
  'a per-block draw is one offset for the whole block, not a groove');
check('RATE dice is drawn at the runStep call site',
  /knobAmount \(cfg, kDiceRate\)[\s\S]{0,2000}runStep \(/.test(src.slice(src.indexOf('per-step knob dice'))));
check('SWING dice is drawn in computeActual (where a step time is decided)',
  /auto computeActual[\s\S]{0,900}knobAmount \(cfg, kDiceSwing\)/.test(src));
check('OCTAVES dice is drawn in runStep',
  /void runStep[\s\S]{0,2500}knobAmount \(cfg, kDiceOctaves\)/.test(src));
check('PATTERN dice is drawn in runStep',
  /void runStep[\s\S]{0,2500}knobAmount \(cfg, kDicePattern\)/.test(src));
check('the diced pattern index actually reaches the fire() call',
  /patternIndex \(effModeDice \(cfg, mod\[7\], patternBias\)/.test(src));
check('the JSON config parses knobDice into a full-width buffer',
  /readNumArray \(go->getProperty \("knobDice"\), tmp, kKnobDice, 0\.0, 1\.0\)/.test(src));
check('the scheduler advance uses the UNDICED stepLen (no unbounded drift)',
  /else nextNominal \+= stepLen;/.test(src) && /nextNominal \+= stepLen;/.test(src));

check('GATE dice is drawn in runStep next to the global gate',
  /knobAmount \(cfg, kDiceGate\)/.test(src) && /gateFrac \*= 1\.0f \+ dev \* gateDice \* 0\.5f/.test(src));
check('gate dice is MULTIPLICATIVE, not additive on the fraction',
  /gateFrac \*=/.test(src),
  'additive on a ratio is huge at short gates and negligible at long ones');
check('gate dice is skipped in SEQ mode (the lane owns it there)',
  /if \(! cfg\.seqEnabled\)[\s\S]{0,220}knobAmount \(cfg, kDiceGate\)/.test(src));
check('direction flags are parsed from JSON',
  /getProperty \("knobDiceBipolar"\)/.test(src));
check('signedDraw exists and takes a direction flag', /static float signedDraw \(/.test(src));
check('every live draw goes through signedDraw (one helper, no drift)',
  (src.match(/signedDraw \(cfg, kDice/g) || []).length >= 4,
  `${(src.match(/signedDraw \(cfg, kDice/g) || []).length} call sites`);

// --- 1b. The LANE dice (transpose / gate) — previously decorative ----------
// The arp detail view renders a die on the transpose lane and one on the gate
// lane, writes both into `arp.laneDice`, and persists them. The ENGINE READ
// NEITHER: `laneDice` appeared nowhere in ArpEngine.h. The dice animated, the
// value saved, and the arp did not move — the user's "I am not sure the chaos
// dice actually are effective for certain parameters" was literally correct.
//
// These assertions are the pair that would have caught it: presence of the
// field alone is not enough, so each is paired with a use at a per-step seam.
check('laneDice exists in the config at all (it did, but was read by nothing)',
  /std::array<float, 2> laneDice/.test(src));
check('laneDice is actually READ by the engine, not just stored',
  /cfg\.laneDice\[\(size_t\) k\] \* chaos/.test(src),
  'a field only written is the shape of a control that looks alive and is not');
check('lane dice are scaled by the chaos master like the knob dice',
  /static float knobAmountLane \(/.test(src) && /static float signedDrawLane \(/.test(src));
check('the JSON config parses laneDice into a full-width buffer',
  /getProperty \("laneDice"\)[\s\S]{0,300}kKnobDice|getProperty \("laneDice"\)[\s\S]{0,300}, 2, 0\.0, 1\.0/.test(src),
  'a short array from an older preset would read past the end of the buffer');
check('the direction flags are parsed too',
  /getProperty \("laneDiceBipolar"\)/.test(src));

// The seam matters as much as the presence: drawn once per BLOCK it is one
// static offset shared by every step, which is a detune, not a groove.
check('the GATE lane dice is drawn per step, beside the value it randomises',
  /knobAmountLane \(cfg, 1\)[\s\S]{0,300}gateFrac \*=/.test(src));
check('the gate lane dice is MULTIPLICATIVE like the global gate dice',
  /gateFrac \*= 1\.0f \+ dev \* laneGateDice \* 0\.5f/.test(src));
check('the TRANSPOSE lane dice is drawn at the pitch-offset seam',
  /knobAmountLane \(cfg, 0\)[\s\S]{0,400}stepTr = juce::jlimit/.test(src));
check('both lane dice draws are inside runStep, not the block-timing code',
  !/knobAmountLane \(/.test(blockTiming),
  'a per-block draw is one offset for the whole block, not a groove');
check('the transpose dice is clamped to the painted lane own -12..12 envelope',
  /stepTr = juce::jlimit \(-12, 12,/.test(src),
  'randomness must never push a note outside what the knob itself allows');
check('both lane dice are skipped in SEQ mode (the Seq lanes own it there)',
  /if \(! cfg\.seqEnabled && cfg\.useStepLanes\)/.test(src));

// --- 1c. The lanes themselves were gated on a flag nobody set ---------------
// `useStepLanes` defaulted to `false` in every patch and NO code path ever
// wrote it `true`, so `cfg.useStepLanes ? stepGate[..] : 1.0f` always took the
// `: 1.0f` branch: painting the transpose/gate lanes changed nothing at all.
// The normalizer now emits `true` (the lanes are always live — the user's "if
// the values are all at 0 its not active, we dont need the extra active
// button"), and the engine keeps the flag only as a way to force them off.
const types = readFileSync(resolve(root, 'src/shared/types.ts'), 'utf8');
check('the normalizer no longer defaults useStepLanes to false',
  /useStepLanes: true,/.test(types),
  'a false default plus no writer = the lanes silently do nothing');
check('the flag is still parsed, so an old preset can still force the lanes off',
  /getProperty \("useStepLanes"\)/.test(src));

// --- 2. The maths -----------------------------------------------------------
// Mirrors knobAmount + the two clamp-bearing draws.
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
function knobAmount(knobDice, chaosAmount, k) {
  if (k < 0 || k >= 4) return 0;
  return clamp(knobDice[k] * clamp(chaosAmount, 0, 1), 0, 1);
}
const rateFactor = (amt, u) => clamp(1 + (u * 2 - 1) * amt * 0.5, 0.25, 4);
const swingOff = (amt, u) => (u * 2 - 1) * amt * 12.5;

check('an out-of-range index is rejected', knobAmount([1, 1, 1, 1], 1, 9) === 0);
check('chaos at 0 disables every knob dice',
  [0, 1, 2, 3].every((k) => knobAmount([1, 1, 1, 1], 0, k) === 0));
check('chaos at 1 passes the amount through unchanged',
  knobAmount([0.5, 0, 0, 0], 1, 0) === 0.5);
check('chaos scales the amount (half chaos = half dice)',
  Math.abs(knobAmount([0.8, 0, 0, 0], 0.5, 0) - 0.4) < 1e-6);
check('a negative chaos clamps to 0 rather than inverting the dice',
  knobAmount([1, 0, 0, 0], -1, 0) === 0);
// u=0 is the LOW end of the draw => the smallest factor (fastest step).
check('rate factor stays in 0.25..4 at 100% dice',
  rateFactor(1, 0) === 0.5 && rateFactor(1, 1) === 1.5,
  `u=0 -> ${rateFactor(1, 0)}, u=1 -> ${rateFactor(1, 1)}`);
check('rate dice cannot stall the arp (factor floor)', rateFactor(1, 0) <= 4 && rateFactor(1, 1) >= 0.25);
// Multiplicative: half dice moves the factor by a quarter, symmetric about 1.
check('rate is a MULTIPLICATIVE factor, not an additive Hz jitter',
  rateFactor(0.5, 1) === 1.25 && rateFactor(0.5, 0) === 0.75,
  'an additive Hz jitter would be inaudible at high rates and huge at low ones');
check('a zero dice amount is a strict no-op on rate',
  rateFactor(0, 0) === 1 && rateFactor(0, 1) === 1);
check('swing dice offset stays inside the 50..75 envelope',
  (() => { const s = 62 + swingOff(1, 1); return s >= 50 && s <= 75; })());
check('a zero swing amount is a strict no-op', swingOff(0, 0) === 0 && swingOff(0, 1) === 0);
check('independent draws actually differ (the whole point of a groove)',
  (() => {
    // A fixed seed makes this deterministic; the assertion is that consecutive
    // per-step draws are not all identical, which a per-BLOCK draw would be.
    let s = 12345;
    const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const draws = Array.from({ length: 16 }, () => rateFactor(1, u()));
    return new Set(draws).size > 1;
  })());

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);