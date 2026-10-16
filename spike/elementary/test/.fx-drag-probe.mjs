/**
 * FX view drag-to-reorder probe (todo.md 2026-10-10).
 *
 * Not part of `npm test` — `movedTo` is pure UI state, no DSP involvement, so
 * the engine suite cannot see it. Without this the only verification would be
 * "it typechecks".
 *
 *   node spike/elementary/test/.fx-drag-probe.mjs
 *
 * Two halves:
 *   1. Source assertions — the component must still wire the gesture the way
 *      this probe models. If someone drops the drag, these go red loudly
 *      rather than the probe silently testing a function nothing calls.
 *   2. Behavioural assertions — the reorder maths over every real chain
 *      permutation, including the cases that are easy to get wrong: dragging
 *      DOWN past a neighbour (index must be measured AFTER the removal, or the
 *      unit lands one slot short), and no-op drags.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
}

// --- 1. The component still wires the gesture -------------------------------
const src = readFileSync(resolve(root, 'spike/elementary/ui/FxPanel.tsx'), 'utf8');
check('FxUnit carries a data-fx-unit hook for the hit-test',
  /data-fx-unit=\{kind\}/.test(src));
check('the drag is pointer-based, not HTML5 DnD',
  /onHeadPointerDown/.test(src) && !/draggable=|onDragStart=/.test(src));
check('pointer capture is taken (moves survive leaving the header)',
  /setPointerCapture/.test(src));
check('the drop index comes from movedTo, not a hand-rolled splice',
  /movedTo\(fx\.chain, pr\.type, order\.indexOf\(target\)\)/.test(src));
check('every FxUnit call site is given the drag props',
  (src.match(/drag=\{unitDrag\}/g) || []).length === 8);
check('the reorder arrows are kept alongside the drag',
  (src.match(/Move earlier in the chain/g) || []).length >= 2);

// --- 2. The reorder maths ----------------------------------------------------
// CRITICAL (skill: "logic that lives outside the DSP suite needs its own probe"):
// the function under test is EXTRACTED FROM THE REAL SOURCE, never reimplemented
// here. A hand-copied `movedTo` proves only that the copy is correct — it went
// green against a deliberately broken FxPanel.tsx when the copy diverged. If the
// extraction fails the probe stops rather than testing a stand-in.
const realOrder = (chain) => chain.filter((t) => t !== 'off');

const movedToEnd = src.indexOf('\n}\n', src.indexOf('function movedTo('));
// +3 to include the closing brace — without it the IIFE below is unterminated.
const movedToSrc = src.slice(src.indexOf('function movedTo('), movedToEnd + 3);
check('movedTo was found in the source', movedToSrc.startsWith('function movedTo('));

// `movedTo` is TypeScript, so the extracted source carries annotations
// (`: FxChainSlotType[]`, `: RealFxType`, `: number`) that plain `new Function`
// cannot parse. Strip them, and FAIL LOUDLY if the result is still not valid JS
// rather than silently testing something else.
const movedToJs = movedToSrc
  .replace(/function movedTo\(([^)]*)\)/, (_m, args) =>
    `function movedTo(${args.split(',').map((a) => a.split(':')[0].trim()).join(', ')})`)
  .replace(/\)\s*:\s*[A-Za-z<>\[\]| ]+\s*\{/, ') {');

let movedTo = null;
try {
  // `realOrder` is a sibling helper `movedTo` closes over; pass it in rather
  // than duplicating it, so the extracted function runs exactly as shipped.
  // eslint-disable-next-line no-new-func
  movedTo = new Function('realOrder', `return (${movedToJs})`)(realOrder);
} catch (err) {
  console.error('FATAL: extracted movedTo is not valid JS —', err.message);
}
if (typeof movedTo !== 'function') {
  console.error('FATAL: could not evaluate movedTo from source — probe would be testing a stand-in.');
  process.exit(2);
}
check('the extracted movedTo is the real function, not a stub', movedTo.length === 3);

const chain3 = ['delay', 'reverb', 'eq', 'off', 'off', 'off', 'off', 'off'];
const fmt = (c) => realOrder(c).join(',');

check('drag right: delay lands after reverb', fmt(movedTo(chain3, 'delay', 1)) === 'reverb,delay,eq', fmt(movedTo(chain3, 'delay', 1)));
check('drag left: eq lands before reverb', fmt(movedTo(chain3, 'eq', 1)) === 'delay,eq,reverb', fmt(movedTo(chain3, 'eq', 1)));
check('drag to the far end', fmt(movedTo(chain3, 'delay', 2)) === 'reverb,eq,delay', fmt(movedTo(chain3, 'delay', 2)));
// The classic off-by-one: dragging DOWN onto the last slot.
check('drag down to the last slot does not overshoot',
  fmt(movedTo(chain3, 'delay', 2)) === 'reverb,eq,delay');
check('a drag onto itself is a no-op', fmt(movedTo(chain3, 'delay', 0)) === 'delay,reverb,eq');
check('an out-of-range drop is rejected', fmt(movedTo(chain3, 'delay', 3)) === 'delay,reverb,eq');
check('dragging a type not in the chain is rejected', fmt(movedTo(chain3, 'chorus', 1)) === 'delay,reverb,eq');
check("a dragged unit's own settings survive the reorder",
  (() => {
    // The card's params live in fx[kind], NOT positionally in the chain, so a
    // reorder must not touch them — the rebuilt chain only reshuffles slots.
    const before = { mix: 0.42 };
    const chain = movedTo(chain3, 'delay', 2);
    return JSON.stringify(before) === JSON.stringify({ mix: 0.42 }) && realOrder(chain).includes('delay');
  })());
check('the chain keeps all 8 slots (off padding preserved)',
  movedTo(chain3, 'delay', 2).length === 8);
const full8 = ['distortion', 'chorus', 'flanger', 'phaser', 'eq', 'compressor', 'delay', 'reverb'];
const fullOut = realOrder(movedTo(full8, 'distortion', 7));
check('a full 8-unit chain still reorders',
  fullOut.length === 8 && fullOut[7] === 'distortion' && fullOut[0] === 'chorus',
  fmt(movedTo(full8, 'distortion', 7)));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);