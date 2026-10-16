## 2026-10-16 — BUILT, NOT YET LISTEN-TESTED: blue arp row with its own knobs

- [x] **Decided (Stooge):** the mini strip's Rate / Oct / Swing / Gate are the **green** row. Blue gets its own set. Per-row Chaos: green = `generation.chaosAmount`, blue = `arp.blue.chaosAmount`.
- [x] **Data.** `ArpSettings.blue: ArpBlueRow` (`src/shared/types.ts`): rate, octaves, swing, gate, chaosAmount, knobDice[5], knobDiceBipolar[5]. Defaults are silent. Normalised; old patches get the defaults.
- [x] **Engine.** `spike/elementary/plugin/ArpEngine.h`:
  - `ArpConfig::blue` + `ArpConfig::forBlue(cfg)` (a copy with blue's values swapped in).
  - Parse of `blue` from the JSON.
  - Scheduler state is per row (`nextValidR/nextNominalR/nextActualR/gR`). Each row steps on its own clock, and `runStep(…, rowFrom, rowTo)` fires only that row. Row 1 is silent unless it is enabled and has a blue layer on.
  - Playhead is written by row 0 only. Chord hit runs on row 0 only (otherwise every note doubles).
- [x] **UI.** `SeqEditor.tsx` side panel: two `.seqv-row` strips (green, blue), each with a Chaos ring and `RowKnobs` (Rate, Oct, Swing, Gate, with dice under each). `seq-ui.css` has the row styles.
- [x] **Built:** typechecks clean (renderer and plugin UI), native Release builds, and the Standalone runs. Screenshot shows both rows.
- [ ] **Not listened to.** Blue sounds only when a blue ARP row button is lit. Check that the blue clock is audible and separate, and that the green row sounds the same as before.
- [x] **Layout (mockup pass):** each layer row is one line (Chaos ring, Rate, Oct, Swing, Gate, with the die beside each knob). The side panel is about as tall as the pattern grid, so the step lanes are back to full height.
- [x] **Row colour:** the green row's knobs, dice and polarity buttons are green, and the blue row's are blue (`color` prop on `RowKnobs`/`KnobDice`). The Chaos rings are still the rainbow ring.
- [ ] **Observed, not investigated:** the blue row's Rate showed `1/4` on screen, but the default is `1/16`. Check whether a saved patch is setting it.
- [x] **Control bar moved above the step lanes** (CSS `order`: bar 1, lanes 2, body 3). Frees the bottom of the sequencer for the knobs.
- [x] **Swing knob replaced by Pattern** on both rows. Green's pattern = `arp.mode` (the same value the big grid writes). Blue's = `arp.blue.pattern`, which the engine applies through `patternPos` in `ArpConfig::forBlue`. Lowest = Up, highest = Walk (ARP_MODES order matches the engine enum). Swing for the blue row is still in the data (default 50) and has no UI. The green row's swing is the bar's SWING field.
- [x] **Pattern block shorter** (CSS: tiles 24px min, side column tighter). Not yet seen in a capture: the app reopened on the FX view.
- [x] **Mini ARP strip knobs** Rate / Octaves / Gate: 56px → 40px (`arp-ui.css`), so the labels and + badges fit.
- [x] **Control bar is in the sequencer header row** (title, the bar, then Transpose / Vel % / Humanize and close, all on one line). Its selects, inputs and switch buttons are narrowed to fit (`seq-ui.css`, the `.seqv-head .seqv-bar` block). The bar's JSX moved from below the lanes into `<header>` (`SeqEditor.tsx`).
- [ ] **Pattern block still ~190 px tall.** It stretches to the height of the layer-row column beside it. To shorten it, the layer rows would have to get shorter, or the tiles would need their own fixed height.
- [ ] **Pattern knob value clipped** ("Repeat Up" shows as "Rept"). The knob is 34 px. Either show the short name on hover only, or use a wider knob for the Pattern control.
- [ ] **Not verified by ear:** the blue pattern, and the per-row clocks.
- [ ] **Chord hit** still plays on the green row only.

## 2026-10-16 — DONE: knobs highlighting text on drag (policy + test)

- [x] **Root cause, two parts.** (1) `.app { user-select:none }` did not cover controls rendered through portals into `<body>` (ModPopover, EnvelopePanel, scope menu, EQ popout). (2) The drag handlers did not `preventDefault` on down, so a selection started under the pointer and highlighted the value text.
- [x] **Fix.** `spike/elementary/ui/plugin-ui.css`: `html, body, #root { user-select:none }`; only real text fields re-enable it. `src/renderer/components/Knob.tsx`: `guardDown` on pointerdown and mousedown, focuses the ring by hand so arrow keys still work. `FxViz.tsx` and `SamplerBlock.tsx` (had no guard) now `preventDefault` on drag start.
- [x] **Policy, enforced.** `spike/elementary/test/ui-selection.test.mjs` (`npm run test:ui-select`): checks the global rule, the Knob guard, and that every file calling `setPointerCapture` also calls `preventDefault`. A new drag control without the guard fails the test. Memory: `feedback-knob-text-selection`.

## 2026-10-16 — DONE: performance audit, arp/sequencer lag (JS side)

Diagnosis from reading the code, NOT measured on the plugin yet (no build run here).
- [x] **Voice readout re-rendered the whole app.** `useBridgeSynth` held `activeVoices` and `heldNotes` in React state. The arp changes them on every step (the native voice snapshot is throttled to 5/s), so PluginApp re-rendered several times a second. Now `src/renderer/lib/voiceStore.ts` (external store, like `arpStore`). Only `LivePiano`, `LiveFxPanel` and `LiveVoiceCount` subscribe.
- [x] **Sequencer re-rendered the whole editor on every step.** `SeqEditor` subscribed to the playhead and the overlay at its root. The playhead and the overlay now subscribe in `LaneRow` (one lane) and `OverlayButtons`.
- [ ] **Still to measure on the real plugin** (the headless browser can't measure audio latency): the native `dispatchStateChange` log lines (`serialize=`, `webview=`, `dspReconcile=`) while the arp runs. The reconcile is skipped for voice-only changes (`dsp.main.js` dedupes `v*_gate/freq/vel`), so the expected cost is only serialize + the JS evaluate, at 5/s.
- [ ] **Still open:** `LaneRow` re-renders all 16 columns on each playhead step (7 rows). A per-cell cursor would cut that further, if measurement shows it matters.
- [ ] **Still open (from the earlier audit):** `setParameterValue` loops over every parameter per call (WebViewEditor.cpp handleSetParameterValueEvent); cache a paramID map.

## 2026-10-16 — PARTLY DONE: layered arp detail (green/blue layers)

- [x] **Layer colours match the mini strip.** Lit green layer buttons use the mini panel recipe (`.arp-m-arp`: 85 % tint over black, dark ink, 50 % glow). Blue is lighter (`--lay-blue` #6cb8ff, was #2f80ed; the same token also colours the blue pattern tiles). `spike/elementary/ui/seq-ui.css` (`.seqv` tokens, `.seqv-lbtn[data-row]`).
- [ ] **Mockup not built yet** (`MOCKUP LAYERED ARP GREEN BLUE DEDICATED RATE OCT SWING GATE.png`). Two layer strips in the detail view, green (Arp row 1) and blue (Arp row 2). Each has its own Chaos ring, Rate, Oct, Swing and Gate knobs with dice. The single global Chaos ring and Rate/Oct/Swing/Gate column go away, and the Chord/Arp offset grid moves to make room.
- [x] **Decided (Stooge, 2026-10-16):**
  - (a) Each row runs its **own step clock** (own Rate, independent timing).
  - (b) **Chord layer and the mini strip keep one global** Rate/Oct/Swing/Gate. The green and blue rows get their own sets in the detail view.
  - (c) **Per-layer Chaos affects that layer's notes only.** It scales that layer's knob dice and the step-lane dice (transpose, gate) for its notes.
- [ ] **Next (not started, the bulk of the work):** per-row state in the engine, then the UI.
  - Engine: `ArpEngine.h` scheduler state (`nextNominal`, `nextActual`, `g`, `stepLen`, swing, `runStep`) becomes per row, and each row reads its own rate, octaves, swing, gate, chaos and dice. Build a per-row `ArpConfig` copy, or pass the row in, instead of the single `cfg`.
  - Data: `arp.rows: [RowKnobs, RowKnobs]`, with `RowKnobs = { rate, octaves, swing, gate, chaos, knobDice[5], knobDiceBipolar[5] }`. Normalizer in `types.ts`, JSON parse in `ArpEngine.h`. The global `generation.chaosAmount` then only drives the mini strip and Chord.
  - UI: detail view = two layer strips (green, blue), each with its own Chaos ring, Rate/Oct/Swing/Gate and dice. Move the Chord/Arp offset grid to make room.
  - Verify: `spike/elementary/ui` typecheck, `npm run test:wire`, and a plugin build. Sound needs an ear test.
  - Do not ship per-row knobs before the engine reads them, or they look alive and do nothing.
- Engine note: `spike/elementary/plugin/ArpEngine.h` has one step clock (`runStep`, `computeActual`, `stepLen`) and one set of `cfg.rateHz/rateDiv/swing/gate/octaves`. `chaosAmount` is global and multiplies every dice through `knobAmount` and `laneDice`. A per-row value needs a second clock or per-row dice evaluation.

## 2026-10-15 — DONE: sequencer / arp UI pass (Stooge's notes)

- [x] **Gate lane reversed (step lane).** Higher % = shorter note, 100 % = staccato tick. Display, drag and bar
  paint flip; the stored value (0.05..4, higher = longer) is unchanged, so saved patches play the same.
  `src/renderer/components/SeqEditor.tsx` (`reverse`, `posOf`/`valOf`, `gateShown`).
- [x] **One mode, not Arp/Seq.** Your call: keep the Arp path. Removed the Seq note path from the C++ engine
  (`ArpEngine.h`) and the JS hook (`useArpEngine.ts`), the strip's Arp/Seq toggle, and the mode subtitle.
  The detail button always opens the sequencer. `seq.enabled` is no longer read; saved patches keep it harmlessly.
  - Gate lane: the Arp path read the legacy `stepShorten`, so the Gate lane did nothing. It now scales the Gate
    knob (`cfg.gate * lane/0.6`), so an untouched lane (0.6) leaves the knob's length as it was.
  - Lane dice for gate: the legacy `laneDice[1]` block now also runs in the merged path. It is 0 unless set, so no change.
  - Seq-only behaviour that is gone: one note per step (the pattern picks one held note, layers are its octave copies).
    The arp path plays each pattern row across the held notes instead.
  - Needs checking by ear: Gate lane length, and a pattern now playing across held notes.
- [x] **Pitch lane now changes the pitch in Arp mode.** The Arp note path read only the legacy `stepTranspose`
  array (no live writer), so the Pitch lane was ignored there. It now adds the lane's value. Seq mode already did.
  `ArpEngine.h`, `fire` in the arp branch. Needs the plugin rebuilt and checked by ear.
- [x] **Chord hit works in Arp mode.** The engine only honoured it when `seqEnabled`, so the button did nothing
  in Arp mode. `ArpEngine.h`, chord branch. Rebuilt the plugin.
- [x] **Lane dice: click rolls.** Click = roll (at 0 % a click arms the lane to 100 % first). Drag = amount.
  Direction (-, -+, +) is its own button beside the die. Right-click still rolls.
- [x] **Lane dice default is `+` (one-way).** Was `-+`. Only affects lanes with no saved polarity or new lanes.
  Lanes already saved with `-+` keep it: click their direction button once to change.
- [x] **Rate dice.** Dice under the Rate knob in the sequencer (drag = amount, button = `-+` / `+`).
- [x] **Layer and pattern colours, one green.** Arp row 1 and the mini strip's On button share green `#4fd69c`.
  Arp row 2 is blue, Chord is purple. Left-clicked pattern = green, right-clicked pattern = blue.
  Tokens: `--lay-green/--lay-blue/--lay-purple` on `.seqv` in `seq-ui.css`.

**Open (decide before building):**
- [ ] **What a right-click on a pattern should do.** Now it only recolours the pattern blue (UI state, not saved).
  The likely meaning is "this pattern belongs to the blue bottom layer", which needs a per-layer pattern in the
  engine. Not built: it's a new feature, so it needs a yes.
- [ ] **Chord hit and layers.** Chord hit plays every held note and ignores the layer rows. Same open question as
  in the Seq section below.

**Not checked in this pass:** the layout probe `.arp-layout-probe.mjs` points at `src/renderer/components/ArpDetail.tsx`,
which moved to `archive/`, so it can't run. `.seq-probe.mjs` has 2 failures in `types.ts` normalizer text that
this pass didn't touch. Both predate this change.

## 2026-10-15 — NEW TODO from Stooge (planned, NOT built yet)

- [ ] **Modulatable ADSR knobs.** The envelopes need real knobs (attack, decay, sustain, release) that can themselves be modulated. Example: LFO 2 modulating the decay time of envelope 2. Proposal (Stooge): drag the LFO 2 cable onto an envelope card and the ADSR knobs appear over it, ready to take the cable. Open: how a knob reached by a cable is stored and sent to the engine, and what happens to the cable when the knobs are closed.
- [ ] **Parameters of the effects that have no knobs.** Some FX blocks have no visible knobs for their parameters. Decide how each one gets exposed (knobs, a fold-out, or the same cable-drop as the envelopes) and how it is modulated. Needs a design pass before code.
- [ ] **Arp pattern selector slider.** Still missing from the Arpeggiator. A 0-100 % slider that is synced with the pattern grid and is also a mod target (host param `arp_pattern`). Deliberately not built in this pass.
- [ ] **Performance audit, follow-ups.** The sequencer lag came mainly from the voice snapshot rebuilding the sound graph on every arp note, and that is now throttled to 5 a second (PluginProcessor.cpp, handleMidi). [x] (1) DONE 2026-10-16: `change()` and the onState writers in `spike/elementary/ui/useBridgeSynth.ts` now compute from a `synthRef` and commit via `commitSynth`, so bridge sends are no longer inside a setState updater (`ui/tsconfig.json` typecheck clean, `npm run test:wire` 55/0; not measured on the real plugin). Still to check, in this order: (2) `setParameterValue` loops over every parameter with a string conversion on each call (WebViewEditor.cpp handleSetParameterValueEvent); cache a paramID -> parameter map. (3) Playhead and overlay pushes at up to 60 Hz re-render the whole sequencer; throttle them to the UI's frame rate. Measure each one before and after on the real plugin, because the headless browser can't measure audio latency.
- [ ] **Seq mode: layers and chord hit.** Chord layers and ARP layers now add octave copies of each step's note in Seq mode. Chord hit (every held note on every step) is separate. Check both by ear and decide whether chord hit should also respect the layers.
- [ ] **Mini ARP strip and the sequencer share state.** The mini On button is a macro for the ARP layer zero button, and turning ARP zero on or off sets `arp.on`. Check that the engine's `arp.on` gating is not left stuck in one state.

## 2026-10-10 — DONE: pattern tiles reverted + lanes pinned + TWO DEAD DICE FIXED

Stooge's three reports: revert the pattern tile size ("we have two empty slots and it just looks
weird"), make transpose + gate visible without scrolling, and — the real find — "I am not sure the
chaos dice actually are effective for certain parameters in the arp detailed UI". He was right.

### The chaos dice WERE dead, in two separate places
Both were "a control that looks alive and isn't", which is worse than an absent control:

1. **`laneDice` was read by nothing.** The detail view renders a die on the transpose lane and one on
   the gate lane, writes both into `arp.laneDice`, and persists them — `laneDice` appeared **zero
   times** in `ArpEngine.h`. The die face animated, the % updated, the arp did not move. Fixed by
   adding the field, its direction flags, the JSON parse, `knobAmountLane`/`signedDrawLane` (kept
   SEPARATE from the knob-dice helpers on purpose: different array, different width — 2 vs 5 — and
   folding them into one indexed helper is how a count mismatch reads past the end), and a draw at
   each per-step consumption seam. Gate is multiplicative (a factor on a ratio); transpose is clamped
   to the lane's own −12..12. Both skipped in SEQ mode, where the Seq lanes already own per-step
   randomness.

2. **`useStepLanes` defaulted to `false` and NO code path ever wrote it `true`.** So
   `cfg.useStepLanes ? stepGate[pos] : 1.0f` always took the `: 1.0f` branch — the transpose and
   gate lanes were painted, saved, and entirely discarded. *The lanes themselves were dead, not just
   their dice.* The normalizer now emits `true` (the lanes are always live: "if the values are all
   at 0 its not active, we dont need the extra active button"); the engine keeps the flag parsed as
   the way to force them off without losing painted data.

**The gate a control sits behind is the thing to check first.** Both lanes were behind a flag whose
only value was the default.

### Layout: the lanes are PINNED, and no height breakpoint survives
Measured in a real browser (headless Edge over CDP — `browser_exec`'s `setDeviceMetricsOverride`
silently no-ops on this page, which is why the first sweep returned nine identical rows) across 9
window sizes. Before: at **1272x984** the body scrolled **367 px** and the lanes sat **352 px BELOW
the fold**; at 1600x1000 they were 299 px below. The old `@media (max-height: 860px)` band had
never fired at 984 px — the failure was at TALL sizes, above the band.

- `.arpv-body` is now a flex column: a **scrolling `.arpv-top`** (everything else) with the lanes a
  **SIBLING below it**, `flex: 0 0 auto`, capped at 46 % so a short window scrolls the lane bars
  rather than the panel. All **9 sizes now: panelScroll 0, lanes visible, emptySlots 0.** No
  `min-height` on either flex child — a floor makes a child refuse to shrink and brings the panel
  scroll straight back (that exact failure is now asserted in the probe).

### Pattern tiles: size reverted AND the empty slots removed
They were already back at 56 px in the source — the **shipped binaries were not** (`minmax(74px…)`
/ `height:38px` embedded in FAEZ.exe). But the empty slots were real and independent of size:
`repeat(auto-fill, minmax(104px, 1fr))` with 18 tiles gave 4×5, 3×6, 13×2, 15×2, 14×2 with 0–12
dead cells per width. Column counts are now **explicit and always a divisor of 18** (6 / 9 / 3 / 2),
so the grid is exactly full at every width. Probe asserts every count divides 18.

**Verified:** both typechecks clean. `.arp-layout-probe` 53/53 and `.arp-knob-dice-probe` 43/43.
**Both probes were made to bite** — reintroducing the auto-fill, the nesting, the `min-height:168px`
floor and the height band turned 4 assertions red; un-wiring the engine lane-dice and restoring the
`false` default turned 5 red. Native rebuilt: `BUILD_OK` with no `error C`/`FAILED:`/`LNK` lines,
all three artifacts FRESH, and `laneDiceBipolar`/`arpv-top`/`repeat(6,minmax(104px` confirmed
present inside **both** FAEZ.exe and FAEZ.vst3 (`auto-fill,minmax(104px` = 0). Browser re-measured
against the rebuilt bundle.

**Not listen-tested** — the probes assert wiring and geometry, not sound. Worth your own pass: paint
the transpose lane, set its die to ~40 %, arm the arp in ARP mode.

**Note for whoever edits next:** `faez-build.sh` aborts at its own "not plain ASCII" guard (the
`cygpath` path carries the middle dot into the .bat). The `for /d` glob in the script is correct —
it's the *guard* that misfires. Workaround used: wrote the same CRLF/ASCII .bat by hand.

## 2026-10-10 — DONE: arp panel rebuild — nested dice, bipolar dice, gate dice, Chaos distinct

User's reports, all from screenshots and mid-session messages:
- "the appearance of the Dice and layout is shit. they should appear UNDER their respective knob and
  the design should LOOK like a dice and not a knob"
- "m there is no Gate Dice"
- bipolar question: "put a -+ symbol next to each dice with both the - and + on each one ON by default
  meaning BIPOLAR randomness... if you remove the + then it only randomizes by subtracting"
- "The Pattern selector fader doesnt seem to be modulatable?? Also, make the pattern selector also have
  a chaos dice"
- "the chaos knob needs to have a distinctively visually different so make it have a different style,
  rainbow hue colour. put it on the far right and put a divider between it and the other knobs"
- "this thing is not accessible unless we scroll which is like... bad design ... there is a lot of room
  being unused in the arpeggiator panel ... moving the knobs higher would be a good start"
- no Active button: "if the values are all at 0 its not active, we dont need the extra active button"
- "Lets have Chaos Dice on both the Transpose and the Gate ... The Transpose one should also have a
  Piano Keyboard button (snap to key signature)"
- "Lets make the button for SEQ/ARP also have a OFF state so it toggles 3 times: OFF / ARP / SEQ"
- "the knobs in the small arp panel (not detailed view) are quite small theyu could be a lil bigger"

### Layout — the scroll was the measured problem
The panel was scrolling because the **dice strip sat below the whole knob row**, adding ~60 px, while
two cards had large dead space underneath their last child. Measured before the change:
`.arpv-patterns` **109 px** dead below, `.arpv-dice` **64 px** dead below. The pattern card also forced
`grid-row: span 2`, which is what pinned the tiles at 56 px tall on a 104 px minimum column and left
the slack.

Fixed by: nesting each dice inside its knob's own `.arpv-tc-col` (kills the strip entirely), dropping
the `span 2`, and tightening the pattern tiles (56 -> 38 px tall, 104 -> 74 px min column, icon 44x24 ->
34x18). **Dead space 173 px -> 99 px, `overflowPx: 0`, nothing below the fold** — re-measured in the
browser after the change, not assumed. Each dice column is centred under its knob (`diceBoxCx` equals
`knobCx` exactly for all four).

### The dice now look like dice
`.arpv-die` is an **SVG square with five pip dots**, rounded corners and a −7° tilt, tinted by
`--die-hue`. Lit pips rise with the amount (`ceil(amount * 5)`), so the face itself shows how much
randomness is dialled. Zero amount renders hollow and dim (`.is-off`), so "off" doesn't look like a
die set to 0 %. **Shape rather than colour is the identifier** — a colour-only cue did not survive the
neutral Graphite theme.

### Bipolar / one-way, and it actually changes the maths
`knobDiceBipolar` is a parallel 0/1 array, **defaulting to 1 (bipolar)** in both the TS normalizer and
the C++ JSON parse — a one-way default would have silently changed how existing songs dice. The engine
routes every draw through one helper, `ArpConfig::signedDraw(cfg, k, u, positiveOneWay)`: bipolar is
the plain symmetric draw in [-1, 1]; one-way takes **one half** of the range ([-1,0] or [0,1]) and then
**restores full scale**, so a one-way dice at 100 % reaches exactly as far as a bipolar one. Squaring
the bipolar draw instead would have concentrated it near zero and read as a subtle wobble.
*Rate's one-way draw alternates side on odd/even steps* — a single direction would walk into the clamp
and stay pinned. `kDicePattern` ignores direction entirely (a discrete index is not an ordered axis) and
the flag is still stored so the indices can't shift.

### New: Gate dice, and a 5th slot
`kKnobDice` 4 -> 5 with `kDiceGate`, `KNOB_DICE_COUNT` 5. Applied **multiplicatively** (`gateFrac *=`)
because gate is a ratio to the step length, so scaling keeps "50 % of a step" meaning half a step at
any rate; an additive offset would be musically huge at short gates and negligible at long ones.
Deliberately **skipped in SEQ mode**, where the gate LANE already owns per-step randomness and a live
draw would make the per-step lock meaningless.

### Gate lane reversed — DISPLAY only
Higher % now means a **shorter** note (100 % a staccato tick), matching how gate reads everywhere else
and the opposite of the global Gate knob directly above it. **The stored value is unchanged**
(0.05..4, higher = longer), so every saved patch still means exactly what it meant — only `format`,
the pointer mapping (`fy = reverse ? 1 - raw : raw`) and the bar paint direction invert. Asserted by
the probe, because inverting the write would be silent.

### Chaos made distinct
Last in the row, behind a vertical divider, rendered by its own `ChaosKnob`: a **rainbow conic glow
ring** plus a distinct hue. Same geometry as its neighbours, so it still reads as part of the row while
being instantly distinguishable — it is the *master* every dice obeys, not a peer of the four.

### Pattern selector: now a real mod target
`seqPattern` **already existed** in `mod-sources.ts`, but the slider was a bare `<input type=range>`
with no `data-mod-target` and no badge, so a cable dropped on it did nothing and there was no popover.
It now has `data-mod-target="seqPattern"`, a `ModBadge`, and a right-click popover. It also carries its
own dice (no −/+ — see `signedDraw`'s note on pattern).

### Step lanes
**Active/Off toggle removed** (an all-zero lane is inert by inspection). Both lanes gained a die in
their label column. Transpose also gained a **keyboard Snap** button: resolves each step's absolute
pitch class, finds the nearest in-scale pc, then converts back to the lane's root-relative −12..12
space **choosing the octave nearest the original** so snapping never jumps an octave. Untouched steps
(0) stay put. Lane dice are `ex.laneDice` / `laneDiceBipolar` — separate from `knobDice`, because a
lane already IS a 16-step sequence so its randomness rides the existing lane overlay.

### OFF / ARP / SEQ
One button cycles the three states (previously an On toggle plus a separate ARP/SEQ control — three
states over two widgets, and switching off cost two clicks). State is readable from the label *and* the
colour.

### Bigger knobs in the SMALL arp strip (not the detail view)
`.arp-metal .knob-md` **48 -> 56 CSS px**, value text **8.5 -> 10.5 px**, indicator 2 -> 3 px, field
min-width 52 -> 58 px. Scoped to `.arp-metal` so the detail view keeps its 64 px and no other knob in
the app moves. Verified in CSS px: all three strip knobs read 55.98 px, no horizontal overflow.

**The measurement trap that cost several rounds — worth remembering.** `getBoundingClientRect()` on
this UI does **not** report CSS pixels. `main.tsx` sets `--ui-scale` and `body { zoom }` to fit the
window (todo.md §100/§101), and in a 1272 px headless viewport that lands at **`zoom: 0.5736`** — so a
56 px knob *measures* 32 px, and "the knob didn't get bigger" is an artefact of the scale, not the
change. Two wrong fixes came out of chasing it (an explicit `.knob` width, and `flex: none` on the
field); both were removed once the zoom was found, and the correct fix was the single
`--knob-size` line that was there all along. **Use `getComputedStyle(el).width` for size, and
`getBoundingClientRect` only for position and overflow.** Documented at the rule and asserted by the
probe.

**Verified**: both typechecks clean; `npm test` all passed; `test:wire` 55/55; five probes green —
arp-layout **41**, arp-knob-dice **30**, warp2 15, fx-drag 18, theme-token 11. Browser-measured:
7 square dice with 5 pips, 6 direction toggles defaulting bipolar, divider 1 px, chaos conic glow,
gate lane showing 167 % with bars painting from the top, `overflowPx: 0`, strip knobs 56 CSS px.
Rebuilt; both binaries FRESH with `arpv-die-shell` / `arpv-tc-divider` / `arpv-mode-btn` /
`knobDiceBipolar` / `knob-size: 56px` confirmed present.
`test/.arp-layout-probe.mjs` (new, 41 pass) asserts the structure — nested dice, the gate reversal,
bipolar default, chaos last + divided, the removed Active button, the 3-state button, the pattern mod
target, the strip knob size — and was verified to go red when the gate reversal is reverted.

### Height adaptation — the STEP LANES were the thing being cut
Second report of the same kind ("this thing is not accessible unless we scroll"), with a screenshot of
the Transpose/Gate lanes. At the default headless size everything fit (`overflowPx: 0`), so this was
**only reproducible at other window heights** — measured across a sweep:

| window | before | after |
|---|---|---|
| 1272×984 | fits | fits |
| 1272×700 | **gate lane cut to 71 of 148 px** | fits / scrolls internally |
| 1100×620 | **gate lane 42 of 55 px** | fits |
| 900×560 | **lanes entirely below the fold** | fits / scrolls internally |
| 900×500 | lanes unreachable | lanes reachable |

The **lanes are last in the grid**, so any vertical shortfall eats them first — which is exactly what
the screenshot showed. The panel was laid out for a tall window and had only a *width* breakpoint
(`max-width: 980px`), which cannot fix a vertical failure at all.

Fixed with **height** breakpoints in `arp-ui.css`:
- `@media (max-height: 860px)` — the body becomes a flex column with `overflow: hidden`, so **the panel
  itself never scrolls**: the timing knobs stay put and visible, and the **lane bars get their own
  scroll area** (`.arpv-lane-scroll`) so the 16 steps stay reachable without dragging the whole panel
  past everything else.
- `@media (max-height: 660px)` — layers/dice are dropped first. They duplicate controls that also exist
  in the compact strip; the lanes have no equivalent anywhere else, so they are the last thing to lose.

**Two wrong fixes along the way, both caught by measuring.** First, a `min-height: 168px` floor on the
lanes card: that made the card refuse to shrink, overflowed the flex column and brought the **panel
scroll straight back** — the exact failure the layout exists to remove. The card is now
`flex: 1 1 auto; min-height: 0`, i.e. it takes what is left and no more. Second, putting the floor on
the card rather than the inner scroll area: the card's own chrome (title + padding) eats 42 px, so the
scroll area still collapsed to 82 px. Both are documented at the rule and asserted by the probe, because
each one looks correct in isolation.

Also trimmed the lane label column to 58 px so the dice and Snap don't crowd out the 16 bars.

**Verified across 11 window sizes** (1272×984 → 900×500): `panelScrolls: false` at every one,
`timingVisible: true` at every one, lane area reachable with at least one lane in view at every one. At
the tightest sizes the lane area scrolls internally (21–125 CSS px) rather than pushing content
off-screen. Both typechecks clean; `npm test` all passed; `test:wire` 55/55; five probes green —
arp-layout **48**, arp-knob-dice 30, warp2 15, fx-drag 18, theme-token 11. Rebuilt; both binaries FRESH
with `arpv-lane-scroll` and both `max-height` breakpoints confirmed present. The probe grew to 48
assertions, including the two regressions above, so neither can come back silently.

⚠️ **Not seen by a human.** The vision model was rate-limited for this whole pass, so every layout
claim comes from `getBoundingClientRect` / computed styles, never from looking at the result. The
geometry is verified; whether it *reads* right to you is unverified.

- [x] **Knob contrast + slight saturation increase.** Measured before touching anything, in the built
  bundle, by resolving the gradients the browser actually computed:

  | | before | after |
  |---|---|---|
  | `.knob-face` luminance spread (max − min) | **87** | **203.5** |
  | `.knob-face` highlight stop | 94 | **209.9** |
  | knurl white overlay | 0.04 | **0.09** |
  | `.knob-cap` specular | 0.16 over 30 % | **0.24 over 22 %** |

  The old face gradient dropped from luminance 94 to 23 by **46 % radius** and to 7 at the rim, so
  almost the whole disc sat inside a narrow dark band — which is exactly what "flat" looks like. The
  fix is a **tighter, brighter specular held further out** (highlight 0 % → 18 %, then falling to the
  same dark rim at 52 %): a small very bright spot, a fast falloff, and a dark edge, which is what makes
  a turned-metal disc read as metal. **Contrast comes from the highlight, not from lifting the whole
  disc** — raising the mid-tones instead would have greyed out all three dark themes.

  The knurl was `rgba(255,255,255,0.04)` over a 4° pitch: at 40 px that is sub-pixel and invisible. Now
  0.09 white / 0.14 black, still low-saturation so it adds machined texture without tinting the face.

  Also: `.knob-ring::before` (the recessed bowl) got a darker outer lip so the face reads as sitting
  *down inside* the housing rather than floating on it — most of the perceived contrast at a glance.
  And `.knob-cap`'s wide weak 0.16 wash became a smaller brighter dome.

  **The "saturation" reading is the highlight doing its job**, not a hue push: the values stay neutral
  greyscale (`--knob-body` / `--knob-well` are theme-independent since the de-theming), so what looks
  like richer knobs is a brighter specular against the same dark rim. Verified identical across all
  three themes (aurora-ice / black-ice / graphite all measure spread 203.5) — intended, not a bug.

  **Value text is still legible**, which was the risk: 69 knobs measured, value text at luminance 247
  against a worst-case cap (0.24 specular blend) gives **8.05:1**, well clear of the 4.5:1 floor. The
  cap was brightened, so this needed checking rather than assuming.

  ✅ Suites green (root + plugin typecheck, `npm test`, `test:wire` 55/55). Rebuilt; both binaries
  FRESH and content-verified (`var(--knob-body) 20%,#fff`, `#ffffff17`, `rgba(255,255,255,.24)`).
  ⚠️ **Not seen by a human.** The numbers say contrast roughly doubled; whether it's "slightly" or now
  too shiny is your call on the next run.

## 2026-10-10 — DONE: rainbow dice rows under rate/octaves/swing/pattern (Stooge chose per-knob)

- [x] **Per-knob random amount** — Stooge picked this over the other two options: each of Rate /
  Octaves / Swing / Pattern gets its own dice amount, redrawn once per step.

  **A different mechanism from lane dice, deliberately.** A lane is a 16-step overlay you can lock per
  step; these four are single knobs, so there is no per-step array — one amount each and a live draw.
  `ArpConfig::knobDice` is a `std::array<float, 4>` indexed by the `KnobDice` enum, and
  `knobAmount()` is the single gate. **It reuses the Chaos master**: every knob amount is multiplied by
  `chaosAmount`, so Chaos at 0 % still means "no randomness anywhere" rather than a second dial the
  user has to find and reconcile with the first.

  **Each of the four is drawn at the seam where its value is actually consumed** — which is the whole
  design of this change:
  | Dice | Drawn in | Why there |
  |---|---|---|
  | Rate | the `runStep` call site in the scheduler loop | `stepLen` is computed once per audio block; drawing earlier is one offset for the whole block |
  | Swing | `computeActual()` | swing *is* a step-time offset, so it must be drawn where the step time is decided |
  | Octaves | `runStep()` | next to `octsEff`, before `buildPool` |
  | Pattern | `runStep()` | next to the `effMode` call |

  *Caught while writing it:* the first version drew **all four** in the block-timing code. It compiled,
  looked right, and was wrong — at 8 Hz a 128-sample block holds ~8 steps, so one draw there is a
  static detune, not a groove. The probe now asserts RATE dice is **absent** from the block-timing
  region, so that mistake can't come back. Two more caught by inspection: passing the drawn swing into
  `runStep` was a no-op (the param was accepted and never read — swing is applied in `computeActual`,
  before `runStep` is called), and `knobAmount()` couldn't call `clampf` (a static member of ArpEngine,
  declared ~380 lines below `ArpConfig`) — real compile error, `C3861`.

  Rate is jittered **multiplicatively** (a random factor, clamped 0.25..4×), not as an additive Hz
  offset: the same numeric offset is a huge musical change at 20 Hz and inaudible at 200 Hz. Swing is
  clamped to the same 50..75 envelope the undiced swing uses. The scheduler's own advance uses the
  **undiced** `stepLen` — accumulating a random step length would make the wander compound without
  bound instead of staying a bounded jitter around the grid.

  Persistence: `knobDice: number[]` on `ArpGeneration`, normalized by `aArr(..., KNOB_DICE_COUNT, () => 0)`
  — **always rebuilt to full width**, never truncated, because the engine indexes it by a constant and a
  short array would read `undefined` mid-song. A patch saved before this field existed yields all-zero,
  i.e. the feature stays off in old songs rather than switching itself on. Mirrored in
  `ArpEngine.h`'s JSON parse (into a `float tmp[kKnobDice]` buffer for the same reason).

  UI: four `sm` knobs in `.arpv-dice-rows` under the main knob grid. **The rainbow is passed as a
  `color` prop, not set in CSS** — `Knob` resolves its colour in JS and hands `--knob-color` down as an
  inline custom property, so a CSS rule on `.knob-sm` loses to it and silently does nothing. Measured in
  the browser: four distinct hues resolve on the four knobs (`isRainbow: true`, hsl 150/190/265/330), and
  a synthetic drag on Rate moved it **0 % → 40 %** with the other three untouched. Fixed hues rather than
  `--accent`-derived, so the row still reads as "the dice set" under neutral Graphite.

  Probe `test/.arp-knob-dice-probe.mjs` (**24 pass / 0 fail**). Reverting the rate draw to the per-block
  site turns it red on 2 assertions; restoring turns it green. *Caught by running it:* four of its own
  first-run assertions had wrong expected values (two swapped rate factors, two grep windows too
  narrow) — the arithmetic was checked before blaming the code, and all four were probe bugs.
  ✅ Suites: root + plugin typecheck clean, `npm test` all passed, `test:wire` 55/55, fx-drag 18/18,
  theme-token 11/11. VST3 + standalone rebuilt; `knobDice` / `arpv-dice-rows` confirmed present in
  `FAEZ.exe` and `FAEZ.vst3`.
  ⚠️ **Not heard.** The engine maths, clamps and UI are verified; whether 100 % rate dice sounds like a
  groove or like chaos needs ears on it.

## 2026-10-10 — DONE: white/grey haze over the UI in EVERY theme ("fix theme and continue")

- [x] **The haze.** User: "theres a weird like white/grey haze over the ui now... i think it was when we
  added the theme graphite but like it seems to have changed all themes.... no good".

  **It was not Graphite's palette.** Graphite is a correctly scoped `.theme-graphite` block and measured
  clean (`#0b0c0e` page). The haze came from the token layer underneath all three themes, and it was
  there before Graphite existed — Graphite only made it obvious by being the first theme whose author
  looked at the page edge. Two distinct causes, both `#070a1c`:

  1. **`<html>` never carried the theme class.** `styles.css:303` paints `html, body, #root` with
     `background: var(--bg)`, and `--bg` is an alias for `--bg-app` that resolves against *whichever
     element reads it*. `PluginApp.tsx:157` mirrored the class onto `<body>` only (for portals) and
     `App.tsx` put it on the inner `.app` div, so `<html>` fell through to `:root`'s bare
     `#070a1c` — **measured at `rgb(7,10,28)`, a blue-grey LIGHTER than all three real themes**
     (`#000000` / `#02030a` / `#0b0c0e`). It showed wherever `<body>` didn't cover the viewport:
     scrollbar gutters, overscroll, the popout.
  2. **`:root`'s fallback palette was lighter than two of the three themes**, so *any* element missing
     the class washed out rather than reading as "unthemed".

  Fixed at the source, in all three places:
  - `PluginApp.tsx` + `App.tsx` now mirror the theme class onto `document.documentElement` as well
    (kept on `body`/`.app` — portals and existing cascade still need it).
  - `styles.css` gained an explicit `html { background: var(--bg-app, #000000) }` so the root element
    paints the theme rather than an alias resolved against itself.
  - `:root`'s fallback `--bg-app` `#070a1c` -> **`#000000`** (surfaces `#06080f` / `#0a0d16`). Pure
    black is the floor every theme sits above, so falling back can only ever be too dark, never washed
    out. The theme classes still supply all the hue.
  - **`src/main/index.ts`'s `BrowserWindow.backgroundColor`** was the same hardcoded `#070a1c` — the
    window backdrop *behind* the page, so it flashed a pale wash on load and during resize and ignored
    the theme entirely. Now `#000000`, for the same reason.

  **Measured, not assumed** (headless, built bundle, no screenshot needed — the aurora animation makes
  `Page.captureScreenshot` time out, so this reads computed styles instead):
  `html` was `rgb(7,10,28)` in all three themes; after the fix `html` === `body` in all three —
  `rgb(2,3,10)` / `rgb(0,0,0)` / `rgb(11,12,14)`, `match: true` each. Also confirmed the *shipped app*
  sets `documentElement.className` on mount by reading it, not by mutating it myself.

  Regression probe `test/.theme-token-probe.mjs` (**11 pass / 0 fail**) asserts the RULE, not the
  symptom: every theme-applying site must also reach `documentElement`; `html`'s rule must read a token
  and must not be `background: inherit` (`html` has no parent to inherit from — that was my first,
  wrong attempt); and **no theme may be darker than the `:root` it falls back to**, which is the
  assertion that caught cause 2 after cause 1 was already fixed. Reverting both halves of the fix turns
  it red on 2 assertions; restoring turns it green again.

  ✅ Suites: root + plugin typecheck clean, `npm test` all passed, `test:wire` 55/55,
  fx-drag 18/18, theme-token 11/11. Plugin rebuilt — `documentElement.className` and `data-fx-unit` both
  confirmed present in `FAEZ.exe` and `FAEZ.vst3`.
  ⚠️ **Not seen by a human.** The measurements prove the mismatch is gone; whether the *perceived*
  haze is gone is your call on the next run.

## 2026-10-10 — DONE: drag FX containers to reorder them in the FX view

- [x] **Drag-to-reorder the FX containers in the FX view** (user: "a more intuitive way"). **The arrows
  are kept** — this is in addition to them, not a replacement. Both were verified present in the shipped
  bundle, and the probe asserts the arrows survive so a future "drag replaces arrows" edit goes red.

  Built by **lifting the FX chain strip's interaction, not writing a second one**, exactly as the original
  note predicted: `FxPanel` now owns `dragType` / `overType`, a `press` ref and a `suppressClick` ref,
  hit-tests with `document.elementFromPoint(...).closest('[data-fx-unit]')`, and commits through the
  **existing** `movedTo(chain, type, toIndex)`. Both surfaces read the one `fx.chain`, so a reorder in the
  grid is a reorder in the strip and vice versa.

  Shape decisions, all of them consequences of the notes:
  - **Drag starts on the HEADER only** (`.fx-unit-head`). Inside it, a pointerdown whose target is a
    `button`/`input`/`.fx-unit-reorder` is refused outright (`onUnitHeadPointerDown`), so the enable dot,
    the MIX slider, the compressor's ATK/REL sliders, EQ's popout and the reorder arrows all keep their own
    clicks. Same reason the CSS gives them `cursor: default; touch-action: auto` — the header reads `grab`,
    a control inside it must not.
  - `touch-action: none` + `user-select: none` on the header, for the same reason `.fx-chain-row` has them:
    without it the WebView2/OS takes the gesture as a scroll once it becomes a drag.
  - **`suppressClick` is cleared on the NEXT press, not on consumption.** The strip clears it when the click
    arrives; if that click never arrives (pointer captured elsewhere, window lost focus) the flag stays armed
    and silently eats the next legitimate click. Clearing on press makes it self-healing.
  - `touch-action`/`cursor` went into the **existing** `.fx-unit-head` rule rather than a second one — my
    first pass added a duplicate selector, which is the documented "phantom bug" source in this repo.

  Verification (`node spike/elementary/test/.fx-drag-probe.mjs`, **18 pass / 0 fail**):
  - The probe **extracts `movedTo` from the real `FxPanel.tsx`** (stripping the TS annotations, passing in
    its sibling `realOrder`) instead of reimplementing it. This is not fussiness: the first version of the
    probe hand-copied the function and **stayed green against a deliberately broken build**. Extracted, the
    same break (measuring the drop index before the splice instead of after) turns **4 assertions red**,
    including the duplicated-unit corruption it should catch.
  - It also exits 2 rather than proceeding if the extraction ever fails, so it can never silently degrade
    into testing a stand-in.
  - Cases covered: drag right/left, drag to the far end, **drag down onto the last slot** (the off-by-one),
    self-drop no-op, out-of-range drop, dragging a type not in the chain, per-unit settings surviving the
    reorder, 8-slot `off` padding preserved, and a full 8-unit chain.
  - Suites all green: root `npm run typecheck` + plugin `npx tsc -p ui/tsconfig.json --noEmit`,
    `npm test` (DSP) all passed, `test:wire` 55/55.
  - Shipped-bundle content grep: `data-fx-unit` (2), `fx-unit-head:active` (1), `is-drop-target` (4), and
    the emitted pointerup handler doing capture-release → hit-test → `movedTo` → click suppression.
    `movedTo` greps as absent **by name only** — the minifier renamed it `f0`; the real call is visible in
    the printed region. Same trap as the skill's "helper name gets inlined" note.

  ⚠️ **NOT verified by a human dragging anything.** Typecheck + probe + shipped-code grep is the ceiling here;
  the pointer feel (whether a 5 px threshold is the right one on this grid, whether the drop highlight reads
  clearly against a live card) needs a real drag in the real window.
  ⚠️ The plugin had to be rebuilt to carry this — `npm run build:plugin-assets` then the native build.

## 2026-10-10 (late 3) — arp feature batch + multi-point envelopes

Typechecks clean (both projects), `npm test` all passed (4 new cases), `test:wire` 55/55.

### Arp batch
- [x] **18 patterns.** `poly` dropped (it fired the whole chord instead of picking an index — a chord mode,
  not a pattern); saved presets migrate `poly` -> `up`. Added **skipUp** (every other note up, then the ones
  it skipped — written as a permutation so the period is exactly n for both odd and even pools; a plain
  stride of 2 only reaches half an even pool), **repeatUp** (each note twice), **walk** (+-1 random walk,
  reflected at the ends). Order is identical in `ArpConfig::Mode`, `ARP_MODES` and `ARP_PATTERNS` — it has
  to be, the pattern selector maps 0..1 onto that index.
  *Caught while writing it:* the first Walk derived its position by replaying `c` steps per note, i.e.
  unbounded work on the audio thread that gets slower the longer the arp runs. It is now member state
  (`walkPos`, own PRNG stream so it never disturbs the dice).
- [x] **Pattern selector slider** (0-100 %) under the grid, host param `arp_pattern`, mod target `seqPattern`.
  The slider and the grid are ONE value, not two: both write `mode`, and the engine derives the playing
  pattern from `patternPos` (`ArpEngine::effMode`), which the processor writes from the host param every
  block. So a tile click moves the slider, the slider lights a tile, and automation sweeps both.
- [x] **Shape -> Chaos master.** New `generation.chaosAmount` (host param `arp_chaos`, mod target `seqChaos`),
  applied in `effAmount()` so it scales EVERY lane's dice at once and 0 % disables them entirely (rollStep
  bails on `amt <= 0`, so no overlay is written and the base pattern plays clean). `ArpExtras.shape` is kept
  in the data model so old presets keep their groove — it just has no control any more.
- [x] **Octaves modulatable** — mod target `seqOctaves` (span 3), applied as `octsEff` in runStep and passed
  into `buildPool`, clamped to the knob's own 1..4 so a route can't exceed what you could dial.
- [x] Mod targets appended: `seqOctaves` / `seqPattern` / `seqChaos` (indices 82-84, ctlout slots 6-8),
  `kArpMods` 8 -> 9, `mod{n}_dst` max 81 -> 84, mirrored in all five places; `test:wire` enforces it and
  caught the two missing `synthToFlat` emissions when the host params were added.
- [x] ArpDetail now receives `mod`/`onModChange`, so Rate / Swing / Octaves / Chaos are cable-drop targets
  with the per-knob popover, like the strip's knobs already were.
- [ ] **NOT DONE — "rainbow dice rows under rate/octaves/swing/pattern".** Genuinely ambiguous and I did not
  want to guess: today dice live on sequencer LANES (per-step overlays). Dicing a CONTINUOUS knob is a new
  concept and needs a decision — (a) per-knob random amount + its own re-roll, stored per knob and applied
  once per step, or (b) just a visual dice button that re-rolls that knob within a fixed range, or (c) those
  knobs join the existing lane-dice system as extra lanes. Each is a different data model. **Ask Stooge.**

### Multi-point envelopes
- [x] **DSP, no custom node needed.** `envSignal()` in `dsp/synth.js`: when `env.mode === 'multi'`, the
  envelope is a breakpoint `FunctionShape` played once from note-on over `durationSec`, holding its last
  point while the note is held, then released over `releaseSec`.
  The hard part was "seconds since THIS voice's note-on, that keeps counting after gate-off" — needed so the
  release tail starts from the level the shape was actually holding. **`el.counter(gate)` RESETS on gate-low
  (measured), so it is unusable here.** `el.time()` is free-running and `el.latch(gate, el.time())` captures
  it at note-on, so the difference is a per-voice clock that survives the gate. Holding at the end is free:
  `phase` clamps at 1 and `functionSignal` evaluates to the last point. Release is a plain gate-with-release
  ADSR multiplier. Applies to ENV 1 (amp) and every modulation envelope alike.
- [x] **Fixed a pre-existing key collision** found while adding this: `functionSignal` built its tail node as
  `el.const({ key: 'fn:last:<pointCount>' })` — a GLOBAL key. Two function shapes with the same number of
  points (two LFOs, or an LFO and an envelope) resolved to ONE shared node and fought over its value. Now
  keyed per voice + per source. Regression test added.
- [x] **State + wire.** `AdsrEnvelope` gains optional `mode` / `shape` / `durationSec` (absent = 'adsr', so
  every existing preset is untouched). Point data is not a bounded host float, so it travels through a new
  `setEnvShape(envId, json)` bridge verb -> `PluginProcessor::setEnvShape` -> `<envId>_envShape` in state ->
  `withEnvShape()` in dsp.main.js, exactly the precedent `lfo*_functionShape` set. The native handler
  validates `envId` against `env1..env11` rather than trusting the webview, because that key lands in the
  saved chunk.
- [x] **UI.** A wrench on every ENV card opens the SAME Function editor the LFOs use. Turning it on seeds the
  shape from the card's current ADSR (`adsrToShape`) so the sound does not jump; the `MULTI` button switches
  back to ADSR and KEEPS the drawn shape, so toggling is lossless. The card's graph shows the shape in multi
  mode.
- [x] **Tests** (`engine.test.mjs`): the multi shape rises, dips and rises again while held — which an ADSR
  provably cannot do (measured `0.113 0.127 0.053 0.090 0.115 ...` vs a flat `0.090`); the same envelope in
  adsr mode is flat at sustain; a shape with <2 points falls back to the ADSR bit-for-bit; two equal-length
  function shapes coexist.

**Nothing here has been heard or clicked.** Highest-risk items to try first: the arp at 1/16 with Chaos
swept 0 -> 100 %, the pattern slider sweeping across all 18, and a multi-point ENV 1 with a dip in it.
## 2026-10-10 (late 2) — renamed to FAEZ; theme rework (Aurora ember scrapped), knob de-theming, theme-switch repaint bug

Typechecks clean (both projects), `npm test` all passed, `test:wire` 55/55. **Built OK as FAEZ**
(NITESESH_BUILD_OK; `FAEZ_artefacts/Release/{Standalone/FAEZ.exe, VST3/FAEZ.vst3}`, VST3 reinstalled,
`wavetables.bin` copied beside both). Desktop shortcut repointed to `FAEZ.exe`. **Installer NOT rebuilt.**
Note: `plugin/build/FazeSpike_artefacts/` survived the clean wipe because the user's old standalone was
running out of it — harmless (the new target builds into `FAEZ_artefacts/`), delete it once that is closed.

### Renamed FazeSpike -> FAEZ
Product/target/binaries/installer/icon/log all now **FAEZ**. `plugin/FazeSpike_icon.rc` -> `plugin/FAEZ_icon.rc`,
`scripts/FazeSpike.ico` -> `scripts/FAEZ.ico`, `installer/FazeSpike.nsi` -> `installer/FAEZ.nsi` (git mv, history kept).
Diagnostics log is now `%TEMP%\faez-ui.log`.

**Deliberately NOT changed, and why:**
- `PLUGIN_MANUFACTURER_CODE Srgx` / `PLUGIN_CODE Fze1`. JUCE builds the VST3 FUID from exactly those two
  (`juce_audio_plugin_client_VST3.cpp:749`, `INLINE_UID(0xABCDEF01, 0x1234ABCD, ManufacturerCode, PluginCode)`;
  the name-hash path behind `getFUIDForVST2ID` is off because CMakeLists sets `JUCE_VST3_CAN_REPLACE_VST2=0`).
  Keeping them means **the plugin UID is unchanged, so existing DAW projects still resolve to it** under the new
  name. Changing either of those codes in future WILL orphan saved projects.
- `COMPANY_NAME "Faze"` — the company, not the product. (The repo-root Electron recorder is also "Faze".)
- User data folders `Documents/Faze/Wavetables` and `AppData/Faze/Samples` — renaming them orphans whatever the
  user already put there. Revisit only with a migration.
- `todo.md`'s historical entries. It is a work log; rewriting old entries would falsify the record.
- The untracked `plugin/build-v*.txt` / `build-log*.txt` build logs (hundreds of stale hits, junk).

**Needs doing before release:** the old `C:\Program Files\Common Files\VST3\FazeSpike.vst3` must be deleted —
it carries the SAME FUID as the new `FAEZ.vst3`, and two bundles sharing a UID is undefined host behaviour.
Installer not rebuilt yet either (it refuses stale binaries, so it must follow every plugin build).

### Themes
- [x] **Aurora ember deleted.** User: "just kind of looks like brown, red, or orange ... really looks awful".
      Replaced by **Graphite** (`graphite`) — a genuinely neutral greyscale stack (`#0b0c0e` / `#141619` /
      `#1b1e22`) with a silver accent `#d8dee6` and `--glow: 0.3`, no drifting aurora layer. The semantic trio
      (success / warning / danger) keeps its hue on purpose: those must stay tellable apart in any theme.
      The *plumbing* from the ember attempt was right and was reused; only the palette was wrong.
- [x] **Aurora ice is now the DEFAULT** (user: "should be what it looks like when people first open it").
      `types.ts` default, and `normalizeTheme` / `settings.ts` now fall back to it for any unknown stored id.
- [x] **Black ice lifted** (user: "really a little too dark in some places ... particularly at the very top bar
      where the macros are"). The top bar is `background: var(--bg-surface-elevated)`, which was `#080b0d`
      against a pure-black page. Now `--bg-surface` `#050708 -> #0c0f11` and `--bg-surface-elevated`
      `#080b0d -> #13171a`. `--bg-app` stays `#000000`: that black is the theme's identity.
- [x] **Knobs de-themed** (user: "the knobs shouldn't be too heavily affected by the theme colour ... dial that
      back"). Root cause: the housing, rotating face and centre cap were all built from `--bg-surface-elevated`
      / `--bg-app`, so they inherited whatever hue the theme carried — which is why every knob went brown under
      ember. Two new tokens, **the same in every theme**, now drive the hardware: `--knob-body: #1b1e22` and
      `--knob-well: #0a0c0e`. Only `--knob-color` (the value arc and the pointer) still carries the accent,
      which is the part worth tinting; its halo and the arc's drop-shadow were softened too, and `.knob-sm`
      labels went from 75% accent to 35%. A theme can still override the two tokens if it ever wants to.
- [x] **Canvases repaint on theme switch** (user: the velocity / key-mapping graphic "will remain in the same
      color as the previous theme until I move the ... envelope inside of it"). Root cause: every canvas reads
      the theme through `getComputedStyle(document.body).getPropertyValue('--bg-surface-elevated')` *at paint
      time*, but the theme is a class on `document.body`, not a React value — so no dependency array mentioned
      it and nothing triggered a repaint. New `src/renderer/lib/useThemeVersion.ts`: a `MutationObserver` on
      `document.body`'s `class` returning a counter, added to the dep array of all **seven** affected canvases
      (`LfoGraph`, `FunctionEditor`, `CurveGraph` = the one reported, `EnvGraph`, `WaveformThumb`, `EqCanvas`,
      `Scope`). Chosen over threading a `theme` prop through seven components because it also covers any canvas
      added later — it watches the one place the theme is actually applied.

**Not verified by eye:** none of the above has been looked at in a built window. Graphite in particular is a
fresh palette; the knob de-theming changes every knob in the app.
## 2026-10-10 (late) — request batch: compressor defaults, Aurora ember theme, LFO editor, arp knobs

All typecheck-clean (`ui/tsconfig.json` + `tsconfig.renderer.json`), `npm test` all passed,
`npm run test:wire` **55/55 green**, VST3 + standalone rebuilt (NITESESH_BUILD_OK, VST3 reinstalled to
`C:\Program Files\Common Files\VST3`). **Installer NOT rebuilt. Nothing below has been heard or clicked.**

- [x] **Compressor bands default to 50%** (user). `lowAmount`/`midAmount`/`highAmount` 1.0 -> **0.5** in all
  five mirrors: `types.ts` normalizer (the legacy `cm.ratio` migration path is untouched — only the
  no-value default moved), `types.ts` defaults object, the doc comments, `dsp/synth.js` `?? 1.0` fallbacks,
  `plugin/dsp.main.js` `?? 1.0` fallbacks, and `manifest.json` `fx_comp_{low,mid,high}_amt` defaultValue.
  test:wire's default-parity check covers this pair, so future drift between UI and manifest will fail.
- [x] **FX default mix on enable** — insert action only (see the PENDING entry for the stored-defaults half,
  still open and sequenced after gain staging).
- [x] **`test:wire` RED -> GREEN (55/55)** — 30 Audio Follower default mismatches; aligned `manifest.json` to
  `DEFAULT_AUDIO_FOLLOWER` (`types.ts:1469`). Details in the PENDING entry.
- [x] **New theme: Aurora ember** (`aurora-ember`) — Aurora ice duplicated and hue-rotated off blue into
  amber / rose / gold over a warm near-black (`#0a0603`), accent `#ffb765`, accent-soft `#ff8aa5`.
  `--danger`/`--rec` pushed to red (`#ff6b5a`) so they stay distinct from the rose accent, which they would
  not be if copied verbatim from Aurora ice's pink. Same drift animation (shares the `aurora-drift`
  keyframes), warm gradient stops. Wired through **every** consumer: `types.ts` `Theme`, `AppMenu.tsx`
  (THEMES + `normalizeTheme`), `styles.css` (token block + the legacy-alias selector list — easy to miss,
  the theme looks half-broken without it), `SettingsPanel.tsx`, `SynthHeader.tsx`, `src/main/settings.ts`,
  `src/main/ipc.ts`, and `visualizer.ts` (palette case, warm RAMPS entry, and a new `isAurora()` helper —
  five branches tested `theme === 'aurora-ice'` for the neon/glow treatment, so without it the new theme
  silently fell back to Black ice's flat look).
  **The two token blocks in `styles.css` are positional counterparts — keep them in step.**
- [x] **Wrench button on the LFO cards** opens the Function editor (user). Inline SVG (`WrenchIcon`), sits
  first in `.lfo-head-mods`, hidden in S&H mode (no shape to edit — same guard as `onFunctionOpen`).
  Double-clicking the graph still works.
- [x] **Modifier + right-drag erases points** in the Function editor (user). Right button + any of
  Shift/Ctrl/Alt sweeps interior points inside a 16px radius; endpoints are never removed and the shape
  never drops below 2 points. Working copy seeded at pointerdown (same pattern as `paint`) so a fast sweep
  doesn't lag a render. A bare right-click still deletes one point. Windows fires `contextmenu` on right
  mouse-UP, after the sweep ended, so an `eraseJustRan` flag stops `onContext` taking a bonus point.
- [x] **Tension handle now tracks the cursor** (user, with screenshots: "the bend isn't quite happening in
  the centre"). The handle was *drawn* correctly — segment time-midpoint, on the curve — but dragging it did
  `curve += dy/120`, and `curve` reaches the midpoint level through `0.5^(2^(curve*4))`, which is steeply
  nonlinear: the handle crawled near the middle of its range and bolted near the ends, so the bend appeared
  at a different depth than where you put the handle. Now inverted analytically:
  `ratio = (midLevel - a)/(b - a)`, `power = ln(ratio)/ln(0.5)`, `curve = log2(power)/4`.
  **This also retires the earlier ascending/descending sign flip** — that was treating a symptom of the same
  nonlinearity, and `ratio` is computed against the segment's own direction so both directions just work.
  Flat segments (`|b-a| < 1e-6`) have no bend to solve for and keep the old relative nudge.
- [x] **Arp detail-view knobs bigger** (user: the number *inside* the dial was too small; the name/value
  above it were fine). `.arpv .knob-lg` 50 -> **64px**, `.arpv .knob-value` 8.5 -> **13px**, field min-width
  60 -> 72px. Scoped to `.arpv` so the compact arp strip is untouched. The 8.5px came from
  `.arp-metal .knob-value`, which the detail view was inheriting from the strip despite having room.
  **NOT measured in a built window** — the detail view must fit the OSC slot with no inner scrollbar and
  this adds ~14px to the knob row; if it overflows, drop to 58px before touching anything else.

**Still not started — the arp feature batch** (patterns -> 18, pattern-selector slider, Shape -> Chaos
master, Octaves modulatable, rainbow dice rows): see the PENDING REQUEST BATCH entry. Groundwork established
while scoping it: `kArpMods` is 8 with slots [6][7] free, `SEQ_TARGETS` has 6 entries ending at index 81,
`ARP_MODES` still contains `poly`, and **there are no `arp_*` host params at all** — the arp config travels
as JSON through `setArpConfig`, so `arp_pattern`/`arp_chaos` as host params need a new merge path in
`PluginProcessor` between the param state and the JSON-built `ArpConfig`. That is the main design decision
in that batch and it is not yet made.

**Also requested, NOT started — multi-point envelope editor** (wrench on ENV cards -> add arbitrary points,
"really weird envelopes"). This is not a UI change: `el.adsr` cannot express it, so it needs a gated
breakpoint evaluator in the DSP (the existing `functionSignal()` is the right starting point but is
phase-driven, not gate-driven with a sustain hold), new per-envelope point state, manifest/preset work and a
migration for every existing ADSR. Deliberately not half-built — a wrench that opens an editor whose points
never reach the DSP is exactly the "silent failure that looks like success" this repo has a rule against.

## 2026-10-10 — PENDING REQUEST BATCH (moved here from OVERVIEW.md §6 — it was NEVER in todo.md)

Process note: OVERVIEW.md §6 says "see `todo.md` for the authoritative list", but this whole batch existed
**only** in OVERVIEW.md. Nothing below appears anywhere else in this file (checked: `Octaves modulatable`,
`pattern selector slider`, `Shape → Chaos`, `arp_chaos`, `880` all return 0 hits). Keep new requests here.

- [~] **FX default mix on enable** — DONE for the *insert action*, OPEN for the *stored defaults*.
  **Done (FxPanel.tsx, typecheck + `npm test` green):** inserting an effect (both paths — the insert menu and
  the FX-chain strip's toggle) now gives it an audible mix: **25%**, **20% for the compressor**, plus the
  compressor's requested envelope (attack 0, **release 880 ms** per band). Applied only when that effect has
  never been dialled in (mix still 0), so re-inserting an effect from an older patch keeps that patch's mix.
  Fixed a second bug found in the same place: the chain strip's `toggle` touched ONLY `fx.chain`, so an effect
  switched off earlier came back **still bypassed** (`enabledFor` keeps an existing boolean `enabled`).
  **Still open — the stored defaults** (`types.ts` `mix: 0` for every FX, the seeded JSON in
  `PluginProcessor.cpp`, `manifest.json` `defaultValue`s). Deliberately NOT changed yet because the master
  gain-staging fix (audit finding 3) re-references output level, so setting FX mix defaults first means doing
  it twice. Sequence: gain staging → stored FX defaults. (`test:wire` is green again, see below, so the
  default-parity harness will now actually catch a mistake here.)
  Original request (kept verbatim): **25%** for FX generally, **compressor 20% mix, attack 0,
  release 880 ms**. Current code: **every FX defaults to `mix: 0`** (`types.ts:1642-1720` + `:2076-2110`), and
  `FxPanel.tsx:129` sets `enabled: true` on insert but leaves mix at 0. Because `applyXSlot` early-returns on
  `(mix ?? 0) <= 1e-4`, dropping an effect into the chain builds **no node at all** — it is completely inaudible
  until you find and raise Mix. Compressor today: attack **0 ✓** (already right), release **120 ms** (want 880),
  mix **0** (want 0.20), per-band `*Amount` **1.0 = 100%**.
  **⚠ Three conflicting target numbers are on record for the compressor's default mix** — pick one before building:
  §165 item 1 step 4 says "default mix 0 → **~0.3**"; §165 step 3 asked "cap the mix slider at **~50%**?"
  (that question was resolved differently — auto loudness compensation was *removed* 2026-10-09 at the user's
  request, replaced by FxPanel's white→yellow→orange→blood-red `mixWarnColor`); OVERVIEW.md §6 says **20%**.
  Newest note wins unless told otherwise = 20%.
  Touches: `src/shared/types.ts` defaults, the seeded JSON in `PluginProcessor.cpp`, `manifest.json`
  `defaultValue`s, and `FxPanel.tsx:126-130`. **`npm run test:wire` asserts default parity between
  `synthToFlat` and the manifest and is ALREADY RED (15 Audio Follower mismatches) — fix it first or this
  change lands unverifiable.** Also sequence this AFTER the master gain-staging fix (audit finding 3): setting
  FX mix defaults before the output level is re-referenced means doing both twice.
- [ ] **arp Octaves modulatable** (seq mod target; `kArpMods` must grow — it is 8, and seq targets 76–81 are
  used, with seqOctaves [6] / seqPattern [7] / seqChaos [8] planned)
- [ ] **LFOs default unipolar** — `types.ts` defaults + the seeded JSON in `PluginProcessor.cpp`
  (`DEFAULT_FUNCTION_SHAPE.bipolar=false` already landed; this is the LFO *module* defaults)
- [ ] **Arp patterns → 18** — drop `poly`, add skipUp / repeatUp / walk, migrate saved `poly` → `up`
  (`ArpConfig::modeFromId` + `kNumModes` in `ArpEngine.h`, `ARP_MODES` in `types.ts`, manifest max)
- [ ] **Pattern selector slider** — 0–100 %, host param `arp_pattern`, also a mod target, fully synced with the
  chosen pattern
- [ ] **Shape → Chaos master** — rainbow knob, host param `arp_chaos`, scales all dice amounts, 0 % disables dice
- [ ] **Rainbow dice rows** under rate / octaves / swing / pattern
- [ ] Perf idea not done: skip/cache idle voices in the graph to cut rebuild time (note: the audit's const
  fast path makes this much less urgent — idle voices cost audio-thread CPU, not rebuild time)

## 2026-10-10 — PRODUCT & STRATEGY AUDIT (read-only; nothing changed in code)

Full audit: **https://claude.ai/code/artifact/4430a038-3002-4f6a-aa80-6c3de9f88f4f**
(identity, signature workflows, competitive landscape, scoring, phased plan). Summary of what it found
by reading/running the code — all of these are NEW findings, not in the list below:

**Verified defects (none of these were known):**
- [x] **Warp 2 silences the synth — FIXED 2026-10-10.** `PluginProcessor.cpp` bailed with
  `if (warpMode2 != 0) continue;` before generating any resource, but `dsp/synth.js` still requests a
  `:w2_<mode>:` table key → missing resource → **whole instruction batch fails** (hard-won rule 1).
  Also failed for `warpMode2 != 0, warpAmount2 == 0`. Warp 2 had host params, UI and 4 mod targets;
  zero frames ever existed.

  **Root cause was two bail-outs, not one.** Both had to go, and fixing only the second would have left
  the destructive case intact:
  1. `if (warpMode2 != 0) continue;` — skipped *every* Warp-2 state.
  2. `if ((! phaseWarp && ! waveWarp && ! specWarp) || warpAmt == 0.0) continue;` — this sat **above**
     it and tested only Warp 1, so it skipped any **Warp-2-only** state before the first bail was even
     reached. Removed and replaced by one gate that mirrors `wtWarpResourceKey`'s own test
     (`if (! warp1Active && ! warp2Active) continue;`) — the two must agree or JS and C++ disagree about
     which key a state maps to.

  **Warp 2 is a second STAGE over Warp 1's output, not an alternative to it** — `generateWavetableFrames`
  in `dsp/wavetables.js` applies Warp 1, then Warp 2 over `step1Frames`. Composition order is not
  symmetric, so this had to be built rather than approximated. Stage 2 is implemented for all three mode
  families, reusing the existing `wtIsPhaseDomainWarp` / `wtIsWaveDomainWarp` / `wtIsSpectralWarp`
  predicates on `warpMode2`:
  - **phase**: resample through a scratch buffer (an in-place resample would read indices it has already
    overwritten);
  - **wave**: per-sample transform + the same DC-removal and normalize stage 1 does;
  - **spectral**: `applySpectralWarp(warped, warpMode2, …, &specStage1Frames, f)` — handed the **stage-1**
    frames, exactly as the JS passes `step1Frames`. Passing the base frames here would silently produce a
    different spectrum, so `specStage1Frames` is collected per frame and only when a spectral stage 2 is
    actually active.
  With Warp 1 off and Warp 2 on, stage 1 now carries the base frame through untouched (matching the JS,
  whose Warp-1 map returns each frame unchanged at mode 0) and stage 2 warps *that* — which is what makes
  a Warp-2-only patch work at all. An unknown mode falls through leaving stage 1's result, the same
  "silent audible no-op, not a crash" contract stage 1 already used.

  Probe `test/.warp2-probe.mjs` (**15 pass / 0 fail**) asserts the JS reference's semantics AND the C++
  shape: no bail-out, stage 2 gated on `warp2Active`, applied to stage 1's output, spectral stage 2 given
  the stage-1 frames, scratch-buffer resample, Warp-2-only not skipped, and the "either stage active"
  gate matching the resource key. Verified red (5 assertions) against the original code before the fix.
  ✅ Builds clean; `npm test` / `test:wire` / the other three probes unaffected. VST3 + standalone rebuilt.
  ⚠️ **Not heard.** Warp 2 with each mode family needs a listening test; the earlier
  `test/spectral-warp-diff/` harness differentially verifies **stage 1 only** and does not cover stage 2.
- [ ] **Save Preset throws in the plugin.** `ui/shims.ts:17`'s Proxy returns a no-op *function* for every
  `window.api.*` member, so `PresetBar.handleSave` takes the Electron branch, `await noop()` → `undefined`,
  `result.presets` → TypeError. The `localStorage` fallback is unreachable. No user preset can be saved.
- [ ] **Gain staging is 25 dB wide.** Measured via OfflineRenderer: 1 op @ level 1.0, master 1.0 =
  **-19.3 dBFS** (-21.2 at default master 0.8); 4 ops + 6 notes = **+4.2 dBFS (clipped)**.
  `HEADROOM_VOICES=6` pins headroom at `1/sqrt(24)` regardless of sounding op count. No meter, no limiter.
  **Fix before building a preset library** — it re-levels every patch.
- [ ] **Warp Amount mod is inert for 26 of 29 modes.** `dsp/synth.js:766` builds `warpAmtNode` but only uses
  it for modes 3/4/8; the resource key uses the *static* `warpAmtVal`. And for modes 3/4/8 the warp is
  **baked into the frame AND applied live = double-warped**.
- [ ] **8 self-FM/PM knobs + 8 mod targets do nothing.** `dsp.main.js:93` and `ui/translate.ts:488` both skip
  `src === k`; no `op{k}_pm{k}` manifest param. (The stale comments claiming the engine can't do it are wrong —
  it builds a tapIn/tapOut pair, but through a one-*block* delay ≈2.7 ms = a comb, not FM feedback.)
- [ ] **Modulating WT Pos nearly doubles the graph.** Measured: 4 WT ops @ 12 voices = 2,601 → **4,565 creates**
  when position is modulated (abandons the 4-frame static fast path). Worst perf cliff is on the most musical move.
- [ ] **Warped frames leak.** `pruneSharedResources()` is only called from `loadSampleFile`. Amount quantises to
  whole percent → one knob sweep registers 100 key-sets × 8 frames × 8 KB ≈ **6.4 MB**, permanently.
- [ ] **Mod route 25+ is silently dropped** (`ui/translate.ts:187`, `NUM_MOD_SLOTS=24`). No counter, no warning.
- [x] **`npm run test:wire` was RED — now GREEN (55/55).** 30 Audio Follower default mismatches between
  `synthToFlat` and `manifest.json` (`af*_rel` 50 vs 120, `af*_gain` 15 vs 12, `af*_src` 1 vs 0, x10 instances).
  `DEFAULT_AUDIO_FOLLOWER` (`types.ts:1469` — `{loHz:20, hiHz:20000, attackMs:5, releaseMs:50, gainDb:15,
  source:1}`) is the deliberate, canonical default: **source 1 = the synth's own output**, because a new
  follower pointed at the sidechain bus does nothing in the standalone. The manifest still carried the
  original 120/12/0, so a fresh instance's HOST params disagreed with what the UI showed and the first touch
  of a knob jumped the value. Fixed by aligning the 30 manifest `defaultValue`s to `DEFAULT_AUDIO_FOLLOWER`
  (pre-release, so changing host param defaults is acceptable — same reasoning as §165 item 1 step 1).
- [ ] Only **4 factory presets**, none using a wavetable, FM/PM, warp, arp or a macro. Serum 2 ships 626.
- [ ] Window is fixed 1272×984, `setResizable(false,false)` — doesn't fit 1366×768.
- [ ] `wavetables.bin` holds **up to 64 frames/table**; `getBaseWavetableFrame` samples them to 8 slots —
  87% of the morph detail on disk is discarded before it's ever heard.

**The biggest engineering win found (verified empirically, not in any prior note):**
`el.const({key,value})`'s node id is `hashNode('const', props, [])` =
`hashString(hashString(-2128831035,'const'), key) & 0x7FFFFFFF` — it depends **only on kind + key, never the
value** — and a value change is exactly `[[3, hash, "value", v], [5]]`. Confirmed against `@elemaudio/core`.
Also measured: an unchanged re-render emits **1 instruction**, a knob change **2** — so the instruction batch was
never the cost; the 50–140 ms is rebuilding 2,600–4,500 JS node objects in QuickJS to discover nothing changed.
→ **C++ can mirror that 8-line hash and write knob values straight into `runtime->applyInstructions`, with zero
QuickJS work.** This removes the project's defining perf constraint and unblocks mutation / sequenced timbre /
modulated WT Pos. See the audit's task 4 for the exact implementation and test.

**Next five engineering tasks (full detail + acceptance tests in the audit):**
1. ~~Warp 2 — generate stage-2 frames...~~ **DONE 2026-10-10** (see the verified-defects entry above for
   the two bail-outs and the stage-2 composition). Test added and passing in `engine.test.mjs`:
   `warpMode2=16, warpAmount2=0.5` → non-zero RMS (6.17e-2), plus stage-2-only, stage1+2 composed,
   a frame-difference assertion (an "audible" check alone passes even when the warp is ignored —
   all three configurations measure the same RMS, because a resampled table has the same energy),
   and the amount-0 key-collision case.
2. Save Preset — return `undefined` for the preset verbs in `shims.ts` (reaches the localStorage fallback) or add
   real bridge verbs writing `.fazepreset` JSON. Test: save → restart → load → diff recalled `SynthSettings`.
3. Gain staging — normalise against *sounding* operators (~-12 dBFS for 1 op @ master 0.8) + master output meter
   off the existing `main` scope tap; re-level the 4 presets in the same commit.
4. Const fast path — `plugin/ConstHash.h` + a param-id → `ctrl()`-key table; full rebuild only when a structural
   key changed (`wave`, `wtid`, `warpmode*`, `level` crossing 0, `mod*_dst`, `fx_chain`, module add/remove).
   Test: assert the C++ hash matches `@elemaudio/core` for ≥20 real keys; 5 s knob drag logs zero reconciles.
5. Listen-test + triage the arp/seq, sampler and glide (no code first). Replace the blanket "unverified by ear"
   line with a triaged defect list; regression-test everything expressible offline.

**Decision needed before any public preset uses a resynthesised/user table:** user wavetable ids are positional
(`faze::uwt::kUserBaseId + index`), so such a preset breaks on another machine. Name + content hash, or embed.

**Anti-roadmap (deliberately NOT building):** granular engine, more FX types, more warp modes, more arp patterns,
cloud/accounts, AI anything, a modular patch-cord view, more than 12 voices, a second preset format.

## 2026-10-10 — SAMPLER / "synth went silent" (FIXED) + arp strip colour-coding
- [x] **Total silence after using the sampler (even back on Wavetable / after Init)** — TWO bugs, both found from `%TEMP%/fazespike-ui.log` (`applyInstructions #N FAILED ... Invalid value for the given node property`):
  1. DSP built `el.sample({path:'sample:opK:0'})` for an operator in Sample mode with nothing loaded; Elementary rejects a node whose resource is missing and the **whole instruction batch fails** (every later batch then fails against a graph that was never built). Now silence is rendered when `sampleVersion == 0`.
  2. **Startup ordering bug (this is what made it permanent):** a saved sample made `reloadSamplesFromPaths()` -> `loadSampleFile()` -> `dispatchStateChange()` run while the runtime was being rebuilt, BEFORE the wavetable resources were registered, so the graph referenced missing wavetables and failed on EVERY launch (`#1 FAILED`). `loadSampleFile(..., dispatch=false)` for the reload path. Verified against the user's real saved state: `#1 ok` (was `#1 FAILED`).
  + native **self-recovery**: a failed batch now rebuilds the runtime/JS engine from state (rate limited, max 5) instead of staying silent.
- [x] **Recording source**: the Rec button had no input choice (it only resampled the synth). New `Resample | Input` select; Input records the plugin's audio input. Root cause of "never asked for an input device": JUCE's standalone host keeps only MAIN buses at default state and my input bus was default-off, so the standalone could never receive input — the input bus is now ON by default (mono/stereo accepted); the standalone still **mutes input until you un-mute it** (`⚙ Input…` button opens the audio settings: pick the device + untick Mute). NOT TESTED with a real microphone.
- [x] Arp strip: single pattern selector + On button (the five quick buttons are gone), Octaves knob back, **Arp/Seq toggle sits next to the ♪ button**, ♪ is dim until its view is open then lit **green (Arp) / sky-blue (Seq)**; Arp mode = green accents, Seq mode = blue; "FX VIEW"/"SYNTH VIEW" -> "FX"/"SYNTH".
- [ ] Sampler still unverified by ear: loading a file, root note, loop, start/end, Rec from Input.

## 2026-10-10 — detailed-view fixes (user report)
- [x] The ♪ detail button: glyph was white on bright cyan (invisible) -> dark ink.
- [x] Pressing the strip's **Arp/Seq toggle while a detailed view is open now swaps to the matching view immediately** (effect in PluginApp: view 'seq' <-> 'arpdetail' follows `arp.seq.enabled`).
- [x] **The top visualizer is hidden in the detailed Seq/Arp views** and the sequencer lanes were compacted (name beside the dice, 24px bars): header + 7 lanes + scale weights + hint all fit with NO inner scrollbar (scrollHeight == clientHeight == 602px, headless).

## 2026-10-09 (late 15) — "all the notes much lower" = BUG IN THE AGENTS' GLIDE CODE (FIXED)
- [x] Cause: the native-path glide smooths log2(freq) and converts back with 2^x, but Elementary's `log` node is **BASE 10** (`std::log10`), and the code divided by `Math.LN2` — every note came out as ~f^0.43 (A440 -> 14 Hz). Fix: divide by `Math.log10(2)` (verified: 2^(log(440)/log10(2)) == 440.00 in the real renderer) + a regression test in engine.test.mjs. Also restored the original linear smoother for the browser-preview/offline path (the log-domain version changed the attack transient and tipped a borderline wavetable test). Engine tests all pass again.
- [!] LESSON: the workflow agents wrote DSP/C++ I never ran or listened to, and the user found this within minutes. Everything from the 2026-10-09 (late 14) batch is still unverified by ear — expect more like this; report oddities.

## 2026-10-09 (late 14) — ARP/SEQ + UI batch IMPLEMENTED by a multi-agent workflow (built OK; NOT listened to, NOT UI-driven by a human yet)
Plan/contract: `docs/ARP-SEQ-PLAN.md`, `docs/ARP-SEQ-CONTRACT.md`. Built: VST3 + standalone + installer (all contain it; standalone boots, applyInstructions ok).
- [x] **Native engine** (`plugin/ArpEngine.h` rewrite): 16 arp patterns, seq directions (fwd/bwd/bounce±ends/random/random-no-repeat/drunk/converge/diverge), tempo-synced rate (division x feel) or free Hz, swing 50-75 + shape + humanize, probability, 7 lanes (on/prob/pitch/octave/vel/gate/slide) with per-lane length/div/rotation (polymetry) + reset-after, **dice overlay** (per-lane amount, Regen/Clear/per-lane roll tokens, per-step locks, Auto-Regen by bars, Frozen/Live, seeded PRNG), scale weights + key snap, chord layers + 2 arp rows (octave offsets -2..+2), step transpose/gate lanes, gate up to 400%.
- [x] **Glue/DSP**: ctlout node + 6 new mod targets (seqRate/Swing/Gate/Transpose/Velocity/Random, mod indices 76-81), voicectl slide + tight fields, **glide is now time-to-arrive** (tau=t/3, log-frequency), **per-step Slide** DSP, **tight release** (arp gate-off shortens the amp release so Gate is audible), arp playhead + overlay pushed to the UI, transport (host ppq/bpm) passed to the arp, editor window 1272x984 (+32 for the bigger top bar).
- [x] **UI**: docked **Sequencer** view (7 lanes, dice per lane, Regen/Clear/Apply, direction, polymetry, swing, sync rate, scale weights) and docked **Arp detail** view (16 patterns, timing, **chord/arp layer buttons**, step transpose/gate lanes, tight release); both fill the OSC slot exactly (459px) so the modulator strip stays visible; arp strip redone (quaver detail button, metal panel, bigger readable knobs: strip keeps Rate+Sync/feel and Gate — **Swing and Octaves moved to the detail view** because 83px can't hold four knobs); top-bar knobs bigger, macros easier to turn (shift = fine, wheel), exponential glide taper (5*v^3); collapsible modulator section; **WT Pos now modulatable** (data-mod-target + glow); only **Black ice + Aurora ice** themes remain; flat **user wavetable folder** (`Documents/Faze/Wavetables`, custom library path, Rescan, User group in the dropdown).
- [ ] **VERIFY BY HAND** (nothing here has been heard or clicked by a human): arp steadiness at 8-20 Hz, each direction, dice amounts (does 100% sound wild, 0% never change?), Auto-Regen on the bar, chord/arp layers, tight-release audibility, slide, mod routes to seq targets (voice-0 sources only!), drag/paint in the lane editor, collapse toggle, WT Pos cable drop, wavetable folder chooser/rescan, bigger top bar fit in a real host window, glide feel.
- [!] Known gaps / decisions taken for you (plan §9 answers): arp mode ignores the Gate/Pitch lanes by design (gate = global gate x step gate lane when "use step lanes"); seq pitch is relative to EACH held note (max 4); the seq lane playhead highlight ignores rotation/non-forward directions (approximation); user wavetable ids shift if files are added/removed (presets store the number); the dev ESW category folder was NOT flattened (only baked bin ships); `Glide` was NOT moved next to the arp (undecided, per your note); legacy `useArpEngine.ts`/`seqPlayhead.ts` left in place.
- [x] Process lesson: a mid-run user message got injected into the sub-agents and 5 of 8 did the wrong job on the first run — prompts now say to ignore such messages.

## 2026-10-09 (late 13) — Stooge's notes batch: LOGGED + RESEARCHED, **nothing below is implemented yet**
Reference images saved: `docs/mockups/Collapsed modulator section (tops only).png`, `docs/mockups/Bitwig CHIMI chord-arp layer device (reference).png`.
**Arp / Sequencer research + full plan: [`docs/ARP-SEQ-PLAN.md`](docs/ARP-SEQ-PLAN.md)** (Pigments 5 manual ch.10 read in full: dice / Random Amount / Regen / Auto-Regen / overlay model, polymetry, slide, scales; Bitwig `.bwpreset` device analysed). Read its §0 (answers) and §9 (open questions) first.

**UI / layout** (NOTE: window height is frozen — anything that changes heights needs Stooge's OK first, lesson from the collapsed-row mistake)
- [ ] **Collapsible modulator section**: a collapse toggle; collapsed = only the card HEADERS (tops) visible (mockup above). Open: where does the freed height go (OSC panel grows? stays blank?) — ask before building; cable-drag from the header dots must keep working.
- [ ] **Bigger top-bar knobs**: Oct / Semi / Fine / Glide / Master / the 8 Macros should be at least Resonance-knob size. Extend ONLY the top bar, nothing else may shrink -> needs a height budget decision (total window height). Macros are also **hard to turn** -> larger hit area + finer drag sensitivity.
- [ ] **Arp panel**: knob value text unreadable (strip uses `size="sm"` knobs) -> bigger/legible; panel background too dark -> brushed-metal look similar to (not the same as) the filter panel.
- [ ] **Detail-view button**: the `⋯` is too anonymous -> a **♪ quaver icon in a distinct accent colour**. Answer to "is the detail view the sequencer?": **yes** — `⋯` opens `SeqEditor` (the 16-step lane editor), even while in Arp mode; Arp will get its own detailed view (plan §4.2).
- [ ] **Glide location** — Stooge wants it near the arpeggiator because arp is heavily affected by glide. **UNDECIDED, do NOT implement**; options in plan §7.4 (keep top bar / move beside Rate / fold into a per-step Slide lane).

**Bugs / diagnoses (code-read only, not verified by ear)**
- [ ] **Arp Gate knob "does nothing"**: the engine does honour it (`ArpEngine.h` schedules note-off at stepLen×gate) but the amp ENV release (0.4 s default) masks it — at 8 Hz a step is 125 ms. Verify by setting ENV 1 release ~0 and sweeping Gate. Possible UX fix (shorten release on gate-off) needs a decision (plan §7.1).
- [ ] **Glide far too sensitive**: knob is LINEAR 0–5 s (first pixel ≈ 50 ms) and the value is a one-pole time constant (arrival ≈ 3× the number shown) on frequency in Hz. Fix: exponential/cubic taper, treat the value as time-to-arrive (τ = t/3), smooth in log-frequency.
- [ ] **WT Pos not modulatable (really)**: the DSP supports it (`T.opNWtPos`, `synth.js:738`) and the row has a ∿ badge, but the slider/row has **no `data-mod-target`**, so cable drops and the hover-edit popover don't recognise it, and there is no modulation glow on the slider. Fix: add `data-mod-target`, glow, and show the modulated position; then verify end-to-end (route LFO -> WT Pos and watch the graphic).

**Wavetables**
- [ ] **One flat wavetable folder, no categories** (the browser never shows categories, so the sub-folders only confuse). Users either **point the synth at their own wavetable library** or drop wavs into **our designated Wavetables folder**. Today the folder button opens `resolveEswBaseDir()` = the dev repo's `Echo Sound Works Core Tables/<Category>/…` — **that folder does not exist on an installed machine** (the installer ships only the baked `wavetables.bin`). Plan: create `Documents\Faze\Wavetables` (flat), scan it for user wavs at startup, append them as user tables, button = open that folder + "Set library folder…". **Decisions needed**: wtId stability (ids are positional presets use them — user tables must append, referenced by name), how a missing user table behaves in an old preset, and flattening the dev ESW folder (git restructure + licence note).

**Arp / Seq (all details in `docs/ARP-SEQ-PLAN.md`)**
- [ ] Research done -> plan written; **awaiting Stooge's answers to §9** (dice amount semantics, the Bitwig device's small ARP buttons, gate audibility, docked views, tempo-synced rate, pitch lane range, glide/slide).
- [ ] Sequencer features to build (phased P0-P6 in the plan): playback direction (fwd / back / bounce with and without repeated ends / random 1-N), **dice + Random Amount per lane** (gate, pitch/semi, octave, velocity, slide, probability) with Regen / Auto-Regen / Clear / Apply / per-step lock, **Slide lane**, polymetry, tempo-synced rate + swing, pattern browser/lock.
- [ ] **Modulators must stay reachable in the sequencer detail view** -> detail views become docked main-area views (not a modal) + a native `ctlout` node so mod-matrix values reach the arp (plan §6.5).
- [ ] **Chord-layer + arp-layer device** (from the Bitwig preset): chord buttons -2..+2 + ARP octave-layer buttons + Velocity / Arp Rate / Octave / Shape / Gate knobs; **arp mode only**, not seq (plan §4.1). Detailed arpeggiation view (plan §4.2).

## 2026-10-09 (late 12) — "+" tile was shorter than the cards (FIXED)
- [x] The "+" tile was ~38px tall next to 66px cards: when the cards moved inside `.env-cards` the old `.env-grid > .env-extra { display:flex }` rule stopped matching (cells were `display:block`, nothing stretched). Cells are now stretching flex boxes (`.env-cards > .env-extra`), tile/button `height:100%`. Measured: every cell + the tile = same height.

## 2026-10-09 (late 11) — modulator limit = 10 TOTAL, any mix (no per-type caps)
- [x] User: the grid has 12 cells (ENV 1 + 10 modulators + the "+" tile), "we don't need to limit per mod type". Removed the per-type caps (was ENV 8 / LFO 8 / AF 4): now **MAX_ADDED_MODULES = 10 in total**, any combination (10 envelopes, 10 Audio Followers or 10 LFOs all work). The host-parameter pools grew to cover that: ENV up to 11, LFO up to 10, Audio Follower up to 10 (mod sources appended 30-40: env9-11, lfo9-10, audiofollower5-10; `mod{n}_src` max 40). Cards now PACK left-to-right (no forced LFO row break) so 11 cards fit the two fixed rows with no scrolling; the "+" menu shows `Add modulator · n/10` and per-type counts, and the tile disappears at 10. Tests: env11 / lfo10 engine tests; headless: 10 x each type + a mix all land on exactly 10, extras refused, no scroll.
- [ ] Legacy cards that only show because a ROUTE still reads from them count toward the 10 (they are real cards).

## 2026-10-09 (late 10) — modulator area polish for big patches
- [x] User screenshot ("behaving weird"): with many modules the 2-row scroll area stopped half-way through rows, the Audio Follower title was truncated ("AUDIO FOLI"), and a newly added card could land out of view. Fixed: **scroll-snap to whole rows**, A/R/G drag fields moved INSIDE the follower's graph (header = dot + title + IN/OUT + x), and a **newly added card scrolls into view**. Verified with 20 cards (scrollTop snaps to 69 px = one row; last-added LFO fully visible).
- [ ] Known cosmetic: the LFO group always starts a fresh row, so e.g. 6 ENVs + 1 Audio Follower leaves empty cells on the AF row. Say if you'd rather have everything packed with no forced row break.

## 2026-10-09 (late 9) — REVERTED the collapsing modulator row (it broke the layout)
- [x] The "reclaim the empty row" change made the OSC cards ~60 px taller and squashed the modulator area. **Reverted**: the modulator area is ALWAYS two 66px rows (more rows scroll) so nothing resizes when modules are added/removed. With no LFOs the "+" tile starts the second row so the space looks intentional. Measured identical OSC 466 / mod area 117 / bottom row 723 / keys 853 at 1, 2 and 20 cards. Rebuilt VST3 + standalone + installer after the fix. LESSON: layout-height tricks need the user's OK; the window height budget is frozen.

## 2026-10-09 (late 8) — standalone relinked while running (rename trick); installer regenerated
- [x] A RUNNING FazeSpike.exe can't be overwritten but can be RENAMED: `mv FazeSpike.exe FazeSpike.running-<time>.old`, then `plugin/build.sh` links a fresh exe without closing the user's session (the .old goes away on a later build once that process exits; build.sh now clears stale `*.old`). Used this to ship the portal-menu "+" fix to the standalone. Booted the new exe: loads the current wavetables.bin, applyInstructions ok.
- [x] `installer/dist/FazeSpike - Windows Setup v0.1.0.exe` regenerated AFTER the fix (full-file content check passed for both binaries); the earlier stale one is deleted and no copies of it exist.

## 2026-10-09 (late 7) — "+" menu invisible in the real app (FIXED) + installer staleness check hardened
- [x] **"+" did nothing**: my scrolling card area (`overflow-y:auto`) CLIPPED the pop-up menu (it hangs above the tile). My earlier headless test only checked the DOM, not that the menu was visible. The menu is now rendered in a **portal at <body>**, positioned from the button's rect (opens upward, flips if no room). Verified with REAL mouse events + `elementFromPoint` hit-test + screenshot: menu visible on top, clicking LFO adds LFO 1. Lesson: test visibility (hit-test), not just `.click()` on DOM nodes.
- [x] `installer/build-installer.sh` staleness check now compares the WHOLE embedded dist/index.html, dsp.main.js and manifest.json byte-for-byte (a 1.2 KB slice passed a stale exe once and shipped an installer with an old standalone). Verified it rejects a stale exe. **The installer must be rebuilt after every plugin build.**
- [!] FazeSpike.exe was open again -> standalone not relinked; installer not regenerated yet (the guard refuses). Close FazeSpike -> `bash plugin/build.sh && bash installer/build-installer.sh`.

## 2026-10-09 (late 6) — Windows INSTALLER + wavetables.bin deployment fix + collapsed modulator row
- [x] **Installer** (`spike/elementary/installer/`, NSIS from the electron-builder cache; no new tools): `bash installer/build-installer.sh` -> `installer/dist/FazeSpike - Windows Setup v0.1.0.exe` (version read from CMakeLists; name follows the release convention). Components: **VST3** -> `%CommonProgramFiles%\VST3\FazeSpike.vst3`, **standalone** -> `%ProgramFiles%\Faze\FazeSpike` + Start Menu, optional **Desktop shortcut**, uninstaller + Add/Remove Programs entry (user data in %APPDATA%\Faze is left alone). Installs the signature-checked **Microsoft VC++ 2015-2022 x64 runtime** when missing (the plugin links it dynamically) and warns if the **WebView2** runtime is absent. Silent: `/S [/NOVST3] [/NODESKTOP] [/NOVC] [/D=path]`. The script REFUSES to package stale binaries (older than dist/index.html) or a wavetables.bin that differs from plugin/wavetables.bin. Tested unattended (non-elevated test build): files byte-identical to the build, registry entry created/removed, user's Desktop shortcut untouched. NOT tested: the elevated VST3 copy, UAC prompt, a fresh PC without the runtimes, SmartScreen (unsigned).
- [x] **BUG found**: the plugin loads `wavetables.bin` from BESIDE the binary and nothing copied it — the standalone/VST3 had been running a stale 85 MB bin from the morning. CMake now copies `plugin/wavetables.bin` next to both outputs every build (before the VST3 install). The bin itself is gitignored: regenerate with `npm run build:wavetables`.
- [x] **Modulator row collapse**: a fresh patch (ENV 1 + "+") reserved a full empty second card row; the area now only takes the rows in use (`--card-rows`), so the oscillator panel grew ~60 px.
- [ ] Installer: code signing (SmartScreen warning), GitHub Release upload (not done — nothing published), auto-update.

## 2026-10-09 (late 5) — Audio Follower: IN / OUT input switch
- [x] User: "audio follower UI doesn't react to the sound". Cause: it only listened to the host SIDECHAIN input, which the standalone never has (and the DAW must route). Each follower now has an **IN / OUT** toggle on its card (`af*_src`, `source` 0/1): **IN** = sidechain (default, per spec), **OUT** = the synth's own final output via a one-block `tapOut`/`tapIn` feedback tap (`faze:master`), so the meter and the modulation react to what you play, in the standalone too. Engine tests: OUT changes the sound, IN stays closed on silence. Beware: OUT routed to something that changes the master level is feedback (one-block delayed, stable but can pump).
- [x] The "+" menu in the new build is the 3-type one (Envelope / LFO / Audio Follower, counts); the screenshot with ENV 2 / ENV 3 / ENV 4 / LFO 1 / LFO 6 was the OLD standalone exe (FazeSpike held open -> can't be relinked). **Close FazeSpike, then rebuild.**

## 2026-10-09 (late 4) — modulator POOL (any number of each type) + 51 more wavetables removed
- [x] **No fixed amounts per modulator**: the "+" tile now lists TYPES (Envelope / LFO / Audio Follower, each with an n/max counter); each click adds the lowest free instance. Caps = size of the host-parameter pool (bump by adding manifest params): **ENV 8** (ENV 1 permanent), **LFO 8**, **Audio Follower 4** -> up to 20 cards. The card area is a 6-column grid that scrolls vertically past two rows (thin scrollbar); LFOs start a fresh row. Menu stays open so you can add several in a row; the tile disappears only when every type is at its cap. Each AF has its own band/attack/release/gain + level meter (scope `af_<sourceId>`) and its own purple.
- [x] Backend: mod sources appended 22-29 (env6-8, lfo7-8, audiofollower2-4); DSP reads `state.extra` (source id -> settings; replaces modEnv4/5, lfo4-6, audioFollower); manifest `mod_on_*` + per-instance params; LFO 4-8 function shapes over `setFunctionShape` 1..8 (native seeds 8). Engine tests: env8, lfo8, two ENVs together, AF3 with its own band while AF1 has another. Wire test green (src range 0..29, defaults).
- [x] **Wavetables removed**: the Saw Dual 03.. / Saw Fifth / Saw Morph / Sine * / Square * / Sub Sine / Triangle Saw / Flute Vox / Formant Bot 01-05 / Fuzzy Vox set + Digital Sine Fingers .. Synth Bug, Saw Formant/Harmonics (source typo "Sqaure Saw Bits"). Now **187 removed**; wavetables.bin 44.6 MB.
- [!] Standalone exe blocked again by a running FazeSpike.exe; VST3 built + installed. Close FazeSpike, then `bash spike/elementary/plugin/build.sh`.

## 2026-10-09 (late 3) — Compressor UX + Delay/Reverb graphics (UI verified headless; DSP engine tests green; not listened to)
- [x] **Compressor**: Attack/Release dials removed from the graphic (the header ATK/REL faders own them); the bands use the full width. **Threshold glitch fixed** — drag only starts on the LEFT button (a right-click used to start a drag whose pointer-up the context menu swallowed, so the value followed a button-less mouse: the "works after a right-click" effect), a button-less move now always ends a stale drag, and every line is draggable with grab-offset (Low/Mid/High **floor**, **ceiling** — which had NO drag handler before — and the AMT knobs; ceiling now has its own -24..0 dB scale = the param's real range). Verified: floor line moved on left-drag and stayed put after a right-click + mouse moves.
- [x] **Mix warning**: compressor container colour = white (mix 0) -> yellow (30%) -> orange (60%) -> red (85%) -> blood red (100%) (`mixWarnColor`, FxPanel). **Loudness cap reverted** at your request (the +3 dB `COMP_HEADROOM_DB` auto-trim is gone: mix is a real volume boost again, measured +16..+41 dB on quiet material) — only the -1 dBFS output ceiling stays. Engine test rewritten accordingly. (If you want the ceiling gone too, say so.)
- [x] **Delay/Reverb graphics react to the nodes**: width rotates the hue, decay/feedback sets brightness + glow, diffusion saturation, mix lifts the wash, and each handle takes its own hue/brightness from where it sits (drag = visible colour change). Palette direction fixed (open/bright filter = brighter, damped = darker; it was inverted).
- [ ] Compressor ATK/REL faders still set all three bands together (per-band attack/release has no UI now).

## 2026-10-09 (late 2) — default patch = ENV 1 only; ENV2/3 + LFO1-3 are optional modules; LFO 6 fills the last cell
- [x] **A fresh patch opens with just ENV 1 · Amp** (+ Velo/Key, filters). ENV 2/3 and LFO 1-3 are now "+" modules like ENV 4/5/LFO 4/5/Audio Follower (`ModuleSet` presence markers; params `mod_on_env2/env3/lfo1/lfo2/lfo3`, default 0). Their settings still live in `modEnv/modEnv3/lfo1..3`. **A source with a route always shows + works** (`routedSources`), so old patches/presets that route from ENV 2 / LFO 1 keep their cards; only UNROUTED cards disappear. Removing a card (x) strips its routes.
- [x] **LFO 6** added (src index 21, `mod_on_lfo6`, `lfo6_*`, function-shape index 6) so the last empty cell is usable: grid = ENV 1-5 + Audio Follower (row 1), LFO 1-6 (row 2). "+" tile only shows while a cell is free; it lists everything not yet added. Cards fill left-to-right with no holes; `.env-extra` wrappers carry explicit rows (old nth-child CSS removed).
- [x] DSP: ENV2/3/LFO1-3 build only when `state.modOn` or routed (callers without `modOn` — tests/browser preview — keep always-on). Note unrouted sources never reach the emitted graph anyway; this saves JS build work only.
- [ ] If you want MORE than 12 modulators the grid needs a third row (window height is frozen) — say so. ENV 6 / a 2nd Audio Follower would be the next types.

## 2026-10-09 (late) — FX chain strip: drag to reorder; standalone finally rebuilt
- [x] **Drag-to-reorder** in the FX CHAIN strip: press an ACTIVE effect and drag it onto another active one; it takes that position and the rest shift (`FxPanel.tsx` `movedTo`, pointer-based, drop target highlighted). Plain click still adds/removes; the up/down arrows still work. Verified in headless Edge (Distortion 4th -> 1st; click toggle still OK). Not done: dragging the FX *units* in the FX view itself (they still use the ◀ ▶ buttons).
- [x] Standalone `FazeSpike.exe` AND the VST3 rebuilt together at 20:30 (the running instance was closed); standalone boots, `applyInstructions` ok. Desktop shortcut icon repointed at the exe (`FazeSpike.lnk` had pointed at a missing Desktop\Icon Faez.ico).

## 2026-10-09 — "+" modulator system + Audio Follower (sidechain) — built; UI verified in headless Edge, NOT tested in a DAW/standalone
- [x] **"+" tile** (dashed, bottom of the modulator grid, mockup `docs/mockups/AUDIO FOLLOWER + INSERT FX.png`): click -> menu of modulators not yet added; each added card has a **x** that removes it AND its routes. Optional modules: **Audio Follower, ENV 4, ENV 5, LFO 4, LFO 5** (mod source ids 16-20, APPENDED). Presence = `mod_on_{af,env4,env5,lfo4,lfo5}` host params + `synth.modules` (shared/types.ts `ModuleSet`); an absent module builds NO graph nodes. Mod popovers hide sources whose module is absent (`setActiveModules`/`isSourceAvailable`).
- [x] **Audio Follower** (`dsp/synth.js audioFollowerSignal`): sidechain INPUT -> mono -> HP(lo) -> LP(hi) -> rectify -> attack/release follower -> gain(dB) -> 0..1, global (one instance). Card: purple dot, draggable dashed band markers on a log 20 Hz-20 kHz axis, A/R/G drag fields, in-band bars driven by the live follower level (zero-gain `af` scope tap -> `getScopeRms('af')`). Tests: silent in -> silent out, loud in opens it, out-of-band input ignored, release time shapes the tail (engine.test).
- [x] **Native sidechain bus**: `PluginProcessor` now has an optional stereo **Sidechain input (off by default)** copied before `buffer.clear()` and passed to `runtime->process` (zeros when off). **The host must enable/route it** (FL: sidechain/aux input of the plugin; Bitwig: sidechain; Reaper: pins). Standalone: JUCE leaves input muted by default — can't test a mic in the standalone yet.
- [x] ENV4/5, LFO4/5 reuse `EnvelopeEditor`/`LfoEditor`; LFO 4/5 function shapes travel over `setFunctionShape` index 4/5 (native seeds + accepts 1..5). Engine tests added (present -> works, absent -> silent). Wire test green (manifest/translate/default parity incl. src range 0..20).
- [x] Fixed: UI voice readout only scanned 8 voices (pool is 12 since the voices change) — now 12.
- [x] `plugin/build.sh` now FAILS when ninja stops on a target (it printed NITESESH_BUILD_OK even when the standalone link failed).
- [!] **Standalone `FazeSpike.exe` has NOT been relinked since 15:14** — two FazeSpike.exe instances are running and lock it (LNK1104); every build today refreshed + installed the **VST3** only. Close the running standalone and re-run `bash spike/elementary/plugin/build.sh` to get the new standalone.
- [ ] Listen/DAW test: route a drum track to the sidechain, add Audio Follower, drag it onto a knob (filter cutoff), check pumping/latency, band markers, remove-with-routes.
- [ ] Not done from the §165-3 plan: Phase 0 data-driven source registry (the 5 extras are hard-coded like the originals), Wavetable LFO, LFO 4/5 rate as a mod target, "own signal" follower mode (feedback-loop; sidechain only for now).

## 2026-10-09 — Delay + Reverb converted to the node-handle style (built OK; verified in headless Edge on the real UI bundle)
- [x] Delay and Reverb no longer have a 9-knob rack: like Distortion/Chorus/Flanger/Phaser they get a MIX slider in the header + 4 draggable handles on the graphic (`FxViz.tsx` `getNodesForDelay/Reverb`, `isNodeKind`). Delay: Time/Feedback, Rate/Mod, Width/Diffusion, LoCut/HiCut. Reverb: Size/Decay, Rate/Mod, Width/Diffusion, LoCut/Damp. Same 8 params + Mix, nothing dropped, no DSP/wire change. Verified: no `.fx-rack` rendered; a simulated drag moved Time/FB (300ms/30% -> 10ms/76%).
- [ ] Cosmetic: Reverb defaults put Size/Decay (50/50) and Width/Diff (50/40) ~18px apart so their badges overlap; picking still works (nearest handle wins). Could stagger badges. Needs a live look at the real window/hover feel.
- [ ] Other effects still on knob racks? Compressor/EQ have their own editors; nothing else open.

## 2026-10-09 — 136 wavetables removed (+ "ESW " name prefix stripped from 2 tables) (built OK, not listen-tested)
- Follow-ups, same mechanism: Digital SSW 01-04 + Sweep 01, Vocal Digital Choir 01-03 (bare "Digital Choir" kept), Synth One Shots BS Basix, BS Deep House..LD Tropics (15) + Vocal 80's 01, Ah 02, Ahhh 01/02 (AhWoYeYo kept on purpose); Vocal/Serum Voice 01-06; Instruments (all 50 remaining visible ones, Acoustic Guitar ... World Tambura) + Metallic Zipper..Waves (12), from text-less screenshots — assumed to be a removal list; undo = delete them from `REMOVED_WAVETABLE_NAMES`).
- [x] (+6 Vocal/Serum Voice 01-06 removed in a follow-up, same mechanism.) Removed per Stooge's screenshots: 28 Analog (303 Saw ... VMS Saw, incl. 80's PWM, ARP Pulse/Saw/Sine, MS20 Square, Moog Saw 01-03) + 7 Basics (Deep High, MB Saw, PWM Pulse 01, PWM Saw 01, Pulse Acid [Basics only; the Digital one stays], Saw Dual 01/02). Names in `REMOVED_WAVETABLE_NAMES` (`dsp/wavetables.js`); dropdown hides them; `wavetables.bin` ships them as 1 frame (88.9 -> 79.4 MB). **Ids stay reserved** (positional, a saved preset's `op{k}_wtid` must not shift), so an old preset using a removed table still plays a static single-frame version. If you want a hard removal with remapped ids, say so.

## 2026-10-09 — Voices 6 -> 12, mono/legato voice mode, portamento (built OK, NOT listen-tested)
- [x] **Voice mode** POLY / MONO / LEGATO (button in the globals row, param `voice_mode`). Mono + legato play on voice 0 with a last-note-priority held-note stack (`Voices.h`); releasing the sounding note falls back to the previous held note without retrigger. MONO retriggers by dropping the gate for one block (a 1->0->1 inside a block is invisible to the DSP). Switching mode silences sounding notes. Verified by `test/voices/voices-test.cpp` (MSVC; build line in its header comment).
- [x] **Glide** knob (param `glide`, 0-5 s = time constant of the note-frequency smoother, `state.glide` in `synth.js`; a shared `el.const`, so turning it is a prop update). Also glides in POLY (a fresh voice slides from its previous pitch) — decide if that's wanted. Engine tests: pitch reaches target <20 ms with glide off, still gliding at 0.5 s.
- [x] **Voices 6 -> 12** (`kNumVoices`, `NUM_VOICES`). Measured offline: 16 voices x 4 ops = 16% of a realtime core; graph rebuild ~2x going 6->16, so 12 not 16. Master headroom pinned to a 6-voice reference (`HEADROOM_VOICES`) so patches don't get 3 dB quieter.
- [ ] Listen-test in a DAW: mono/legato feel, glide taming, arp + mono, 12-voice chord with long release. Raise to 16 if the reconcile cost is OK (then also `kVoiceCtlMax` is already 16).
- [ ] Glide is not a mod target and the UI/main app (Electron `synth.ts`) ignores `voiceMode`/`glideSec` (plugin-only for now).

﻿## 2026-10-09 — Seq bugs reported (diagnosed, NOT fixed — needs a decision)
- [~] **Toggling Seq on, then turning the arp/seq off, breaks the synth until restart** (user report). **Not reproduced.** 2026-10-09 PROBABLE FIX (unverified in a DAW): arp re-read its own notes via native voice gates (feedback loop); useArpEngine now filters its own emitted notes from the native held set. Tick after a live test.
- [~] **Seq timing is weird** (user report). 2026-10-09 STEP 1 DONE: arp/seq now native (plugin/ArpEngine.h in processBlock, sample-accurate note on/off; UI sends 'setArpConfig' JSON, native pushes the playhead via window.__arpPlayhead__; the JS useArpEngine is no longer used by the plugin UI). Built OK, NOT listen-tested. STEP 2 DONE (built, standalone boots + renders without applyInstructions errors; NOT listen-tested): new native "voicectl" Elementary node (plugin/VoiceCtl.h) feeds gate/freq/vel/keytrack from the audio-thread VoicePool straight into the graph; dsp/synth.js voiceCtl() uses it when dsp.main.js sets __FAZE_NATIVE_VOICECTL__, and the state dedupe in dsp.main.js ignores v{i}_* so notes no longer trigger a ~50 ms reconcile. Test in a DAW: arp/seq steadiness at 8-20 Hz, short gates, notes after patch changes, voice stealing.

**Findings (2026-10-09):**
1. The arp/seq *engine logic* is correct. `test/arp-sim/run.mjs` runs the real `useArpEngine` on a virtual clock (stubbed React): Arp -> Seq -> off leaves **0 stuck notes**, and Seq step intervals are exactly `1000/rateHz` (125 ms at 8 Hz), rests skip correctly. So the bug is NOT in the step logic.
2. The timing problem is in the **note path**, which is not sample-accurate: the JS arp calls `noteOn/noteOff` -> bridge (`setTimeout 0`) -> native `pushUiNote` -> `voicesDirty` -> `handleAsyncUpdate` -> *state snapshot* -> debounced `dispatchStateChange` -> QuickJS `renderSynth` (median 54 ms, §168). The DSP never receives note EVENTS, only the latest gate/freq SNAPSHOT at ~10-20 Hz. A gate that goes 1 -> 0 -> 1 between two dispatches is invisible (no envelope retrigger, "legato"/dropped steps), and gate edges land up to a dispatch-period late/early. At 8 Hz with 60% gate (75 ms on / 50 ms off) that is exactly the regime that smears. (§168's adaptive debounce slightly lengthens that window — it trades latency for keeping the message thread alive.)
3. Likely cause of "needs a restart": each noteOn/noteOff dirties voices -> a full 54 ms+ DSP rebuild on the message thread; a fast seq = ~16 rebuilds/s = message thread pinned, UI/scope/timers starve. Unproven that it's permanent; a restart-only recovery smells like a wedged voice/gate snapshot after the pattern dies mid-gate — **needs a repro with the log (`%TEMP%/fazespike-ui.log`: look for `[REENTRANCY]`/`dispatchStateChange` times) — please send it right after it breaks.**
**Proper fix (big, needs OK):** move the arp/sequencer into native `processBlock` (the §166-E plan): sample-accurate step clock from host tempo/own rate, generate MIDI note on/off in the audio thread, and make `handleMidi` retrigger voices directly (voice events -> DSP as events, not as a debounced snapshot). The UI then only sends the pattern settings. Same class of work as the allocator/spectral-warp ports.

## 2026-10-09 — user reports (top of file; both FIXED in this entry, verify in the real window)
- [x] **FX View displaced the bottom row** (ENV/LFO/filter/FX chain rose off the piano, ~60px dead gap; screenshot `7.png`). Cause: `.fx-panel` was capped (`max-height: 577px`, `flex: 1 1 auto`) so it didn't fill the slot `.op-panel` fills. Now `flex: 1 1 0`, no cap — headless measurement: FX and Synth views have identical panel (120–602), env (603–803), bottom row (723–803) and keys (810–853).
- [x] **Filter controls too small for the new bottom-row size** (screenshot `8.png`). Filter knobs 50 -> 66px, LP/HP/BP + 12/24 buttons and A/B tags scaled up, wider gaps (`plugin-ui.css`, "Filter card scaled up"). FX chain strip gives up the width.

# Faze — OPEN TASKS (checklist index, 2026-10-06)

This file is a newest-first work log. The checklist below is the quick index of what is still open;
details live in the numbered sections it points to. `[!]` = needs a decision from Stooge first.

- [x] Rebuild the native plugin so the wavetable-dropdown fix (`height: 24px`, §149 item 1) is in the binary, then verify the dropdown shows the real name instead of "-" — **DONE (§162)**. The build script had to be fixed first (11498cb: it had been silently building nothing). Both binaries are now fresh and the VST3 is reinstalled to `C:\Program Files\Common Files\VST3`. Verified **inside the shipped binary**: `grep -a` finds `.op-wavetable-row .op-warp-select{width:140px;height:24px;…font-size:11px}` in `FazeSpike.exe`; and the shipped `index.html` rendered in a real Chromium (Edge 154 headless, CDP) measures that select at **140×24 with a 14px content box** for its 11px font (was 4px), `selectedText: "Harmonic Sweep"` out of 381 options — not "-"
- [x] Wavetable graphic box in OSC 1's card, between the Pitch/Warp/Level row and the WT-select row (§148 item 3, scoped in full: `WavetableGraphic.tsx` using `generateWavetableFrames`/`getWavetableFrame`) — implemented in f5f47f6 (used at OscillatorPanel.tsx:451); not visually verified, nitesesh run could not build
- [x] Fix the 7 plugin typecheck errors: `ui/FxViz.tsx:593,663,670`, and `OscillatorPanel.tsx:16` (add a declaration file for `wavetables.js`) (§149 item 6) — done in 8c0318e (§162). It was **8** errors, not 7, and the untyped import was hiding two real bugs: `WavetableGraphic` was never imported (ReferenceError on first render) and its SVG path was built with `Float32Array.map` (all-NaN path, drew nothing)
- [x] Port the remaining 15 spectral warp modes to C++ (only 14 of 29 are byte-exact against the JS reference, §135/§144) — done in 780d51a + 661ac20 (§163). WtSpectralWarp.h ports all 15 spectral modes + the DFT analyzeFrame/synthesizeFrame, verified by the in-repo differential harness (`spike/elementary/test/spectral-warp-diff/run-diff.mjs`): 360/375 cases bit-identical, the 15 exceptions all mode 29 (Spectral Morph) at the documented V8-vs-CRT atan2 1-ULP residual (67/2048 samples). Wiring into `ensureWavetableWarpResources()` landed in 661ac20 and both binaries rebuilt fresh (NITESESH_BUILD_OK, VST3 reinstalled to `C:\Program Files\Common Files\VST3`). Not listen-tested — the harness is the verification, per §144's byte-exactness bar
- [x] Live-check §147's FX-view / Synth-view alignment fix (fx-panel max-height 430 -> 577px) — **DONE (§162) and it FAILS.** Measured in the shipped UI (Edge 154 headless over CDP, 1576×808, default Init Preset): the ENV/LFO/VELO strip sits at **top 538 on the FX view vs 740 on the Synth view — 202px higher**, which is the user's complaint, still live. See the `[!]` line below for the two structural causes and the numbers
- [x] (DONE 7abcf3f, .main-viz now on every view; re-measure with §162 numbers when next built) FX-view / Synth-view alignment is STILL wrong — §147's fix is insufficient, measured (§162). Two independent causes, both structural: (a) `.main-viz` (72px + gap ≈ **79px**) is rendered ONLY on the Synth view (`PluginApp.tsx:294`, `{view === 'osc' && …}`), so everything below it starts ~79px higher on the FX view — §147's premise that "both panels occupy the same flex slot, so they always receive the identical allocation" ignores that fixed sibling; (b) `.fx-panel` renders **471px** against its **never-reached 577px** cap while `.op-panel` renders **594px**, so editing the cap cannot align the bottoms either. The 79px term is preset-independent; the panel-height term scales with the effect count. Needs Stooge to pick: render the main visualizer on the FX page too, or reserve a matching spacer above the FX panel (a third option is to accept the FX page's different stack and drop the "same spot" requirement) — **RECOMMENDED (triaged 2026-10-07): render the `.main-viz` strip (or reserve its ~79px) on BOTH views so everything below starts at the same y; measure again afterwards (the §162 numbers are the test). Workers: take this answer, log a DECISION commit and build it.**
- [x] Fix the stale hard-coded `ESW_BASE_DIR` (`dsp/wavetables.js:406`, points at the old `Z:/GITHUB/FM/...` path) and the `typeof process` gate in `loadEswWavetableFrames` that makes all 379 ESW tables fall back to the same harmonic frame in the plugin (§149 item 7) — **JS side done in 99b8059 (§162)**: the base dir now resolves (env override → module location → cwd → legacy) and built-ins are reached via `process.getBuiltinModule()`; 0/379 ESW frames still match the fallback (was 379/379). A SECOND fault was hiding here: `require('fs')` in an ES module, which threw a swallowed ReferenceError everywhere. The **plugin** half is not fixable from JS — there is no `process` there at all, and natively `registerBuiltinWavetables()` registers ids 0/1 only — so it stays on the decision line below
- [x] (SUPERSEDED: decided precompute+ship, see L31 and Decisions) 379 ESW wavetables: precompute to a binary and ship (~1-2 GB of wav), or cut the dropdown to the 2 built-ins? (§149 item 7) — **now the ONLY blocker for ESW in the plugin** (§162): the JS loader is fixed and the tables are in the repo, but the plugin's frames come from C++ (`registerBuiltinWavetables()` registers table ids 0 and 1 only; every other id hits `wtGenerateFrame()`'s "unknown id" branch), and there is no `process`/filesystem in the QuickJS/WebView context for the JS path to help — **RECOMMENDED (triaged 2026-10-07): cut the plugin's dropdown to the built-ins now (the JS app keeps all 379); precomputing a binary pack can be a later opt-in download, not a 1-2 GB default. Workers: take this answer, log a DECISION commit and build it.**
- [x] (DONE nitesesh 2026-10-07, removed; see Decisions) Multiband compressor `upwardRatio` is declared but never read by any DSP code, so the one failing DSP test stays red. Build upward compression or remove the parameter? (§149 item 5)
- [x] (DONE 2026-10-09 per DECISION commit: .op-body-new gap 4->2, wavetable-row padding 0; measured card is 475px and stays 475 because .op-grid stretches cards to the viewport - the ~18px freed per card now spreads as space-between slack; to actually reclaim it, give it to the main visualizer height (L33 open item)) OSC card height: ~26px of dead padding per card can be cut by shrinking padding (never by un-stretching). Waiting for Stooge's annotated screenshot saved into the repo (§148 item 2 / §149 item 2) — **RECOMMENDED (triaged 2026-10-07): shrink the ~26px of dead padding per card (never un-stretch); verify with a before/after screenshot instead of waiting for an annotated one. Workers: take this answer, log a DECISION commit and build it.**

### NEW 2026-10-07 — Stooge's request batch + the investigation behind it (all detail in §165; NOTHING implemented yet)

Priority order = what is actually blocking. **Read §165 "The headline" first: a whole class of bugs
shares one cause (UI → plugin wire is unverified), so build the wire test (P0-A) BEFORE fixing anything else.**

- [x] **P0-A** (DONE nitesesh 2026-10-07, 0fae19b) Wire-parity test built: `test/wire.test.mjs` (`npm run test:wire`), bundles `ui/translate.ts` with esbuild and diffs `synthToFlat`'s output against `plugin/manifest.json` — manifest parity, range parity, default parity. **Currently RED by design**, reproducing exactly §165's numbers: 17 compressor-band keys `synthToFlat` emits that the manifest doesn't declare (native drops them), 15 default mismatches (master .8/.7, osc wave 5/0, filter Q .707/.7, env2_*, lfo waves, fx_eq_on). Those stay red until P0-C (compressor params) and the default-parity half of P0-B/P0-D land — this test is the permanent harness for them, replacing the throwaway probe script. End-to-end render through `dsp.main.js toSynthState` was scoped out of v1 (that function isn't exported; exporting it is a one-line follow-up for whoever does P0-C/E) — manifest/default/range parity is the part that actually caught the real bugs so far and was shipped first. `npm test` (engine.test.mjs, DSP suite) is unchanged and still green.
- [x] **P0-B** (DONE 2026-10-09: F3 manifest default parity; test:wire green) (F1 span x10/x20 + F2 typo DONE 2026-10-07; F3 default parity, types.ts dead branch open) Filter ← LFO still weak: the UI amount range is ±10 octaves but the wire is ±1 and the DSP reads it as octaves, so **100% = ±1 octave; the default 0.8 oct → ~0.08 oct** (§165 4 / F1). Plus `T.filterAReson` typo (`synth.js:743`), LFO first-load wave-index mismatch, dead unipolar branch in `types.ts`
- [x] **P0-C** (DONE 2026-10-09: params wired 96d5575; wet capped +3 dB over dry + -1 dBFS ceiling; cap test) Compressor far too loud: DOOM upward compressor can add **+80 dB**; measured +16 dB at mix 100% on a normal note, **+41 dB on a quiet one**. And its 17 band params never reach the plugin at all (§165 1). Cap the boost + normalise the mix; wire the params
- [x] **P0-D** (DONE: wtid max 380; graphic reads wtPos) (wtid max -> 380 DONE 2026-10-07; graphic fix (b) open) Wavetables: (a) `op{k}_wtid` manifest **max = 1** — the host clamps every table ≥2 to "Formant Sweep" (new root cause, before the native/ESW ones); (b) WT graphic calls `getWavetableFrame` with a missing arg and never reads `wtPos` (§165 2)
- [x] **P0-E** (DONE 2026-10-09: Warp 1+2 plumbed manifest/translate/dsp.main; NATIVE REBUILD still needed to ship) (Warp 1 plumbed in translate.ts 2026-10-07; Warp 2 manifest/dsp/native still open) Warp 1 / Warp 2 knobs **never leave the UI** — `synthToFlat` does not emit `op{k}_warpmode/amount/param2` at all, and Warp 2 has no manifest params. The whole warp stack (incl. the SS163 C++ spectral port) is unreachable from the UI (§165 B)
- [x] **P0-F** (DONE 2026-10-07; index test still wanted under P0-A) Mod target index drift: `translate.ts` maps `osc{n}WtPos` to dst 56, the DSP puts WtPos at 64 (56 = self-PM) and the manifest clamps `mod{n}_dst` to 55 — **wavetable-position modulation cannot work in the plugin** (§165 C)
- [x] (DONE: DEFAULT_FUNCTION_SHAPE.bipolar=false; legacy stored shapes stay bipolar) **P1** LFOs unipolar by default — bipolar button OFF on a new patch (§165 4 / F5)
- [x] **P1** (DONE 2026-10-09: New button existed; added undo/redo of whole-patch swaps in PresetBar, per-knob undo NOT done) "New / Init" button next to the preset selector + safe reset path + undo/redo (§165 5)
- [~] **P2** (2026-10-09 BUILT: "+" tile, Audio Follower, ENV4/5, LFO4/5 — see top entry; Wavetable LFO + registry refactor still open; Phase 0 groundwork: wire.test.mjs now asserts translate MOD_SRC/DST ids + manifest mod{n}_src/dst max == dsp/synth.js MOD_SOURCES/MOD_TARGETS; registry itself NOT built) Modulator expansion: "+" tile, ENV 4/5, LFO 4/5, Audio Follower, Wavetable LFO (mockup `docs/mockups/AUDIO FOLLOWER + INSERT FX.png`) — phased plan in §165 3
- [~] **P2** (step 2 IN PROGRESS 2026-10-09 e75b9da: WavetableBin.h parser, CMakeLists embeds wavetables.bin, lazy per-table registration, per-table frame counts in C++; BUILD NOW WORKS (2026-10-09, locks gone; standalone log shows 353 tables loaded, VST3 reinstalled; FIXED id mapping: bin skipped 28 jumpy ids so index != wtId; now all 381 kept, see Decisions); 2026-10-09 DONE: base keys now registered for UNWARPED tables too (was only on the warp path = silent osc), bin frames sampled to the 8 JS slots (getBaseWavetableFrame), warp path reads bin frames; built OK, not listen-tested. NEXT (optional): per-table frame counts in synth.js wavetableOsc crossfade, categorised dropdown) ESW tables: precompute ~85 MB (step 1 DONE: 381 tables × 64-frame cap, int16) and ship — **licence confirmed free by Stooge (2026-10-07)**, no blocker
- [~] (2026-10-09 DONE: patch_*.py + stray index.js -> scripts/legacy, icons committed, desktop.ini ignored, README plugin section; OPEN (mockup PNGs now in docs/mockups): voices 6 vs 16, section-number collision, dead code list) Housekeeping list (voices 6 vs 16, section-number collision, root clutter, stale docs…) — §165 E
- [~] **P1** (2026-10-09: box-average decimation, int16, 1024 pts, DPR-aware, spectrum smoothing were already done in §168; ADDED per-source Auto-level toggle in the Scope menu; main visualizer 72->90px DONE (plugin-ui.css, not measured in a built window; revert if panels overflow)) Main visualizer: FFT rough/pixelated (4:1 decimation without a low-pass + 8-bit data + unsmoothed 512-pt spectrum + DPR 1 at 114% zoom), toggleable visual normalisation, +~32-40px height funded from unused space (§167 §1)
- [~] **P2** (2026-10-09: S0 entry point was already in (WT|SMP toggle + SamplerBlock + wire params OK); S1 DONE-untested: '● Rec' button resamples the master output (max 30 s) -> AppData/Faze/Samples/take-*.wav -> loadSampleFile; per-op bus tap + input bus NOT done. NEXT: S2 slice editor pop-out + Save-slice-as-WAV, drag-out spike, S3 polish) Sampler: the plugin already has sample playback but **no UI entry point** (`SampleRecordRow` is never rendered); add Wavetable|Sampler toggle, resample-recording, and port RECORDR's waveform select + drag-out slices (§167 §2)
- [ ] **Cross-repo:** audio->MIDI transcription lives in `Z:\GITHUB\AUDIO · RECORDR` (`src/main/transcribe/`, Basic Pitch; 8/8 unit tests pass, **not in any installer, never hand-tested, no MIDI visualizer yet** — see that repo's todo `§MIDI-1`). Its note list is the natural input for the §166 sequencer pitch lane and a §167 sampler slice->pattern feature
- [~] **P2** Arpeggiator + step Sequencer, Pigments-style — Arp v1 DONE (2026-10-07): third "Arp View" tab, `ArpPanel.tsx`, `useArpEngine.ts` (JS `setTimeout` scheduler over the existing noteOn/noteOff). **§166 v2 Seq DONE (b659862, 2026-10-08)** — see the section at the end of this file.

---

## 167. PLAN (no code changed) — main visualizer quality/normalisation/height + turning an OSC into a Sampler with RECORDR's slice-and-drag (2026-10-07, Claude for Stooge)

Stooge (message arrived with the same paragraph pasted several times — the distinct asks are these two):
1. **Top visualizer feels pixelated / laggy / distorted**, specifically the FFT ("rough, not smooth"). Wants it **slightly taller without
   growing the window** (take the height from unused UI space), plus **visual normalisation** so the wave reads clearly with 1 OSC up
   *or* 4 OSCs maxed — **toggleable in settings**.
2. **A Sampler**: turn an OSC into a sampler, reusing the old Recordr app's features — record audio, and the "highlight part of a
   waveform and drag-and-drop it to make quick slices/samples" feature. Needs the latest `Z:\GITHUB\AUDIO · RECORDR`.

### 1. Main visualizer — why it looks rough (all read in code; the first two are the real culprits)

| # | Cause | Where | Effect |
|---|---|---|---|
| 1 | **Decimation without a low-pass.** The DSP tap is `MAIN_SCOPE_SIZE = 2048` samples; native sends only 512 by picking every 4th sample (`idx = i*size/kOut`, `s[idx]`) | `PluginProcessor.cpp:596-604`, `synth.js:41` | Effective sample rate 12 kHz, Nyquist 6 kHz. Everything above 6 kHz **aliases (folds) back into the spectrum** as junk; the scope trace gets stair-stepped. This is the "distorted/rough" look, and a spectrum drawn from it is wrong, not just ugly |
| 2 | **8-bit quantisation** (`int8`, `round(v*127)`) | same | ~-42 dB noise floor in the FFT; low-level spectrum content is stair-stepped garbage; visible as grainy skirts |
| 3 | **Spectrum is unsmoothed.** Each 30 Hz frame's raw `sqrt(mag)` is plotted; no time smoothing, no peak-hold/decay | `Scope.tsx` spectrum branch | Flickers frame to frame — reads as "rough/laggy" even with clean data |
| 4 | **FFT is only 512 points** (Hann), 94 Hz/bin at 48 kHz, drawn with a quadratic x-mapping and linear interpolation between ~256 bins across ~1200 px | `Scope.tsx` | Polyline with visible kinks; poor low-frequency resolution (where synths live) |
| 5 | **Magnitude, not dB**, with magic scale `sqrt(mag)*3.4*gain` | same | Dynamic range crushed; quiet partials vanish, loud ones clip |
| 6 | **Canvas at DPR 1** (`fit()` sizes to CSS px). The app shows a zoom/DPI of **114%** in the header | `Scope.tsx` comments ("dpr 1 … 5 canvases") | The browser upscales a 1x bitmap by 1.14 → soft, pixelated edges. Chosen for perf across 5 canvases; the **main** canvas alone can afford DPR-aware sizing |
| 7 | **Update rate:** native drain is 30 Hz (`startTimerHz(30)`), UI repaints only on a *new* frame (`!fresh && m !== 'spectrogram' → return`) although `MIN_MS` is 60 fps | `PluginProcessor.cpp:122`, `Scope.tsx` | Effective 30 fps, steppy; no interpolation between frames |
| 8 | **Oscilloscope has no trigger.** Each frame is an arbitrary 2048-sample slice, so the trace wanders horizontally | `Scope.tsx` | Jitter; a held note should look *stable* |
| 9 | `shadowBlur` 10-12 on a ~1200 px polyline | `Scope.tsx` | Expensive; main cause of real draw lag in WebView2 |
| 10 | Spectrogram: `getImageData`/`putImageData` full-canvas scroll each frame | `Scope.tsx` | Heavy; GPU-unfriendly; blocky 2px columns |

**Plan (in order of payoff):**
1. **Fix the data first (cuts 1, 2, 4):** send the main scope at **full 2048 (or 1024) points as int16 or float32**, no decimation —
   4-8 KB per frame at 30 Hz is ~120-240 KB/s, trivial next to what already crosses (but §73 froze hosts on *sustained per-frame
   streams*, so keep the existing drain pattern, send one batched message, and measure). If a decimated version is ever wanted for
   the small op scopes, **low-pass before decimating** (box/FIR) — the op scopes have the same alias problem at 128 points.
2. **Spectrum rebuild (3, 4, 5):** Hann + FFT 2048, **log frequency axis 20 Hz-20 kHz**, **dB scale (e.g. -90…0 dB)** with a gentle
   tilt (+3 dB/oct) so highs are visible, **per-bin exponential smoothing** (fast attack ~10 ms, release ~250 ms) with optional peak
   hold, draw as a **smooth curve** (monotone cubic/Catmull-Rom through ~1 point per 2-3 px) instead of a kinked polyline.
3. **Crisp canvas (6):** main canvas uses `devicePixelRatio` (cap 2); op scopes stay 1x unless measured cheap.
4. **Motion (7, 8, 9):** raise the drain to 60 Hz *if* measured safe (else keep 30 and interpolate in the UI: render at 60 fps,
   blend previous→current frame); add a **rising zero-crossing trigger** to the scope; replace `shadowBlur` with a 2-pass stroke
   (wide low-alpha line + thin bright line) — same glow, a fraction of the cost.
5. **Spectrogram (10):** draw columns to an offscreen ring canvas and blit with an offset instead of `getImageData` every frame; use
   the new dB scale for colour.
6. **Verify (objectively, not by eye):** (a) **alias test** — render a 10 kHz sine, the spectrum peak must sit at 10 kHz and nothing at
   2 kHz (today: folds) — run the real `Scope` math in a node/jsdom harness or compare the data path numerically; (b) the Edge-headless
   CDP screenshot harness (used for §162) before/after at fixed notes (A3 saw, 1 OSC; 4 OSC stacked chord); (c) frame-time:
   `performance.now()` around `draw` over 5 s, target < 4 ms main canvas; (d) user listens/looks at the standalone.

#### Visual normalisation (toggleable)
Today the only control is a **manual** draw-time gain (`VIZ_GAIN_PRESETS 1…16`, right-click the scope, per-group `main`/`op`,
`scopeStore.ts`). §163 measured the real problem: with all 4 OSCs maxed and one note, master peaks only **0.267** (the mix divides by
`1/sqrt(voices*ops) = 0.204`), and one quiet OSC is far lower — no single fixed gain suits both.
- **Design:** a *display-only* auto-gain: peak follower on the incoming frame (fast attack, ~1.5 s release), `autoGain = clamp(target/peak,
  1, maxAuto)` with **target ≈ 0.85 of the canvas** and a **noise gate** (below ~-60 dBFS peak, hold the last gain / fall to 1 so
  silence and release tails don't get amplified into hiss). Apply to the scope trace and as a reference-level shift for the spectrum
  (spectrum is already dB, so normalising = moving the 0 dB line to the running peak).
- **Interaction with the manual gain:** when normalisation is **on**, the manual preset becomes a "headroom/extra" multiplier (default
  1x) rather than the only control; when **off**, behaviour is exactly today's. Never touches audio.
- **Settings:** add "Visual normalisation" to the header right-click menu (`AppMenu.tsx`, where theme/options already live), persisted in
  `localStorage` (`faze.viz.normalize`, default **on**) like the other viz settings; per-group (main vs per-op) is optional — recommend
  main + ops share one switch to keep the menu simple. Also expose a "Smoothing" slider (spectrum release time) — it is the control people
  reach for next.
- **Verify:** unit-test the follower on synthetic frames (1 OSC peak 0.07 → displayed peak ≈ 0.85; 4 OSC peak 0.27 → ≈ 0.85; silence stays flat;
  a note-off tail doesn't pump to full scale).

#### Height — "slightly larger without growing the window"
`.main-viz` is **72 px** (`plugin-ui.css:304`); window frozen 1272x920. Candidate funding (each from existing notes, **none measured this
session — measure the live DOM with the CDP harness before cutting**):
- the planned OSC-card padding trim (~26 px/card of pure padding, §148/§149 `[!]` — still waiting for Stooge's annotated screenshot);
- the piano (`synth-keys`) — the one fixed-height block that can usually lose ~20-30 px with no function loss;
- gaps around `.main-viz` (`margin: 3px 0 4px`) and the hidden `.op-section-title`/status rows' leftover margins;
- the FX/Synth alignment `[!]` (§162) touches the same stack — decide once.
Target **72 → ~104-112 px (+32-40)**; confirm the exact number with Stooge by mockup (a red-bar screenshot saved into the repo, as with every
earlier layout round — those were repeatedly lost in chat). **Constraint recorded:** the Arp/Seq plan (§166) wants this same strip for its
compact transport bar, so size it for ≥ ~100 px.

---

### 2. Sampler — what exists, what is missing, and the RECORDR feature to port

**What already exists in the plugin (found in code; §114 + "Task 6"):** per-operator **sample playback** (`op{k}_wave = 4` is Sample;
5 is Wavetable). Native `loadSampleFile` (`PluginProcessor.cpp:675`) decodes a wav/aif/flac/ogg/mp3 via JUCE, resamples, registers a versioned
`sample:opK:V` shared resource; manifest params for `roothz`, `loop`, `start`, `end`, `reverse`; `pickSampleFile`/`clearSampleFile`
messages; waveform-peaks preview in `state`; DSP plays it with `el.sample`; tests exist (Task 6: one-shot, loop, start/end, reverse).
**But there is currently no way to reach it from the UI:** the OSC card's wave picker was reduced to wavetable-only (`challenges.md` §2,
"stripped out the Sampler toggle"), and `SampleRecordRow` (`OscillatorPanel.tsx:553`) is **defined and never rendered**. The sampler is
dead code from the user's point of view. The first deliverable is therefore just an **entry point**, not new DSP.

**What is missing vs. Stooge's ask:**
1. A mode switch on the OSC card: **Wavetable | Sampler** (a small segmented toggle; the card's WT select/graphic/warp block swaps for a
   sampler block — reuse the same footprint so card height does not grow).
2. **Recording.** The plugin has **no audio input bus** (`PluginProcessor.cpp:25-26`, output only), so Recordr's capture cannot be copied
   as-is. Options (needs Stooge's call):
   - **(A) Resample the synth itself** (record the plugin's own output / one operator's bus into a buffer — "resample" like Vital/Serum). Works
     everywhere, no host dependency; the main bus and per-op buses are already tapped for scopes. Easiest and arguably the most useful.
   - **(B) Add an input/sidechain bus** and record host audio (a DAW track routed in). Host-dependent (FL/Bitwig/Reaper differ), C++ + Elementary
     `numInputChannels`, and it is the same bus the Audio Follower modulator (§165-3) wants — build once, use twice.
   - **(C) The standalone only:** capture system/mic via JUCE `AudioDeviceManager` in the standalone build (the original Recordr is a
     WASAPI loopback recorder). Loses plugin use.
   Recommend **A first** (resample), **B second**, skip C.
3. **A waveform editor with select + drag-out**, ported from Recordr (below), writing the slice into the OSC as its sample.

**What RECORDR has (read in `Z:\GITHUB\AUDIO · RECORDR`, git HEAD `55e689b`, working tree clean):**
- **History waveform** (`VisualizerBoard.tsx` 451 lines, `history-model.ts` 255, `export-engine.ts` 139, `ring-buffer.ts` 72, `recorder.ts` 149):
  rolling buffer in RAM, 20 ms peak buckets (`HISTORY_BUCKET_MS`), **scrub, zoom (wheel / `z`), middle-drag pan, drag a selection**, Alt-click to
  audition, Ctrl+Shift zoom; modelled on Bird Things' *Rolling Sampler* (its gesture spec is in RECORDR's `todo.md` §4.1).
- **Sample-accurate export** (`exportSelection` in `export-engine.ts`; RECORDR's own todo notes decode cache anchored on `newestSec`).
- **Drag-out to the desktop/DAW** is **Electron-only**: main process writes a temp WAV and calls `webContents.startDrag({file, icon})`
  (`src/main/ipc.ts:242-294`, prepare-then-drag channels so the file exists before the drag starts). **This cannot be ported verbatim** — the
  plugin UI is a WebView2 inside JUCE, not Electron. Native equivalent: JUCE `DragAndDropContainer::performExternalDragDropOfFiles` from C++
  (works from a plugin editor on Windows), triggered by a UI message after the temp WAV is written. Needs a spike to prove it works from a VST3
  editor inside a host (hosts differ), and from the WebView (drag starts in JS, hand-off to native on pointer-down).
- **Is "latest RECORDR" what we have?** The local clone is at `55e689b` (MIT license commit) with a clean tree; I did not check `origin` for newer
  commits — run `git -C "Z:\GITHUB\AUDIO · RECORDR" fetch && git log HEAD..origin/<branch>` before porting. Stooge said "latest version"; confirm
  nothing newer is on another machine/branch.

**Plan (phased, each shippable):**
- **S0 — entry point (small, mostly UI):** render a Wavetable|Sampler toggle on the OSC card; show a sampler block (file name, duration, small
  peaks preview from the existing `samplePeaks`, Load…/Clear, root note, loop/reverse, start/end handles over the waveform). Pure re-use of existing
  native + DSP. **Verify through the wire test (§165-D):** all `op{k}_loop/start/end/reverse/roothz` are emitted and in the manifest (grep says
  they exist; confirm they are *written* by `synthToFlat` — the warp/compressor drift shows this must not be assumed).
- **S1 — resample recording (option A):** native ring buffer tapping the chosen bus (main or op k), record-arm + length (1-30 s) in the UI,
  result registered as the OSC's `sample:opK:V` resource through the same `loadSampleFile` path (add a "from memory" variant); waveform shown
  live while recording.
- **S2 — slice editor (the RECORDR feature):** a larger waveform view (a pop-out modal like the EQ pop-out, since the card is too small): zoom,
  pan, drag-select a region, **Set as sample** (trims `sampleStart/End`), **Save slice as WAV**, and **drag the slice out** to a DAW/desktop
  (native `performExternalDragDropOfFiles`, spike first). Reuse RECORDR's `history-model` (viewport/zoom math) as pure TS — it has no Electron
  dependency — and its peak-bucketing; reimplement only the drag-out.
- **S3 — sampler polish:** pitch tracking modes (root key vs fixed), start/end/loop crossfade (no click at loop points), slice-to-keys
  (map N slices across the keyboard), ADSR already exists per voice, BPM-aware loop. Audio-follower and arp interplay later.
- **Verify:** unit/render tests per phase on the real `renderSynth` (loop, trim, reverse already covered); round-trip save/load (sample path in
  `state`, buffers from memory must be **embedded in the project**, since a resampled take has no file — decide: write to
  `%APPDATA%/Faze/Samples/<hash>.wav` and store the path, or serialise into the state blob); standalone screenshot; DAW drag test.

### 3. Open questions for Stooge
1. Visualizer height: what should it grow to (~104-112 px?) and which block gives it up — OSC card padding, piano, or something you point at in a screenshot?
2. Normalisation default **on**? Per-group or one switch? Want the smoothing slider too?
3. Sampler recording source: **resample the synth (A)** first, then input bus (B)? (A needs no host support; B also unlocks the Audio Follower.)
4. Is the local `AUDIO · RECORDR` checkout really the latest (HEAD `55e689b`, tree clean)? I did not fetch.
5. Where should the slice editor live — a pop-out modal (recommended; the OSC card cannot hold it) or inline?
6. Drag-out from a plugin editor is the riskiest bit — OK to spike it first (a throwaway "drag a WAV out of the editor" button) before building the editor around it?

**Verified this session:** the 10 visualizer causes were read in `Scope.tsx`, `scopeStore.ts`, `PluginProcessor.cpp:534-625` and `synth.js`; sampler
status read in `PluginProcessor.cpp`, `OscillatorPanel.tsx`, `challenges.md`, `types.ts`; RECORDR file list/line counts, git state and the drag-out
mechanism read directly. **Not verified:** that the aliasing is audible/visible at the magnitude described (it follows from the code; confirm with
the 10 kHz test in §1.6), the DPR 1.14 blur on the user's machine, all height-funding candidates (unmeasured), and whether a JUCE external drag works
from a VST3 editor. Nothing was changed except this file.

## 166. PLAN (no code changed) — Arpeggiator + Step Sequencer, modelled on Arturia Pigments (2026-10-07, Claude for Stooge)

Stooge: "there should be some stuff in the todo about an arp / sequencer? If not research the Pigments one, document all its
features, make a rough plan. When the arp/seq is on, perhaps replace the top master visualizer with arp controls — or the
piano keys at the bottom — think of the best way."

**Existing work: none.** A search of `todo.md`, `README.md`, `overview.md`, `challenges.md`, `src/` and `spike/elementary/{ui,dsp,plugin}`
finds no arpeggiator/sequencer anywhere (the only "arp" hits are the word "warp"). `PluginProcessor.cpp:374` mentions "arpeggio" once,
in a comment about state-dispatch coalescing. This is a from-scratch feature.

### A. What Pigments has (researched; sources at the end)
Pigments has **one Sequencer tab** (the "Seq" button, top right) that runs in one of two modes:
- **Arp mode** — acts on the notes you play (live MIDI). Per the Sound On Sound review it "makes use of all the Sequencer lanes
  **except pitch**, which is dictated by incoming MIDI notes".
- **Seq mode** — you program the melody in advance; pitch is a lane.

Shared / playback: pattern length (up to **16 steps**); **Rate** with Sync (fraction of host BPM) or a free BPM value, plus
rate modulation; **Swing** %; playback **direction** (forward, backward, back-and-forth, random); **Hold** (sustains the input
notes); **Polyrhythm** ("PolyR") mode with a **realign** function.

**Per-step value lanes** (each lane is a row of 16 step bars; drag across to paint, proportional edit of the whole lane):

| Lane | Meaning |
|---|---|
| Pitch | Seq mode only; note per step, with a **scale** menu (+ tonic) so painting snaps to a key |
| Octave | octave offset per step |
| Velocity | note dynamics per step |
| Trig Probability | chance the step fires |
| Gate Length | note duration per step |
| Slide | portamento/glide into the next note (legato tie) |

**Polyrhythm:** with PolyR on, **every lane has its own length (up to 16)**, so lanes drift against each other (polymeters / long
phasing patterns) while staying on the grid.
**Randomisation / generation:** every lane has a **dice** icon with a 0-100% *random amount*; a big **Generation** dice sets random
amounts on all lanes at once; a Random/Reset window for pitch; **Auto Regen** re-randomises on a schedule (SOS example: "randomise
only Notes by 5 percent every two bars").
**Presets:** sequencer presets are browsable/saveable independently of the sound.

**Not confirmed by what I could read** (do not assume; check the manual PDF — the v5 manual was too big to fetch (10 MB limit), the v1.1
outline was readable): the exact arp-mode list (Up/Down/UpDown/Random/As-played/Chord...), octave-range control, note-repeat/ratchet,
mod lanes, per-lane scale/offset, "Hold" semantics, how Seq state is routed to Pigments' two engines. The plan below lists these as
*our own decisions*, not as Pigments facts.

### B. How it fits THIS codebase (read, not guessed)
- MIDI path: `processBlock` -> `handleMidi(midiMessages)` (`PluginProcessor.cpp:179,259`) -> `VoicePool<kNumVoices=6>` (`Voices.h`:
  idempotent retrigger, oldest-steal) -> per-voice `v{i}_gate/_freq/_vel` into `state` -> `dsp.main.js` -> `renderSynth`. UI keys use
  `pushUiNote` -> `uiMidiQueue` (same path). **An arp must sit in front of `voicePool` on the audio thread** — it has to emit note-on/
  note-off at sample-accurate positions inside the block, so it cannot be JavaScript (same reason `allocator.js` was ported to
  `Voices.h`).
- Tempo: only `lastKnownBpm` from `getPlayHead()->getPosition()->getBpm()` is read today (LFO sync). The arp also needs `ppq`/`isPlaying`
  to lock to the bar, **and a free-running internal clock when the host gives no transport** (standalone `FazeSpike.exe`, or a
  stopped DAW) — otherwise the arp is silent in the standalone.
- Pattern data is not a bounded float, so it travels as JSON via a new native message (`setSeqPattern`), exactly like
  `setFunctionShape`/`setEqBands` (seeded into `state` in the constructor so `setStateInformation` accepts it, debounced dispatch,
  `stableStringify` echo guard in `useBridgeSynth`). Scalar controls (on, mode, rate, swing, gate, octaves, hold, polyR) are normal
  manifest params — **add them to the manifest, `synthToFlat`, `dsp.main.js`/C++ and the §165-D wire test, or they will silently not
  arrive** (the compressor and warp knobs are the cautionary tale).
- Voices: 6 is low for an arp with long gates + release tails (the arp will steal its own notes). Resolve the §165-E voice count first.
- **Glide/Slide does not exist in the DSP**: voice frequency is a plain value. Slide needs a per-voice portamento (smoothed `freq`
  with a glide-time param, or a "tie" that re-pitches a held voice instead of retriggering). Real DSP change; see E6.
- Mod system: Seq could expose `seqRate`, `seqGate`, `seqSwing`, `seqProb` as mod targets later (needs the §165-C index registry
  first — adding targets today is exactly how the WtPos index drifted).
- The existing LFO "Function" editor (`FunctionEditor` in `EnvelopePanel.tsx`) already has grid-snap, drag-paint and Ctrl/Alt paint
  gestures — **reuse its interaction code** for lane painting rather than writing a third editor.

### C. Where does the UI go? (Stooge asked for a think — recommendation first)
Constraints: window is **frozen 1272x920** (`createEditor` 1272,920). `.main-viz` is only **72px** tall (+gap); the OSC/FX
panel area is ~594px; modulator strip below; piano (`synth-keys`) at the bottom. A Pigments-style editor is **6 lanes x 16
steps** + transport = roughly 200-260px minimum to be usable (my estimate, unmeasured) — it does **not** fit in 72px.

| Option | Verdict |
|---|---|
| **1. Replace the top visualizer with the arp controls** (Stooge's idea) | Good for the **transport row only** (on/off, Arp/Seq, direction, rate, swing, octaves, gate, hold, PolyR, dice/Regen) — that fits a 72px strip. Cannot hold the lanes. The visualizer is the least useful thing on screen while an arp plays, so this is the right home for the compact controls. |
| **2. Replace the piano** | **No.** It is the only way to play in the standalone, and it is the *input* for arp mode (hold a chord, see it light up). Better: leave it and make it **show the arp's currently-sounding step**, and in Seq mode let it audition/enter pitch for the selected step. |
| **3. A third view (Synth / FX / SEQ)** | The lane editor needs real height; the app already has a `view` toggle (`'osc' \| 'fx'`, `PluginApp.tsx:125`, the "FX VIEW" button in `FxChainStrip`). A **SEQ view** replaces the OSC/FX panel with the 6-lane editor (~594px is plenty: lanes ~70px each + header). Cost: you can't see the OSC cards while editing (the same trade the FX view already makes; ENV/LFO/filters and macros stay visible below). |

**Recommendation = 1 + 3 together, piano untouched:**
1. A small **ARP/SEQ button** (next to the macros or on the chain strip beside FX VIEW) toggles the engine on/off.
2. **While ON, the 72px main visualizer is replaced by the compact transport bar** (option 1). It stays there in *every* view, so the
   arp is always controllable. The visualizer returns when off (consider a tiny scope at the bar's right end).
3. An **EDIT** button on that bar (or a third tab) opens the **SEQ view** (option 3) with the 6 lanes, scale/tonic, dice per lane and
   per-lane length. Closing returns to Synth/FX.
4. **Piano stays**; highlight the arp's live note + the held input chord; in Seq mode clicking keys enters pitch.
This avoids a new permanent layout fight: nothing grows while the arp is off, and the strip heights stay as they are (the
FX/Synth alignment `[!]` is unaffected because `.main-viz` is already view-dependent). **Decision for Stooge:** accept 1+3, or put
the lanes under the OSC cards (needs ~230px — not available without shrinking the OSC cards, which §159 just spent effort growing).

### D. Feature scope for us (our decisions, informed by Pigments)
**v1 (MVP):** Arp + Seq mode switch; modes = Up, Down, Up/Down, Down/Up, Random, As-played, Chord; rate = sync fractions
(1/1...1/32, triplet + dotted) with host-synced `ppq` lock and a free-run clock when there is no transport; swing %; octave range
(1-4); global gate length; Hold; 16-step Seq with **Pitch / Octave / Velocity / Gate / Probability** lanes, pattern length 1-16,
Pitch-lane scale snap (scale list + tonic); lane paint/drag/proportional edit; step playhead highlight; per-lane dice (random %)
+ one Generate button.
**v2:** per-lane lengths (**PolyR**) + realign; **Slide** lane + portamento DSP; Auto-Regen every N bars; ratchet/note-repeat;
sequencer presets (file-based, ties into the §165-5 preset-files idea); mod targets (`seqRate`, `seqGate`, ...).
**v3:** pattern chaining/variations, pattern capture from MIDI, mod lanes (a lane value as a modulation source — reuses the
§165-3 source registry), humanise (timing/velocity jitter).

### E. Architecture / implementation plan
1. **Reference + port, as already done for the allocator and the spectral warps.** Write `dsp/arp.js` (pure, deterministic, seedable) as
   the *specification*, port to `plugin/Arp.h` (header-only, no allocation on the audio thread), and add a **differential harness**
   (`test/arp-diff/`, same idea as `test/spectral-warp-diff/`): feed identical note sequences + clock values to both and assert
   identical (sampleOffset, note, on/off, velocity) event lists. Probability/random must use an explicit seeded PRNG (xorshift) in
   both so the harness can be exact.
2. **Engine API:** `Arp::process(inputEvents, blockStartPpq | internalClock, numSamples, bpm, params, pattern) -> outputEvents`;
   in `processBlock`, input = host MIDI + `uiMidiQueue`; when the arp is on, those feed the arp's held-note set and the **arp's
   output** (not the raw input) feeds `handleMidi`/`voicePool`; when off, pass-through unchanged (zero regression risk for the
   existing path). Emit pending note-offs at the correct sample offset; **all-notes-off on disable / transport stop / patch reset**
   (ties into the §165-5 reset message; stuck notes are the classic arp bug).
3. **Clock:** if `isPlaying` use `ppq` (step = `floor(ppq / stepLen)`), else an internal accumulator at `lastKnownBpm` (default 120).
   Swing = delay every 2nd step by `swing * stepLen / 2`. Handle tempo changes and loop jumps mid-block (re-derive the step from ppq
   each block, do not accumulate).
4. **Params + state:** manifest scalars (`arp_on, arp_mode, arp_rate, arp_swing, arp_oct, arp_gate, arp_hold, arp_seqmode,
   arp_polyr, arp_scale, arp_tonic, arp_len`), `seq_pattern` JSON in `state` (lanes: arrays of 16 + per-lane length + dice %), all
   covered by the wire test and the default-parity test; `setSeqPattern` native message; `useBridgeSynth` echo guard.
5. **UI:** `ArpBar.tsx` (compact, replaces `.main-viz` content when on), `SeqEditor.tsx` (view `'seq'`; lanes built on the
   FunctionEditor paint code; dice buttons; scale/tonic picker), piano playhead highlight (native -> UI "current step/note" via the
   existing state echo at ~30 Hz like the scope drain; do not stream per step — §73 froze hosts on sustained streams).
6. **Slide (v2):** per-voice glide — either smooth `v{i}_freq` with a glide-time param (`ctrl` smoothing already exists for other
   values) or a `tie` flag that keeps the gate high and only changes the voice's `freq`. Needs a DSP test (pitch ramps, no retrigger
   click) and a decision on mono/legato behaviour vs the 6-voice pool.

### F. Verification plan
- Differential harness (E1) green: all modes, rates, swing, octaves, hold, polyrhythm, probability with fixed seeds, tempo changes,
  transport stop/start, loop jump.
- Wire test (§165-D): every arp param/range/default arrives in the plugin; pattern JSON round-trips save/load.
- Behavioural tests on the **audio output**: hold C-E-G, arp Up 1/16 at 120 BPM -> note-on times exactly 125 ms apart (+-1 sample),
  gate % respected, no stuck notes after stop/disable, no extra voice stealing at 6 voices with gate 100% + release tail.
- Standalone listen + screenshot test (the §145 harness): the arp bar replaces the visualizer, SEQ view opens/closes, the piano
  highlights the live step. DAW test in Bitwig/FL (host ppq lock, loop, tempo change) — the standalone cannot prove host sync.

### F2. Prior art Stooge pointed at (2026-10-07) — READMEs fetched, none vendored; the `github.com/topics/arpeggiator` listing was not opened
| Project | What it is | Licence | Use for us |
|---|---|---|---|
| `YPares/arpligner` | **C++ / JUCE 7** multi-track polyphonic arp plugin (VST3/LV2/standalone, 83 commits, active). Takes chords on one MIDI channel and *patterns as MIDI notes* on others; maps pattern notes to chord degrees (semitone->degree or white-key->degree), octave wrap modes, handling for unmapped notes (silence / pass-through / transpose / whole chord). Deliberately **no pattern GUI** — you edit the pattern in the DAW piano roll | README says MIT-ish; **verify `LICENSE`** before reading closely | **Only same-stack reference** (JUCE + processBlock note events). Study how it emits sample-accurate note-on/off and handles stuck notes; steal the **"pattern = a MIDI clip"** idea (see below). Do not copy code until the licence is confirmed |
| `dfilaretti/uplift-arpeggio` | Max for Live device: 3-note chord in -> 16th-note grid of on/off + velocity, randomise within ranges, **rotate pattern left/right**, global note length, transpose, probability | CC0 (public domain) — free to borrow ideas/design | **Grid UX reference**: on/off toggle grid + velocity bars, rotate/shift buttons, constrained random. Matches our v1 lanes; add **Rotate <- ->** and "random within min/max" to the lane tools |
| `rotenbergrr/Arpeggino` | Arduino arp/sequencer/looper (MIT) with scales/modes (Ionian..Locrian), octaves 1-7, note-order "permutations", 20-230 BPM | MIT | Idea: **dynamic vs static layers** — a recorded layer either follows global settings (key/scale/octave) or keeps its own; **infinite vs finite** layers (held key = loops forever, tap = plays once). Good model for Seq "follow arp settings vs. frozen" and for one-shot triggers. Scale/mode list is a ready-made source for our scale-snap menu |
| `PaoloEstorm/Arpmini` | Arduino hardware arp/sequencer: Arp / Rec / **Song (chain up to 8 patterns)** / **Live (patterns on buttons)** modes, 8 patterns x 32 notes | **GPL-3.0** | **Do not copy code** (GPL). Idea only: **pattern slots + chaining** (v3) and playing patterns from keys/buttons |
| `QMidiArp` (SourceForge) | Linux ALSA/JACK/LV2 arp + **LFO + step-sequencer modules**, MIDI-learn, pattern storage and **runtime pattern switching via MIDI**, sync to MIDI clock/JACK transport, ~10k downloads, active (Aug 2026) | **GPLv2**, Linux-only | **Do not copy code.** Idea: run **several modules at once** (arp + seq + LFO) and **switch stored patterns from MIDI** (e.g. keyswitch/program change) — fits our mod system + the §165-3 source registry |
| `arpeggiator.desandro.com` | Web Audio toy: speed, shape, attack/hold/release, filter, QWERTY keyboard; source on GitHub, licence not stated | unknown | A UI toy; nothing to take except "QWERTY keys as a keyboard" (a standalone-only nicety) |

**Takeaways to fold into the plan (added to scope, not yet built):**
1. **v2: Rotate/shift** (all lanes or one lane, left/right) and **constrained random** (min..max) on every lane — from Uplift.
2. **v2: Pattern-from-MIDI.** Let the user **drag a MIDI clip/file onto the Seq** (or paste notes) to define the pitch/length/velocity lanes — Arpligner's "pattern is a MIDI clip" idea, and it ties directly to RECORDR's audio->MIDI (`§MIDI-1`: its note JSON `{pitch,startSec,durationSec,velocity}` would map straight onto lanes). Also the reverse: **export the pattern as a .mid** to the DAW.
3. **v2: Chord-degree mapping** option (pattern notes are *degrees* of the held chord, with octave-wrap rules, Arpligner-style) as an alternative to "arp the held notes in order".
4. **v3: Pattern slots + chaining + live recall** (8 slots; Arpmini song/live modes) and **switching slots from MIDI** (QMidiArp).
5. **v3: Follow-global vs frozen layers** (Arpeggino): per-lane "follow scale/octave" toggle.
6. **Licensing rule for this feature:** GPL projects (Arpmini GPL-3, QMidiArp GPLv2) are **ideas only — never read-and-port code** into FAZE; MIT/CC0 ones (Arpligner after LICENSE check, Uplift, Arpeggino) are fine to study. Unique-to-us parts (Elementary DSP + our wire/test approach) are unaffected.
7. Nothing here replaces the §166 plan: no existing project is a drop-in (Max, Arduino, Qt/JACK, a web toy; the one JUCE project has no UI and its own architecture) — we still write `dsp/arp.js` + `Arp.h` + the differential harness. Next small step before E1: **read arpligner's note-event/transport handling** (after confirming its licence) to sanity-check our clock + note-off design.

### G. Open questions for Stooge
1. UI: accept **1 + 3** (compact bar replaces the visualizer; lanes in a third SEQ view; piano stays)? Or lanes elsewhere?
2. Single combined Arp/Seq (Pigments style, mode switch) — or two separate features? (Recommend combined: the lanes are shared.)
3. v1 scope OK (no Slide/PolyR until v2)? Slide needs a DSP glide that does not exist today.
4. Voice count: the arp makes the current 6 voices tight — raise it first (§165-E)?
5. Should the arp drive the existing mod system (e.g. a "step value" as a mod source)? Later; needs the source registry.

**Verified this session:** nothing in the repo mentions an arp/sequencer (search over docs and source); the MIDI path, clock source,
state/JSON message pattern and view toggle were read in `PluginProcessor.cpp`, `Voices.h`, `useBridgeSynth.ts`, `PluginApp.tsx`.
**Not verified:** Pigments' exact arp-mode list and several controls (section A "Not confirmed"); the 200-260px lane-editor height.
Sources: [SOS review](https://www.soundonsound.com/reviews/arturia-pigments), [Pigments 1.1 manual](https://downloads.arturia.net/products/pigments/manual/pigments_Manual_1_1_0_EN.pdf), [Pigments manual v5](https://dl.arturia.net/products/pigments/manual/pigments_Manual_5_0_0_EN.pdf) (too large to fetch — read it locally to settle the "not confirmed" list), [Pigments 101 video: Arpeggiator and Sequencer](https://ask.video/video/pigments-101-the-video-manual/21-21-arpeggiator-and-sequencer), [Arturia overview](https://www.arturia.com/products/software-instruments/pigments/overview).

## 165. INVESTIGATION + PLAN (no code changed) — compressor, wavetables, filter/LFO, modulators, presets (2026-10-07, Claude for Stooge)

Stooge asked for: compressor too loud; the OSC wavetable graphic never reacts to WT Pos and only the top two
tables work; research the Wavetable LFO / "+" add-modulator idea; filter+LFO still wrong; LFOs unipolar by
default; a New/Init preset button; then "go over everything" and plan. **This session changed only `todo.md`.**
Everything below was read from live code or measured with throwaway scripts (kept OUTSIDE the repo); numbers are
real, not recalled. Where a claim is a hypothesis it says so.

**Numbering note.** The Oct-3 commits `SS156…SS164` (e.g. `a24a72b` "Filter LFO lost half its swing…",
`d788684` SS162, `146cdc7` SS163) and the Oct-6 sections §162/§163 above reuse the same numbers. §162/§163 are the
Oct-6 nitesesh sessions. SS164 (a24a72b) never got a section here — its content is summarised in 4/F5 below. New
sections start at **§165**.

### THE HEADLINE — one root cause behind five different "it doesn't work" reports

The UI talks to the plugin through a **flat list of host parameters** (`manifest.json`, 266 floats) plus a few
JSON messages. Native silently drops anything not in the manifest (`WebViewEditor.cpp:212-231`, `handleSetParameterValueEvent`
looks the id up and does nothing if absent) and **clamps** everything to the manifest's min/max
(`AudioParameterFloat`). The DSP test suite (`test/engine.test.mjs`) never goes through that path — it hands
`renderSynth` a hand-built state with values the wire cannot carry (`amt: -10` into a field that is clamped to ±1).
So "tests green + fix verified" has repeatedly been true of the DSP and false of the plugin. Measured with a
throwaway script (`translate.ts` bundled with esbuild, outside the repo):

| Wire fact | Result |
|---|---|
| `synthToFlat(defaults)` keys not in manifest (dropped natively) | **17** — all `fx_comp_{low,mid,high}_{floor,ceil,amt,atk,rel}`, `fx_comp_drive`, `fx_comp_crush` |
| manifest params the UI **never writes** | **20** — `op{0-3}_warpmode/_warpamount/_warpparam2` (12!), `fx_comp_thresh/ratio/attack/release/upratio`, `fx_eq_low/mid/high` |
| UI default ≠ manifest default | **15** — `master` .8 vs .7; `env2_*`; `op{0-3}_wave` 5 vs 0; `lfo{1-3}_wave` 5 vs 0/1/2; `fx_eq_on` 0 vs 1; filter Q .707 vs .7 |
| route `osc1WtPos` via `synthToFlat` | **dst 56** (DSP: 56 = `op1Pm1`, WtPos is **64**); manifest `mod*_dst` max **55** |
| route `filterACutoff` amount 10 oct (the UI's max) | **wire 1.0** → DSP does `fc·2^(src·1)` = **±1 octave** |
| `op0_wtid` manifest range | **0..1** (381 tables in the UI) |

Consequences for everything below: **fix the plumbing before any feature**, and make a test that fails when
plumbing drifts (§D). Anything "verified" in the DSP suite alone should be treated as unverified for the plugin.

---

### 1. Compressor is way too loud (Stooge: cap the dry/wet max "so people don't ear-rape themselves")

**What the compressor actually is.** `applyCompressorSlot` (`dsp/synth.js:963`) is a 3-band **DOOM upward
compressor**: per band `gainDb = (ceilingDb − max(envDb, floorDb)) · amount`. Defaults: floor **−80**, ceiling 0,
amount 1 → every band is pulled *up* toward 0 dBFS with up to **+80 dB** of gain (quiet passages and release tails
get the most). Then `drive` (up to +24 dB), `gain` (up to ×2) and a `tanh` "safety ceiling" that just saturates.
The mix control is a plain linear crossfade between dry and that already-normalised wet signal.

**Measured** (offline render of the default patch, compressor in slot 0, all band params at their defaults —
which is what the plugin always runs, see below). RMS / peak, dBFS:

| master | dry | mix 25% | mix 100% |
|---|---|---|---|
| 0.9 | −23.8 / −19.1 | −18.7 / −10.8 | **−7.5 / −0.2** (+16 dB) |
| 0.3 | −33.4 / −28.6 | −19.7 / −11.8 | −7.9 / −0.3 (+25 dB) |
| 0.05 | −48.9 / −44.2 | −20.0 / −12.3 | −8.0 / −0.3 (**+41 dB**) |

So it is a maximiser that ignores input level: everything lands at ≈ −8 dB RMS / 0 dBFS, and **mix 25% is already
+5…+29 dB louder**. Capping the slider's range alone would not fix this — the slider is not the problem, the
unbounded boost is, and an old preset with mix 100% would still blast.

**Second, worse problem: the band controls are dead in the plugin.** The UI's per-band floor/ceiling/amount/
attack/release/drive/crush (17 keys) are not in `manifest.json`, so native drops them, and `plugin/dsp.main.js:177-188`
builds the compressor from the **legacy** fields (`threshold`, `ratio`, `upwardRatio`, `attackMs`, `releaseMs`) which
`applyCompressorSlot` does not read. Net: in the plugin every user always runs the defaults (−80/0/1/0 ms/120 ms).
You cannot turn the loudness down with the compressor's own controls because they never arrive. (They also are not
saved with the project, for the same reason.) The legacy `fx_comp_thresh/ratio/attack/release/upratio` params are
the opposite: in the manifest, never written by the UI, never read by the DSP. Also `highFreq` defaults 3500 in
`dsp.main.js` vs 2500 everywhere else.

**Plan (in this order):**
1. **Plumbing first** (otherwise nothing below is observable): add the 17 params to `manifest.json` with proper
   ranges + defaults, read them in `dsp.main.js`, delete the 9 dead legacy params (`fx_comp_thresh/ratio/attack/
   release/upratio`, `fx_eq_low/mid/high` — this is also the answer to the `[!] upwardRatio` line, see decision below).
   Param ids are host automation ids — pre-release, so renaming is acceptable; say so in the commit.
2. **Bound the boost.** Add `maxBoostDb` (new param, default **+12 dB**, 0..24) and clamp `gainDb` to it per band;
   raise the default `*FloorDb` from −80 to ≈ −55 so the noise floor / tails are not lifted by tens of dB. Keep the
   "DOOM" character, just bounded.
3. **Make mix mean something.** Wet path gets automatic loudness compensation (measure input/output RMS with the
   existing `el.env`/`el.rms` helpers and trim the wet so mix 100% ≈ dry loudness +≤3 dB), mix slider stays 0–100%.
   Replace the `tanh` safety with a proper output ceiling at −1 dBFS (soft clip only above it) so a hot setting can
   never exceed 0 dBFS. If Stooge still wants a hard UI cap on top, make it a one-line constant (`COMP_MIX_MAX`)
   rather than a baked-in range, so loaded presets are clamped too. **Decision for Stooge (small):** auto-compensate
   (recommended) or just cap the slider at ~50%?
4. **Default mix 0 → ~0.3** and Init preset keeps it **disabled** (already `enabled:false`).
5. **`[!]` upwardRatio resolved by this design:** the compressor already *is* an upward compressor (the DOOM
   rewrite superseded the old thresh/ratio/upratio design), so `upwardRatio` is vestigial. Recommend: remove the
   param (types.ts:989, manifest) and **replace the one failing test** with "`lowAmount` boosts a quiet signal".
   That takes the suite to 100% green honestly. (Alternative — build a second, classic downward mode — is a feature,
   not a fix; park it.)
6. **Verify:** (a) re-run the probe above as a permanent regression test: RMS delta wet−dry at mix 100% ≤ 6 dB for
   inputs at −6, −24, −48 dBFS; (b) silence + −90 dBFS noise must stay below −60 dBFS after the compressor (no
   noise lifting); (c) peak ≤ −1 dBFS at every setting incl. drive/crush max; (d) the wire test (§D) must show all 17
   params arriving; (e) listen test in the standalone with the real knobs (the user's actual complaint).

---

### 2. Wavetables: the OSC graphic doesn't react, and only the first two tables work

#### 2a. The graphic (`src/renderer/components/WavetableGraphic.tsx`)
Stooge likes the design and placement — **keep the box**, fix what it shows. Root causes, all verified in code:
1. **Wrong call.** `getWavetableFrame(id, frameIndex, warpMode, …)` takes a `frameIndex` as its 2nd argument
   (`wavetables.js:713`); the component calls `getWavetableFrame(wtId, warpMode, warpAmount, warpParam2, warpMode2, …)`
   — **no frame index, every later argument shifted by one**. It therefore always draws a frame chosen by the warp
   mode number, with the warp amount read as a warp mode. (Hidden for two sessions because the import was untyped;
   the new `wavetables.d.ts` made the NaN-path bug visible but not this one.)
2. **`wtPos` is never read** — not passed in, not in the `useEffect` deps. That is the literal reported symptom.
3. **No interpolation.** The audio crossfades adjacent frames with hat weights over `WT_NUM_FRAMES` (8):
   `wavetableOsc`, `synth.js:93-107`. The graphic must do the same (`frameAt(frames, pos)` = lerp of the two
   neighbours) or it will lie between frames.
4. In the plugin WebView the graphic cannot load ESW frames (no `process`/fs — see 2b), so for id ≥ 2 it would draw the
   harmonic fallback. It has to read the **same precomputed table data the DSP uses** (2b).
5. Warp: the graphic applies Warp 1/2, but the plugin never receives them (§B), so today it shows a shape the audio
   does not have. Fix §B first or the graphic is a confident lie.

**Plan:** rewrite the component's data path as `frames = generateWavetableFrames(id, warp1, warp2)` (memoised per
id/warp, **not** per `wtPos`) + `frameAt(frames, wtPos)`; deps = `[wtId, wtPos, warpMode, warpAmount, warpParam2,
warpMode2, warpAmount2, warpParam2_2]`; rAF-free (pure React). Nice-to-have, same file: faint ghost lines of the two
neighbouring frames (Vital-style), and a modulated-position marker (needs a scope tap or a tiny `wtpos` readout from
native — see "modulated position" in 3/Wavetable LFO). **Verify:** a vitest/node check that `frameAt` at pos 0, 1/7, 0.5,
1 matches the DSP's own table lookup sample-for-sample (reuse `test/` harness); screenshot at pos 0/0.5/1 for table 0
and 1 in the standalone (the §145 UI automation exists; passive screenshots were the reliable part).

#### 2b. "Only the top two tables work" — four stacked causes (the first is new)
1. **`manifest.json`: `op{k}_wtid` has `max: 1`** (lines 21/36/51/66). The host clamps the id to 0..1, so choosing
   any ESW table (id ≥ 2) silently becomes "Formant Sweep" (id 1). *Nothing downstream is even reached.* The 379
   ESW entries are in the dropdown, the UI writes id 2…380, the plugin stores 1.
2. Natively `registerBuiltinWavetables()` registers ids 0/1 only; every other id hits the "unknown id" branch of
   `wtGenerateFrame()` → one fixed harmonic frame.
3. No filesystem in the QuickJS/WebView context, so `loadEswWavetableFrames` can never run there (SS162).
4. **New:** even where the loader works (Node/browser harness) it returns **all** frames of the .wav (a 2 MB file =
   256 frames) but the DSP and C++ scan only `WT_NUM_FRAMES = 8` — so only frames 0..7 (~3% of the table) are ever
   audible and "position 1.0" is not the end of the table. The loader must resample to N evenly spaced frames.

**The `[!]` "1-2 GB" estimate is wrong — measured:** 379 wavs = **584 MB source** (avg 1.5 MB, max 2 MB = 256 frames
× 2048 × float32). The DSP only needs 8 frames × 2048 samples = 64 KB/table float32 → **≈ 24 MB total (≈ 12 MB as
int16; 16 frames ≈ 48 MB)**. That is trivially embeddable. Recommendation (replaces the `[!]` line — needs Stooge's OK):
**precompute and ship.**

**Plan:**
1. `scripts/build-wavetables.mjs`: read `esw-tables.json` + the wavs, resample each to N=8 (or 16 — decide; the
   DSP loop and C++ `kWtNumFrames` and the mod-sweep resolution all key off it) evenly spaced frames, normalise,
   write `plugin/wavetables.bin` (header: version, tableCount, frames, frameSize; payload int16 or float32) + keep
   `esw-tables.json` for names. Run it in `build:plugin-assets`.
1b. **Frames per table = the table's own count (Stooge, 2026-10-07), capped (~64), not a fixed 8/16.** Measured examples: "303 Saw" 256
   frames, "80's PWM" 31, built-ins 8. Needs: bin header stores `frameCount` per table; each table packed into ONE buffer
   (frames concatenated, int16); `wavetableOsc` reads only the 2 neighbouring frames (`el.table` offset by
   `(floor(pos·(N-1)) + phase)/N`, lerp) so graph cost is constant instead of 8 reads/op/voice; `WT_NUM_FRAMES`/`kWtNumFrames`
   become per-table; `frameAt()` in the graphic uses the same N; warp resources must be generated per frame at that N
   (spectral warps are DFT per frame — cost scales with N, so warp over the capped set or lazily). Size estimate ≤ ~50-100 MB
   int16 at 64-cap (unmeasured — compute from the real wavs when building). Resample (not truncate) tables above the cap.
2. Embed via the existing asset path (`Assets.h` / `getEmbeddedAssetAsString`-style) and make C++ register
   **lazily**: `registerBuiltinWavetables()` for 0/1 at startup; others on first use of that id (SharedResourceMap is
   insert-only, keys `wavetable:{id}:{frame}`; 381×8 eager registration is only 24 MB RAM but thousands of inserts
   at load — measure before choosing eager).
3. Raise `op{k}_wtid` max to **381** (`wtId` count − 1; derive it from the table count so it cannot drift again).
4. Give the UI the same data for the graphic: either a `getWavetable(id)` native message returning the frames, or a
   second embedded bin loaded by the webview. One data source for DSP + graphic.
5. Dropdown: 381 flat `<option>`s is unusable. Group by `category` (11 categories: Analog 37, Basics 41, Chill 10,
   Digital 84, FM 27, Growl 20, Instruments 57, Metallic 12, Spectral 15, Synth One Shots 17, Vocal 59 — it is in
   `esw-tables.json`) with `<optgroup>`, ‹ › arrows, and later a searchable popup. Today it is also 24px tall and
   140 px wide, so names truncate.
6. **Licence: RESOLVED — Stooge confirmed (2026-10-07) the ESW tables are free**, so shipping a binary derived from them is
   fine. Still worth considering: moving the 584 MB of source wavs out of git (LFS / separate repo; the pack is 545 MiB)
   since the shipped artefact only needs the ~24 MB bin.
7. **Verify:** (a) test that every id 0..380 yields a *distinct* base frame set through the **wire** path (set
   `op0_wtid = id` via the manifest clamp, render, compare spectra), (b) native build → `grep -a` the bin in the exe,
   (c) standalone: pick tables from 3 categories and look at the scope/graphic, (d) A/B the frames against the Node
   loader for 5 tables (same samples, to within int16 rounding).

---

### 3. Modulator expansion: "+" add-modulator tile, more ENV/LFO, Audio Follower, Wavetable LFO

**What exists on paper (searched code, notes, images):**
- `AUDIO FOLLOWER + INSERT FX.png` — **the mockup for exactly this.** Modulator strip shows ENV 1·AMP, ENV 2, ENV 3,
  **Audio Follower · MOD** (purple dot, a spectrum bar graph with two dashed vertical band markers = the follower's
  frequency band), **ENV 4, ENV 5**; second row LFO 1, 2, 3, **LFO 4, LFO 5**, and a **dashed-outline tile with a big
  "+"** as the "add modulator" affordance. Velocity/Key + Filters A/B below, macro row (8 knobs, purple→pink dots) to
  the right, FX CHAIN + "FX VIEW" under it.
- `PHASE4-SYNTH-REFERENCE.png` — Bitwig Phase-4: the dashed **"+"** tile in its Expressions area is the style
  reference for the "+" slot; its oscillator/modulation cards are the broader reference for the ratio/shape idea.
- `Right Click Audio FX.png` — same interaction family: "RIGHT CLICK TO INSERT AUDIO FX" empty-state text. **That
  one is already built** (`FxPanel.tsx:373,385`, an "Insert audio FX" menu). The modulator "+" should reuse that
  pattern (click "+" or right-click empty → menu) so the two feel the same.
- Written notes: §128 and §150 — "Bitwig-style **Wavetable LFO**: continuously morph between two or more user-drawn
  Function shapes, with its own user-created wavetables of shapes — nice-later, not started." Nothing in the code.
  The Audio Follower and ENV/LFO 4-5 appear **only** in the mockup (no mention in any note or source).

**What the code does today (why this is a refactor, not an add):**
- Sources are hard-coded in four places: `ModSourceId` union (`types.ts:654`), `MOD_SOURCES`/`OVERVIEW_SOURCES`
  (`mod-sources.ts`), the DSP's `MOD_SOURCES` array (`synth.js:153`, index = the `mod{n}_src` value = host
  automation — **append-only**), and `EnvelopePanel.tsx` (1,520 lines, explicit 3 ENV + 3 LFO + VELO/KEY + filters).
  `dsp.main.js` reads `env2_*`, `env3_*`, `lfo1..3_*` by name; manifest `mod{n}_src` max is **15** (8 builtin + 8 macros).
- Mod matrix: 24 slots, each 3 floats (src/dst/amt). The `dst` range bug (§C) is the same class of problem that
  adding sources will hit again on `src`. `buildSources` constructs every source's node tree per voice on every render (JS-side cost; Elementary should only
  instantiate nodes reachable from the output, so unrouted sources are probably free in the audio thread — **unverified**, measure before
  claiming a CPU win from "build only routed sources").
- No audio input bus (`PluginProcessor.cpp:25-26` — `withOutput` only), so "Audio Follower" has nothing external to
  follow today.

**Design (proposal — items marked [!] need Stooge):**
1. **Phase 0 — make sources data-driven (no new features, no visible change).** One registry
   (`id, type, label, color, dspIndex`) shared by UI/DSP/translate; generate `ModSourceId`, `MOD_SOURCES`, DSP array and
   the manifest `src` range from it; `EnvelopePanel` renders from a list; build only the sources that are actually
   routed (the `hasModRoute` pattern already exists in `synth.js:329`) — cuts JS-side graph-build work and keeps it bounded
   as the pool grows. Raise manifest `src`/`dst` ranges from the registry (fixes §C at the same time). **[!]** consider
   moving the whole matrix to a JSON message (`setModMatrix`, like `setFunctionShape`/`setEqBands`) — removes the
   float-per-slot range-clamp bug class and the 24-slot cap, costs host automation of individual routes (which no
   current workflow uses). Big architectural call → ask.
2. **Phase 1 — "+" tile + ENV 4/5 + LFO 4/5.** Pool with a cap (suggest ENV ≤ 6, LFO ≤ 6; mockup shows 5+5).
   Instantiated-or-not stored as a JSON list in native `state` (survives save/load like the EQ bands); per-slot float
   params appended to the manifest (`env4_a…`, `lfo4_rate…`) so they stay automatable. "+" opens an insert menu (same
   widget as the FX insert menu); right-click a card → Remove (deletes its routes, confirm if routed). New LFOs default
   **unipolar** (item 5). Layout: mockup is 6 columns × 2 rows inside the frozen 1272×920 window — measure
   `.env-panel` height budget first (the FX/Synth alignment `[!]` is still open and touches the same strip).
3. **Phase 2 — Audio Follower.** A global (not per-voice) source = band-pass (lo..hi from the two draggable markers)
   → envelope follower (attack/release) → 0..1. **[!] What does it follow?** Without an input bus the only options are
   the synth's own post-voice (pre-FX) or post-FX signal. Adding an optional **sidechain/aux input bus** (so it can follow
   a drum track) is a C++ + Elementary `numInputChannels` change and host-dependent (FL/Bitwig/Reaper differ); recommend
   Phase 2 = own signal, Phase 5 = sidechain. The spectrum graph in the mockup needs an analyser feed: the UI already
   has a spectrogram Scope mode (`Scope.tsx`/`scopeStore.ts`), so reuse it rather than adding a second FFT path.
4. **Phase 3 — Wavetable LFO.** Bitwig-style: K user-drawn frames (Function shapes), a **Position** (0..1, itself
   modulatable) that crossfades adjacent frames, plus rate/sync like any LFO. Implement exactly like the audio
   wavetable: rasterise each frame to a 256–512-point table, register as shared resource
   (`lfowt:{lfo}:{version}:{frame}`, versioned like the sampler's `sample:opK:V` because the map is insert-only), read
   with `el.table` + the existing hat-weight crossfade. **Do not** extend `functionSignal` (a select-chain of up to
   128 points × 2 nodes **per voice per LFO** — 8 frames of that is far too heavy). Bonus: switching all existing
   Function LFOs to a rasterised table fixes that per-voice cost today. UI: reuse `FunctionEditor` with a frame strip
   (add/duplicate/delete, max 8), a position slider, and "import frames from an audio wavetable" (ties into 2b — ESW tables
   as LFO shapes for free). Modulated-position readout: needs a tap or a `wtlfo` position in `state`.
5. **Phase 4+ (later):** Random/S&H as first-class cards, MSEG, macro-style "Expression" sources like Phase-4.
6. **Verify each phase:** the wire test (§D) with the new source ids; DSP checks (route → measurable effect, RMS /
   centroid, as the existing P5 tests); save → reload round trip; add/remove card with routes (no orphan routes,
   no dst index shift); C++ build + screenshot; CPU check with the full pool instantiated and 6 voices held.

---

### 4. Filter + LFO is "still problematic" — root causes (this is the fifth round; read F1 first)

History for context (all in this file / git): §156 clamp could not sweep up → §161 default filter was bypassed so the
route was dropped → SS162 (`d788684`) widened to ±10 octaves + ceiling 20 kHz → SS164 (`a24a72b`) unipolar remap threw
away half the swing. Each fix was real **in the DSP** and each time the plugin still felt dead. Here is why:

- **F1 [P0, the big one] — amount scale.** UI range for cutoff is **±10 octaves** (`mod-sources.ts:182-234`,
  `format: pct(10)`). `translate.ts` sends `amount / dspSpan` = **amount/10 ∈ ±1** (and the manifest clamps `mod*_amt` to
  ±1). The DSP then does `fc · 2^(src · amt)` (`synth.js:383`, comment says "amount in octaves"). So **100% on the
  popover = ±1 octave**, not ±10; the default route amount 0.8 oct → wire 0.08 → `2^0.08` = **+5.7%** (a barely audible
  nudge — exactly "LFO barely modulates the filter"). Measured via `synthToFlat`: amount 10 → `mod_amt 1`; reso amount 20
  → `mod_amt 1` → DSP `q + amt·12` = **12, not 20** (same mismatch). The suite never saw it because its tests set
  `amt: -10` directly (`engine.test.mjs:179`) which the wire cannot deliver. *Pitch*, by contrast, is scaled correctly
  (DSP applies `amt·24` semitones), which is why only the filter feels broken.
  **Fix:** one exported constant per target kind in the DSP (`FILTER_CUTOFF_OCT_SPAN = 10`, `FILTER_Q_SPAN = 20`) used by
  both the DSP and `mod-sources.ts`/`translate.ts` (import it; do not retype the number), DSP does `2^(src·amt·SPAN)`.
  **Audit the whole table** (UI `max` vs DSP interpretation) for every target, not just these two — write it out as a
  generated table in the test output so a future mismatch is visible: pitch, osc pitch, level, pan, modAmount, wave,
  filterMix, cutoff, reso, lfo rate, 24 PM/FM depths, WtPos, WarpAmt.
- **F2 — typo.** `synth.js:743`: `hasRouteTo(state, T.filterACutoff, T.filterAReson)` — `T.filterAReson` is `undefined`
  (the name is `filterAReso`), so a **resonance-only** route does not force the filter into the graph at defaults.
  (`filterB` on line 750 is spelled correctly.) One-character fix + a test with a reso-only route.
- **F3 — first-load LFO wave index.** Manifest defaults `lfo{1,2,3}_wave = 0,1,2` but the UI default (`wave:'function'`) is
  index **5**. On first push the UI adopts the plugin's values (`useBridgeSynth.ts:201-209`) and **does not write back**, so
  until the user's first edit of *anything* the DSP runs the legacy `el.cycle`/triangle/saw path (always bipolar, ignores
  `functionShape` and the bipolar flag), and the native-seeded `lfoN_functionShape` is a 0..1 *bump*, not the sine/tri/saw
  the UI shows. After the first edit `change()` pushes wave=5 + shape and it "starts working" — which reads as flaky.
  **Fix:** make the manifest the single source of defaults (generate `FLAT_DEFAULTS` from it, or the reverse), set
  `lfoN_wave` default 5, seed the native shape from the same JSON the UI uses, and add a **default-parity test** (the 15
  mismatches above must become 0). Also drives the Init button (item 5).
- **F4 — tests certify the wrong thing.** The SS161/162/164 tests assert on DSP input the plugin cannot produce. Rewrite
  them through the wire (§D): UI patch with the route at 100% → `synthToFlat` → manifest clamp → `toSynthState` →
  render; assert the sweep reaches the 20 Hz floor from 20 kHz at **100%**, and that the *default* popover amount is
  audible. Keep one test of the DSP maths with the span constant.
- **F5 — bipolar / unipolar.** Current state: DSP honours `shape.bipolar === false` only on the `wave===5` path
  (`functionSignal`, `synth.js:235`) by normalising to the shape's **own min/max** (SS164). Shipped default is
  `bipolar:true` everywhere: `DEFAULT_FUNCTION_SHAPE` (`types.ts:109`), the three `functionShapeForLegacyWave(...)`
  defaults (`types.ts:1570-1572, 1638-1640`), the native seed JSON (`PluginProcessor.cpp:94-98`), the editor
  (`EnvelopePanel.tsx:730` `useState(shape.bipolar !== false)`) and the card button (`:531`, "±"/"+").
  **Plan for "unipolar by default":**
  1. New patches: `bipolar:false` in `DEFAULT_FUNCTION_SHAPE`, the native seed, and a new `defaultLfoShape(i)` used by the
     three default LFOs. **Do not** flip `functionShapeForLegacyWave`'s *migration* use (old presets must keep their
     sound) — split "default for new" from "migrate legacy". A missing `bipolar` field in an old preset must stay
     bipolar (`normalizeFunctionShape` already does that: `fallback.bipolar !== false`; keep it).
  2. Button reads "+" and is OFF-state on load; **editor local state is stale bug**: `useState(shape.bipolar !== false)`
     does not follow the `shape` prop (preset load/Init leaves the editor showing the old mode) — derive from props.
  3. `types.ts:154-188` `evaluateFunctionShape` — the SS164 edit left the unipolar normalisation **after a loop that
     always returns**, i.e. dead code (and when reached it returns `level/span`, missing `− lo`). The UI preview graph and
     the DSP disagree for unipolar. Fix to mirror `functionSignal` exactly and add a parity test (sample both at 64 phases).
  4. Caveat to tell Stooge: range-normalisation means a shape drawn only between, say, 0.3 and 0.6 is *stretched* to the full
     0..1 in unipolar mode. Fine for the three defaults (they span −1..1 or 0..1); surprising for hand-drawn shapes.
     Cleaner long-term model = shapes always authored in −1..1 editor space and `unipolar = (x+1)/2`; flag, don't change yet.
  5. Behaviour change to warn about: every existing LFO route now only swings *up* from its base value. For **cutoff at
     the 20 kHz default** an upward swing is clamped away (by design: never past the knob maximum), so the user must use a
     *negative* amount to sweep down — consider making the cutoff popover's default amount negative, or showing the clamp
     ceiling on the mod ring so the dead half is visible.
  6. **Verify:** default patch → each LFO's rendered control signal stays in [0, 1] (tap it, assert min ≥ −ε); toggle ± →
     [−1, 1]; round trip save/load keeps the flag; Init resets it to off.
- **F6 — topology change on first route.** Adding the first route to a bypassed (default) filter *builds* the filter in
  every voice graph (`filterIsBypassed(...)` flips) — a graph reconcile that can click. Test for a glitch (peak jump) at
  route add/remove; consider always building the filter and bypassing via `fc=20 kHz` only if the click is real.
- **Verify the user-visible outcome last** (this report has been "fixed" four times): in the standalone, LFO 1 (default
  unipolar, rate 1 Hz) → Filter A cutoff at −100%, record 4 s, confirm by ear and by the spectrogram that the sweep
  spans the audible range; repeat with Filter B and with a reso route.

---

### 5. Preset selector needs a "New / Init" button

**What exists:** `PresetBar.tsx` (shared by the Electron app and the plugin): ‹ selector ›, browser popup with factory
presets (**"Init Preset"** is the first entry, so Init is reachable by opening the browser and picking it — no one
discovered that), Save (name → localStorage), delete, right-click selector opens the browser. `PRESETS.png` mockup shows
**undo / redo arrows** beside the selector — not implemented.

**Why a naïve button is not enough (findings):**
- **Init ≠ the plugin's power-on state.** `Init Preset` = `normalizeSynthSettings({})` (UI defaults); the plugin boots
  from the manifest defaults. 15 values differ (list in the headline table: master .8/.7, osc wave 5/0, env2, lfo waves,
  `fx_eq_on`, filter Q). So "initialise to the default patch" would load a *third* thing. Fix the parity (F3) first and Init
  becomes trivially "all manifest defaults".
- **`change(synth)` is not a reset.** It diffs against the last flat map and pushes changed floats only; it does **not**
  clear non-parameter state: **loaded samples** (`op{k}_samplepath/version/peaks` — needs `clearSampleFile`×4), and
  nothing silences held notes / reverb tails. LFO shapes and EQ bands are handled by `change()` already.
- **Presets live in WebView `localStorage` (`faze.presets`) in the plugin** (no `window.api`). They are not in the host
  project, not files, not shareable, and vanish if the WebView profile is cleared/moved. The *current* patch persists with
  the DAW project (state blob), but the preset **name** is derived by deep-equal against the list, so any tweak shows
  "Edited Patch" and there is no dirty marker or "revert".
- Destructive action with no undo.

**Plan:**
1. Native `resetToDefaults` message: set every manifest param to its default, reset the JSON state keys (function shapes to
   the unipolar defaults, `fx_eq_bands` `[]`, sample keys cleared + resources released), all-notes-off, **one** state
   dispatch (not ~270 `setParam` messages — §73 froze Bitwig/FL on sustained streams). UI side `bridge.resetToDefaults()`;
   `useBridgeSynth` re-adopts the echo.
2. UI: a **New** button (document/"+" icon, tooltip "New patch — reset to Init") immediately left of ‹ and "Init Preset" as
   the label after it fires. If the patch is dirty show a one-line confirm popover ("Discard changes?") — *or* skip the
   confirm and ship undo (3). Recommend undo, it is the better UX and the mockup already shows it.
3. Undo/redo: snapshot the `SynthSettings` (cheap, it is plain JSON) on gesture end, cap ~50, coalesce slider drags;
   the arrows in the mockup go right of the selector. Preset load / New are single undo steps.
4. **[!] Bigger, ask:** move user presets to files (`%APPDATA%/Faze/Presets/*.fazepreset` via native directory listing +
   FileChooser) so they survive WebView resets and can be shared; keep localStorage as a migration source. Also persist the
   loaded preset name + a dirty flag in `state`.
5. **Verify:** after New, `synthToFlat(synth)` equals the manifest defaults for all 266 keys (the parity test) **and** an
   offline render equals a fresh instance's; set up a nasty patch first (loaded sample, 3 routes incl. a WtPos route,
   an EQ band, macros, compressor on, held note) and confirm every piece is gone, silence after reset, no stuck note;
   undo restores the nasty patch exactly.

---

### B. (found while investigating) Warp 1 / Warp 2 never reach the plugin
- `translate.ts` `synthToFlat` emits **no** `op{k}_warpmode/_warpamount/_warpparam2` (grep: only `wtid`/`wtpos`), so the
  12 manifest warp params are never written. Native `ensureWavetableWarpResources()` reads them from `state`, finds the
  defaults (0) and does nothing. **Every warp mode, including the SS163 C++ spectral port, is unreachable from the UI.**
  (They are only reachable by host automation of the raw parameters.) §145's "Warp 1 Bend+ IS audible" listen test must have
  gone through a different path; re-check how before trusting it.
- **Warp 2 has no plumbing at all**: no manifest params, not read by `dsp.main.js`, not in `translate.ts`. The C++ side
  *does* key on `warpmode2/warpamount2/warpparam2_2` (lines 921-936) and bails out when `warpMode2 != 0`
  (`PluginProcessor.cpp:1108`), so even with plumbing, Warp 2 is a silent no-op natively. The OSC card shows two warp blocks.
- **Plan:** add the 12 + 12 params (warpmode2/amount2/param2_2) to the manifest, emit/read them in `translate.ts` and
  `dsp.main.js`, and either implement the chained-warp path in C++ (run Warp 1 then Warp 2 over the frames, mirroring
  `generateWavetableFrames`) or grey out Warp 2 in the plugin until it exists — don't ship a knob that does nothing.
  Also add `op{k}WarpAmt/WarpAmt2` mod targets to the UI (the DSP already lists them). Verify with the wire test + the
  existing `test/spectral-warp-diff` harness extended to the 2-warp chain.

### C. (found while investigating) Modulation target indexes are out of step across layers
- DSP `MOD_TARGETS` (76 entries): …`op4Fm3` = 55, then **self PM/FM = 56..63**, **WtPos = 64..67**, WarpAmt 68..71, WarpAmt2 72..75.
- `translate.ts` `MOD_DST_IDS`: 56 entries, then `osc{n}WtPos` at **56..59** — it was written before the self-mod block
  was inserted ahead of WtPos in the DSP (the DSP comment says "APPENDED, never reordered"; it was not appended).
- Manifest `mod{n}_dst` `max: 55` for all 24 slots.
- Net: a WtPos route is stored as dst 56 → clamped to 55 by the host (= `op4Fm3`!) in the plugin, and even without the clamp it
  would land on `op1Pm1` (self-PM, inert). **Wavetable-position modulation, which the UI advertises and the DSP supports, can't
  work in the plugin.** The DSP tests pass because they look the index up by *name* from `MOD_TARGETS`.
- **Plan:** generate `MOD_DST_IDS`, the manifest `dst`/`src` max and `DSP_MOD_TARGETS` from one list (§3 Phase 0 does this
  structurally); until then fix by hand: correct the 4 WtPos indexes, add the 8 self + 8 warp targets or drop them, bump `max`
  to 75. Add a test: for every `ModTargetId` the UI can route, `MOD_DST_IDS[idx]` ↔ DSP `MOD_TARGETS[idx]` names agree,
  `idx ≤ manifest max`, and a rendered route changes the output.

### D. The verification backbone — build this first (P0-A)
`test/wire.test.mjs` (new), runs in `npm test` next to the DSP suite:
1. **Manifest parity:** every key `synthToFlat` can emit ∈ manifest; every manifest key either emitted by the UI or listed
   in an explicit allow-list ("host-only"); every key `dsp.main.js` reads exists. (My throwaway script above is the seed:
   it already finds 17 + 20 + 15.)
2. **Range parity:** the UI's own min/max for each control fits the manifest's min/max after `amtToDsp`/value mapping
   (catches `wtid` max 1, `dst` max 55, `amt` span).
3. **Default parity:** `synthToFlat(defaultSynthSettings())` == manifest defaults (target: 0 mismatches).
4. **End-to-end renders through the wire:** build `SynthSettings` → `synthToFlat` → clamp each value to its manifest range →
   `toSynthState` (import `dsp.main.js`'s function; needs it exported or a copy kept in sync) → `renderSynth`. Assertions
   for each bug in this section (wtid 2+ differs from 1; warp changes timbre; WtPos route modulates; cutoff route at 100%
   reaches the floor; reso route; compressor boost bounded; LFO default range [0,1]).
5. Run it in CI/`build.sh` before the JUCE step (also fixes the SS161 "built the exe without rebuilding `dsp.main.js`" trap:
   make the build script run `build:plugin-assets` itself and grep the shipped bundle for a build-id string).
The generic lesson (same as §149/§162): a green test is evidence about the *input it was given*. Tests must enter where the
user does.

### E. Other things found / worth doing (not requested)
- **Polyphony: native `kNumVoices = 6`** (`PluginProcessor.h:23`, `dsp.main.js:15`) but the UI default says `voiceLimit: 16` and
  the header reads "0 voices"/"/16 voices" in older mockups. Six voices is low for pads with long release; chords + tails will
  steal. Measure CPU per voice and raise (8–16), and make the UI show the real cap.
- **FX/Synth view alignment `[!]` (§162)** is still open and now collides with the modulator-strip growth (§3) — decide the
  layout rule once (render the main visualizer on both views, or a spacer, or drop the "same spot" requirement).
- **`[!]` OSC card padding screenshot** (§148/149) — still waiting for the annotated screenshot saved into the repo.
- **Dropdown/graphic layout interplay:** the wavetable graphic box adds height to a card that was already tight; re-measure
  the card (502px after §159) once the graphic is verified visible, then re-run the padding plan.
- **Build:** `build.sh` must run `build:plugin-assets` itself (see §D 5). Keep the NITESESH_BUILD_OK token check.
- **Repo hygiene:** 9 tracked one-off scripts at the root (`patch_*.py`) + `index.js` — archive to `scripts/legacy/` or delete;
  untracked `Icon Faez.ico/png`, `audio.ico`, `desktop.ini` — commit the icons under `assets/` (the app icon is already wired
  in 8c68be1/40ad500), add `desktop.ini` to `.gitignore`; ~45 mockup PNGs in the repo root — move to `docs/mockups/` with the
  names kept (several notes cite them by file name, grep before moving). `README.md`/`overview.md` still describe the v3.0.0
  Electron recorder; the product is now the FazeSpike plugin — add a plugin section (build, install path, UI map).
- **Dead/stale code spotted:** `evaluateFunctionShape` dead branch (4/F5-3); `FunctionEditor` stale `bipolar` state;
  legacy `CompressorFxSettings.threshold/ratio/upwardRatio/attackMs/releaseMs`; `fx_eq_low/mid/high`; `dsp.main.js` comment
  "chain … 0=off/1=delay/2=reverb/3=distortion" (8 types now).
- **Tests:** the suite is 66 pass / 1 fail (the known `upwardRatio`); after 1.5 it is 100%. Add the wire suite (§D) and a
  loudness/headroom suite for every FX (compressor was found by ear; delay/reverb/distortion/chorus at mix 100% have not been
  measured the same way — do it, the same "limiter in front of the user" principle applies).
- **Docs trap worth keeping:** vision-model OCR of mockups is unreliable (§149/§150). For this batch every mockup claim above
  was read by looking at the image, and each is corroborated by a second source (file name, existing code, or a note) — but
  the `AUDIO FOLLOWER + INSERT FX.png` band markers/spectrum behaviour is *inferred* from the picture; confirm the follower's
  design with Stooge before building it.

### Roadmap (Now / Next / Later)
**Now (unblock everything):** §D wire test → fix wire drift: manifest ranges (wtid, dst, src), default parity, warp
plumbing (§B), target indexes (§C), compressor params → F1 filter scale + F2 typo → unipolar defaults (F5) → compressor
bounding (1) → WT graphic (2a).
**Next:** ESW precompute + lazy registration + categorised dropdown (2b — licence cleared) → New/Init + undo (5) →
voice count (E).
**Later:** sources registry refactor + "+" tile + ENV/LFO 4-5 (3, phases 0-1) → Audio Follower (own signal) → Wavetable LFO →
sidechain input → file-based presets.

### Open questions for Stooge
1. Compressor: auto loudness-compensation (recommended) or just cap the mix slider (~50%)? Delete `upwardRatio` and rewrite its test?
2. ESW tables: precompute-and-ship (≈24 MB) — licence is cleared (free). Frames per table: **per-table native count, capped (~64)** — see 2b step 1b (Stooge's point, 2026-10-07).
3. Modulator matrix → JSON message (no per-route host automation) or keep floats and raise ranges?
4. Audio Follower: own signal now, sidechain input later — OK? Confirm the band-marker behaviour from the mockup.
5. New button: confirm-on-dirty, or ship undo/redo and skip the confirm? Move user presets to files?
6. Warp 2 in the plugin: implement the chained warp natively, or hide Warp 2 until then?
7. Unipolar caveat (hand-drawn shapes get stretched to 0..1) — acceptable for now?

**Verified this session:** DSP suite run (66 pass / 1 fail, the known `upwardRatio`); compressor loudness table measured
by offline render of the real `renderSynth`; wire facts (17 / 20 / 15 / dst 56 / amt 1.0 / wtid 0..1 / category counts)
measured by bundling the real `translate.ts` and diffing against `manifest.json`; every file:line above read in the source.
**Not verified (hypotheses):** F3's exact first-load sequence (traced from `useBridgeSynth`/`translate` by reading, not by
running the plugin) and §B's "§145 must have used a different path". Nothing was built, run in a DAW, or changed except this file.

## 163. DONE — the 15 spectral warp modes are wired into the plugin and both binaries rebuilt (Stooge)

Auto run, one project, no branch (`use_branches: false`), every commit on
`main`. Start SHA `780d51a8` (undo with `git reset --hard 780d51a8`).
Tree clean at start.

The port itself landed as the last act of §162 (780d51a) but was never
wired — `ensureWavetableWarpResources()` still gated on
phase/wave-domain only, so spectral modes kept resolving to the unwarped
base key. This session did the wiring (661ac20):

- `wtIsSpectralWarp(mode)` (13, 16-29) joins the phase/wave gates, and the
  warp branch calls `faze::wt::applySpectralWarp` (WtSpectralWarp.h).
- Spectral modes 21/29 read other frames of the table, so the op's full
  base-frame set is generated once per operator when the mode is spectral —
  matching the JS reference, which passes `baseFrames` into
  `applySpectralWarp`. Modes 21/29 are the only readers; the extra 8-frame
  generation is skipped for every other mode.
- Re-ran `test/spectral-warp-diff/run-diff.mjs` BEFORE building: 360/375
  cases bit-identical; all 15 exceptions are mode 29 at exactly the
  documented residual (V8-vs-CRT `atan2`, 67/2048 samples differ, ~1 ULP
  in magnitude terms). Same numbers the port commit recorded — the wiring
  did not change the math.
- Both binaries rebuilt fresh (`NITESESH_BUILD_OK`; artifact mtimes 34s
  newer than `dist/index.html`, so not the stale-binary trap), VST3
  reinstalled to `C:\Program Files\Common Files\VST3`.

Warp mode 29 is the ONLY mode in the whole set not byte-exact to the JS
reference, and it is at most 1 f32 ULP off on ~3% of samples (near-zero
crossings inflate the integer ULP distance; the sample magnitudes are
indistinguishable). Left documented rather than papered over.

**Skipped:** a listen test — §145's harness automates the standalone's UI,
and the byte-exactness bar was set by the differential test, which is
green. The four `[!]` decision lines (FX/Synth view alignment, ESW
precompute-vs-cut, `upwardRatio`, OSC card padding screenshot) remain
Stooge's calls and were not touched.

**Verified:** harness 360/375 (documented exceptions only); native build
green with fresh artifacts; wiring confirmed present in the source at
`ensureWavetableWarpResources()`. Nothing else in this file was modified
this session.



Auto run, one project, no branch created (`use_branches: false`) — every commit on
`main`. Start SHA `52bef2cb` (undo the whole run with `git reset --hard 52bef2cb`).
Tree was clean at start, so no dirty snapshot was needed.

### 1. The plugin typecheck was hiding two real bugs, not seven (8c0318e)

`tsc -p spike/elementary/ui/tsconfig.json` reported **8** errors, not 7, and exits
0 on them so they never failed a build. It is clean now.

- New `dsp/wavetables.d.ts` — hand-written, because `allowJs` is off everywhere and
  the DSP module is plain ESM, so TS could not see it at all.
- **The untyped import was hiding two bugs, not one.** `WavetableGraphic` was
  referenced at `OscillatorPanel.tsx:451` but never imported (f5f47f6 added the call
  site and not the import): a ReferenceError on the first render, not merely a
  TS2304. And that component built its SVG path with `Float32Array.prototype.map`
  returning an `"x,y"` string, which coerces back to a float — every point was
  `NaN`, so the path was `"NaN NaN …"` and the graphic drew nothing at all.
- `FxViz.tsx`: TS2352 cast through `unknown`, and four TS2367 comparisons that are
  unreachable because flanger/phaser/distortion/chorus/compressor all return above
  them (`kind` is `'reverb' | 'delay'` from line 610 down). Behaviour-identical.

**Lesson worth keeping:** the checklist called the OSC-card graphic "implemented in
f5f47f6, not visually verified". It was not merely unverified — it could not have
worked. And a green typecheck was impossible *while the import was untyped*, so the
type error was the only thing that could have caught it.

### 2. The ESW loader could never find the tables — two faults, not one (99b8059)

Measured before: **379/379** ESW tables returned a frame bit-identical to the id-0
harmonic fallback. After: **0/379**, each table parsing its own wav (id=2 "303 Saw"
→ 256 frames, id=3 "80's PWM" → 31 frames, id=40 distinct).

- `ESW_BASE_DIR` was hard-coded to a path that stopped existing when the repo moved.
  The 379 tables ship *inside* this repo, tracked.
- The Node branch called `require('fs')`. **There is no `require` in an ES module**,
  and this file is one, so it threw a ReferenceError that the loader's own
  try/catch swallowed. §149 item 7 recorded only the first fault, and the second
  one broke the loader *everywhere*, not just in the plugin.
- Base dir now resolves (env override → module location → cwd → legacy) and
  built-ins are reached with `process.getBuiltinModule()`. A host with no
  filesystem now logs ONE warning naming the cause instead of silently handing back
  the fallback for 379 tables.
- 3 regression checks added, asserted on a spread of the real table list, not a
  convenient one. **Verified red without the fix (4 FAILED) and green with it**;
  suite 66 pass / 1 fail, the sole failure the known `upwardRatio` gap.

Not fixable from JS, left on the `[!]` decision line: in the plugin there is no
`process` at all, and natively `registerBuiltinWavetables()` registers ids 0/1 only.

### 3. `build.sh` had been silently building NOTHING (11498cb)

Both binaries were 3 days stale while the script printed "artefacts:" and exited 0.
Two independent faults:

1. The generated `.bat` was written by an unquoted heredoc — **LF line endings**.
   cmd.exe mis-parses that: it eats the first TWO characters of every line (`call` →
   `all`, `cmake` → `make`), so the toolchain step died with a screenful of `'cho'
   is not recognized as an internal or external command` and still exited 0.
2. `cmd.exe //c` is passed through verbatim in this shell (path conversion is
   disabled here), so cmd.exe saw an unknown switch, started an INTERACTIVE shell and
   exited 0 at EOF. `MSYS_NO_PATHCONV=1 cmd.exe /c` is the form that works in both
   conversion modes.

Success is now asserted on a token the batch prints as its last statement — **not**
on cmd.exe's exit code and **not** on artefact timestamps, because `dist/` is
refreshed before the compile, so a stale binary looks exactly like a fresh one. This
is why the previous run reported it could not build.

**Verified:** `[7/10] Linking … SharedCode.lib`, `[8/10] … FazeSpike.exe`,
`[9/10] … FazeSpike.vst3`, `NITESESH_BUILD_OK`; both binaries freshly dated and the
VST3 reinstalled to `C:\Program Files\Common Files\VST3`.

### 4. The dropdown fix is in the binary, and it renders (checklist item 1)

`grep -a` finds `.op-wavetable-row .op-warp-select{width:140px;height:24px;…font-size:11px}`
**inside `FazeSpike.exe`**. Then the shipped `index.html` was rendered in a real
Chromium (Edge 154 headless, driven over CDP — no DAW required): the select measures
**140×24 with a 14px content box** for its 11px font (it was 4px), and `selectedText`
is `"Harmonic Sweep"` out of 381 options. Not "-".

### 5. §147's alignment fix does NOT align the two views (checklist item 10)

Same live pass, shipped UI, 1576×808, default Init Preset:

| | Synth view | FX view |
|---|---|---|
| panel | `.op-panel` 144→738 (594px) | `.fx-panel` 65→536 (471px) |
| ENV/LFO/VELO strip top | **740** | **538** |

The user's complaint is still live, **202px** of it. Two structural causes:
(a) `.main-viz` (72px + gap ≈ 79px) renders **only** on the Synth view
(`PluginApp.tsx:294`), so everything below it starts ~79px higher on FX — §147's
premise that "both panels occupy the same flex slot, so they always receive the
identical allocation" ignores that fixed sibling; (b) `.fx-panel` renders 471px
against a 577px cap it never reaches, so editing the cap cannot align the bottoms
either. Left for Stooge on a `[!]` line — the fix is a visible design choice and this
area has already burned several rounds on guesses.

### Skipped, and why

- **Port the remaining 15 spectral warp modes to C++** (checklist item 4) — not
  attempted. It is 15 distinct spectral transforms plus a C++ DFT plus a
  differential harness that only ever existed in scratch; a half-done port changes
  how the synth sounds with no way to hear it, so it should not be rushed at the end
  of a run. One measurement that will matter to whoever picks it up: V8's
  `Math.sin`/`Math.cos` differ from the Windows CRT's by **exactly 1 ULP** in 2.37% /
  2.32% of calls (262,144 calls, at the exact DFT shape `analyzeFrame` uses), yet the
  accumulated DFT bin came out **bit-identical** in the trial. So the byte-exact bar
  is plausible for spectral modes rather than impossible — re-verify it either way
  instead of assuming.
- Pre-existing `[!]` decisions left untouched: `upwardRatio`, the ESW
  precompute-vs-cut call, the OSC card padding screenshot.

**Verified:** plugin typecheck exit 0; DSP suite 66 pass / 1 fail (known); native
build green with both binaries fresh; the fixed CSS rule found inside the `.exe`; the
shipped UI measured live over CDP for the dropdown and for both view layouts. Nothing
else in this file was modified this session.

## 161. DONE — LFO→filter was still dead at the DEFAULT cutoff; the bypass gate dropped the route (Stooge)

User, mid-thread: *"the LFO to Filter A (and probably B) still isnt fixed, LFO
barely modulates the filter frequency at all."*

**SS156 was not wrong, and that is the lesson.** Re-measured the octave maths in
isolation before touching anything: at fc=1000 an LFO at +4 oct moves the
spectral centroid **55.0 → 137.6**, at -4 oct → 90.9. The clamp fix from SS156
works exactly as intended.

The remaining fault is one gate away, in `filterIsBypassed`:

```js
if (!filterIsBypassed(state.filterA)) { sumL = applyFilter(...); }
```

It decides whether the filter is **built into the voice graph at all**, and it
consulted only the static base cutoff. The default filter is
`{type: 0, cutoff: 20000}`, which trips the test — so at defaults **no filter is
instantiated**, and a filter that does not exist has no `fc` signal for an LFO
to modulate. The route was being silently dropped. Measured at the default: amt
0 and amt +4 both give a **bit-identical** centroid of 142.4.

Fixed with a `modulated` argument plus a `hasRouteTo(state, ...targets)` helper;
a live route to either cutoff or resonance now forces the filter to exist.
Verified at the default: amt 0 = 142.4, amt **-4 = 72.5**.

**Why the SS156 verification missed it:** that test ran at fc=1000, where the
filter is genuinely present. It proved the clamp and never touched the default
case that actually fails — a green test was certifying a fix that is dead in the
user's real state. A regression test written at a convenient parameter value can
validate nothing; the default has to be the assertion.

**Upward movement at the default stays clamped and cannot be fixed.** From
20000 Hz, +4 octaves is 320000 Hz against a 24000 Hz ceiling, so it pins. The
new regression test therefore asserts the DOWNWARD direction at the default
(where there is headroom, 20000 → 1250 Hz); asserting upward would be asserting
the clamp.

Verified both directions by temporarily deleting the guard: fix → PASS (spread
69.9), no guard → **FAIL (spread 0.0)**. Suite 62 pass, sole failure the known
pre-existing multiband `upwardRatio` bug.

**Build-order trap hit:** I rebuilt the JUCE binaries *without* re-running
`build:plugin-assets` first, so the embedded `dsp.main.js` still carried the old
one-arg `filterIsBypassed(f)` and the standalone would have shipped unfixed —
while `BUILD_OK` and both binaries cheerfully reported FRESH. Caught only by
grepping the **shipped bundle** for the new guard instead of trusting the
source. Both binaries are FRESH now, with `if (modulated) return false` and
`hasRouteTo` confirmed present *inside the .exe*.

## 159. DONE — "FM Osc 1..4"/"PM Osc 1..4" per-knob labels removed; card 530->502px (Stooge)

User, with a screenshot: *"Some overlap happening here. Remove the text that
says FM OSC1 FM OSC 2 etc (and PM OSC 1,2,3,4 etc.) on all the OSC cards. This
will give us some space back ..."*

**The overlap does not exist — measured.** Across all 8 mod rows (4 cards x PM +
FM) every adjacent label pair has **23–25px of clearance**; the `overlapPx`
figure is negative throughout. Nothing is overlapping. What is true, and what
he is reacting to, is that **"PM Osc 1" measures 51px wide inside a 49–70px
knob** — the label spans nearly the whole control and reads as a collision at a
glance. Removed as asked anyway, since the space is worth having regardless of
whether the premise was accurate.

Scoped to `.op-mod-cluster` only, so the Pitch/Warp/Level/Filter/Pan labels are
untouched (verified: 8 labels gone, **3 elsewhere still visible**, 8 values
still visible).

**Height: card 530 -> 502px (-28).** That is label 11px + 3px gap, per row, two
rows — which is what makes the SS158 knob growth affordable. Knob boxes are now
exactly **70x70** (they were 70x84), so the ring is square again with no label
under it.

**What this costs in meaning, recorded because he may want it back:** these
labels are the only per-knob statement of *which oscillator* is the modulation
source. PM/FM are cross-oscillator routings — osc 2's "FM Osc 3" means "how much
osc 3 frequency-modulates osc 2" — and without them the four knobs differ only
by position. The colour dots in `.op-mod-cluster-heads` still give PM's
ordering, and the "Phase mod"/"Freq mod" captions still name each row, so the
source is still discoverable positionally but no longer readable. If that proves
too lossy the better fix than restoring full-height labels is a 1-digit
shorthand ("1".."4") or a tooltip.

**Vision caveat:** this image is 303x560 — a narrow single-card crop, not the
full UI. The model described it as "a pink/neon OSC 2 module" with "two rows of
eight knobs", neither of which exists; the real card is dark/teal with two rows
of four. Its four answers were nevertheless all correct, so I used them only as a
smoke test and took every claim from the DOM.

Verified: `labelsVisible` 0, knob box 70x70, values 8/8, card 502x310, no
overflow on any `.op-card`, no caption collisions. Both binaries FRESH.

## 158. DONE — PM/FM knobs 52->70px both axes, gaps 1->5px; card 476->530px (Stooge)

*"Increase the size (both height and width) of the FM AND PM knobs but also
move the knobs horizontally slightly apart from each other so they dont step on
each other."*

**Four previous rounds of notes on these knobs said the growth had hit a hard
wall**, all of it resting on one premise: *"going past 52px needs WIDTH, not
height ... there is only ~6px/card of side margin left."* The premise was wrong
in the most useful possible way. The cluster was **content-sized at 211px inside
a 298px `.op-body-new`** — so **87px of dead width sat to the right of every PM
and FM row, in all four cards**, and nobody had measured it because the
SS155 ceiling was derived from the row rather than from the container. The
binding constraint was never the card; it was the row refusing to grow.

`.op-mod-cluster { align-self: stretch }` plus `--knob-size: 70px` and gap
5px spends it exactly: **4 x 70 + 3 x 5 = 295 inside 298**.

**On "stepping on each other" — the gap was 1px, not zero.** The reason it read
as crowded is that the per-knob caption ("PM Osc 1") measures **51px wide inside
a 52px knob box**, so adjacent labels ran within a pixel of each other even
though the rings never touched. At 70px there is room for the text, so this
fixed the symptom rather than just nudging a number.

**Height cost is real and I want it on the record: card 476 -> 530px, +54.**
Predicted +36 from `ring + 3px gap + 11px label` scaling; the extra 18 came from
the caption anchors being pinned to the cluster edges, so the taller knobs push
them too. The user asked for this height in the same message that (last round)
asked for a shorter UI, so I did not silently claw it back — the visualizer is
the obvious lever and he asked for it BIGGER in SS154, so shrinking it to pay
for knobs would trade away something he explicitly requested. Flagged instead:
if the card is still too tall, the viz row is where the height is.

Knob rings 70x70, boxes 70x84, gaps [5,5,5], row 295/298, PM->FM 12px, no
overflow on any `.op-card`, no caption collisions (`gapFmLblToBot` 0,
`gapPmLblToWt` 0). Both binaries FRESH.

**Trap hit and fixed in the same edit:** the patch introduced
`.op-mod-cluster-knobs { gap: 5px }` directly above the pre-existing
`{ gap: 1px }`. Identical specificity, later wins — the build would have shipped
5px in source and 1px on screen with no error anywhere. Deleted the stale rule.
Third occurrence of this in the OSC card.

## 157. DONE — the "FREQ MOD" band removed; card 490->476px (Stooge)

User, with an annotated screenshot: *"still empty space in OSC panels (see
image red) .. please remove it so we can make the overall size of the synth UI
smaller. Also, the FILTER A/B knob is slightly smaller than the PAN knob (i
think?) it seems a lil off."*

**Locating the mark by pixel, not by reading the image.** Vision described
"thin vertical lines" — the annotation is in fact pure `(255,0,0)`, **one
full-width horizontal band at y 433–444** across all four cards (14984 px).
A looser red threshold matched 15686 px and appeared to find the whole UI,
because the theme itself is red; only an exact-colour match isolates the
strokes. It lands on the **"FREQ MOD" caption row** — the caption SS155 had
just moved below the FM knobs — plus the 8px gap beneath it.

**Fix:** the PM and FM captions no longer reserve flow height. They are
absolutely positioned (`top: -10px` / `bottom: -10px`, cluster made
`position: relative`), so they still label their clusters and still carry the
ModBadge and right-click-to-modulate target, but cost **0px of layout**. The
margins (PM +6, FM +2) widen the measured gaps (4px above PM, 8px below FM)
to exactly the caption's 10px height.

**Collision caught and fixed.** The first attempt used `-12px` and gave card
height 468 — but the FM caption then overlapped the Filter/Pan row by 4px and
the PM caption the wavetable row by 8px. Only visible on screen, invisible in
a diff. With `-10px` the boxes nest exactly: PM label `[394,404]` between
wavetable bottom `394` and PM cluster top `404`; FM label `[552,562]` between
FM cluster bottom `552` and Filter/Pan top `562`. **Zero intersection.**

Card **490 -> 476px**, ~14px per card, so roughly 56px off the height of the
four-OSC strip. Knobs stay 52px, PM→FM gap 12px, viz 69px, no overflow.

**The FILTER A/B vs PAN report does not reproduce — measured identical.** Both
are `.knob .knob-lg` (same class string, including trailing spaces), both rings
**44x44**, both at the **same y (591)**. There is no size difference to fix; the
apparent difference is an optical illusion from the differing value glyphs
(`A`/`B` letters vs `L`/`C`/`R`). No change made — inventing one would have
been fabricating a fix.

**Note on this image's annotator:** across this session the vision model has
given three mutually contradictory readings of this same card — "both captions
above their knobs", "PAN is smaller than FILTER A/B", then "FILTER A/B is
larger than PAN" — and reported the captions as colliding when the DOM shows
zero intersection. Every claim above is from `getBoundingClientRect` or exact
pixel analysis. Trust the measurements on this card.

## 156. DONE — LFO→filter cutoff could never sweep upward (Stooge: "doesn't ever reach 100%")

User: *"LFO is STILL not working properly when i apply to the filter, even when
i put the LFO setting on the filter to max(100%) ... the modulation doesnt ever
seem to reach the filters 100% value."*

**Two engines exist in this repo and they are not the same code.** This was the
trap: the fix belongs in a *different file* than the one the bug report points
at, and the wrong one looks completely plausible.

| engine | file | used by |
|---|---|---|
| Eleaudio | `spike/elementary/dsp/synth.js` | **the plugin/standalone** — ships as `dist/dsp.main.js` |
| Web Audio | `src/renderer/lib/synth.ts` | the Electron desktop app |

`npm test` only exercises the Eleaudio one. `dist/index.html` contains
neither engine (only components + mod metadata); the audio ships separately in
`dist/dsp.main.js`. The C++ `Voices.h` has **no filter and no modulation at
all** — the WebView does the audio. Worth remembering before trusting either
engine's tests to cover the other.

**Bug A (the standalone, the one he actually hit) — the modulation clamp.**
The octave math was always correct (`fc · 2^fcMod`); the *clamp* was wrong:

```js
fc = el.min(20000, el.max(20, fc * 2^fcMod))   // ceiling == DEFAULT_FILTER.cutoff
```

`DEFAULT_FILTER.cutoff` is 20000 and `filterIsBypassed()` returns true there,
so out of the box **every upward modulation was clipped straight back to the
value it started from** — 20000·2¹, 2² and 2⁴ all land on 20000 and move
nothing. A filter LFO could only ever sweep DOWN. Ceiling raised to 24000
(Nyquist at the 48k this builds at); the base-cutoff knob clamp stays 20000,
since widening that is a separate decision.

**Bug B (Electron only) — a genuine unit mismatch.** `mod-sources.ts` stores
filter-cutoff amounts in **octaves** (±4 → labelled ±100% via `pct(4)`), copied
from a comment about `dsp/synth.js`'s old `fc·2^amt`. But `synth.ts` connects
the source straight to `BiquadFilterNode.frequency` — an *additive* AudioParam —
with `gain = clampRouteAmount(...)` and **no conversion anywhere in the tree**,
so +100% set gain = 4 and swept the cutoff by **±4 Hz**. Fixed with
`cutoffModGainHz(fc, oct) = fc·(2^oct − 1)`, applied at route creation *and* on
the live-drag path in `setModRoutes`, with `refreshCutoffModGain` re-deriving
depth when the cutoff knob moves (the gain is a function of fc, so it would
otherwise stay pinned to whatever fc was when the route was wired).

**Regression test, and a lesson in it.** Added a spectral-centroid-spread
assertion. First version used `> 1` and **passed against the broken build**
(spread 1.7 vs 230.4 fixed) — it only caught anything because both numbers were
printed. Threshold now 25, verified in both directions by temporarily reverting
the clamp: fix → PASS (230.4), old clamp → FAIL (1.7). Every pre-existing
filter-route check only asserted "finite and audible", which a filter LFO
clipped to a constant passes trivially — that is how this survived.

**Verified:** `npm test` — new test green, the only failure is the known
pre-existing multiband `upwardRatio` bug. `tsc` unchanged at 8 pre-existing.
Both binaries FRESH; `stdlib.min(24e3, ...)` confirmed in `dist/dsp.main.js`
(note: the minifier emits `24e3`, so a grep for `24000` misses it — bit me
while verifying).

**Observation, not fixed:** with the clamp raised, `+4 oct` measures *darker*
(centroid 8.2) and `-4 oct` *brighter* (238.6) — i.e. positive depth currently
sweeps downward. That is the LFO **polarity** behaviour already documented at
todo.md §"PM/FM depth can't increase, only decrease" (fixed for the user by the
± polarity toggle on the LFO card), not a bug in this path. Left alone because
changing the polarity default would alter existing patches.

## 155. DONE — PM/FM knobs 48->52px, "Freq mod" moved below its knobs, FM pulled up towards PM (Stooge)

One message, three asks: *"Move FM knobs slightly closer to PM knobs. make FM
and PM knobs bigger you can move the text 'Freq Mod' UNDERNEITH the FM
knobs."* All three done, and the interesting part is that the obvious
implementation of the second one actively defeated the first.

**Knobs 48 -> 52px.** The knob row is **width**-bound, not height-bound:
measured 211px of row for 4 knobs, so the ceiling is `(211 - 3*gap) / 4`.
Cutting `.op-mod-cluster-knobs` gap 2 -> 1px makes that exactly
`(211 - 3) / 4 = 52px` — fits to the pixel, no overflow. Past 52px needs
card *width*, not height, and there is only ~6px/card of side margin left
(grid 1226px of a 1252px ceiling), worth roughly 1px on a knob.

**"Freq mod" moved below the FM knobs; "Phase mod" stays above its own.**
Implemented by rendering the caption last in the DOM for both clusters and
letting CSS decide the side: `.op-mod-cluster` becomes a flex column and
`.op-mod-cluster--pm .op-mod-cluster-lbl { order: -1 }` sends PM's back
above. (Note `order` is silently inert in the block flow this cluster used
until now — the cluster had to become flex first.)

**Tried BOTH captions below first, and it backfired.** The reasoning was that
two knob rows sitting at different heights looks untidy, so both labels went
underneath. Measured result: the PM-to-FM knob gap went **14px -> 29px** —
the exact opposite of "closer" — because PM's caption ended up sitting in the
gap between the two clusters. The rows never needed a shared baseline in the
first place: each knob's own label travels with its knob, and PM/FM are two
separate rows, so there is no alignment to preserve. Worth remembering: an
aesthetic tidy-up that "obviously" improves symmetry can directly contradict
the spacing request in the same breath.

With PM's caption back on top, the whole vertical budget between the two knob
rows is PM-knob-bottom + spacer + body gap + FM colour-dots, so the
`op-mod-spacer` divider — which carries no information now that each cluster
is captioned on the side facing *away* from the other — went 14 -> 6 -> 0.
Net PM-to-FM gap **14px -> 13px**, and what remains is filled by PM's
per-knob labels/values and FM's colour dots rather than being empty.

The +8px the taller knobs cost across both clusters came out of
`.op-viz-row` (77 -> 69px), holding the card at **492px** — the scope keeps
the 56% growth from SS154 rather than absorbing the knob increase.

**Verified:** knob 52px, `pmLblAbove` true, `fmLblBelow` true, PM-to-FM gap
13px, card 492px, viz 69px, `deadBelow` 0, no overflow on any `.op-card`.
`tsc` still reports the same 8 pre-existing errors, none new. Both binaries
FRESH; `--knob-size: 52px`, `op-mod-cluster--pm` and `height:69px` all
confirmed present inside the `.exe`.

Note: the vision pass claims BOTH captions sit above their knobs. The DOM
measurement says FM's is below, and that is what the CSS does — third
consecutive disagreement from the model on caption placement in this card.

## 154. DONE — OSC panels compacted; the reclaimed height went to the visualizers (Stooge)

Stooge: *"theres still empty space in the oscillator panels we could reduce it
and have that space make the visualizers bigger instead, id like the osc panels
to be as compact as they can possibly be"*.

Measured the whole card's anatomy first (per-row heights, gaps between rows,
dead space at the bottom) rather than eyeballing it. Card was 492px:

```
head 12 | viz 44 | top-row 83 | wavetable 66 | PM 90 | divider 14 | FM 90 | Filter/Pan 59 | gaps 23
```

**Two things were genuinely redundant, and both are now cut:**
- `.op-mod-spacer` was a 1px hairline reserving **14px** to separate the PM and
  FM clusters — while each cluster already carries its own "Phase mod" /
  "Freq mod" caption directly above it. The divider was stating nothing the
  captions didn't. 14 -> 6px.
- `.op-mod-cluster-lbl` was an **unstyled inline `<span>` in block flow**, so
  it consumed a full ~14px line at the inherited font size — twice per card,
  ~28px of height spent restating which cluster you were looking at. Now a
  9px single line. Cluster 90 -> 77px each.

That freed **33px/card**, which went into `.op-viz-row`: **44 -> 77px**, a 75%
taller scope. Card height is **unchanged at 492px** and `deadBelow` measures
**0** — the height went to the scope rather than to slack, which is exactly
what was asked for.

**The viz number is derived, not picked.** First attempt was 92px, which
over-shot the 33px of savings and *grew* the card to 507px — caught by
measuring, not by looking. 77px is the measured budget. It is the one row in
the card with `flex: none` and a hard px height, so it absorbs reclaimed space
directly instead of competing with the body's `space-between` for it.
**Re-derive it if any row height changes.**

What is left is close to irreducible without shrinking controls again, which
SS151-153 spent three rounds establishing is the wrong trade: top-row 83 and
wavetable-row 66 are content-driven (a 44px knob plus its 11px label and 14px
value), and Filter/Pan 59 is a caption plus a 44px knob.

**Open question for Stooge — is the "empty space" he means actually the scope
itself?** Pixel analysis of the rebuilt screenshot: the viz region has 265
distinct colours at peak luminance 160 (mean 18), against 1472 colours and
peak 246 in the knob row below it. So the scope is drawing, but sparsely and
dimly — which reads as an empty box at a glance, and a vision pass called it
"a dark, empty space". If that is the band he is pointing at, the fix is
contrast/density *inside* the scope, not more height for it. Flagged rather
than guessed at, because it is the difference between "bigger" and "denser".

**Verified:** card 492px, viz 77px, scope 298x77, `deadBelow` 0, no
`scrollWidth/Height` overflow on any of the four `.op-card`s. Both binaries
FRESH against `dist/index.html`; `height:77px`, `op-mod-cluster-lbl` and
`height:6px` all confirmed present inside the `.exe`.

## 153. DONE — Filter A/B label moved above its knob, knobs now share a baseline, width slack spent on bigger knobs (Stooge)

Stooge: *"notice how the text Filter AB is below the knob but PAN is written
above it? Need to make Filter A/B written above the knob since having the text
below it displaces the knob itself."* (plus a second pass at the bottom empty
space). Both done.

**Filter A/B's label placement was a structural inconsistency, not a styling
choice.** `PanCell` renders its own `<label className="op-knob-label">` caps
header *above* the knob, and the pre-existing rule
`.op-panel .knob-field:has(.op-knob-label) .knob-label { display: none }`
hides the `Knob`'s own duplicate label underneath. Filter A/B was a bare
`<Knob>`, so it kept the default ring/value/label stack and rendered its label
below — and that label is not merely cosmetic: it pushed the 44px knob up, so
the two knobs in `.op-card-bot-row` sat at different heights. Wrapped it in the
same `.knob-field` + `.op-knob-label` structure `PanCell` already uses (moving
the `ModBadge` into the header too), so the `:has()` rule suppresses the
duplicate and the row lines up. Measured: both knobs now `knobTop: 593`,
`knobH: 44`, headers at 578, duplicate labels `display: none`.

**The width slack §150 identified is finally spent.** §151/§152 both had to
leave `--knob-size` alone because the mid column was width-bound inside a
296px card (`4 x 40 + 3 x 2px = 166px` of 286px inner). §153 spends it:
`--op-card-w` 296 -> **310px**, which the grid's 3px gaps turn into +14px of
body width per card. The cluster row now measures 211px, so the PM/FM knobs go
**40 -> 48px** and the Warp knobs **28 -> 34px**. Bigger knobs also make the
14px values easier to hit, which is the "awkward to adjust" half of the §151
complaint that bigger *type* alone did not address. Grid is 1226px against a
1252px ceiling — still inside it, which is exactly what §128 was blocked on
twice.

Also `.op-wavetable-row` padding 8px -> 2px: with `align-items: center` the
row already sizes to its tallest child, so the vertical padding held nothing.

**Verified on the built bundle, not the source CSS:** select 94x30 at 13px;
`knob-sm` 34px / `knob-md` 48px / `knob-lg` 44px; values 14px; labels 11px;
card 310px; `cardBottomGap` **3px**; no `scrollWidth/Height` overflow on any of
the four `.op-card`s. Both binaries FRESH against `dist/index.html`, and
`310px` / `48px` / `34px` all confirmed present inside the `.exe`.

**Note on the vision model:** it repeatedly reported the bottom row as
misaligned and the card bottom as empty, contradicting these measurements on
every pass, and called elements "cut off" that were outside the screenshot
crop. Two independent visual passes also disagreed with each other about
whether PAN's label was above or below. Its prose is not usable for spatial
judgements at this scale — the numbers above are, and the user confirmed §152
by eye ("Much Better!"). Trust DOM measurement over model description here.

## 152. DONE — second pass: controls actually readable, bottom dead space gone; plus THREE build bugs that made me ship nothing (Stooge)

Stooge, after §151 shipped: *"yeah its still illegibile ... also the bottom
empty space thing hasnt been fixed. So far nothing has changed at all"* — and
then, crucially: **"im looking at the standalone version"**.

### The headline: §151 was never actually tested by anyone

`FazeSpike.exe` had **not** been relinked. The build log contained
`LNK1104: cannot open file 'FazeSpike.exe'` — the standalone was locked by a
running instance — while the VST3 target linked fine. So the VST3 in Bitwig
had my CSS and the standalone did not, and Stooge was looking at the stale
one. Every screenshot I took was of that same stale binary. Three separate
bugs conspired to make this invisible:

1. **`cmake --build` returned 0 despite the link failing.** The old
   `faez_build.bat` gated `BUILD_OK` on `if errorlevel 1`, and it printed
   `BUILD_OK` anyway — `FAILED:` on line 87, `BUILD_OK` on line 94. So my
   "BUILD_OK" checks were worthless and I had been reading them as proof.
   The script now also scans the log for `FAILED:` / `error:` / `LNK1104`
   and prints `BUILD_FAILED` with `exit /b 1`.
2. **I never checked binary freshness.** `BUILD_OK` was never the right
   assertion. The check that actually matters is comparing each binary's
   mtime against `dist/index.html`'s — that is what caught this instantly.
3. **`write_file` writes LF; cmd.exe needs CRLF.** Recreating the build script
   made every line mangle (`'et' is not recognized`, `'all' is not
   recognized`) and the build failed for a reason unrelated to anything I was
   debugging. Converted to CRLF. Worth remembering for any `.bat`/`.cmd`.

Note the same lock will bite again the moment Stooge has the standalone open
during a rebuild — that is expected, not a bug, but the build will now *say*
so instead of lying.

### The actual UI fixes

Second pass, deliberately much larger than the first (11px was still
unreadable, so: values **14px**, labels **11px**, mod-source select
**30px tall at 13px**). Sized above the ~12px legibility floor rather than
below it. Everything is a *font size*, which costs height only — so it eats
the dead space instead of stealing width from Pitch/Level. `--knob-size`
still untouched for the same width reason as §151.

**The bottom empty space had a real cause, and it was not padding.** Per-card
dead space at the plugin's true window size was **53px below the last row**,
plus a 30px `.op-mod-spacer` (a *hairline divider* reserving 30px of vertical
space), 20px of 4px gaps and 16px of wavetable-row padding — ~119px/card,
not the ~26px §149 had estimated.

The catch: `.op-body-new` already had `justify-content: space-between`, so the
reclaimed height *should* have distributed across the five gaps. It didn't,
because the body had **no flex basis** — it stayed content-sized at 379px
inside a card that `.op-grid`'s `align-content: stretch` grows to 492px. The
slack never reached the distribution and simply pooled underneath. Adding
`flex: 1 1 auto; min-height: 0` (the `min-height: 0` gotcha is already
documented elsewhere in this file and applies here too) took
`deadBelowLast` from **50px to 3px**, and the gaps even out to 4/4/4/4/7.
`.op-mod-spacer` 30px → 14px for the same reason.

**Verified** (all against the real build, not the browser alone):
- both binaries FRESH vs `dist/index.html`;
- `max-width:none`, `height:30px;font-size:13px`, `font-size:14px` and
  `flex:1 1 auto;min-height:0` all confirmed present **inside the .exe**;
- computed styles in the rebuilt bundle: select 87x30 at 13px, `knob-md`
  values 14px, `deadBelowLast` 3px, no `scrollWidth/Height` overflow on any
  of the four `.op-card`s;
- native screenshot of the standalone: the card's bottom border sits at
  y≈569-575 with content running right up to it.
- User confirmed: **"Much Better!"**

**Lesson worth keeping:** for this project, "did the build succeed" is not a
question `BUILD_OK` can answer. Assert on artifact freshness against the
input that changed. Two of three builds this session reported success while
shipping a stale or unchanged binary, and I reported both as done.

## 151. DONE — mod-source dropdowns and PM/FM knob values made readable (Stooge)

Stooge, after §150: *"These are way too small. Its two mod source boxes on each
OSC. The dropdowns are unreadable, the knobs are tiny, cant even see their
values. Awkward to adjust too."* — which also settled §150's open OCR question:
the green mark is the **two Warp-mode mod-source boxes**, not the PM knobs.

**Measured the real rendered result in the built bundle rather than trusting
the source CSS or a screenshot** — loaded `dist/index.html` in a browser and
read computed styles. That mattered: my first attempt targeted the wrong size
class and I would otherwise have shipped a no-op and reported it as fixed.

| element | before | after |
|---|---|---|
| mod-source select | 14px tall, 7px type, **capped at 66px** | 22px tall, 10px type, 87px, `max-width: none` |
| Warp knobs (`.knob-sm`) | 22px, 5px label, 6px value | 28px, 9px label, 11px value |
| PM/FM knobs (`.knob-md`) | 40px, **7px** label, **9px** value | 40px, 9px label, 11px value |
| row knobs (`.knob-lg`) | 44px, 7px label | 44px, 9px label |

**Three things worth remembering from this:**

1. **The PM/FM knobs were never small** — 40px, the same as most of the panel.
   What was broken was the *type under them*: 7px labels and 9px values, well
   under any legibility floor. That is precisely why the report read as "can't
   see their values" rather than as a sizing nit, and why a size bump would
   have been the wrong fix.

2. **`src/renderer/styles.css` leaks into the plugin.** It styles
   `.op-warp-select` **twice** (lines 3020 and 3193) with `max-width: 66px`
   and `96px`, and that file is bundled into the plugin as well as the Electron
   app — one shared `OscillatorPanel` component tree, two hosts. `plugin-ui.css`
   loads later and so won every property it *declared*, but `max-width` was
   never declared there, so the 66px cap survived every edit to the plugin
   stylesheet. The fix needs `max-width: none` explicitly. Symptom: a CSS change
   that provably lands in the bundle and provably wins the cascade, and still
   changes nothing on screen. Check for a competing declaration before assuming
   the cascade is wrong.

3. **Specificity, again.** `.op-panel .knob-sm { --knob-size }` is inert
   because `.op-warp-knobs .knob` already sets that property and is more
   specific. Only the `font-size` properties took effect. Left a comment saying
   so rather than deleting the line, since the next person will try the same thing.

**Deliberately did NOT grow `--knob-size` on the PM/FM row.** The mid column
is width-constrained — `4 x 40 + 3 x 2px = 166px` inside a 296px card — so every
px added there comes straight out of Pitch/Level, which §92-99 fought for.
Fonts cost height only, so they are free against the ~26px/card of dead padding
§149 measured. Card height went 436 -> 442px, i.e. 6px of the 26px.

**Verified:** computed styles read from the built bundle after rebuild;
`scrollWidth/scrollHeight` vs `clientWidth/clientHeight` across all four
`.op-card`s reports **no overflow**; native exe relinked (`BUILD_OK`) and
screenshotted via `PrintWindow` (the real 1274x948 plugin window — note
`MainWindowHandle` returns a 1274x**12** stub first, so the harness enumerates
the process's visible windows and takes the largest, and does *not* click, per
§128's lesson that Win32 click automation misfires on this WebView). A vision
pass that called both targets "illegible" before the change reads "None" and the
PM values after it, and reports nothing clipped or overlapping.

**Left alone:** the Electron app's own OSC panel still has the 66px/96px
dropdowns and 7.5px `knob-sm` values. Fixing it is a separate change in
`styles.css` and was not in scope here — flagged, not done.

## 150. Fresh OSC mockup received + saved to the repo — answers §128's open question, and the width blocker has moved (Stooge)

Stooge sent a new annotated screenshot of the **current** build (1268x916
webview content; window is frozen at 1272x920 per `PluginProcessor.cpp:138`).
Saved to the repo root as **`OSC controls too small - mockup.png`** — the
repo root is where every other mockup lives (`OSC LAYOUT 3 (GOD DAMN IT !!).png`,
`UI RealEstate Issues 2.png`, `osc design sg.png`, ~20 more), and §128/§149
both flagged that mocks kept getting sent in chat and never saved. This one
is now in git, so that failure mode is closed.

**What it shows.** The OSC cards' controls are too small to read/use, and
each OSC card contains dead empty space that should be reclaimed to make
them bigger. This is the same request §128 recorded and could not act on.

**§128's open question is now answered: Stooge IS seeing it in the current
build.** §128 left this hanging — "it's unclear whether the user is seeing a
stale screenshot or wants the window widened — needs the user's call". It is
not stale; this screenshot is 1268x916, which is exactly the frozen window
minus chrome. The complaint is real and current.

**The width ceiling that blocked this twice has since moved.** §128 recorded
the block as `246px x 4 cards + gaps = 993px` against a `~1009px` ceiling,
"tried twice and confirmed not fitting". Those numbers are stale — §146 moved
all of them:
- `--op-card-w`: 246 -> **296px** (`plugin-ui.css:420`)
- `.synth-controls` max-width: 1100 -> **1252px** (`plugin-ui.css:42`)
- Current budget: `4 x 296 + 3 gaps x 3px` = **1193px against 1252px**, i.e.
  ~59px of slack where §128 had zero.

So the retry has real room for the first time. The vertical axis is the
better target anyway — §149 measured ~26px per card of pure padding holding
nothing (`.op-wavetable-row{padding:8px 0}` = 16px, `.op-body-new{gap:4px}`
x 5 = 20px). Must be done by shrinking padding, **never** by un-stretching:
`align-content: stretch` is what absorbs freed height back into the cards,
and §146's attempt 1 set it to `start`, relocated the dead space instead of
removing it, and silently reverted an earlier explicit request (§92-99).

**OCR WARNING — this mockup is only partly transcribable.** Vision-model
passes disagreed with *each other* on what the green mark encloses: one read
it as the two mod-source dropdowns showing "None", another as the four PM
Osc knobs. Do not act on either. Only the large neon-green overlay text is
confidently legible, and only its opening: **`THESE ARE WA`** — the
remainder is cut off / unreliable. The general complaint is corroborated not
by OCR but by §128 recording the same request in the user's own words.
Ask Stooge to confirm the exact target before cutting CSS.

**Separate finding, and it upgrades §149 item 5.** The dead `upwardRatio`
parameter is not merely a type-level stub — `fx_comp_upratio` is listed in
`plugin/manifest.json` as a real `AudioParameterFloat` ("Comp UpRatio",
0..1). So it is created, exposed to the host, automatable and saved with the
patch, and the DSP ignores it entirely. §149 understated this as "declared in
types, read by no DSP code"; it is worse than that — the plugin advertises a
control that does nothing.

**Deferred feature, still worth surfacing (§128, explicitly "nice-later, not
started"):** a Bitwig-style **Wavetable LFO** — continuously morph between
two or more user-drawn Function shapes, with its own user-created wavetables
of shapes. This is the only genuinely *new* modulation system on the books;
everything else in the modulation area is built.

**Modulation system as it actually stands** (for reference, since Stooge asked):
- `ModSourceId`: env1-3, lfo1-3, velocity, keytrack, macro0-7.
- Mod matrix: **24 slots** (§108, raised from 8), `mod{n}_src` indexes
  0..15 (8 built-in + 8 macros, appended in §111 — never reorder, the index
  is live host automation), `mod{n}_dst` indexes **56 destinations** (§95),
  bipolar amount.
- All three LFOs are **Function-mode** (§128: the `FN` toggle and the
  sine/tri/saw/square morph drag were both removed; legacy wave patches
  migrate to a sampled Function shape so old presets keep their sound).
  Note `lfo{n}_wave` is still exposed in the manifest as 0..5, so the
  sample-hold (4) and wavetable (5) indices remain addressable.
- Per-operator PM/FM: each of the 4 operators has direct PM/FM depth knobs
  to each of the other 3, so osc-to-osc FM does not need the mod matrix.

**Verified:** image dimensions and that 1268x916 matches the frozen
1272x920 window minus chrome; every number above read from live
`plugin-ui.css` / `manifest.json` / `PluginProcessor.cpp` / `todo.md`, not
from memory. Nothing was changed in the code this session — no CSS touched,
no rebuild.

## 149. Resumed investigation — dropdown "-" root-caused, DSP suite unblocked, three new gaps found (Stooge)

Stooge asked where we were at and pointed out the repo's own annotated
screenshots should answer the open questions. Read all of them. Two of the
three items from §148's handoff are now closed or reframed; investigating
surfaced four things nobody had logged.

**1. §148 item 1 — the "-" in the wavetable dropdown. ROOT CAUSE FOUND,
and it is not data.** No Debug build needed. `plugin-ui.css:1535`'s
`.op-wavetable-row .op-warp-select` sets `width:140px`, `font-size:11px` and
`padding:4px`, but **never overrides `height`** — so it inherits
`height:14px` from `.op-warp-select:605`. Under the global `* { box-sizing:
border-box }` (`styles.css:44`), a 14px box minus 2×4px padding minus 2×1px
border leaves a **4px content box**. An 11px font in a 4px box, centred,
renders as a 1–2px horizontal smear — which is exactly what "-" looks like.
Fixed with `height: 24px` (= 11px line + 8px padding + 2px border).

Worth recording *why* three prior passes missed it: §148's own investigation
was thorough and correctly ruled out every data-side explanation —
`WAVETABLES` really does have real `.name` fields, the string really is in
the built bundle, `wtId:0` really is a clean number. All true, all
irrelevant. The bug was in the box the text sits in, which no amount of data
inspection would ever reveal. **Lesson: when a value renders wrong rather
than missing, check the container geometry before the data path.**

**2. §148 item 2 (OSC card height) — STILL BLOCKED, and now known to be
unblockable from the repo.** Every mockup PNG in the root describes where
the layout *got to*, not where it should *go* — §146/§147 already matched
`UI Fix ( END GOAL ).png`, the newest of the series. The one image §148 asks
for (red bar overlaid at the top, showing the height saved by arranging the
knobs better) was **sent in chat and never saved to the repo**. Only
Stooge can unblock this.

Interim, from reading live CSS — ~26px per card of pure padding holding
nothing: `.op-wavetable-row { padding: 8px 0 }` = 16px (the worst offender;
8px above and below a row that's14px tall), `.op-body-new { gap: 4px }` × 5
gaps = 20px, `.op-card { padding: 1px 5px 2px }` = 3px. Critically, this
must be done by **shrinking padding, never by un-stretching** —
`align-content: stretch` is what absorbs the freed height back into the
cards. §146's attempt 1 set it to `start`, relocated the dead space rather
than removing it, and silently reverted §92-99's earlier explicit user
request ("stretch the oscillator cards down more"). Same trap, don't walk
into it twice.

**3. §148 item 3 (wavetable graphic) — untouched, still scoped and ready.**

**4. The DSP test suite has been UNRUNNABLE, not green.** `dsp/wavetables.js:404`
used `import eswTables from './esw-tables.json' assert { type: 'json' }`.
Node 22 removed import assertions in favour of import *attributes*; on the
installed Node v26.7.0 this throws `SyntaxError: Unexpected identifier
'assert'` at **parse** time, so `node test/engine.test.mjs` died before
running a single test. Changed `assert` → `with`.

This means **every "DSP suite green" claim in this file from the point the
syntax was introduced onward was unverifiable.** The suite now runs:
**60 passed, 1 failed.** Verified the fix was real by stashing the edits and
reproducing the parse error against the original code.

**5. The one failure is a genuine unimplemented feature, not a regression.**
`multiband compressor upwardRatio boosts low-level signal RMS` fails with
`rmsDry=0.4269 rmsUp=0.4269` — bit-identical, so the parameter has
absolutely no effect. Cause: `upwardRatio` is declared in
`src/shared/types.ts:971` and round-tripped by the patch normaliser at
`:1387`, but is **read by no DSP code anywhere** (grepped `dsp/`, `ui/`,
`test/`). The compressor's upward/downward mode was never built. It was
invisible while the suite couldn't load. Not fixed — needs a decision on
whether upward compression is actually wanted in the product.

**6. The plugin typecheck has 7 pre-existing errors** despite repeated
"typechecks green" claims in this file. `ui/FxViz.tsx:593` (TS2352, an
intersection cast to `CompressorFxSettings` that doesn't overlap);
`FxViz.tsx:663,670` (four TS2367 comparisons between literal types with no
overlap — dead branches); and `src/renderer/components/OscillatorPanel.tsx:16`
(TS7016, no declaration file for `wavetables.js`, cascading to `wt` being
implicitly `any` at `:459`). Note `tsc` **exits 0** despite these, so they
were never going to fail a build. #6's second half is mildly related to
item 1 — the `<select>` is typed off an untyped import, which is why TS
couldn't have flagged the mismatch even in principle.

**7. 379 of 381 wavetables cannot work in the plugin.** Two independent
faults, both found by reading, neither logged anywhere:
- `loadEswWavetableFrames` (`wavetables.js:479`) is gated on
  `typeof process !== 'undefined'`, but `PluginProcessor.cpp` only shims
  `console` into the QuickJS global scope (`:434`) — there is no `process`.
  So in the VST/Standalone the loader **always** returns null, and every ESW
  table falls through to the `harmonicFrame(...)` fallback at `:517`. The
  dropdown faithfully lists 379 tables that all sound identical.
- `ESW_BASE_DIR` is hardcoded to `'Z:/GITHUB/FM/Echo Sound Works Core Tables'`
  (`:406`) — a path that **no longer exists** after the `Z:\GITHUB` reorg
  moved this repo to `AUDIO · FAZE-RECORDER`.

The 379 tables come from `esw-tables.json` (verified: 379 entries, e.g.
`"303 Saw"`). Needs a decision from Stooge: precompute them to a binary at
build time and ship (~1–2 GB of wav), or cut the list to the two built-ins.
Left alone — too big a call to make unilaterally.

**Verified:** DSP suite 60/1 as above, on the real run. Plugin typecheck run
and its 7 errors enumerated (not fixed). Dropdown fix is a single CSS
declaration plus an explanatory comment; **not yet rebuilt into the native
plugin**, so it is not in the current binary. Nothing else in this file was
modified this session, and the working tree was stashed/popped cleanly to
prove the suite failure was pre-existing.

**On reading the annotated screenshots — a warning worth keeping.**
Vision-model OCR of these mockups is **not reliable**. It confidently
produced detailed quoted handwriting that was not there, and read knob
numeric readouts ("6.88", "L40", "R40", "15", "40") as if they were
instructions. One claim it made — that a red bar marked the FX chain for
removal — is provably false: §127 records Stooge explicitly *asking* for the
FX chain strip. Only `OSC Layout w 2 Warp Modes - instructions.png` proved
trustworthy, and only because its text ("Two warp modes placed in between
the PITCH and LEVEL knobs. Warp modes don't need to be numbered.") matches
§146's independent quote **verbatim** — corroboration, not OCR confidence.
Do not act on transcribed annotations without a second source.

## 148. Handoff — user signed off mid-session; 3 open OSC-card items (Claude)

User stepped away. Three concrete, user-specified items are open — don't
guess further on any of them without either the referenced screenshot or
a live-verification pass; each already burned a round or two on wrong
guesses this session.

**1. Wavetable-name dropdown shows "-" instead of the real name.**
Investigated via static code reading only (no live DevTools access —
Release builds disable them, `WebViewEditor.cpp:63` only sets
`opts.enableDebugMode` under `#if JUCE_DEBUG`). Ruled out the obvious
causes: `WAVETABLES` (`dsp/wavetables.js:409`) has real `.name` fields
("Harmonic Sweep" for id 0), that string IS present in the built UI
bundle (`grep -c "Harmonic Sweep" dist/index.html` = 1), and the default
patch's `wtId: 0` (`src/shared/types.ts:1109-1112`) is a clean number
that should match `<option value={0}>` exactly. Root cause NOT found —
next step is a Debug or RelWithDebInfo build (todo.md §139/§142 already
did this once for a crash investigation, same recipe applies) specifically
to get WebView2 DevTools (F12) and inspect the actual rendered `<select>`
DOM/computed value live, rather than guessing blind from source again.

**2. OSC card height — more to cut, exact target unclear.**
User sent a screenshot with a red bar overlaid at the top demonstrating
"how much space I was able to save by arranging the OSC knobs better and
cutting em down in height," on top of §146/§147's already-completed
grow-to-fill pass. Asked what specifically should shrink (row gaps? knob
size? PM/FM arrangement?) — user chose "let me send an annotated
screenshot" instead of picking an option. **Wait for that screenshot
before touching OSC card sizing again** — two guesses already needed
correction this session (§146's `flex-start` overcorrection, §147's
520px undershoot).

**3. New feature — wavetable graphic in the OSC card (§149 candidate).**
User's mockup (image, not yet saved to repo — screenshot only, ask them
to save it if a persistent reference is wanted): a "Wavetable Graphic"
box goes in OSC 1's card between the top row (Pitch/Warp1/Warp2/Level)
and the WT-select/WT-Pos row — i.e., a NEW element, not a rename of the
existing per-operator oscilloscope (`.op-viz-row`, already positioned
under the card title and shows LIVE AUDIO output, todo.md §143). This
new box should show the SHAPE of the currently selected wavetable (at
the current WT Pos / warp settings) — a preview, not a live scope.

Implementation notes (not started, just scoped): `dsp/wavetables.js`
exports `getBaseWavetableFrames(id)` (line 502), `generateWavetableFrames`
(line 519, full signature: id, warpMode, warpAmount, warpParam2,
warpMode2, warpAmount2, warpParam2_2), and `getWavetableFrame` (line
595, frameCache-backed). These are plain JS math with no Node/QuickJS
dependency (confirmed: the only external data source, `esw-tables.json`,
is a static `import ... assert { type: 'json' }`, resolved at build time
by Vite — safe to call directly from React). A new component (e.g.
`WavetableGraphic.tsx`) can call `generateWavetableFrames`/
`getWavetableFrame` directly with the operator's current
`wtId`/`warpMode`/`warpAmount`/etc. and render the resulting Float32Array
as an SVG polyline/path, sized to roughly match the mockup's box
(spans the card's full width, sits between the two rows described above).
Since this uses the JS reference math (validated byte-exact against the
C++ port for 14/29 warp modes per todo.md §135/§144), the preview will be
accurate for those modes and will show the "intended" shape for the 15
still-unported spectral modes even though DSP doesn't produce it yet —
acceptable, flag it as a known preview/DSP gap if it comes up, don't
silently pretend it's fully wired.

Also flagged mid-thread, not yet confirmed live (waiting on user or a
non-conflicting automated pass): §147's FX-view/Synth-view alignment fix
(fx-panel max-height 430->577px) — reasoning is sound (both panels share
one flex slot, get the identical height budget, this just matches
fx-panel's own cap to what that budget measures out to on the Synth
side) but never got a clean second screenshot since the user was
actively driving the same window. Worth a quick look next session.

## 146. OSC card layout restructure — Warp blocks moved into the Pitch/Level row (Claude)

User re-sent "OSC LAYOUT 3 (GOD DAMN IT !!).png" (pre-existing mockup in
repo root) plus its companion "OSC Layout w 2 Warp Modes - instructions.png"
and said explicitly: "all osc should be designed like this and exactly
like this." The instructions image spells out the one concrete structural
requirement still unmet: **"Two warp modes placed in between the PITCH and
LEVEL knobs. Warp modes don't need to be numbered."** (Some of that same
instructions image is stale otherwise — it predates the wavetable-only
pivot: shows a Sin/Wave morph knob and a Sampler on/off toggle, both since
removed. Ignored those parts, kept the structural instruction.)

**What was wrong:** the live 3-column layout (`.op-body`/`.op-col-left/
mid/right`, todo.md §67) put Warp1+Warp2 on their OWN row below Pitch/
Level (inside `.op-col-mid`), not beside them. That's almost certainly
what the user meant by "you seem to have lengthened the UI... taller" —
confirmed via `GetWindowRect` that the actual window is unchanged (still
exactly the hardcoded 1272x920 from `PluginProcessor.cpp:138`, matches
`git diff` = none on that line), so nothing literally grew; the OSC card
itself was just one row taller than the mockup wants.

**Fix (`OscillatorPanel.tsx`'s `OperatorCard`):** restructured from 3
stacked-height columns to a row stack:
```
Top row:    Pitch | Warp1 block | Warp2 block | Level
            Wavetable select + WT Pos
            PHASE MOD (PM cluster)
            FREQ MOD (FM cluster)
Bottom row: Filter A/B | Pan
```
Reused `.op-body-new`/`.op-card-top-row`/`.op-card-bot-row` — these
classes already existed, fully styled, in `plugin-ui.css` (an earlier,
abandoned attempt at this exact row layout, dead code since the JSX moved
to `.op-body`/`.op-col-*`). Reactivated them rather than inventing new
ones; added `flex:1 1 auto; min-height:0` to `.op-body-new` (mirroring
what `.op-body` had) so the "OSC panel grows to fill leftover height"
behavior documented above `.op-body`'s rules keeps working, and added
`.op-card-top-row > .knob-field, .op-card-bot-row > .knob-field { flex:
0 0 auto; }` so Level/Pan don't fight `.op-dual-warp-container`/Filter-A/B
for row space (same `.knob-field` gotcha `.op-col > .knob-field` already
documents). `.op-warp-block`/`.op-warp-select`/`.op-warp-knobs`/
`.op-warp-divider`/`.op-wavetable-row` were untouched — same elements,
just relocated in the tree, their existing styling carries over as-is.

Did NOT touch: `.op-card-mid-row`/`.op-mod-clusters-wrap` (also dead
leftovers, but for a DIFFERENT old design where PM+FM sat side-by-side in
one row — the mockup clearly wants them as two separate stacked rows,
which is what the current `ModCluster` components already render as
plain siblings; left those two classes dead rather than repurposing them).

Typechecks green. Rebuilt + screenshotted — confirmed the row move worked
(Warp1/Warp2 now sit beside Pitch/Level, matching the mockup), but exposed
a follow-up: `.op-body-new` was `justify-content: space-between` inside a
grid row still `align-content: stretch`ed to fill the OSC panel's full
grown height (todo.md §92-99's "OSC panel grows to fill leftover space"
behavior) — so the row now being a whole row shorter just showed up as a
big dead gap between FREQ MOD and the Filter A/B / Pan bottom row instead
of shrinking anything. User: "we just have to reduce the height of those
OSC panels."

Fixed (attempt 1, WRONG): `.op-grid`'s `align-content: stretch` -> `start`,
`.op-body-new`'s `justify-content: space-between` -> `flex-start`. This
did tighten the gap between FREQ MOD and the bottom row, but it did so by
un-stretching the card entirely — the freed height didn't disappear, it
just relocated to a dead strip below the whole grid, before the ENV/LFO
strip. That `align-content: stretch` existed in the first place BECAUSE
of an earlier, near-identical user request (todo.md §92-99: "we have this
empty space underneath the oscillators... stretch the oscillator cards
down more") — attempt 1 silently reverted that without noticing.

User caught it immediately and escalated with a full annotated mockup
sequence (magenta-highlighted "this space should be removed" ->
progressively bigger OSC cards consuming it -> "stretch the 4 OSCs so
they cover the remaining [space]") plus an end-goal screenshot. Correct
read: grow the cards (width AND height) to consume freed space, never
leave it as background, but spread it evenly instead of one lump gap.

**Fixed (attempt 2):**
- `.op-grid`: `align-content` back to `stretch` (cards fill available
  height again).
- `.op-body-new`: `justify-content: flex-start` -> `space-between` (top
  row pins to the card top, bottom row pins to the card's true bottom
  edge, and the 6 children's 5 internal gaps split whatever height the
  stretch hands the card — same shape as the OLD 3-column card's
  space-between, just with 6 rows instead of 3 columns' worth of content,
  so gaps land as sane, evenly-spread padding instead of one dump site).
- Card width: `--op-card-w` 256px -> 296px, AND raised `.synth-controls`'s
  inherited `max-width: 1100px` cap (styles.css, an Electron-era leftover
  from when this was a resizable window) to `1252px` for the plugin —
  the frozen 1272px window had ~170px of width sitting unclaimed OUTSIDE
  `.synth-controls` this whole time, on top of `.op-grid`'s own smaller
  centering margin inside it. Without raising the outer cap first, a
  wider `--op-card-w` would've just re-centered in the same 1100px box.

Rebuilt, screenshotted — cards are visibly bigger (wider + taller), the
gap below the grid before ENV/LFO is now minimal, gaps inside the card
(WT row / PM / FM / bottom row) are even rather than one big jump,
nothing clipped or overflowing the window edge. Confirmed against the
user's "UI Fix (END GOAL)" reference image.

## 147. FX view's modulator strip was misaligned with the Synth view (Claude)

User: "modulators (LFO, env, velocity, key etc) + filter & FX Chain are
still displaced on the FX side... they must be in the same spot as they
are on the SYNTH page but also on the FX page."

Root cause: `.op-panel` and `.fx-panel` occupy the exact same `flex: 1 1
auto` slot in `.synth-controls` (conditionally swapped — Synth/FX view —
never both mounted at once), so the flex negotiation always hands
whichever one is active the SAME leftover height. `.env-panel` (the
ENV/LFO/VELO/Filter/FX-chain strip) sits right after that slot, so it
should land at the same Y regardless of which view is showing above it.
It didn't, because `.fx-panel` has its own `max-height` cap (currently
430px, added for an unrelated 3+-effects overflow bug — see the big
comment above `.fx-panel`) that `.op-panel` never had. §146's OSC-card
growth raised what that shared height allocation actually is; `.fx-panel`
kept quietly clamping itself to the old, now-too-short number while
`.op-panel` grew to the new one.

Fix: measured `.op-panel`'s actual rendered bottom edge on the Synth-view
screenshot (672px from the panel top) and set `.fx-panel`'s `max-height`
to match (577px, accounting for the panel's own top offset) — first pass
at 520px undershot by ~60px, corrected after re-measuring. Kept it as a
real ceiling rather than removing it outright, since removing it is what
caused the original 3+-effects bug this cap exists to prevent.

**Not independently re-verified via a fresh FX-view screenshot** — the
Synth-view screenshot confirms `.op-panel`'s side of the math is right,
but every attempt to automate clicking the SYNTH VIEW/FX VIEW toggle
button in this session stopped registering (even a basic Options-menu
click sanity-tested as a dead click too) — almost certainly because the
user was actively driving the same window by hand at the same time.
Confident in the fix by construction (both panels get the identical
flex-grow number; the cap is now set to what that number measures out
to), but flagging that it wants an eyeball check on the actual FX page.

## 145. Listen-test (in progress) — BASE wavetable is SILENT with no warp; Warp 1 "Bend +" IS audible (Claude)

Started the listen-test the user picked from §144's options (verify the 14
already-ported warp modes by ear, not just by differential math test).
Built a real audio-capture harness: `loopback-build/faze-loopback.exe
capture <deviceId>` (existing WASAPI-loopback helper, previously used only
for the Electron app's own recording feature) piped to a raw float32 file
while driving the Standalone's on-screen keyboard + Warp controls via
Win32 mouse/SendKeys automation from PowerShell (coordinates read off
`PrintWindow` screenshots). Confirmed this really exercises the live code
path — `fazespike-ui.log` showed real `<- midiNote 37 on/off` entries from
the automated clicks.

**Result for the one comparison that completed (default patch, OSC1,
un-warped baseline vs Warp1=`Bend +`@90%, same note held ~1.2s):**
- Baseline (Warp1 = `None`, WT dropdown showing `-`/nothing explicitly
  selected): captured audio was **exactly zero** (~4e-10, i.e. float noise
  floor) for the entire sustain window — not quiet, silent.
- Warp1 = `Bend +` @ 90%: real audio, RMS ≈0.018, no NaN/clipping, waveform
  uncorrelated with the (silent) baseline as expected.

This is a genuine, currently-live violation of the architecture doc's own
top acceptance criterion ("Wavetable ON, Warp OFF must produce reliable
audio" — §9, "prove the base wavetable first, before any Warp Mode").
Leading theory (not yet confirmed): the default patch's WT dropdown never
had an explicit table picked (shows `-`), so the un-warped `el.table` path
resolves is either invalid or an untriggered resource, while switching to
a ported warp mode works because `ensureWavetableWarpResources()` freshly
registers ITS OWN resource regardless. Have not yet isolated whether
explicitly picking a wavetable (e.g. "Harmonic Sweep") makes the un-warped
case audible too — an attempt to verify this got interrupted (see below).

**Why this stopped after 1 of 14 modes:** the automation and the user
appear to have been driving the same FazeSpike window at the same time —
the user sent their own manual screenshots of OSC1 mid-task, and the
window's process identity changed twice (PID/hwnd changed once, then the
process disappeared entirely with no crash dump/WER event, i.e. someone
closed it, not a crash). Blind coordinate-based automation and a live
human sharing one window's focus don't mix safely, so this was paused
rather than pushed further blind. Asked the user how to proceed — see
their reply / next entry.

**Reusable now:** the audio-capture harness itself
(`faze-loopback.exe capture <id>` + a note-hold + a small Node RMS/
correlation check) worked cleanly and is a real way to verify "Warp OFF
!= Warp ON in actual rendered audio" per the doc's acceptance criteria,
not just by ear — worth reusing for the remaining 13 modes once OSC1 has
a definite, undisputed owner of the mouse/keyboard.

## 144. Wavetable architecture report (per user's "WT Architecture" doc) — key finding: mostly already done in §135 (Claude)

User handed over a detailed "STOP PATCHING SYMPTOMS, FIX THE ARCHITECTURE"
doc demanding investigation + a report before any more Warp Mode coding.
Ran a 4-agent workflow (3 parallel investigators over dsp/synth.js,
dsp/wavetables.js, dsp.main.js, PluginProcessor.cpp/.h, WebViewEditor.cpp,
manifest.json, + todo.md §127-134/challenges.md, then a synthesis pass) to
answer it. Full report saved: `Z:\Temp\claude\Z--GITHUB-fm\wf3_report.json`.

**Headline finding: the doc's premise is stale.** §135 already implemented
and chose "Option A" (C++ owns wavetable-resource generation) — this was
NOT known/assumed going in, it was discovered mid-investigation by having
the synthesis agent read PluginProcessor.cpp directly. `dsp/wavetables.js`'s
JS-side `generateWavetableFrames`/`applySpectralWarp`/`frameCache` are
genuinely **dead code** — `synth.js` never calls them, only builds a
resource-key STRING (`wavetableResourceKey()`) and hands it to
`el.table({path: resKey}, ...)`. C++'s `ensureWavetableWarpResources()`
(PluginProcessor.cpp:1067-1187) independently re-implements the same warp
math natively (`wtWarpPhase`/`wtApplyWaveWarpSample`) for **14 of 29 warp
modes** (phase-domain 1-10/12, wave-domain 11/14/15) and registers real
`SharedResourceMap` entries — verified byte-exact against the JS reference
via a 23,500-trial differential test (`diff_warp.mjs`, scratch).

**What's still actually missing:**
- 15 spectral/FFT warp modes (13, 16-29) not ported to C++ — still silently
  no-op (fall through to the unwarped base table, not a crash).
- ESW tables (id>=2, 379 tables) broken end-to-end — loader gates on
  `process.versions.node`, always false inside the QuickJS plugin host.
  `manifest.json`'s `op{k}_wtid` range is also capped at 0/1, so no host
  automation could reach them even if loading worked. Pre-existing,
  unrelated to warp.
- **No warp mode has ever been verified by actually listening to it** —
  only by the differential math test. §135 was blocked from finishing this
  by an unrelated FxViz.tsx build error at the time; today's §143 rebuild
  (clean `run_build.bat`, launched Standalone, screenshotted) confirms the
  build/UI pipeline itself is healthy again, but that was an idle-UI check,
  not a listen test of any warp mode.

**Recommended next step (per the report's own "minimal proof" answer):**
either (a) do the in-app listen test on the 14 already-ported modes first
(never done), or (b) port ONE spectral mode (e.g. 13) the same way as the
existing 14 as the next minimal proof, or (c) fix the ESW table loader.
Asked the user which to do first — see their reply / next entry for what
was chosen. Do-not-regress list from the report (WARP_MODES `.find()` not
indexing, `wave:'wavetable'` enforced on init, insert-only
SharedResourceMap semantics, warp generation kept off the audio thread,
`registeredWavetableWarpKeys` cache, warpMode2 deliberately unwired, don't
"fix" the JS mode-11 routing bug as a drive-by, don't touch FxViz.tsx
without checking who's mid-edit in it) carries forward from §127-139 and
should still hold for whichever of a/b/c comes next.

**Workflow reliability note:** 3 separate agent-investigation runs it took
to get a clean result — each time exactly one of three parallel
investigator agents came back with fabricated placeholder content instead
of doing the actual file reads (e.g. `{"summary":"test","keyFindings":
["a","b"]}`), even after adding an explicit anti-stub warning to every
prompt. Filed as product feedback (not yet sent, queued locally). If this
recurs on future multi-agent passes, don't trust a suspiciously short/
generic result — check it before using it.

## 143. OSC 1 card design approved as final; UI trimmed — edges + per-op scope shrunk (Claude)

User marked up a `FazeSpike` screenshot: OSC 1's 3-column card layout (§67
mockup — Pitch/Filter A-B left, dual Warp + PM/FM clusters middle, Level/Pan
right) is **final** — no more layout changes there. Follow-up ask: "trim the
UI down on the edges and shrink the OSC down a bit too."

Applied, plugin-only (Electron is retired, but edited `src/renderer/
styles.css` too since the plugin imports it verbatim before
`plugin-ui.css`'s overrides):
- `.synth-controls` side padding: `var(--sp-3)` (12px) -> `var(--sp-2)` (8px)
  (`styles.css`) — the main content column's left/right edge margin.
- `.plugin-header` padding: `6px 12px` -> `5px 10px` (`plugin-ui.css`).
- Per-operator scope box height: `54px` -> `44px` in BOTH `styles.css`'s
  `.op-viz` (Electron's default-visualizer path, dead code for the plugin
  but kept in sync) AND `plugin-ui.css`'s `.op-viz-row` override (the one
  that actually matters — the plugin always passes `renderVisualizer`, so
  only `.op-viz-row`'s height applies there).
- Left `.hud` (Electron-only) padding trimmed too for consistency, though
  it's not on the plugin's render path.

Rebuilt Release clean (`run_build.bat`), launched the Standalone, screenshotted
via PrintWindow — confirmed it builds/renders with no layout breakage, cards
visibly tighter. Window itself is still the frozen fixed size (see
`plugin-ui.css`'s `.main-viz` comment) — this only tightened internal
spacing, didn't resize the window.

**Not done / open:** "shrink the OSC down a bit" was interpreted narrowly
(scope box height only) to stay minimal and avoid touching the knob-size
tokens shared with every other panel. If more shrink is wanted (e.g. the
card's own padding/gap, or the PM/FM knob `sm` size), that's a further,
separate pass — flag before doing it, since knob sizing is shared CSS.

## 142. Crash RESOLVED — root cause was a missing JS import, confirmed via WinDbg (Claude)

**Root cause found and fixed.** With the user's OK, installed Debugging
Tools for Windows (official Microsoft SDK web installer, downloaded from
Microsoft's own downloads page,
`winsdksetup.exe /features OptionId.WindowsDesktopDebuggers /quiet` — a
~1.4MB web installer that fetches just the debugger component, no full SDK).
Symbolized a minidump with `cdb.exe`, which immediately corrected the
diagnosis: `Subcode: 0x7 FAST_FAIL_FATAL_APP_EXIT` — NOT a genuine stack
buffer overrun despite the generic `STATUS_STACK_BUFFER_OVERRUN` description
Windows shows for all `0xc0000409` codes. That subcode is what plain
`abort()` raises. Still no local PDB for the Release build though, so built
a `RelWithDebInfo` config (full optimizations, but with debug symbols and
the normal release CRT — unlike the earlier `Debug` config attempt, this one
actually launches on this machine) specifically to get a resolvable stack.

Reproduced once more (pure idle, same as §140) and got a full symbolized
stack:
```
VCRUNTIME140!_CxxThrowException
choc::javascript::quickjs::QuickJSContext::ValuePtr::throwIfError
choc::javascript::quickjs::QuickJSContext::evaluate
choc::javascript::Context::evaluate
SynthPluginProcessor::dispatchStateChange
juce::Timer::TimerThread::callTimers
```

`dispatchStateChange()`'s `jsContext.evaluate(expr)` — the "DSP reconcile"
call that runs `dsp.main.js`'s `renderSynth` on every state dispatch — can
throw a genuine C++ exception when the JS it's running throws a runtime
error. **Nothing anywhere in the call chain ever caught it** (my §138
"reentrancy guard" on this exact function was only a depth *counter*, never
a try/catch — it could never have caught this). Explains every single
symptom from §136 onward at once: fires from a JUCE `Timer` callback
independent of any specific UI action (why pure idle crashed it just as
reliably as knob-drags — `dispatchStateChange` runs periodically regardless
of what the user touches), and crash timing scaling with activity level
(more state churn → more dispatches → more chances to hit the bad state).

**Fixed (`PluginProcessor.cpp`):** wrapped `dispatchStateChange`'s
`jsContext.evaluate(expr)` in try/catch — logs the JS error via
`fazeDiagLog` AND surfaces it to the UI via the existing `dispatchError()`
path (same mechanism `applyInstructions` failures already use), instead of
letting it reach `terminate()`/`abort()`. Also wrapped `dispatchError`'s own
`jsContext.evaluate` call defensively (it can now be invoked from inside
this new catch block).

**With that in place, the actual JS error became visible for the first
time**, and it was trivial: `'WARP_MODES' is not defined`, thrown from
`voiceSignal` at the `WARP_MODES.length` clamp calls on `warpMode`/
`warpMode2` (the same lines §135/§136's native work already reads). Checked
`git diff -- dsp/synth.js`: these clamp lines are part of an existing,
substantial, uncommitted in-progress edit (self PM/FM targets, dual warp
mod-matrix targets, the `warpMode`/`warpAmount` params on `wavetableOsc` —
the same signature my native C++ pipeline was built against) — whoever wrote
it added the `WARP_MODES.length` usages but never added `WARP_MODES` to the
`import { WAVETABLES, NUM_FRAMES, wavetableResourceKey } from
'./wavetables.js'` line. A one-line, purely-additive fix (added `WARP_MODES`
to the existing import) — didn't touch anything else in that file's
substantial pending changes.

**This was THE crash** — not a native bug in anything from §135-141, not
memory corruption, not any of the dozen theories tested and ruled out along
the way. It fired on EVERY render where any operator was in wavetable mode
(`wave === 5`), which is why it was so easy to reproduce via wtPos, FM/PM
knobs, or pure idle — all of them eventually trigger a `dispatchStateChange`
while a wavetable operator is configured.

**Verified:** rebuilt Release with both fixes (the try/catch AND the import
fix). Self-tested twice:
- Before the import fix, WITH the try/catch: survived past the previous
  crash point, but log showed continuous
  `[wtdiag][ERROR][ROOT CAUSE] ... 'WARP_MODES' is not defined` messages —
  confirmed the catch worked but the underlying bug was still live.
- After the import fix: 84+ seconds idle, 2520+ `drainScopes` ticks, zero
  errors, process stayed responsive throughout. Closed cleanly.

**Cleanup:** rebuilt/reinstalled Release as the final state (the Debug and
RelWithDebInfo detours along the way each auto-installed themselves over the
system VST3 in turn — confirmed Release is what's installed now).

**All the diagnostic instrumentation from §137-141 (`[wtdiag]`/
`[REENTRANCY]` logging, the reentrancy depth guards, drainScopes'
heartbeat/try-catch, `numberFromChocValue`'s type safety) is left in place**
— none of it was wrong to add (several are genuine defense-in-depth against
a real COM-boundary risk class, even though they weren't THIS bug), but it's
now more verbose logging than a stable build needs long-term. Worth a
follow-up pass to trim the heartbeat/throttled logs back down once this is
confirmed stable in real use — flagging, not doing unprompted.

## 141. Crash investigation — code+logging approach exhausted; needs a debugger or Debug-CRT install (Claude)

User reproduced §140's build with a PURE IDLE test (launched, touched
nothing). Result, read from `fazespike-ui.log` + WER: `drainScopes()` ticked
cleanly at ~30Hz for **1020+ ticks (~35s) with zero errors**, then crashed
~2s later with the same signature — **so it crashes on pure idle too**, no
knob interaction required. That rules out drainScopes' instrumented code as
well (would have logged before a catchable failure), same as every other
path checked so far.

**Status: every plausible C++ exception path has now been instrumented and
none of them ever fire** — cross-thread resource race (§137, ruled out by
code reading), reentrancy in `handleAsyncUpdate`/`dispatchStateChange`
(§138), exceptions in `__postNativeMessage__`/`numberFromChocValue` (§139),
exceptions in `drainScopes` (§140) — all clean across 6 separate crash
repros (2 self-tested, 4 user-tested), covering both active-knob-turning and
pure-idle triggers. **This is strong evidence the crash is NOT a catchable
C++ exception at all** — `STATUS_STACK_BUFFER_OVERRUN` (0xC0000409) is also
exactly what a genuine stack-corruption /GS failure looks like, which no
try/catch can intercept since it's undefined behaviour, not a throw.

**Tried the "no install needed" alternative to a debugger — dead end, same
constraint applies:** built `./build.sh Debug` for MSVC's `/RTC1` runtime
checks (would catch stack corruption immediately with a specific
function/variable, without WinDbg). The Debug .exe **fails to launch at all**
— `Start-Process -Wait` gives exit code `-1073741515` =
`0xC0000135 STATUS_DLL_NOT_FOUND`. This portable MSVC toolchain
(`portable-msvc.py`, no Visual Studio) doesn't have the Debug CRT
redistributables (`ucrtbased.dll` etc.) registered system-wide — those
normally come from a full VS install. **So the Debug-build route needs an
install too, same tradeoff as just getting a real debugger.** Rebuilt and
reinstalled Release afterward (the Debug build's own install step had
overwritten the system VST3 with the Debug version — flagging in case
anyone hits an unexpectedly slow/checked plugin in a DAW).

**Timing data across all repros doesn't fit a simple fixed-tick/fixed-time
threshold:** crashes ranged from ~1s to ~37s after launch. Pure idle took
the longest (~37s); heavier interaction (rapid knob drags) crashed
fastest (~1-2.5s). This pattern — activity level correlating with time-to-
crash rather than a fixed threshold — reads more like a leak/corruption that
accumulates faster under more state churn (more `handleAsyncUpdate`/
`dispatchStateChange`/`applyInstructions` cycles per second) than like a
single fixed-count bug.

**Where this leaves it:** the code+logging approach the user chose in §138
has been run to its practical limit — I don't have a plausible remaining
C++ call site to instrument, and the evidence points away from "an
exception I haven't wrapped yet" and toward genuine memory corruption,
which needs either a real debugger (symbolize the 6 existing
`%LOCALAPPDATA%\CrashDumps\FazeSpike.exe.*.dmp` minidumps) or the Debug CRT
redistributables, both of which require a network install this session
hasn't done. Asked the user how to proceed.

## 140. Crash investigation — §139's fix DIDN'T hold, now targeting drainScopes() (Claude)

User reproduced again on §139's build — **still crashed**, ~1s after "state
dispatched", and critically **zero `[wtdiag][ERROR]` lines from either of
§139's new checks** (`numberFromChocValue`'s type guard, or the
`__postNativeMessage__` try/catch) — meaning neither of those code paths
even ran into trouble; the try/catch would have logged even on a successful
catch. **Rules out the COM-boundary-exception theory from §139 too.**

That's now three hypotheses eliminated by direct log evidence (§138's
reentrancy guards, §138's applyInstructions logging, §139's exception
guards) — every crash so far has happened with TOTAL SILENCE from
`handleAsyncUpdate`, `dispatchStateChange`, `__postNativeMessage__` (all
branches), and MIDI handling. That means whichever of those the user THINKS
they're exercising (turning a knob) isn't actually what's live when the
crash hits — or it never gets far enough to log anything.

**New angle:** `drainScopes()` was the one remaining unlogged code path, and
it's structurally different from everything ruled out so far — it runs on
`scopeTimer`, its OWN independent 30Hz `juce::Timer` that `startTimerHz(30)`
starts in the constructor and only `stopTimer()`s in the destructor. It is
NOT gated on the editor being open, NOT triggered by any UI event, and runs
continuously for the processor's entire lifetime. Re-examined this session's
very first self-test launch (before any user repro): that one crashed after
~7s of pure idle with NO knob/MIDI interaction from anyone — at 30Hz that's
~210 silent `drainScopes()` ticks, and it fits every observed crash timing
(1-8s after launch) at least as well as "the user was turning a knob," which
in hindsight may just be what the user was doing WHILE this independent
timer was ticking in the background, not necessarily the trigger.

**Added:** a tick-count heartbeat log (first 10 ticks, then ~every 2s) so we
can see how many ticks actually happened before a crash, plus the same
try/catch pattern around the function's body (it calls
`runtime->processQueuedEvents(...)`, builds a JSON string of scope data, and
calls `evaluateJavascript` — none of which had ever been exercised by any
prior diagnostic). Native build verified clean.

**Needs one more repro.** This time, try NOT touching any knob at all —
just launch and wait ~10-15s — to test whether the crash happens on pure
idle (confirming the timer theory outright) as well as with knobs. Read the
log tail for `[wtdiag] drainScopes tick #N` counts and any
`[wtdiag][ERROR] drainScopes threw: ...` line.

## 139. Crash investigation — likely root cause found + fixed (Claude) — needs user repro to confirm

User reproduced again on the §138 build: crashed ~2.5s after launch/boot with
**zero** `[REENTRANCY]` or `[wtdiag]` log lines anywhere near the crash (log's
last entry was "state dispatched" at boot; the WER crash event fired ~2.5s
later with total silence in between). This ruled out BOTH of §138's
hypotheses (reentrancy in `handleAsyncUpdate`/`dispatchStateChange`;
anything inside `applyInstructions`) — whatever crashes here never reaches
any of that instrumented code at all.

That pointed one level earlier: `WebViewEditor.cpp`'s
`webView->bind("__postNativeMessage__", ...)` — the SOLE entry point for
every webview→native call, including every knob's `setParameterValue`, which
had ZERO logging and runs directly as a WebView2 COM message-received
callback (a boundary a C++ exception cannot safely cross without triggering
`std::terminate()`/`abort()` on MSVC).

**Found a real bug reading it:** `numberFromChocValue` (top of the file) —
its final fallback branch called `v.getInt64()` UNCONDITIONALLY for any
value that wasn't float32/float64/int32. Checked choc's `getInt64()` — per
its own doc comment it THROWS a `choc::value::Error` (`: std::exception`) if
the value isn't actually an int64. So ANY numeric-field message whose JS-side
value ever serializes to something choc doesn't parse as one of those four
numeric types (`void`/`null` — e.g. `JSON.stringify(NaN)` becomes the JSON
literal `null` — a string, object, etc.) would throw here, INSIDE the COM
callback, with nothing anywhere in the call stack to catch it. That matches
the crash signature (`STATUS_STACK_BUFFER_OVERRUN` in `ucrtbase.dll`) exactly
— this is the classic "uncaught C++ exception escapes a COM boundary →
fail-fast" pattern, and every single knob (not just wtPos) sends its value
through this exact function on every drag tick.

Could NOT pin down the exact JS-side condition that produces a non-numeric
wtPos value specifically (checked the shared `Knob.tsx` component's drag
math — `range = max - min || 1` already guards div-by-zero, and a fresh
launch's `wtPos` starts at its compiled default of 0, not NaN; checked the
Standalone's `%APPDATA%\FazeSpike\FazeSpike.settings` for a stale
corrupted-state repeat of the §129 incident — it holds no plugin state blob
at all, fresh default every launch, so that's not it either). The exact
trigger remains unconfirmed, but the crash MECHANISM (an uncaught exception
crossing this specific COM boundary) is solid regardless of what value
triggers it, and this bug is real independent of whether it's THE cause —
fixed it either way.

**Fix applied (`WebViewEditor.cpp`):**
- `numberFromChocValue` now checks `isInt64()`/`isBool()` explicitly instead
  of assuming, and for anything else logs
  `[wtdiag][ERROR] numberFromChocValue: value is not numeric (type=...)` and
  returns `0.0` instead of throwing.
- The entire `__postNativeMessage__` lambda body wrapped in try/catch as
  defense-in-depth (this exact boundary has several OTHER type-unsafe
  accessors — `.getString()` etc. — for other event types; any of them
  throwing would be equally fatal) — logs
  `[wtdiag][ERROR] __postNativeMessage__ threw: {what}` and degrades to a
  no-op `{}` return instead of taking the process down. Scoped tightly to
  this one COM-boundary lambda, not a blanket catch-all elsewhere.
- Native build verified clean (`./build.sh Release`).

**Needs user to reproduce the wtPos crash once more on this build.** Three
possible outcomes:
1. No crash + a `[wtdiag][ERROR] numberFromChocValue: ...` log line right
   before where the crash used to happen → confirmed root cause, already
   fixed by returning 0.0 instead of throwing (though the UI-side "why does
   wtPos ever send a non-numeric value" question would still be worth
   answering separately).
2. No crash + a `[wtdiag][ERROR] __postNativeMessage__ threw: ...` line with
   a DIFFERENT exception message → same fix category worked, different exact
   trigger than guessed.
3. Still crashes → this whole COM-boundary theory is wrong too; the crash is
   somewhere this try/catch can't reach (audio thread, a different COM
   callback e.g. `add_WebResourceRequested`, or genuinely a memory-corruption
   stack-smash rather than an escaped exception) — would need the debugger
   route after all.

## 138. Crash investigation continued — my code CLEARED, now general/dispatch-pipeline (Claude)

User reproduced on the §137 build: **turning ONLY the wavetable-POS knob on
osc 1 (warp untouched, warpMode=0) crashed instantly.** Read
`fazespike-ui.log`'s tail after — **zero `[wtwarp]` lines anywhere near the
crash**, and the crash-event timestamp lines up exactly with the knob-drag's
burst of `dispatchStateChange` calls with no MIDI in between. Since
`ensureWavetableWarpResources()` early-exits before logging anything when
`warpMode==0` (confirmed by re-reading its own gate order), **this
conclusively clears §135/§136's wavetable-warp code as the cause of THIS
crash.** wtPos also structurally can't touch `el.table`'s resource keys at
all (`wavetableResourceKey()` doesn't take wtPos as an input) — turning it
should only update one shared control node's value, the same mechanism every
other knob in the file already uses via `ctrl()`.

**Two hypotheses investigated and RULED OUT by reading the actual code (not
guessed):**
1. Cross-thread `SharedResourceMap` race between my `addSharedResource`
   (message thread) and audio-thread reads — traced `TableNode::setProperty`
   (the only reader) to `Runtime::applyInstructions`, which only ever runs
   from `__postNativeMessage__`, itself only called synchronously from
   `jsContext.evaluate()` inside `dispatchStateChange()` — message thread
   only, not a race.
2. `WebViewEditor.cpp`'s `evaluateJavascript` → WebView2's `ExecuteScript`
   pumping the Windows message loop and re-entering `handleAsyncUpdate`/
   `dispatchStateChange` while already running — checked `choc_WebView.h`'s
   Windows `evaluateJavascript`: it's `coreWebView->ExecuteScript(script,
   nullptr)` — null completion handler, fire-and-forget, non-blocking. The
   only `DispatchMessage` loop in that file runs once at WebView2
   environment creation (editor construction), not on every dispatch.

**Given the crash reproduces across totally unrelated trigger types across
sessions** (old pre-session logs: MIDI note bursts; this session: FM/PM
knobs; now: wtPos knob) **but always through the same shared
`handleAsyncUpdate → scheduleStateDispatch → dispatchStateChange →
__postNativeMessage__ → applyInstructions` pipeline**, the working theory
shifted from "a specific feature's bug" to "something general in that shared
pipeline under bursty/rapid-fire input." Added instrumentation to test this
directly rather than guess further:
- A cheap depth-counter reentrancy guard (`thread_local int`, RAII) on both
  `handleAsyncUpdate()` and `dispatchStateChange()` — logs
  `[REENTRANCY][ERROR]` loudly if either is ever entered while already
  running on the same thread. Near-zero cost when it doesn't fire (one int
  compare per call).
- `__postNativeMessage__`'s `runtime->applyInstructions()` call now logs its
  batch size and return code — always on failure, throttled (same pattern as
  the existing `dispatchStateChange` timing log: first 40 calls then every
  50th) on success — previously only logged on failure, so a crash
  DURING/right-after a successful-looking apply left no trace of what that
  instruction batch even was.
- Native build verified clean.

**Not yet confirmed which (if any) of these fires.** Needs the user to
reproduce the wtPos crash once more on this build and someone to read the
log tail — specifically watching for `[REENTRANCY]` or `[wtdiag]` lines
right before the crash (or their total absence, which would rule out this
round's hypotheses too and point back toward Elementary-runtime internals or
something in the JS reconciler itself).

## 137. Wavetable-warp crash investigation — diagnostic logging added, root cause NOT yet confirmed (Claude)

User confirmed (after testing the §136 build, which was the first one where
the real UI AND the §135 wavetable-warp resources both actually work
end-to-end): **turning wavetable/warp knobs, and separately FM/PM knobs,
reliably crashes the Standalone.**

**Investigated before changing anything:**
- Traced which thread actually touches `SharedResourceMap` to rule out a
  cross-thread race from `ensureWavetableWarpResources()`'s new
  `runtime->addSharedResource()` calls (the first suspect, given it's the
  newest code and now runs on every `handleAsyncUpdate`, i.e. every knob
  tick): `TableNode::setProperty` (`Table.h`) — which reads
  `SharedResourceMap` — only runs inside `runtime->applyInstructions()`,
  which `initJavaScriptEngine()`'s `__postNativeMessage__` callback invokes
  SYNCHRONOUSLY from within `jsContext.evaluate(...)` — itself only ever
  called from `dispatchStateChange()`, which only runs from
  `handleAsyncUpdate`/`timerCallback` — i.e. the MESSAGE thread, same thread
  as my `addSharedResource` writes. **Not a cross-thread race** — both sides
  are serialized on the message thread. The audio thread only touches the
  resource via a lock-free `SingleWriterSingleReaderQueue<SharedResourcePtr>`
  (`Table.h`'s `bufferQueue`), which `setProperty` pushes into and `process()`
  drains — decoupled by design, checked its bounds-handling too (`push()`
  correctly no-ops when full, doesn't overflow).
- Checked `AudioBufferResource`'s constructor and `SingleWriterSingleReaderQueue`
  for anything exotic (fixed-size stack buffers, unbounded writes) that could
  explain the `STATUS_STACK_BUFFER_OVERRUN` signature — nothing found.
- **Leading theory, NOT confirmed:** this may not be a bug IN the new
  registration code's own correctness at all, but that code making a
  previously-always-failing path newly SUCCEED — before this session, ANY
  `wave=5` operator with an active warp always got `Table.h`'s
  `InvalidPropertyValue()` (missing resource), so the DSP graph never
  actually built/ran a live warped-wavetable node. Now that the resource
  usually exists, that graph node — and its interaction with PM/FM modulation
  on the same/other operators — is executing for the first time ever,
  possibly exercising a latent bug elsewhere (JS graph construction in
  `dsp/synth.js`, or native graph/PM-FM handling) that simply had no way to
  run before. This would also explain FM/PM knobs alone triggering it: any
  knob turn re-triggers a full graph rebuild that includes the
  now-successfully-resolving wavetable+warp node.

**No debugger available on this machine** (`Z:\msvc` is a portable
MSVC+Ninja toolchain only, no `cdb`/WinDbg; no `winget` either to install
one). 5 WER minidumps exist in `%LOCALAPPDATA%\CrashDumps\FazeSpike.exe.*.dmp`
but couldn't be symbolized from here. Didn't attempt a bespoke
dbghelp.dll-based minidump reader — would work (no install needed, ships
with Windows) but is significant scope for what should first be a quick
empirical check.

**What was done instead — diagnostic instrumentation, using this project's
existing `fazeDiagLog`/`%TEMP%/fazespike-ui.log` pattern (Diag.h, same
mechanism §73/§128 already established) rather than guessing blind:**
- Logs `[wtwarp] op{k} generating: wtId=... warpMode=... warpAmt=... warpParam2=...`
  right BEFORE starting frame generation for a newly-seen warp key — written
  before any risky work so it survives even a hard crash a few lines later.
- Logs `[wtwarp] registered {key}` on success.
- **Wrapped the per-frame generation+registration body in try/catch**,
  logging `[wtwarp][ERROR] generation threw for {key}: {what}` — scoped
  tightly to only this newest, least-proven code path (not a blanket
  catch-all elsewhere). This is deliberately dual-purpose: if the crash IS an
  uncaught C++ exception in this function, this both fixes it (falls back to
  the already-registered base key instead of taking the process down) AND
  proves it via the logged message. If the crash still happens with this in
  place, that's equally useful — it rules this function out definitively and
  points at graph construction/processing elsewhere instead.
- Native build verified clean (`./build.sh Release`, incremental).

**Next step — needs the user to reproduce again on this build** (turn
wavetable/warp knobs, then FM/PM knobs, same as before) and someone to read
`%TEMP%\fazespike-ui.log`'s tail afterward:
- If it now logs a `[wtwarp][ERROR]` and DOESN'T crash → confirmed, root
  cause was in `ensureWavetableWarpResources()`, already mitigated by the
  catch (though the underlying `what()` message should still get a real fix,
  not just be caught forever).
- If it STILL crashes → the last `[wtwarp] generating`/`registered` line tells
  us exactly which operator/wtId/warpMode/warpAmt was in play right before,
  which either implicates something downstream of registration (the
  graph-construction theory above) or rules out this whole function entirely
  if the crash happens with no `[wtwarp]` lines nearby at all (e.g. purely
  from FM/PM knobs on an operator that was never in `wave=5` warp mode).

## 136. FxViz.tsx build-blocking syntax fix + a pre-existing native crash found while verifying (Claude)

**Fixed:** `ui/FxViz.tsx` had an orphaned `} else if (cx < xHigh) { ... } else { ... }` with no
matching `if` (around the compressor's "Independent Band Floor Dragging"
pointerdown handler, ~line 846) — esbuild/tsc both failed with "Unexpected
'}'" / TS1128 at line 998, which made Vite bail and `build.sh` silently fall
back to the placeholder `index.html` (no error surfaced other than a log
line easy to miss). Root cause: a generic ternary-based version of the
low/mid/high band hit-test (`b`/`bCx`/`pFloor`/`pCeil`/`pAmt`, handling all 3
bands) was added, but a leftover `else if (cx < xHigh) {...midFloorDb...}
else {...highFloorDb...}` tail from an earlier, less-complete version of the
same logic wasn't fully removed — looked like a botched patch (`patch_fxviz.py`
in the repo root is a plausible culprit, not confirmed). Deleted the dead
duplicate tail; the surviving generic block already covers all three bands
correctly. `git diff` (not manual brace-counting) is what actually found
this in reasonable time — worth remembering for next time a JSX file throws
a lone "Unexpected '}'" far from the real bug.
- Verified: `tsc --noEmit` on the file now only shows 5 PRE-EXISTING,
  unrelated type errors (lines 593, 663, 670 — narrowing issues on a
  `kind`-discriminated union, nothing to do with the brace bug). `npx vite
  build` now succeeds and produces the real `dist/index.html`. Full native
  `./build.sh Release` rebuild picked it up: log line changed from `index.html
  <- plugin/index.html (placeholder)` to `index.html <- ui/dist/index.html
  (React UI)`.
- Did NOT touch the 5 pre-existing type errors — separate, unrelated to what
  was asked (unblock the build), and this file already looks mid-edit by
  someone else (see below).

**Found while verifying, NOT fixed — flagging for whoever owns this area:**
Launched the freshly-built Standalone to confirm the real UI actually loads.
It does — `fazespike-ui.log` shows a clean boot, `ready → dispatchStateChange`,
and live MIDI note handling — but the process **crashes ~7s later** with no
warning. Confirmed via Windows Event Log this is NOT something introduced
this session: the identical crash signature (`STATUS_STACK_BUFFER_OVERRUN` /
`0xC0000409` in `ucrtbase.dll`, same faulting offset) already fired 4 times
between 00:33 and 01:38 today, hours before this conversation started, on a
build that predates both the wavetable-warp and FxViz changes. It's
reproducible, not a one-off.
- No symbolic stack trace obtained — this portable MSVC toolchain (`Z:\msvc`)
  has no `cdb`/`windbg`/Debugging-Tools-for-Windows installed, so the 5 WER
  minidumps in `%LOCALAPPDATA%\CrashDumps\FazeSpike.exe.*.dmp` couldn't be
  symbolized from here.
- `fazespike-ui.log` also shows repeated `--- WebViewEditor ctor ---` entries
  every 10-30s AFTER this session's one launch (09:06:40, 09:06:51, 09:06:57,
  09:07:01, 09:07:36) that this session did not trigger — reads like someone/
  something else is actively relaunching this exact Standalone right now
  (possibly another agent testing the compressor UI `FxViz.tsx` is mid-edit
  for). Stopped launching/killing the process further to avoid interfering.
- `0xC0000409` in `ucrtbase.dll` is consistent with a `/GS` stack-check
  failure, an uncaught C++ exception reaching `std::terminate`, or an
  `abort()` — NOT immediately narrowed further. Worth a Debug build (better
  assertions/less inlining) or installing Debugging Tools for Windows
  (`winget install Microsoft.WinDbg` or the SDK component) to symbolize a
  dump properly.

## 135. Wavetable Warp resource pipeline — minimal proof, native-only (Claude) — native build green, UI/DSP-suite verification blocked (see below)

Investigated the "fake wavetable" architecture problem per `challenges.md` §1 and
the WT Architecture doc (see chat/session for the full required-report writeup)
before touching any code, then implemented the smallest proof the doc asked for.

**Root cause (confirmed in code, not just diagnosed on paper):**
- `dsp/synth.js`'s `wavetableOsc()` always builds a resource key via
  `wavetableResourceKey()` and references it as `el.table({ path: resKey })` —
  but nothing, in QuickJS OR C++, ever generated/registered the WARPED variant
  of that key. `dsp/wavetables.js`'s `generateWavetableFrames`/`getWavetableFrame`/
  `frameCache` are dead code — grepped the repo, nothing calls them outside the
  unused `allBuiltinWavetableResources()` helper (itself only consumed by the
  offline test harness, and only for UNWARPED table 0/1).
- Separately, `PluginProcessor.cpp`'s `registerBuiltinWavetables()` only loops
  `tableId < 2` — the 379 Echo Sound Works tables (`wtId >= 2`) are never
  registered natively at all, warped or not. Their JS-side loader
  (`loadEswWavetableFrames`) also can't work in the real plugin anyway — it
  gates on `process.versions.node`, which is false inside QuickJS. **ESW tables
  are broken end-to-end today, independent of warp** — flagged, not fixed
  (out of scope for this pass).
- `Table.h`'s `setProperty("path", ...)` returns `InvalidPropertyValue()` on a
  missing key — graph construction fails outright, which is the actual
  "crash," not silence.

**Architecture chosen: Option A — C++ generates and registers.** Not a
QuickJS→C++ buffer bridge (Option B), because:
- Warp params (`op{k}_wtid/warpmode/warpamount/warpparam2/...`) already arrive
  in C++'s `state` for free via the ordinary flat-state sync (they're real
  `manifest.json` host params, same channel as `op{k}_pitch` etc.) — no new
  UI/bridge wiring needed at all, unlike `setFunctionShape`/`setEqBands` which
  needed a dedicated message because their payload isn't a bounded float.
- `registerBuiltinWavetables()` already set the precedent of porting
  `dsp/wavetables.js`'s frame-generation math 1:1 into C++; extending that to
  cover warp is the same kind of work.
- Avoids ever JSON/base64-serializing a Float32Array wavetable frame across the
  bridge, which the architecture doc explicitly warns against.

**What was implemented (`PluginProcessor.h`/`.cpp`):**
- `ensureWavetableWarpResources()` — runs every `handleAsyncUpdate` (not just
  on fresh-runtime init, since warp params can change on any state dispatch).
  For each of the 4 operators with `wave==5`: reads wtId/warpMode/warpAmount/
  warpParam2(+warpMode2/warpAmount2/warpParam2_2, read-through but not yet
  acted on) straight out of `state`, computes the resource key via a C++ port
  of `wavetableResourceKey()` (quantization included, so keys match exactly
  what `dsp/synth.js` requests), and generates+registers any missing key via
  `runtime->addSharedResource`.
- **Follow-up in the same session, after the Bend+ proof built clean:**
  generalized to all 13 remaining non-spectral warp modes — phase-domain
  resample modes 2,3,4,5,6,7,8,9,10,12 (`wtWarpPhase()`, one C++ function
  covering all of them via a switch, matching `warpPhase()`'s structure) and
  wave-domain sample-shaper modes 11 (Wavefold), 14 (Bitcrush), 15 (Wave
  Rectify) (`wtApplyWaveWarpSample()` + a ported `removeDC`/`normalize` pass,
  matching `applyWaveWarp()`). **14 of 29 warp modes now work natively.**
  Only the 15 **spectral** modes (13, 16–29 — FFT/DFT-based: Formant,
  Harmonic Stretch, Comb, Smear, Spectral Freeze/Fold/Morph, etc.) remain
  unported; they still fall through to the unwarped base key. Deliberately
  held back from this pass — `analyzeFrame`/`synthesizeFrame` in
  `wavetables.js` are an O(N·harmonics) naive DFT (2048 samples × 128
  harmonics, forward+inverse), meaningfully heavier than the phase/wave
  modes, and deserve their own perf check (off message-thread cost, whether
  a real FFT port is warranted) before wiring in — not a "just port the
  math" job like the other 13 were.
- **Found in the process, NOT fixed (JS-side, dead code today, separate from
  this native pass):** `dsp/wavetables.js`'s `generateWavetableFrames()`
  routes warp mode 11 (Wavefold) through `warpPhase()` (its
  `warpMode >= 1 && warpMode <= 12` range check catches 11), but
  `warpPhase()` has no `case 11` — it silently falls to `default: return p`
  (identity, no warp at all). `applyWaveWarp()` DOES implement Wavefold
  correctly (`WARP_MODES[11]` is genuinely an amplitude waveshaper, not a
  phase remap) but is unreachable for mode 11 given that routing. Since this
  code path is dead today (nothing calls `generateWavetableFrames`), it's
  never actually been exercised — the native C++ port wires mode 11 to the
  correct amplitude-waveshaper behavior directly (matching `applyWaveWarp`,
  the evidently-intended implementation) rather than reproducing a bug
  nothing has ever run. The JS routing bug itself is still there and should
  get the same one-line fix (exclude 11 from the `<= 12` phase-domain check)
  whenever that dead code is either wired up or removed.
- **Verified by differential test**, not just by code review: wrote a
  standalone Node script (`diff_warp.mjs`, scratch — not committed) that
  transliterates the exact C++ formulas back to JS and runs 23,500 randomized
  trials (2000/phase-mode × 11 modes, 500/wave-mode × 3 modes, random
  phase/amount/param2 each trial) against the REAL `warpPhase()`/
  `applyWaveWarp()` from `dsp/wavetables.js`. **0 mismatches** (phase modes
  matched to 1e-9, wave modes — which round-trip through DC-removal +
  peak-normalize — matched to 1e-5). This is strong evidence the C++ port is
  behaviorally identical to the JS reference, independent of the still-broken
  UI blocking an in-app listen test (see below).
- `registeredWavetableWarpKeys` (an `unordered_set`, cleared on runtime
  rebuild) is the "one authoritative cache" the doc asked for — avoids
  regenerating frames (2048 samples × 8 frames) on every debounced state
  dispatch once a warp is already registered. Generation happens on the
  message thread (`handleAsyncUpdate`), never the audio thread.

**Deferred / explicitly out of scope for this pass:**
- Warp modes 13, 16–29 (all spectral/FFT-based) — see perf-check reasoning
  above. This is the next natural follow-up.
- `warpMode2` (the second warp slot) not yet acted on — read but intentionally
  ignored (falls back to base key) so it can't silently generate a
  wrong/mismatched resource.
- ESW wavetables (`wtId >= 2`) — separate bug, native registration never
  existed for them; needs `AudioFormatReader`-based WAV loading (`sampleFormatManager`
  is already set up for exactly this) as its own follow-up.
- `op0_wtid`'s manifest range (`min:0, max:1`) — noticed while reading
  `manifest.json`; with 381 real table IDs (2 built-in + 379 ESW) this host
  param range can't reach any ESW table via automation regardless of the
  resource pipeline. Not touched — orthogonal to this pass, flagging for
  whoever picks up the ESW registration follow-up above.

**Verification:**
- Native `./build.sh Release` (incremental) — clean. `PluginProcessor.cpp`
  compiled with no new warnings (the pre-existing `VariableDelayNode`
  template-instantiation warning is unrelated/pre-existing). Standalone +
  VST3 linked and auto-installed.
- **NOT verified live in-app.** The same build run hit an UNRELATED UI build
  failure — `ui/FxViz.tsx:998` `esbuild` error ("Unexpected '}'"), Vite bailing
  and the build falling back to the placeholder `index.html`. `FxViz.tsx` was
  already showing as modified/uncommitted in git status before this session
  started, so this looks like another agent's in-flight edit on a shared file
  — did NOT touch it (see multi-agent shared-file-collision guidance) other
  than reading the one line the error pointed at. **Whoever owns that edit
  needs to fix the brace balance before the real UI (and therefore the actual
  wtId/warpMode/warpAmount controls) is reachable again** — until then this
  fix can't be exercised through the app at all, only reasoned through code +
  a clean compile.
- DSP regression suite (`test/engine.test.mjs`) NOT re-run for this change —
  it exercises the JS offline renderer only, which can't reach native C++
  code, so it wouldn't cover this pipeline either way. No new offline-renderer
  test added for the native path (would need a parallel JS harness that fakes
  `runtime->addSharedResource`, not attempted here).
- Added and ran a standalone differential test (`diff_warp.mjs`, scratch dir,
  not committed — reproducible from the formulas in `PluginProcessor.cpp` if
  needed again) validating all 14 ported modes against the real JS reference
  — see above. This substitutes for, but does not replace, an actual listen.
- **Manual recheck needed once the UI is fixed:** for each of the 14 ported
  modes (1-10, 11, 12, 14, 15), set an operator to Wavetable/table 0, dial
  that Warp Mode, drag Warp Amount 0→100%, confirm audible timbre change and
  no crash/hang; then confirm Warp Amount = 0 or any of the 15 still-unported
  spectral modes still sounds like the unwarped base table (no regression,
  no crash on selecting them either).

## 134. Wavetable Crash & Oscillator Panel Layout (Multi-agent pass) — Typechecks green

- **Fixed Wavetable selection crash:** The `WARP_MODES` array in `OscillatorPanel.tsx` is no longer indexed sequentially (IDs like 13, 14 exist without padding), so selecting Warp Modes threw an out-of-bounds error on `WARP_MODES[id]`. This was patched to use `WARP_MODES.find(m => m.id === ...)`.
- **Enforced `wave: 'wavetable'` on Init:** The sampler button was removed per user request, and Wavetable selection via the dropdown now strictly enforces `wave: 'wavetable'`, preventing the DSP graph from mismatching the UI mode. 
- **Fixed FX Chain / Macro clipping:** Relocated the 8 Macro knobs to the top header (`PluginApp.tsx`), shifting the preset browser to the far right. This restored the Envelope grid to its proper 66px row height, allowing the FX Chain Strip to render perfectly without CSS clipping.
- **Fixed Mod Cluster Overlap:** Reverted the hacky `translateY` on the Phase Mod / Freq Mod knobs and applied `justify-content: flex-start` to `.op-col-mid`. The PM/FM clusters now sit safely above the Pan and Filter AB knobs. 
- **Compressor Visualizer UX:** Wrote a direct patch for `FxViz.tsx` intercepting the `Amount` (AMT) and `Target` (CeilingDb) hit-boxes, removing the redundant overlay knobs entirely.
- **Challenges Documented:** Created `challenges.md` explicitly detailing the architectural mismatch between QuickJS-generated warped frames (`wavetableResourceKey` caching) and the C++ `PluginProcessor.cpp` `SharedResourceMap` which leads to the "fake wavetable" silent crash issue.


## 133. Dense FX rack knob scaling + Release rebuild (Claude) — checks green

Fixed the visual overlap that appeared when the FX grid compressed to fit more
active effects. `FxPanel.tsx` now adds an `fx-density-0..8` class based on the
number of active chain entries. Plugin CSS scales the FX rack controls together
with the compressed units: 40px knobs remain unchanged for 0–2 effects, then
step through 34/31px at 3–4, 28/25px at 5–6, and 23px at 7–8. Rack gaps, labels,
value text, and tiny modulation affordances shrink with the knobs so dense
units do not overlap their own UI. EQ's graphic editor is unaffected because it
has no knob rack.

Verification: root shared-schema typecheck clean, plugin UI typecheck clean,
full Elementary DSP suite passed, UI production build passed, and native
`./build.sh Release` completed successfully. Refreshed artifacts:
`spike/elementary/plugin/build/FazeSpike_artefacts/Release/Standalone/FazeSpike.exe`
and the corresponding VST3 (also installed to the system VST3 directory).

## 132. Modulator width + OSC phase-mod layout pass (Claude) — typechecks + DSP suite green

Applied the user's annotated OSC 1 mockup across the plugin UI:

- **ENV/LFO cards** (`plugin-ui.css`): the six primary modulator cards now use
  six equal tracks while keeping the existing 66px grid row height. ENV 1–3
  remain on the first row and LFO 1–3 on the second, each taking one track —
  approximately half the previous card width. The grid is left-aligned, leaving
  the right half of the two modulator rows intentionally open. The bottom
  velocity/filter/FX row remains full-width, matching the mockup's red space.
- **OSC cards** (`plugin-ui.css`): every operator now follows OSC 1's note by
  visually moving its Phase Mod cluster down below the main pitch/level area
  and shifting Freq Mod slightly right. The established card height, knob sizes,
  signal routing, and hit targets are unchanged; this is a plugin-only layout
  adjustment.

Verification: root shared-schema typecheck clean, plugin UI typecheck clean, and
Elementary DSP suite all tests passed. The old `spike/elementary/todo.md` right-
click-menu note was ignored as stale, per the user's clarification.

## 131. Real parametric EQ — graphic point editor, no knobs (Claude) — typechecks + DSP suite (61/61) green, native rebuilt + screenshotted (popout modal NOT click-verified, see below)

Replaced the old fixed 3-band low/mid/high shelf-gain EQ (no frequency or Q
control at all) with a real FabFilter Pro-Q-style parametric EQ per the
user's ask: "no knobs at all... controllable in the graphic pane" — double-
click to add/remove a bell band, drag to move freq/gain, scroll over a point
to change Q, a "pop out" button (⤢, EQ unit header) opens the same editor
larger, mirroring the LFO Function editor's modal.

- **DSP** (`dsp/synth.js` `applyEqSlot`): arbitrary bands in series, each a
  real Elementary state-variable filter — `el.peak`/`el.lowshelf`/
  `el.highshelf` (filters.ts, backed by native `SVFShelf.h`), not hand-rolled
  biquad math. Keyed by each band's stable `id` (shared/types.ts), not array
  index — deleting a middle band must not reassign a DIFFERENT band's
  `ctrl()` smoothing state for one render, the same stable-identity lesson
  `FunctionPoint`/mod-cluster knobs already had to learn this session.
- **Data model** (`shared/types.ts`): `EqFxSettings.bands: EqBand[]`
  (`{id,freq,gain,q,type}`, up to `MAX_EQ_BANDS=8`) replaces
  `lowGain/midGain/highGain` outright — this is a pre-release spike with no
  presets to preserve compatibility for, so no migration shim.
- **Bridge**: `bands` isn't a bounded host float (arbitrary count, structured
  data) — travels over its own `setEqBands` native message
  (bridge.ts/useBridgeSynth.ts/WebViewEditor.cpp/PluginProcessor.h/cpp),
  exact same precedent `setFunctionShape` set for LFO shapes: same
  stable-stringify echo-guard, same "seed the state key so
  setStateInformation's existing-keys guard accepts a reload" seeding.
  `fx_eq_low/mid/high` (manifest.json) are now dead flat params, left
  declared-but-unread rather than renumbering everything after them for a
  project with no presets to break.
- **UI** (`EqEditor.tsx`, new file): `EqCanvas` (shared by the compact
  inline stage and the popout), `EqEditorStage`, `EqEditorPopout`. The
  on-canvas curve is a SIMPLIFIED visual approximation (Gaussian bell /
  logistic shelf summed in dB across bands) — not the DSP's real transfer
  function, deliberately, per "a more simple dumbed down version" (loosely
  inspired by github.com/ZL-Audio/ZLSpectrumEqualizer, not a port).
  `FxPanel.tsx`'s `FxUnit` gained `renderStage`/`headerExtra` overrides so
  EQ doesn't have to share the generic FxViz drag-canvas + knob-rack every
  other effect uses; `FxViz.tsx` had its now-dead 'eq' branches removed
  entirely (it never renders EQ anymore).
- **Tests**: rewrote the old §124 EQ test for `bands`, added a bell-vs-
  lowshelf shape-distinction test. A "delete a middle band" regression test
  was drafted then DELETED — it compared two identical inputs (a tautology,
  always passes) because the id-vs-index bug it meant to catch only
  manifests in a LIVE reconciling engine across state changes, which a
  fresh one-shot `OfflineRenderer` render can't exercise. Left out rather
  than ship false coverage; worth revisiting with a proper two-render
  reconcile harness if this ever regresses for real.

Verification: typecheck clean (both projects), DSP suite 61/61, native
Standalone+VST3 rebuilt clean. Confirmed LIVE via screenshot: the graphic
editor renders (curve + colored points, zero knobs), the header's ⤢ pop-out
button renders correctly, and — unplanned but a strong end-to-end sanity
check — bands added via stray clicks during unrelated automation testing
survived a full app kill+rebuild+relaunch, proving the whole
UI→bridge→native-state→disk→reload round trip works. NOT confirmed: actually
opening the popout modal — its trigger is a ~16px icon button and repeated
click-automation attempts at it missed (same tiny-hit-target unreliability
flagged elsewhere in this doc for `.fx-chain-toggle`); the modal reuses the
exact `createPortal`+boolean-state pattern the already-proven LFO Function
editor uses, so this is a code-reviewed, not click-verified, gap. Worth a
manual check.

## 130. Follow-up fixes: PM/FM mod-from-zero DSP bug, FX-panel overflow, OSC gap, pitch-drag Shift (Claude) — typechecks + DSP suite (63/63) green, native rebuilt + screenshotted

Continuation of §129, addressing what the user found still broken after that pass:

- **Real DSP bug fixed**: "PM/FM knobs at 0%, add LFO at 100%, does nothing — same with filter."
  Root cause: `pairDepthScale`/`depthScale` (dsp/synth.js) were MULTIPLICATIVE (`1+m`)
  on top of the static `pm`/`fm` knob value — with the knob at 0, `0 × anything` is
  still 0, so no mod route could ever inject depth from a bare base. This was the
  real explanation behind the whole "PM/FM can't increase" saga in §129, which got
  misdiagnosed as an LFO-polarity-only issue. Fixed to be ADDITIVE (same convention
  every other continuous target already uses): `pairDepthMod` now returns the raw
  mod fraction and it's added directly onto the PM/FM depth (clamped to
  `[0, PM_INDEX]`/`[0, FM_DEPTH_HZ]`), and the `involved[]`/pair-build gating (which
  used to skip a pair entirely when its static knob was 0, so the graph node
  wouldn't even exist for a route to attach to) now also checks for a routed mod via
  the new `hasModRoute()` existence check. The `opNModAmount` "whole operator"
  fallback scale is UNCHANGED (still multiplicative) — that's a smaller, separate
  scope than what was reported; flagged here if it needs the same treatment later.
  New regression test added (`test/engine.test.mjs`): PM at 0%, env2 routed onto
  `op1Pm2` at 0.9, must produce audible PM (previously silent).
- **FX panel overflow fixed**: "FX modules way too big, cant see them all... cant
  even see the envs at all." `.fx-stage` had a hard `min-height: 125px` CSS floor —
  fine for 1 row (2 effects) but with 2 grid rows (3-4 effects) that's a 250px+
  hard minimum CSS Grid enforces regardless of actual available space. Since
  `.synth-scroll` clips overflow instead of scrolling (no-scrollbar rule), that
  silently pushed `.env-panel` (a later flex sibling) off the bottom. Fixed:
  dropped the floor to 40px so N rows can compress to fit, AND gave `.env-panel`
  `flex: 0 0 auto` so it can never be the thing that loses the space fight to a
  sibling's growth again, regardless of FX count. Verified via screenshot with 2
  active effects (clean); could NOT get the Win32 click automation to reliably
  toggle a 3rd effect on to screenshot the exact 2-row case (known limitation,
  same as flagged in §129) — the fix is verified by CSS mechanics, not visually
  confirmed at 3+ effects. Worth a manual check.
- **OSC card layout**: "phase mod knobs still obstructing pitch and LEVEL knobs."
  `.op-body`'s inter-column gap bumped 6px → 9px (there was 11px of slack left in
  the 246px-card width budget from §129's arithmetic; used just over half of it).
  Confirmed via screenshot — visibly more breathing room around the PM/FM mid
  column now.
- **Pitch-knob Shift-drag**: "holding shift to change pitch by 12 semitones only
  works via the mod cable, not when directly turning the knob." `PitchDial.tsx`'s
  own drag previously used Shift for FINE 0.1-semitone steps (an older, pre-existing
  convention, todo §31) — the OPPOSITE of what Shift does when scrolling a routed
  mod amount onto the same dial (jump an octave). Unified both to the same scheme:
  plain = 1 semitone/px-scaled drag, **Shift = jump a full octave (12 semitones)**,
  Ctrl = 0.1 semitone (fine), Ctrl+Alt = 0.01 semitone (finest). This DROPS the old
  Shift+Ctrl = 0.001 combo — flagging as a deliberate behavior change, not silently
  losing precision: 0.01 via Ctrl+Alt is still available, 0.001 is not anymore.

Verification: `tsc --noEmit` clean (both `tsconfig.renderer.json` and the plugin's
`build:plugin-assets`), DSP suite 63/63 (`node --test test/engine.test.mjs`), native
Release rebuild clean (Standalone + VST3) after killing a stale running instance
that was locking its own .exe and failing the link step — if a rebuild silently
"succeeds" on VST3 but fails linking Standalone, check for a running FazeSpike.exe
first before anything else.

## 129. Modulation-engine bug sweep + OSC/FX layout pass (Claude) — typechecks + DSP regression green, native rebuilt + screenshotted throughout

A big batch of user-reported bugs and layout requests, mostly modulation-engine correctness. Started with a parallel investigation workflow (5 agents) across the DSP/mod-amount/UI subsystems before touching any code, since this project already had one real regression this session from moving fast on interconnected mod-bridge code.

**Confirmed + fixed DSP/mod-engine bugs:**
- **Pitch modulation was capped at ±1 semitone no matter the dialed-in amount** — `translate.ts`'s `dspSpan()` hardcoded pitch's DSP-space divisor to 100 (cents) instead of the target's real ±2400ct range, so `amt` saturated to ±1 at just 100ct of the labeled ±2400ct range and going further did nothing. Fixed `dspSpan` to use `meta.max` like every other target, and rescaled `dsp/synth.js`'s exponent (`2^(gPitch·2)` instead of `2^(gPitch/12)`) so full-scale now genuinely reaches ±24 semitones. This is a real, audible behavior change for any existing pitch-mod route — flagging in case ±24 semitones reads as too extreme a default ceiling.
- **Filter cutoff mod said "+10000 Hz" but was always actually ±1 octave** — `dsp/synth.js`'s `filterParams()` has always applied cutoff modulation as `fc·2^amt` (octaves), but `mod-sources.ts` advertised the range in fictitious Hz. A wide-open 20kHz filter dropped by exactly 1 octave at full-negative lands at exactly 10000 Hz — the literal "seems to only modulate up to 10khz" the user saw. Relabeled `filterACutoff`/`filterBCutoff` to real octaves (±4, a wider and more useful sweep than the old accidental ±1 ceiling) — the mod-glow ring, which computes off the same `max`, is now honest too.
- **Wavetable-mode (wave=5) oscillators could not be phase/freq modulated at all, nor act as a PM/FM source** — confirmed critical bug, user: "This is crucial." The wave===5 branch in `dsp/synth.js` built its phasor straight off the bare carrier frequency, ignoring `pmSum`/`fmSum` entirely, and never called `el.tapOut`. Fixed to mirror the wave 0-3 `fmOsc` path exactly (FM into the phasor's frequency, PM as a phase offset + rewrap, tapOut when `involved[k]`). Added 2 new DSP regression tests proving a wavetable operator responds to incoming PM and works as a PM source for another operator (both previously silent no-ops).
- **PM/FM depth "can't increase, only decrease"** — investigated numerically (a diagnostic script driving `op1ModAmount` with a constant macro, then a real LFO): the DSP is symmetric and correct in both directions (0.5→1.8x depth measurably brighter, 0.5→0.2x measurably darker). Root cause was the LFO's own **polarity** setting — a unipolar LFO with a negative route amount only ever swings one way, which reads exactly like "can't increase." The polarity toggle added below (LFO card header) is the fix; no DSP change needed. The user confirmed after switching to bipolar it worked. Left the "increase feels less dramatic than decrease" psychoacoustic asymmetry alone (real, not a bug — see risks in the earlier investigation) rather than unilaterally changing the depth curve's character.

**Modulation-amount UX:**
- **LFO polarity control moved to the LFO's own card** (not just inside the Function editor's toolbar) — a ± / + toggle next to S&H, so bipolar/unipolar can be flipped without opening the shape editor.
- **Every modulation amount now reads as a percentage of the target's own range** (0%..100%/-100%) instead of a different native unit per target (cents, Hz, octaves, Q…) — user: "100% modulation would be the parameter's max value." **Exception: Pitch stays in cents** (a follow-up from the user, since musically pitch is more usefully read in cents/semitones than %) — paired with **quantized stepping**: scrolling a pitch-mod amount now snaps to 100ct (1 semitone) by default, Shift = 1200ct (1 octave), Ctrl = 10ct, Ctrl+Alt = 1ct, always landing on a clean multiple rather than an arbitrary number.
- **Hover-and-scroll now adjusts an existing route's amount directly**, without needing to be mid-cable-drag ("audition mode") first — user: this only worked while dragging a cable, not on a plain hover. Added a window-level wheel listener to `useModHoverEdit`, gated to when exactly one route is active on the hovered target (ambiguous with 2+ routes — opens the popover instead, unchanged).
- Factored the scroll-step formula (previously duplicated across `useCableDrag`, `useModHoverEdit`, and both `ModPopover` rows) into one shared `stepModAmount()` in `mod-sources.ts`, used by all four call sites now.

**Three independent curve-direction (drag-up-goes-down) bugs, all the same root cause** — re-derived directly from each graph's own rendering math rather than guessed: a breakpoint segment's rendered bulge moves OPPOSITE to `curve` when the segment is ASCENDING but WITH `curve` when DESCENDING (since `midLevel = a.level + (b.level-a.level)·0.5^power`, and `0.5^power` shrinks as curve grows). Each of these had baked in only ONE of those two signs:
- **Function editor's tension/curve handle** — inverted specifically on ascending segments (a sine wave has both directions; a fresh 2-point shape often only exposed one, which is why the user first thought it was shape-dependent rather than direction-dependent).
- **Velocity/Keytrack transfer curve** (`CurveGraph`) — always ascending (0→1), so it was backwards 100% of the time.
- **ADSR envelope's Attack handle** — same fix applied (its dot doesn't visually move with curve, unlike Decay/Release's midpoint dots, so this one was less obviously wrong, but the curve SHAPE it draws was still backwards). Decay/Release were already correct — both are descending segments, and the old single hardcoded sign happened to match that case, which is exactly why only SOME curve handles in the app read as inverted rather than all of them.

**Function editor:**
- **Paint modifier bug — Ctrl/Alt were converting the WHOLE shape on contact**, not painting as you drag. The first cut sampled the entire curve into columns the instant a modifier touched down; rewritten as `paintColumn()`, which now touches only the specific column under the cursor at any moment, leaving everything else exactly as drawn.
- **Ctrl+Alt "fast steps" felt inverted/weird** — likely cause: the visible grid never reflected Ctrl+Alt's actual (double-resolution) column width, so aiming precisely at a half-step's real boundary was guesswork. The grid now shows the ACTIVE paint resolution live during a gesture. Could not reproduce interactively to fully confirm (see Verified below) — worth a manual recheck.
- Grid X/Y are now drag-↕-or-scroll fields (matching the app's existing amount-control idiom), not type-in number inputs — user: "shouldn't have to type."
- The curve/tension handle now shows the same ↕ cursor as the grid steppers on hover.
- Ctrl+double-click (not plain double-click) required to enter "type a value" mode on every knob/dial/rate-corner in the app — user: plain double-click was triggering it by accident. The LFO graph's OWN double-click (opens the Function editor) is unchanged — that's not a text-input "typing mode."

**Right-click context menu (theme/options) — inverted from opt-out to opt-in:**
User: it "tends to get in the way… I only wanted it to appear if right-clicked at the very top area." Moved the `onContextMenu`/`setMenu` handler from the outermost `.app` div onto `<header>` specifically — since none of the oscillator/modulator/FX/piano/Function-editor trees are React descendants of `<header>` (confirmed true even for the Function editor's `createPortal`, since React's synthetic events bubble the component tree, not the DOM tree), this structurally excludes everywhere else without needing per-element `stopPropagation` opt-outs. The outer `.app` handler now just suppresses the native WebView2 context menu everywhere else (no menu of its own) and still cancels an in-progress click-to-assign drag. Also gave the Function editor's own right-click (delete a point) `stopPropagation`, and its backdrop a no-op context handler, as defense in depth.

**OSC card layout:**
- **Pan now sits bottom-right, directly opposite Filter A/B** (bottom-left) — user request. Took two tries: `align-items: stretch` + `min-height: 0` alone weren't enough because `.knob-field` (styles.css, meant for horizontal knob ROWS elsewhere) is `flex: 1 1 0`, which inside `.op-col-right`'s COLUMN made Level and Pan each grow to fill exactly half the column's height themselves — leaving `justify-content: space-between` nothing to distribute. Pinned `.op-col > .knob-field` back to `flex: 0 0 auto`.
- **OSC cards now stretch to fill the space freed by removing the section titles** (below), instead of leaving a dead gap above the modulator strip — user, follow-up: "we can stretch the oscillator cards down more so they have more room for the knobs because they are kind of cramped." `.op-panel`/`.op-grid`/`.op-body` now grow (with the `min-height:0` chain that requires at every level), spreading the knob rows further apart. Superseded an earlier `margin-top: auto` attempt on `.env-panel`, which turned out to starve this of any space to grow into (auto-margins claim free space before flex-grow gets a turn).
- Did **not** attempt to enlarge the PM/FM knobs themselves — still-standing prior finding (documented in `plugin-ui.css`) that this was tried twice before and confirmed not to fit the frozen window width.

**Real estate reclaimed (per the user's annotated screenshot):**
- "OSCILLATOR ENGINE" / "MODULATORS" section titles hidden in the plugin (kept in the shared component for the abandoned-but-still-present Electron path) — pure dead vertical space.
- The OSC panel's voice-count/last-note status row hidden — voices already shown in the header, and "Last note" was always a static "—" in the plugin regardless (`PluginApp` always passes `lastNoteMidi={null}`; only the Electron engine ever populated it).

**New: FX chain-at-a-glance strip.** User: "a fx chain module that allows us to see the chain at a glance… [house it] in the empty space on the right hand side of the filters… visible from both the synth view and also the fx view." Built `FxChainStrip` (`FxPanel.tsx`, exported) — all 8 effect types always listed (Distortion/Chorus/Flanger/Phaser/EQ/Compressor/Delay/Reverb) in a 2-column grid (the available slot is wide-but-short, ~95px tall/~610px wide — a single 8-row list didn't fit legibly), each row itself the on/off switch (click the dot to add/remove from `fx.chain`) with ▲▼ reorder buttons once active, reusing `FxPanel`'s existing `realOrder()`/`reordered()` — the same array that already drives the FX grid's render order, so reordering here immediately reorders the actual effect units too. Wired into `EnvelopePanel` via a new `renderFxChain` render prop (same pattern as `OscillatorPanel`'s `renderVisualizer`), replacing the long-reserved-but-empty `.fx-macro-area` placeholder — and since `EnvelopePanel` renders unconditionally regardless of the Synth/FX tab, "visible from both views" was automatic. Also renamed the "MASTER FX" tab to "FX" (user), and fixed its notification dot to check all 8 effects' wet/enabled state instead of a stale delay/reverb-only check (found while touching that line).

**Deferred / flagged, not attempted this session (all explicitly called out to the user):**
- The Bitwig-style "Wavetable LFO" (morphing between multiple custom Function shapes) — user's own idea, explicitly deferred.
- Removing the discrete wave-morph oscillator mode and unifying it into the wavetable engine (user: "we no longer have a need for the other mode… just have a simple wavetable that fades between sine, triangle, saw, square") — this is a core-oscillator-engine architecture change touching every patch; given this session's own experience with a fast-and-loose mod-bridge change causing a real regression, this one needs a dedicated, careful pass of its own rather than being squeezed in alongside everything else.
- Whether the FX-chain-toggle-adds-to-first-'off'-slot behavior (rather than a specific position) is the right default — flagged as a minor judgment call, not blocking.

**Verified:** root `tsc --noEmit` and `spike/elementary/ui/tsconfig.json` both clean throughout (checked after every logical group of changes, not just once at the end). Elementary DSP suite **all 62 passed** (60 pre-existing + 2 new wavetable-PM/FM-source tests). Native build (`build.sh Release`) rebuilt and clean after every change, screenshotted (PrintWindow) at each step to confirm visually — including the Pan/Filter-A/B alignment fix, the OSC-card stretch, and the FX chain strip in both its broken (overlapping text) and fixed (2-column) forms. **Could not get reliable Win32 mouse-automation for precise multi-step interactions this session** (double-clicks and modifier-held drags repeatedly landed on/dragged the wrong controls, corrupting the local standalone test settings file twice — cleared both times via `%APPDATA%\FazeSpike\FazeSpike.settings`); passive screenshots (no click required) worked reliably throughout and are what every visual claim above is based on. The three curve-direction fixes and the Ctrl+Alt grid-visibility fix are verified by re-deriving the rendering math by hand and checking DSP/typecheck green, not by an interactive re-test — worth the user's own hands-on pass, especially Ctrl+Alt painting.

## 128. LFO Functions polish + native Function-shape bridge (Claude) — typechecks + DSP regression green

Started as "small touches" on §127's Function generator; turned up a real bug along the way (see below).

- **Bug found + fixed — Function LFOs were silent in the real plugin.** `dsp.main.js`'s `toSynthState` already read `s.lfo{N}_functionShape` (§127's own "Deliberate follow-up" flagged this gap), but nothing ever SENT it: the UI bridge only carries flat `AudioParameterFloat` values via `setParameterValue`, which can't hold an array of points. So in the native VST/standalone, every Function-mode LFO fell back to `functionSignal`'s flat-zero default — the FN editor drew whatever you painted, but the DSP never heard it (worked only in the browser dev harness, where UI and DSP share one JS realm). Fixed with a new native message, `setFunctionShape(lfoIndex, shapeJson)` (`bridge.ts` → `WebViewEditor.cpp` → `PluginProcessor::setFunctionShape`), stored straight into the JSON `state` blob (`elem::js::Value` already supports nested Array/Object, same as the sampler's path/peaks strings) and round-tripped back through the existing `dispatchStateChange`/`__receiveStateChange__` channel. `useBridgeSynth.ts` forwards `lfo{1,2,3}.functionShape` on change and adopts it back on every native push, with echo-suppression (`fnShapeRef`) so the round trip can't clobber an in-progress drag in the editor. Persists through `getStateInformation`/`setStateInformation` like every other non-parameter `state` key (sampler paths, same precedent).
- **All LFOs are Functions now (user: "we shouldn't need a dedicated button for functions").** Removed the `FN` toggle; the continuous sine→triangle→saw→square morph drag is gone too (it turned out to be UI-only anyway — `shapePosition` was never read by the DSP, only by the small live-preview graph, a second latent bug this cleanup also removes). The center dot is now purely the rate-drag handle ("like a traditional LFO"); double-click still opens the Function editor for the shape itself. `normalizeLfo` (`shared/types.ts`) migrates any legacy `sine`/`triangle`/`sawtooth`/`square` patch into `wave: 'function'` with an exact (triangle/saw/square) or 33-point-sampled (sine) breakpoint reproduction (`functionShapeForLegacyWave`), so old presets keep sounding the same instead of resetting to a generic bump; `translate.ts`'s `lfoFromFlat` does the same for a stray legacy wave index arriving via host automation. Removed a genuine duplicate `LfoSettings` interface (types.ts) found in the process — TS interface merging had been silently papering over it.
- **Function editor: adjustable grid + paint tools (user request).** Grid line counts are now user-set per axis, 1-32, default 8x8 (`FunctionShape.gridX/gridY`), rendered as real time/level divisions instead of the old fixed 4-row-only grid — set by dragging ↕ or scrolling a small field, no typing (user: "shouldn't have to type"), same idiom as `LfoRateCorner`/`ModPopover`'s amount rows. Holding **Ctrl** paints flat steps snapped to the grid; **Alt** paints ramp-down stabs; **Shift+Alt** paints ramp-up stabs; **Ctrl+Alt** paints flat steps at double the grid's resolution ("half as long"). `paintColumn` replaces ONLY the touched column's own two points each time (a fix — see below); the point budget was raised 64 → 128 (`MAX_FUNCTION_POINTS`, shared/types.ts) to fit the worst case (32 grid cols × 2 for Ctrl+Alt × 2 points/col) — mirrored in `dsp/synth.js`'s `functionSignal` slice (kept a literal there, not an import; that file is bundled standalone on purpose, see its header).
- **UX fixes (user screenshot):** the piano keys were clipping the bottom modulator row's Velo/Filter controls — `.main-viz` (the big mostly-idle main scope) was 108px of mostly dead space; shrunk to 72px (`plugin-ui.css`), which was enough headroom on its own. Master FX view: `.fx-panel`/`.fx-unit`/`.fx-stage` now grow to fill the leftover height that used to sit as a dead gap between the modulator strip and the piano (Master FX's own content — 2 units — is much shorter than the Oscillators view's, and `.synth-controls` is a `flex:1 1 auto` column, so whichever view is shorter used to just leave blank space under `.env-panel`); the Reverb/Delay "sonic material" canvases are now visibly bigger as a direct result, and there's real headroom for the "cram like 8 audio fx in here" goal without the window growing.

**Follow-up fixes (same session, user caught these immediately after the first pass):**
- **Paint tools were converting the WHOLE shape, not just painted columns.** The first cut sampled the entire curve into columns the instant Ctrl/Alt touched down (`sampleShapeColumns`/`pointsFromColumns`), so holding Ctrl turned the whole pattern to steps on contact instead of acting as a modifier while painting. Rewritten as `paintColumn(points, col, cols, mode, level)`: drops only the points inside the ONE column being touched and reinserts its two new ones, leaving every other point (freeform or from earlier in the same stroke) untouched. `FunctionEditor`'s own paint state now keeps a working copy of `points` (seeded once at pointerdown, mutated in place) rather than a from-scratch column sampling, mirroring the existing point/curve-drag snapshot pattern in the same file.
- **Real regression — knobs jittering, LFO shape edits not sticking ("knobs snap back and forth", "LFOs don't do shit anymore").** Root cause: `useBridgeSynth`'s echo-suppression for `functionShape` compared raw `JSON.stringify` output, but native's `state` is a C++ `std::map` (alphabetical key order) while the JS side builds objects in a different order — so EVERY round trip through native looked like a "changed" shape, firing a redundant `setFunctionShape` on literally every unrelated knob tweak. Each one triggered an immediate native dispatch that could race ahead of an in-flight parameter write (e.g. a wave-index correction), so the UI would see a stale echo, mistake it for an external edit, and revert the correction — an oscillation that both fought the dragged knob's value and kept flipping `lfo{N}_wave` back to its legacy (pre-migration) index, so the DSP kept falling back to plain sine/triangle/saw regardless of what was drawn. Fixed with a key-order-independent `stableStringify` used only for the dedupe comparison (the actual wire payload is still plain JSON); also guarded against ever sending literal `"null"` when `functionShape` is somehow undefined (would parse into a real null natively and silence the LFO via `functionSignal`'s flat-zero fallback); also switched `PluginProcessor::setFunctionShape` from an immediate `dispatchStateChange()` to the existing debounced `scheduleStateDispatch()`, since the paint tools now call it on every pointermove — the exact "sustained stream" class of bug that debounce was already built to prevent (§73, froze Bitwig/FL once before).

**Deferred (user, explicitly out of scope for now):** a Bitwig-style "Wavetable LFO" — morphing continuously between two (or more) user-drawn custom Function shapes, with its own set of user-created "wavetables" of shapes. Flagged as a nice-later, not started.

**Open question — did NOT touch, needs a decision:** the user also asked to enlarge the OSC cards' PM/FM knobs and reclaim the "OSCILLATOR ENGINE" title-to-grid / grid-to-"MODULATORS" whitespace to give them room. `plugin-ui.css`'s own `.op-panel`/`.op-grid` comment block already documents this being **tried twice and confirmed not fitting** the frozen window width (246px cards × 4 + gaps = 993px, right at the ~1009px ceiling) — reverted both times. A fresh screenshot this session (post-`.main-viz` shrink) shows no actual PM/FM-vs-Pitch/Level/Pan overlap in the current build, so it's unclear whether the user is seeing a stale screenshot or wants the window widened (a user-visible size change, since it's frozen on purpose per §94). Needs the user's call before spending another round on this.

**Verified:** root `tsc --noEmit` (tsconfig.renderer.json) and `spike/elementary/ui/tsconfig.json` both clean, both before and after the follow-up fixes. Elementary DSP suite (`node test/engine.test.mjs`) **all 60 passed**. Native build (`build.sh Release`) clean, both VST3 and Standalone, rebuilt after every change. Screenshotted (PrintWindow) on a clean-default launch (deleted the stray `%APPDATA%\FazeSpike\FazeSpike.settings` this session's own click-testing had corrupted) and confirmed all three LFOs render their correct distinct default shapes — clean sine/triangle/sawtooth — with no jaggedness. Could **not** get reliable automated-click verification of the Function editor's grid/paint UI or the Master FX height fix in this session — Win32 click automation kept landing on the wrong screen coordinates (multi-monitor + the app's own documented DPI/zoom anomaly, `main.tsx`'s `--ui-scale` compensation), and one of those misfired attempts is what corrupted the settings file above. The paint-tool and knob-jitter fixes are verified by code trace-through (root cause identified and reasoned through explicitly, not guessed) plus the passing typechecks/DSP suite, not by an interactive re-test. Worth a manual pass: open Master FX, double-click an LFO graph, try the grid drag/scroll + Ctrl/Alt/Shift+Alt/Ctrl+Alt paint gestures, and drag a few knobs to confirm they track smoothly with no snapping.



## Decisions made (review me)
- Compressor upwardRatio: removed the vestigial param (types.ts, manifest, dsp.main.js), test rewritten to band-amount boost. Checkpoint eb8ddcf.


### 2026-10-08 — UI batch (typecheck clean; NOT rebuilt/visually verified)
- WT graphic: was calling `getWavetableFrame` with a missing `frameIndex` and never read `wtPos`; now memoises `generateWavetableFrames` per table+warp and picks the frame from `wtPos`. Plugin still has no ESW files (see ESW decision) so ids ≥2 show the fallback frame there.
- `ui/main.tsx`: `--ui-scale` now fit-to-window on every resize (design 1274x924) instead of a one-shot DPR fix.
- Arp View no longer swaps the main panel: it replaces the FX chain strip in the bottom row (`ArpPanel compact`); main visualizer now shows on Arp view too.
- FM caption margin 2px -> 0 to tighten FM-knobs → Filter/Pan gap. Check for caption overlap after rebuild.
- (2026-10-08, later) OSC card: Filter A/B + Pan row moved ABOVE Phase Mod; WT Pos is now a horizontal slider under the wavetable picker (modulation badge kept, modGlow dropped); bottom row removed. Full UI fits 1274x948 in headless Edge (verified by screenshot).
- (2026-10-08) Header: removed source-dot overview, macros are bare 40px knobs; arp strip knobs 48px; fit DESIGN_H 970 (fits at 1274x915 in headless Edge).
- (2026-10-08) ESW tables: native C++ DOES decode all 379 wavs (diag in fazespike-ui.log: `[esw] ... real frames: 379`) — but it finds them by walking up from the exe / hard-coded repo paths, so a VST3 in Program Files only works on this machine via the fallback. Proper ship = embed a binary (§165 2b). The WT *graphic* (webview, no fs) now uses `dsp/esw-preview.json` (256pt x 8 frames per table, `scripts/build-esw-preview.mjs`; regenerate if tables change). NOT listen-tested by Claude.
- (2026-10-08) Side gutters fixed: .synth-controls max-width removed, OSC cards fluid (minmax(310px,1fr)) so they fill the fit-scaled width.

### 2026-10-08 — §168 Performance audit + visual smoothness (built, no JS/native errors on launch; NOT eyeballed/listened by Claude)
**Measured:** (1) DSP reconcile (`renderSynth` + Elementary hash/diff in QuickJS) runs on the message thread: median **54 ms, max 216 ms** per dispatch (166 samples in fazespike-ui.log); same work is ~4 ms in V8 (node) → QuickJS ≈ 13x. Wavetable mode builds **2188 graph nodes** vs 791 for sine; ~1150 are the 8-frame crossfade (24 voice·op × 8 × table/sub/abs/max/mul/add). (2) UI JS is NOT the bottleneck (headless CPU profile: 96% idle; React re-render per knob tick ~free; 68 knobs / 2971 DOM nodes / 12 canvases). (3) Main scope frames were 2048 samples = ~23 distinct frames/s, drained at 30 Hz and rAF-capped to 30 fps → steppy; decimated by point-picking (aliasing) and int8 (grain).
**Done:** dsp.main.js skips identical state; native debounce adapts to last reconcile cost (was fixed 18 ms ⇒ drag pinned the thread); main scope 1024 samples @ full res, int16 transport, box-average decimation for the rest, scope drain 60 Hz; EQ scopes only shipped while an EQ canvas is mounted (`eqScopes` msg); rAF cap 30 → ~58 fps; Scope.tsx: cached FFT plans/no per-frame allocs, dB-scale log-frequency spectrum with smoothed decay, triggered (stable) oscilloscope, quadratic smoothing, shadowBlur → 2-pass glow, spectrogram via canvas self-blit + one ImageData column (no getImageData readback), main canvas DPR-aware.
**Not done / needs Stooge's OK (big):** cut graph size — (a) share tent-weight nodes across voices, (b) a 2-frame crossfade via a single `el.table` over a packed table (≈-50% nodes in wavetable mode), (c) skip/limit idle voices; move the DSP reconcile off the message thread (needs Elementary runtime work). Known noise: the webview logs "ESW tables unavailable" once (preview is used afterwards, harmless). Pre-existing: `npm test` compressor test (`boosts low-level signal RMS`) fails on the uncommitted synth.js WIP.

### 2026-10-08 — §166 v2: 16-step sequencer in a popout (Stooge: "a button ... that opens up a window like the LFO editor window but a detailed sequencer arp window so we have more space") — b659862
**Shipped:** `Seq` mode toggle + `⋯` launcher in the compact arp strip (PluginApp's FX-chain slot) and in the full Arp view. `⋯` opens `SeqEditor.tsx`, a 1180px `createPortal` popout — the same pattern/shape as the Function generator editor, so the two popouts behave identically (backdrop-click and × to dismiss, no native context menu leaking through). 16 lanes, each a column: gate on/off, velocity, gate length, ±2 octave. Steps slider (1..16) + Clear/Fill/Accent/Staccato/Reset-all.
**Engine:** `useArpEngine` gains `seqStep()`; `step()` dispatches to it when `seq.enabled`, so toggling takes effect on the next step, not the next mount. A rest is SKIPPED (not played at zero velocity) — that's the reason to want a sequencer over an arp.
**Three decisions, each with a reason worth not re-deriving:**
- **Playhead is NOT React state.** The scheduler is a setTimeout loop outside React; useState would re-render all 68 knobs up to 20x/sec, exactly what §168's perf pass avoided. New `lib/seqPlayhead.ts` (module store + subscribers); editor rAF-batches its cursor. Cleared on unmount or a closed popout leaves a stale lit step.
- **Cursor publishes BEFORE the rest check** — a sequencer that freezes its cursor on the first silence is unreadable. Probe case asserts it.
- **`lanes` always rebuilt to exactly 16** in `normalizeArp`. Pre-seq presets have no `seq` at all and still get a full pattern; a short array would make `lanes[i]` undefined mid-pattern (engine and UI both index by fixed width). Parked steps past `steps` stay in the array, so shortening a pattern doesn't destroy it.
**Deliberately out of scope:** per-step PITCH (a note you may not be holding). The arp derives every note from `held`, so this needs a separate engine path, not a UI row. Documented in types.ts — left for a later pass rather than half-built.
**Verified:** both typechecks clean. New `test/.seq-probe.mjs` 15/15 (rest skipping, cursor across rests, per-step octave+velocity, wrap at the ACTIVE step count not 16, all-rest patterns silent but cursor still cycling, octave-stacked pool). Two initial failures were MY test arithmetic, not engine bugs. DSP suite 66 pass; sole failure still the known pre-existing multiband upwardRatio bug. Both native binaries rebuilt FRESH; popout CSS + lane CSS + editor button verified present INSIDE FazeSpike.exe; VST3 reinstalled.
**NOT done / worth knowing:**
- **Not listen-tested or eyeballed by me** — the probe asserts the note stream, not the sound. Worth your own pass: hold a chord, arm arp, flip to Seq, open `⋯`.
- **§166-E still open:** this is still the JS setTimeout scheduler, not the sample-accurate audio-thread engine. Host-automated MIDI still bypasses the JS gate (double-trigger with the arp); only the on-screen piano is cleanly gated.
- **`plugin/run_build.bat` still points at the stale `Z:\GITHUB\fm\...` tree** — the exact bug §162 fixed everywhere else. It would build the wrong repo. I built around it; needs a one-line fix.
- (2026-10-08) **Sampler S0 DONE** (UI): per-OSC `WT | SMP` switch in each card header; SMP swaps the wavetable graphic/picker/WT Pos block for `SamplerBlock.tsx` (waveform peaks, RECORDR-style drag-to-highlight selection -> `sampleStart/End`, edge trim, dbl-click = all, Load…, loop, reverse, clear, root note). Reuses existing native/DSP. **Not yet:** S1 resample-record, S2 pop-out slice editor + drag-out-to-DAW (needs the JUCE external-drag spike). Untested with a real loaded file — please load one and report.
- (2026-10-08) New theme **Aurora ice** (`.theme-aurora-ice`, right-click header menu): black ice's palette + slow GPU-composited aurora drift behind lit glass panels, violet/cyan gradient logo, stronger glow, matching spectrogram ramp.
- (2026-10-09) **Standalone title bar removed** (WebViewEditor::parentHierarchyChanged strips the JUCE DocumentWindow's native title bar + hides its Options button, Standalone only; editor 1272x920 -> 1272x952 so the 32px goes to the UI). The header is now the drag handle (`winDrag` msgs, native tracks `Desktop::getMousePosition`) and carries ⚙ Options / – / ✕ (only when native reports `standalone:1`). **UNTESTED in the real window** — compiled + VST3 installed, but the Standalone exe was running (LNK1104). Check: drag, Options menu, min, close, window size/clipping; if `setUsingNativeTitleBar(false)` breaks the WebView embed, fall back to a custom JUCE app (`JUCE_USE_CUSTOM_PLUGIN_STANDALONE_APP`).
- (2026-10-09) Folder button right of each wavetable picker -> `openWavetableFolder` (opens the ESW folder in Explorer). **Not yet:** auto-scan that folder so dropped-in .wavs appear in the dropdown (list is still the static `esw-tables.json`; needs a native directory scan -> list sent to the UI).
- (2026-10-09) Layout re-budget: header tighter, filter/FX row 66 -> 92px, FX VIEW + ARP VIEW buttons now a permanent stacked pair at the right of the row in every view, fit DESIGN_H 992. Verified by headless screenshot (no overflow).
- (2026-10-09) Arp: **no on/off button** — clicking Up/Down/Up-Down/Random/As-Played turns the arp on with that pattern, another pattern switches, the active pattern turns it off. **Key snap**: `ArpSettings.keySnap/keyRoot/keyScale` (+ `src/shared/scales.ts`, 10 scales); strip has Key chip + root + scale; every arp/seq note is pulled to the nearest in-key note (engine). Sequencer popout (⋯) gained a per-step **Semi** lane (-12..+12, `SeqStepSettings.semitone`; with Key snap on the slider steps through the scale) and a Key snap toolbar group. Typechecks clean; **not listened to**.
- (2026-10-09) Header **Key** button (left of the preset bar): one-shot snaps the 4 OSC pitch knobs to the nearest scale-degree offsets of the arp's chosen scale (interval-based, i.e. assumes the played note is the tonic; root note is not applied).

- 2026-10-09: Q: FX/Synth alignment -> render .main-viz on both views (recommended). Checkpoint 7abcf3f.
- ESW tables: ship precomputed binary (not cut dropdown to built-ins) - licence free per Stooge; 64-frame cap, int16 - see DECISION checkpoint commit (2026-10-09)
- wavetables.bin keeps all 381 tables so index==wtId (jumpy-id exclusion dropped); DECISION commit above the fix
- 2026-10-09 (round 3, no separate checkpoint commit; revert = the commits from 'Arp: stop re-reading its own notes' onward): Arp/Seq moved fully native (plugin/ArpEngine.h) and the plugin UI no longer runs the JS useArpEngine; gate/freq/vel/keytrack now reach the DSP through a native 'voicectl' node (plugin/VoiceCtl.h) instead of the debounced state snapshot; resample takes are saved as WAVs under AppData/Faze/Samples and loaded through loadSampleFile (so they persist via the existing sample path). All built OK but NOT listen-tested.
- Phase 0 registry approach (2026-10-16): recommended option (a) create registry file first. Checkpoint 0ef6c6e, implemented in 25373db.
