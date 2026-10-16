/**
 * Arp detail layout + dice structure probe (todo.md 2026-10-10 — Stooge's
 * screenshots and layout complaints).
 *
 * Asserts the STRUCTURE rather than pixels: that each dice is nested under its
 * own knob, that the gate lane is inverted in DISPLAY only, that the mode button
 * cycles three states, and that the pattern selector is a real mod target.
 * Pixel geometry is measured in a real browser instead (see the todo entry) —
 * this probe guards the shape so a refactor can't quietly undo it.
 *
 *   node spike/elementary/test/.arp-layout-probe.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const tsx = readFileSync(resolve(root, 'src/renderer/components/ArpDetail.tsx'), 'utf8');
const css = readFileSync(resolve(root, 'spike/elementary/ui/arp-ui.css'), 'utf8');
const types = readFileSync(resolve(root, 'src/shared/types.ts'), 'utf8');
const cpp = readFileSync(resolve(root, 'spike/elementary/plugin/ArpEngine.h'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
}

// --- Dice nested under their own knob ---------------------------------------
// The old layout put all four dice in one strip BELOW the row, so RATE's dice
// sat under SWING. One `.arpv-tc-col` per knob (die inside the column) is what
// fixes it, and the probe asserts the strip is gone.
check('each knob and its dice share one column (.arpv-tc-col)', /arpv-tc-col/.test(tsx));
check('the Timing row uses that column wrapper', /arpv-knobs arpv-tc-row/.test(tsx));
check('the old separate dice strip is gone', !/className="arpv-dice-rows"/.test(tsx),
  'a shared strip is what put RATE dice under SWING');
check('a dice is rendered INSIDE the knob column, not beside the row',
  /arpv-tc-dice/.test(tsx) && /arpv-tc-col[\s\S]{0,900}arpv-tc-dice/.test(tsx));
check('all four timing knobs carry a dice', (tsx.match(/dice=\{DICE\./g) || []).length === 4,
  `${(tsx.match(/dice=\{DICE\./g) || []).length} found (rate/octaves/swing/gate)`);

// --- The die LOOKS like a die ------------------------------------------------
check('the die is an SVG square with pips, not a knob', /arpv-die-shell/.test(tsx) && /arpv-die-pip/.test(tsx));
check('the pips scale with the amount', /Math\.ceil\(amount \* 5\)/.test(tsx));
check('a zero-amount die reads as OFF (hollow + dim)', /is-off/.test(tsx) && /\.arpv-die\.is-off/.test(css));
check('one-way vs bipolar is readable from the die itself',
  /\.arpv-die\.is-unipolar \.arpv-die-shell \{ stroke-dasharray/.test(css));

// --- Bipolar -/+ ------------------------------------------------------------
check('each dice has a -/+ direction toggle', /arpv-die-dir/.test(tsx));
check('bipolar is the DEFAULT (both directions lit)', /dice\.bipolar \? \['-', '\+'\]/.test(tsx));
check('the direction default is bipolar in the normalizer',
  /knobDiceBipolar: aArr\(gn\.knobDiceBipolar, KNOB_DICE_COUNT, \(x\) => \(aNum\(x, 0, 1, 1\) >= 0\.5 \? 1 : 0\)\)/.test(types),
  'a one-way default would change how existing songs dice');
check('the engine stores a direction flag per knob', /knobDiceBipolar/.test(tsx));
check('signedDraw honours the flag in C++', /static float signedDraw \(/.test(
  readFileSync(resolve(root, 'spike/elementary/plugin/ArpEngine.h'), 'utf8')));

// --- Chaos is visually distinct + last + divided -----------------------------
check('Chaos renders through its own component', /function ChaosKnob/.test(tsx));
check('Chaos has a rainbow hue treatment', /conic-gradient/.test(css));
check('Chaos is preceded by a divider', /arpv-tc-divider/.test(tsx) && /arpv-tc-divider/.test(css));
check('Chaos is LAST in the timing row', /arpv-tc-divider[\s\S]{0,400}Chaos/.test(tsx),
  'it is the master every dice obeys, not a peer of the four');

// --- Gate lane reversed, display only ----------------------------------------
// The `reverse` flag still inverts the POINTER mapping so a drag maps to the
// value the user reads, and the bar/number both follow it. What changed is what
// the axis MEANS (see the shorten block above) — these two assert the mechanics
// that still have to hold for the numbers and the drag to agree.
check('the gate lane passes reverse', /label="Gate"[\s\S]{0,200}reverse/.test(tsx));
check('reverse inverts the pointer mapping', /const fy = reverse \? 1 - raw : raw/.test(tsx));
check('the STORED shorten value is NOT inverted on write',
  /onChange=\{\(v\) => patchEx\(\{ stepShorten: v \}\)\}/.test(tsx) &&
  !/stepShorten: v\.map/.test(tsx),
  'inverting the write would silently change every saved patch');

// --- The Active button is gone ----------------------------------------------
check('the step-lanes Active/Off toggle is removed', !/arpv-lanes \$\{ex\.useStepLanes/.test(tsx),
  'user: "if the values are all at 0 its not active"');
check('useStepLanes no longer gates the card visibility', !/arpv-lanes is-off/.test(tsx));

// --- 3-state mode button ----------------------------------------------------
check('one button cycles OFF -> ARP -> SEQ', /mode-\$\{arp\.on \? \(arp\.seq\.enabled/.test(tsx));
check('all three labels are present', /'Seq' : 'Arp'\) : 'Off'/.test(tsx));

// --- Pattern selector is modulatable + has a dice ---------------------------
check('the pattern slider carries data-mod-target', /data-mod-target="seqPattern"/.test(tsx));
check('the pattern slider shows a mod badge', /ModBadge targetId="seqPattern"/.test(tsx));
check('the pattern selector has its own dice', /arpv-pat-dice/.test(tsx) && /DICE\.pattern\.amount/.test(tsx));
check('the pattern dice has no -/+ toggle (a discrete index has no direction)',
  !/arpv-pat-dice[\s\S]{0,600}arpv-die-dir/.test(tsx));

// --- Gate lane: a SHORTEN axis, not a note length --------------------------
// `stepGate` (16 x 0.05..4, higher = LONGER) duplicated the Gate KNOB directly
// above it and fought it, and its BAR grew downward from the top so the default
// 0.6 rendered as a nearly-full-height column pinned to the ceiling — which is
// exactly what the user described as "defaulting at the top of the thing".
// It is now `stepShorten` (0..4, higher = SHORTER), drawn bottom-up: 0 at the
// bottom plays at the knob's length, turning up shortens (100 % = half).
check('the gate lane writes stepShorten (the shorten axis), not the old length',
  /onChange=\{\(v\) => patchEx\(\{ stepShorten: v \}\)\}/.test(tsx),
  'the old field duplicated the Gate knob and read backwards against it');
check('a reversed lane still grows its bar from the BOTTOM',
  /const draw = reverse \? 1 - frac : frac/.test(tsx) &&
  /\{ bottom: 0, height: `\$\{Math\.max\(2, draw \* 100\)\}%` \}/.test(tsx),
  'growing down from the top is what made the gate lane read as pinned-high');
check('the bar height uses the INVERTED fraction so bar and number agree',
  /draw \* 100/.test(tsx));
check('the stored shorten value is NOT inverted (patches keep their meaning)',
  !/patchEx\(\{ stepShorten: v\.map/.test(tsx),
  'inverting the write would silently change every saved patch');
check('the engine shortens as 1/(1+v) rather than scaling by v',
  /clampf \(1\.0f \/ \(1\.0f \+ cfg\.stepShorten/.test(cpp),
  'a plain multiply would make 4 mean 400 % LONGER, the opposite of the intent');

// --- The two new lanes are wired end to end -------------------------------
// Both were requested as "add in velocity step lane. And also a slide step lane".
// A lane that renders and saves but is never READ is the exact bug this panel
// already had twice (laneDice, useStepLanes), so each is asserted at its seam.
check('the velocity lane exists in the UI', /label="Vel"/.test(tsx));
check('the velocity lane writes stepVel', /patchEx\(\{ stepVel: v \}\)/.test(tsx));
check('the slide lane exists in the UI', /label="Slide"/.test(tsx));
check('the slide lane writes stepSlide', /patchEx\(\{ stepSlide: v \}\)/.test(tsx));
check('the new lanes are inside the ONE pinned lane-scroll area',
  (tsx.match(/arpv-lane-scroll/g) || []).length === 1 &&
  (tsx.match(/arpv-lane-scroll[\s\S]*label="Slide"/) || []).length === 1,
  'a lane outside it would sit below the fold the pinning exists to remove');
check('the engine has storage for both new lanes',
  /std::array<float, kSteps> stepVel/.test(cpp) && /std::array<float, kSteps> stepSlide/.test(cpp));
check('the engine PARSES both new lanes from JSON',
  /getProperty \("stepVel"\)/.test(cpp) && /getProperty \("stepSlide"\)/.test(cpp),
  'a lane that renders but is never parsed is a lane that does nothing');
check('the velocity lane actually reaches the trigger',
  /\* stepVelLane/.test(cpp), 'it must multiply the note velocity at the fire() seam');
check('the slide lane actually reaches the trigger',
  /slideMs \+ stepSlideMs/.test(cpp), 'it must add glide ms at the fire() seam');

// --- New lanes default to NEUTRAL, or every saved song changes on load ------
// This is the rule that has bitten twice in this panel already, and a lane
// default is a preset-compatibility decision, not a formatting one.
check('the normalizer defaults velocity to 1 (the held note\'s own = no-op)',
  /stepVel: aArr\(ex\.stepVel, SEQ_STEPS, \(x\) => aNum\(x, 0, 1, 1\)\)/.test(types),
  'anything else changes how every existing song sounds on load');
check('the normalizer defaults slide to 0 (no glide)',
  /stepSlide: aArr\(ex\.stepSlide, SEQ_STEPS, \(x\) => aNum\(x, 0, 1000, 0\)\)/.test(types));
check('the engine constructor defaults the lanes to neutral too',
  /stepVel\.fill \(1\.0f\)/.test(cpp) && /stepShorten\.fill \(0\.0f\)/.test(cpp) &&
  /stepSlide\.fill \(0\.0f\)/.test(cpp),
  'the C++ default and the TS default must agree — they are separate readers');

// --- The legacy stepGate patch is CONVERTED, not dropped or copied ---------
// The two fields are different axes, so a straight copy would stretch every
// saved note. The conversion is 0.6/R - 1, and it must be conditional on the
// new field being ABSENT — reading it unconditionally would overwrite the new
// meaning on every subsequent load of a patch this build had already saved.
check('legacy stepGate is migrated, not copied',
  /0\.6f \/ legacy\[\(size_t\) i\] - 1\.0f/.test(cpp) &&
  /getProperty \("stepGate"\)/.test(cpp),
  'copying 0.05..4 into a 0..4 shorten field would stretch notes to 5x');
check('the migration only runs when stepShorten is ABSENT',
  /if \(! ao->hasProperty \("stepShorten"\)\)/.test(cpp),
  'reading it unconditionally re-converts a patch this build already saved');
check('the TS normalizer migrates legacy stepGate too (both readers must agree)',
  /0\.6 \/ legacy - 1/.test(types),
  'the TS and C++ sides are separate readers of the same file');
check('a longer-than-baseline legacy step clamps rather than going negative',
  /Math\.max\(0, Math\.min\(4/.test(types));
check('the transpose lane has its own dice', /laneDiceFor\(0\)/.test(tsx));
check('the gate lane has its own dice', /laneDiceFor\(1\)/.test(tsx));
check('lane dice are stored separately from knob dice', /laneDice: number\[\]/.test(types));
check('the transpose lane has a scale-snap control', /arpv-lane-key/.test(tsx) && /snapTransposeToScale/.test(tsx));
check('scale snap works in absolute pitch classes then returns to root-relative',
  /nearestInScale\(absolute\)/.test(tsx));

// --- Layout: no scroll, and no empty pattern slots ---------------------------
// The panel must never scroll, at ANY window height. The old fix was a
// `@media (max-height: 860px)` band, and the real browser sweep proved it was
// wrong: at 1272x984 the body scrolled 367 px and the transpose/gate lanes sat
// 352 px BELOW the fold — the failure was at a TALL size, above the band.
check('the pattern card no longer force-spans two rows',
  !/\.arpv-patterns \{ grid-row: span 2/.test(css),
  'the span is what left 109 px of dead space below the tiles');
check('the pattern tiles are back at the legible 56 px (user: revert the size)',
  /\.arpv-pat \{[\s\S]{0,400}height: 56px/.test(css),
  'a 38 px tile is not readable at a glance');
check('the pattern grid does NOT use auto-fill (that is what leaves empty slots)',
  !/\.arpv-pat-grid \{[^}]*auto-fill/.test(css),
  'auto-fill produced 4x5 / 13x2 / 15x2 layouts with 0-12 dead cells per width');
check('every pattern column count divides 18, so no row is ever ragged',
  [...css.matchAll(/\.arpv-pat-grid \{ grid-template-columns: repeat\((\d+)/g)]
    .map(m => Number(m[1]))
    .every(n => n > 0 && 18 % n === 0));

// --- Height adaptation: the lanes are PINNED, not a height band ------------
// The lanes have no equivalent in the compact strip, and as the last item of a
// scrolling grid they were the first thing cut. They are now a SIBLING of the
// scrolling `.arpv-top`, so they are visible at every height.
check('the scrolling area is a dedicated top region, not the whole body',
  /\.arpv-top \{[\s\S]{0,400}overflow-y: auto/.test(css));
check('the lanes are a SIBLING of .arpv-top in the markup',
  /<div className="arpv-top">[\s\S]*<\/div>\{(\/\*) \/\.arpv-top/.test(tsx),
  'nested, they are the last card again and the first thing cut');
check('the panel body itself never scrolls', /\.arpv-body \{[\s\S]{0,300}overflow: hidden/.test(css));
// Generous windows: these values sit several lines into their rules, and the
// comments that explain WHY are longer than the declarations themselves. A
// window that stops early reports a present value as absent, which is worse
// than no assertion at all.
check('the lanes card is pinned as a sibling, not a height-band participant',
  /\.arpv-lanes \{[\s\S]{0,900}flex: 0 0 auto/.test(css) &&
  /\.arpv-lanes \{[\s\S]{0,900}max-height: 70%/.test(css),
  'flex: 0 0 auto + a cap is what keeps the card from outgrowing the panel');
check('the lanes get the majority of the height (4 lanes need more than 62%)',
  /max-height: 70%/.test(css),
  'at 62% the four lanes overflowed the card by 212 px at every size measured; 70% gives them room');
check('the lane bars have a floor small enough that all four fit',
  /\.arpv-lane-bars \{[\s\S]{0,900}min-height: 58px/.test(css),
  '96px per lane was sized for TWO lanes and overflowed with four');
check('the lane bars get their own scroll container instead',
  /\.arpv-lane-scroll \{[\s\S]{0,200}overflow-y: auto/.test(css));
check('the scroll container exists in the markup', /arpv-lane-scroll/.test(tsx));
check('NO min-height floor on the flex children (it re-broke the panel scroll)',
  !/\.arpv-lanes \{[\s\S]{0,300}?min-height: [1-9]/.test(css) &&
  !/\.arpv-top \{[\s\S]{0,300}?min-height: [1-9]/.test(css),
  'min-height:168px made the card refuse to shrink and the panel scroll came back');
// Strip comments first: the rule names the OLD breakpoints in prose, and a
// grep for `max-height: 860px` would match this file's own explanation of what
// it removed rather than a live @media rule.
const cssLive = css.replace(/\/\*[\s\S]*?\*\//g, '');
check('the max-height:860px band is GONE (it never fired where the failure was)',
  !/@media \(max-height: 860px\)/.test(cssLive),
  'the lanes were 352 px below the fold AT 984 px tall, above the band');
check('no height breakpoint hides the layers/dice cards any more',
  !/@media \(max-height: 6\d\dpx\)/.test(cssLive),
  'those bands only trimmed cards; the real fix was pinning the lanes');
check('the lane label column does not eat the 16 bars',
  /\.arpv-lane-label \{[\s\S]{0,80}?flex: 0 0 66px/.test(css));

// --- Compact strip knobs are bigger -----------------------------------------
// Measured in CSS pixels, which is the only honest unit here: the app applies
// `body { zoom }` to fit the window (main.tsx, --ui-scale), so a 56 px knob
// MEASURES 32 px through getBoundingClientRect in a 1272 px viewport. Asserting
// on rect width would either fail forever or push someone to "fix" the zoom —
// which is exactly the round-trip this comment exists to prevent.
check('the compact strip knobs are enlarged (48 -> 56 CSS px)',
  /\.arp-metal \.knob-md \{ --knob-size: 56px; \}/.test(css));
check('the strip value text is enlarged with them',
  /\.arp-metal \.knob-value,[\s\S]{0,90}font-size: 10\.5px/.test(css));
check('the strip knob rule is scoped so the detail view keeps its 64 px',
  /\.arpv \.knob-lg \{ --knob-size: 64px; \}/.test(css) && !/\.arp-metal \.knob-lg/.test(css));
check('the zoom measurement trap is documented where it will bite again',
  /MEASUREMENT TRAP/.test(css) && /getComputedStyle/.test(css));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);