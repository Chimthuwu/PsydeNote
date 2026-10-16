// UI text-selection policy test.
//
// Bug it guards (2026-10-16): dragging a knob highlighted its value text like
// a word processor, and the highlight then stopped the drag. Two causes:
//   1. `.app { user-select:none }` did not cover controls rendered through
//      portals straight into <body> (ModPopover, EnvelopePanel, scope menu, EQ).
//   2. Pointer-drag handlers did not stop the browser's default on down, so a
//      selection started under the pointer.
//
// POLICY (enforced here, run with `npm run test:ui-select`):
//   - html, body and #root are user-select:none in plugin-ui.css.
//   - Only real text fields (input, textarea, contenteditable) may select text.
//   - Every file that starts a pointer capture (a drag) must call preventDefault
//     in the same file, so the drag cannot start a selection.
//   - Knob.tsx guards both pointerdown and mousedown.
// A new drag control that skips these fails this test.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');       // repo root
const elem = path.resolve(here, '..');                    // spike/elementary
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

// --- 1. the global rule covers the page root, portals included -------------
const css = readFileSync(path.join(elem, 'ui', 'plugin-ui.css'), 'utf8');
const rootRule = /html,\s*body,\s*#root\s*\{[^}]*user-select:\s*none/.exec(css);
check(!!rootRule, 'plugin-ui.css: html, body, #root must be user-select:none (portals render into body)');
const textRule = /input,\s*textarea,\s*\[contenteditable="true"\]\s*\{[^}]*user-select:\s*text/.exec(css);
check(!!textRule, 'plugin-ui.css: real text fields must be re-enabled for selection');

// --- 2. Knob guards pointer and mouse down ---------------------------------
const knob = readFileSync(path.join(root, 'src', 'renderer', 'components', 'Knob.tsx'), 'utf8');
check(/guardDown\(e\)/.test(knob) && /onMouseDown=/.test(knob),
  'Knob.tsx: must call guardDown on pointerdown and mousedown');
check(/preventDefault\(\)/.test(knob), 'Knob.tsx: guardDown must call preventDefault');

// --- 3. every drag starter guards its own down event -----------------------
const scanDirs = [path.join(elem, 'ui'), path.join(root, 'src', 'renderer', 'components')];
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === 'archive' || name === 'node_modules' || name === 'dist') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
};
let dragFiles = 0;
for (const dir of scanDirs) {
  for (const file of walk(dir)) {
    const src = readFileSync(file, 'utf8');
    if (!/setPointerCapture/.test(src)) continue;
    dragFiles++;
    check(/preventDefault\(\)/.test(src),
      `${path.relative(root, file)}: starts a pointer drag (setPointerCapture) but never calls preventDefault`);
  }
}
check(dragFiles > 0, 'no pointer-drag files found: the scan paths are wrong');

if (failures.length) {
  console.error(`ui-selection: ${failures.length} failure(s)`);
  for (const f of failures) console.error('  FAIL ' + f);
  process.exit(1);
}
console.log(`ui-selection: OK (${dragFiles} drag files guarded, global rule present)`);
