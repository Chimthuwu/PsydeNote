# Arpeggiator + Step Sequencer — research & implementation plan

*Written 2026-10-09 for Stooge. Nothing in this document is implemented yet — it is the spec we will build from.
Supersedes the earlier sketch in `todo.md` §166 (kept there for history; where the two disagree, this file wins).*

Sources read for this plan
* **Arturia Pigments 5 User Manual**, chapter 10 "Sequencer and Arpeggiator" (pp. 175–189) and §3.3.6 — read in full from the PDF
  (<https://dl.arturia.net/products/pigments/manual/pigments_Manual_5_0_0_EN.pdf>). Every "Pigments does X" below is from that chapter unless marked otherwise.
* Splice, *What's new in Pigments 5?* (<https://splice.com/blog/?p=31002>) and Sweetwater's Pigments 3 quickstart — secondary confirmation of the dice / Random Amount behaviour.
* Your Bitwig device `XXX CUNTHUWU [CHIMI].bwpreset` (Note FX Layer) — its parameter and device names were extracted from the binary preset; the screenshot is saved as
  `docs/mockups/Bitwig CHIMI chord-arp layer device (reference).png`.
* Current FAZE code: `plugin/ArpEngine.h`, `src/renderer/components/ArpPanel.tsx`, `SeqEditor.tsx`, `useArpEngine.ts`.

---

## 0. Quick answers to the questions in your note

| Question | Answer |
|---|---|
| **"Is the detail view the sequencer?"** | **Yes.** The `⋯` button in the arp strip opens `SeqEditor` — the 16-step lane editor (per-step on/off, velocity, gate, octave, semitone). It opens even while you are in *Arp* mode, which is confusing: today there is no separate detailed *arpeggiator* view. The plan below gives each its own. |
| **Gate knob "doesn't do anything"?** | The engine *does* use it (`ArpEngine.h`: note-off is scheduled at `stepLen × gate`). It is **masked by the amp envelope release**: ENV 1 defaults to a 0.4 s release, but at 8 Hz a step is only 125 ms, so every note rings on well past its gate-off and the gate change is inaudible (more so with several voices overlapping). Diagnosed by reading the code — **not yet verified by ear**; test: set ENV 1 release to ~0 and sweep Gate. If confirmed it is not a bug in the arp, it is a UX problem: see §7.3 (gate must feel audible). |
| **Glide "way too sensitive, even at the lowest values"?** | Two causes, both in code: (1) the knob is **linear** 0–5 s, so the first pixel of travel is already ~50 ms; (2) the value drives a one-pole smoother whose *time constant* is the number shown, i.e. the pitch needs ~3× that long to arrive — and the smoother runs on frequency in Hz (not in pitch), so wide intervals sweep fast then crawl. Fix: exponential/cubic taper on the knob + treat the value as "time to arrive" (τ = t/3) + smooth in log-frequency. Logged in `todo.md`. |
| **Where should Glide live?** | You want it near the arpeggiator. Not decided — see §7.4 for the options; **not implementing yet**, as you asked. |

---

## 1. What FAZE has today

* **Engine** (`plugin/ArpEngine.h`, runs in `processBlock`, sample-accurate): 5 modes (Up, Down, Up/Down, Random, As Played), rate in **Hz** (0.5–20), octaves 1–4,
  global gate, Hold, key-snap (root + scale), and a **16-step lane table**: per step `on`, `vel`, `gate`, `octave`, `semitone`; pattern length 1–16. In Seq mode the held chord is
  played step-by-step (note = pool[step % notes] + octave·12 + semitone).
* **UI**: compact arp strip (mode buttons, Seq toggle, `⋯` detail button, Key snap, Hold, Rate/Octaves/Gate knobs) and a pop-out `SeqEditor` modal for the lanes.
* **Missing vs. Pigments / your brief**: playback direction options, tempo sync (rate is Hz only), swing, probability, slide, per-lane random ("dice"), Regen/Auto-Regen,
  per-lane length (polymetry), rotation, per-lane rate divider, lock, pattern presets, modulation of any sequencer value, and the whole chord-layer / arp-layer device.

---

## 2. How the Pigments sequencer works (reference)

### 2.1 Structure
* One tab, **two modes**: *Step Sequencer* and *Arpeggiator*. They share all lanes and settings; the Arp simply takes its **pitch from the held keys**, so the **Pitch lane is unavailable in Arp mode**.
  You can generate a pattern in Seq mode and use it as an arp rhythm.
* **16 steps max, length 1–16** (drag the grey end-line), combinable with tempo sync for odd meters.
* **Rows = tracks (lanes)**, **columns = steps**. Drag a bar to set a value, drag horizontally to *paint*; **Shift-drag** edits the whole lane proportionally (values keep their ratios until one hits min/max, then the others "catch up").

### 2.2 The six lanes
| Lane | Range / behaviour |
|---|---|
| **Pitch** (Seq only) | semitone within **one octave** per step; "dragging the number beside PITCH transposes the whole track"; that transpose is a **modulation destination applied *before* the scale**, so you can modulate pitch and still stay in key. |
| **On/Off + Probability** | each step has an on/off button and a **Trigger Probability** (100% = always, 0% = never). |
| **Velocity** | 1–127 per step, plus a **velocity %** field: 0% = use only incoming MIDI velocity, 100% = only the step velocity, in-between = ratio. |
| **Octave** | **±2 octaves** per step (separate from Pitch). |
| **Gate Length** | **5 % … 400 %** of a step (400 % sustains across 4 steps). Interacts with Play Mode: in *Poly* long gates ring over later steps; in *Mono/Legato* a later step cuts the earlier note off. |
| **Slide** | glide time in **milliseconds** from the previous step's pitch. |

Per-lane extras: **Random** (dice), **Div** (a per-lane rate divider, "half down to one-sixteenth"), **Reset** (eraser), **Rotation** (◀ ▶ shifts the lane one step per click, wrapping), and a per-**step Random Lock** (padlock on the step number: that step is immune to generation).

### 2.3 Playback
* **Mode**: forward · backward · **continuous forward-and-backward ("bounces")** · random order.
* **Rate / sync**: free BPM, or synced (straight / triplet / dotted), from many bars down to fine divisions. **Swing 50–75 %** (50 = straight).
* **Polymetry**: separate **length handle per lane**, so lanes drift against each other (e.g. 5-step pitch over a 16-step gate) — "less robotic". **Reset**: after N steps every lane realigns to step 1 (works with or without polymetry).
* **Arp modes**: As Played, Up, Down, Up&Down *inclusive* (top/bottom repeated), Up&Down *exclusive*, Random. One note held = repeated; several = alternated. (Chord-unison modes give chord arpeggiation.)
* **Pattern browser** (Seq mode): Factory / Presets / User; **Seq/Arp Lock** (padlock) keeps the pattern while you change the sound preset.
* MIDI out: the pattern can also drive other instruments.

### 2.4 The dice — how Pigments' randomness really works (the part you asked about)
This is the key idea, and it is more subtle than "randomise the lane":

1. **Each lane has a small dice = a *Random Amount* from 0 % to 100 %** (click = roll new values for that lane; **drag up/down on the dice = set the amount**). Amount 0 % ⇒ that lane is **never** touched by generation.
2. **The big Generation dice ("Regen")** rolls **every lane at once, each within its own amount**. "You control exactly how much chaos applies." It works while playing or stopped.
3. Random values are a **separate overlay on top of the pattern you drew** — the drawn values are not destroyed:
   * **X (Clear random values)** removes the overlay and **restores your original pattern**.
   * **✓ (Apply random values)** bakes the overlay into the pattern permanently (and into a saved pattern/preset).
   * the per-lane **eraser** resets a lane to defaults; the History menu is the undo.
4. **Auto Regen**: re-rolls everything on a schedule — from **1/16 bar up to 8 bars** — "never quite playing the same phrase twice".
5. **Pitch randomness is "odds", not "distance"**: the Pitch dice "increases the odds that at any step a different note is going to be played than the one you chose". *Which* note comes out is decided by the **scale** and, in the scale editor, **per-note probability sliders** ("a prize draw": a high slider = more tickets, 0 = can never win). **Snap-to-scale** also constrains random notes. 14 classic + 10 generative scales (+ Custom).
6. Per-step **Random Lock** protects chosen steps (e.g. keep the downbeat note, randomise the rest).

### 2.5 What Pigments does *not* appear to have (so we are free to differ)
Ratchets/note-repeat, per-step "mod lanes", a "rest" distinct from probability, chord-layer octave stacks. (Pigments' manual lists none of these.)

---

## 3. FAZE sequencer — target feature set

Everything in §2 that fits, plus your additions. **Lanes (all with a dice + amount, a length, a divider):**

| Lane | Range | Notes |
|---|---|---|
| **On/Probability** | 0–100 % | on/off button per step + probability |
| **Pitch** (Seq only) | −12…+12 st (one octave is Pigments; we allow a bit more) | scale-snapped; transpose-all field before scale |
| **Octave** | −2…+2 | |
| **Velocity** | 1–127 (+ velocity-% balance vs. incoming) | |
| **Gate** | 5 %–400 % of a step | cut-off rules per voice mode, see §7.3 |
| **Slide** | 0–1000 ms | needs a per-note glide in the DSP (§6.4) |

**Your requested playback controls** (a `Direction` selector — superset of Pigments):
* **→ Forward** · **← Backward**
* **↔ Bounce, ends repeated** ("left-right, right-left, left-right…": 1 2 3 4 4 3 2 1 1 2 …)
* **↔ Bounce, ends not repeated** (1 2 3 4 3 2 1 2 …)
* **? Random** — each step picks a random step 1…N (option: *no immediate repeat*)
* Optional extras (cheap, from Bitwig's list): **drunk walk** (±1 random), **converge** (outside→in), **diverge** (inside→out).

**Dice (per lane) + Generation — FAZE rules (decisions in bold, open points in §9):**
* Keep Pigments' **overlay model**: `effective = overlay[i] ?? base[i]`; **Clear** and **Apply** buttons; per-lane dice **click = re-roll that lane, drag = amount**; big dice = Regen all; per-step **random lock**.
* **Auto Regen** every `1/16 … 8` bars (aligned to the host bar if playing, else the internal clock), or Off.
* **What "amount" means** (your spec: *"higher values will assign values much higher or lower than what the value is currently set at"*):
  * **continuous lanes (velocity, gate, slide, probability):** `overlay = clamp(base + (u·2−1) · amount · span)` with `u ~ U(0,1)` — so the **size of the deviation grows with the amount**: 10 % wanders a little around your drawn value, 100 % can land anywhere in the lane's range, up or down.
  * **octave lane:** with probability `amount` the step is replaced by `base + k`, `k` drawn from `±round(amount·2)` (so a low amount only nudges ±1 octave, 100 % reaches ±2).
  * **pitch lane:** Pigments' odds model **plus** your magnitude idea: with probability `amount` the step is replaced by a **scale degree** drawn with the **per-note weights**, restricted to within `round(amount·11)+1` semitones of the drawn note (so low amounts stay melodic, 100 % may jump anywhere in the scale).
  * **probability / on-off:** the dice moves the step probability (continuous rule) rather than flipping steps outright.
* **Frozen vs Live chaos** (new switch, default **Frozen** = Pigments): *Frozen* — the overlay is rolled on Regen / Auto-Regen and then repeats; *Live* — a fresh draw every time a step plays (never repeats; the "chaos knob").
* **Deterministic**: a seeded xorshift PRNG, seed advanced on every roll; the seed is part of the saved state so a roll can be reproduced and tested.

**Polymetry / structure (from Pigments):** per-lane length, per-lane **Div** (÷2…÷16), **Rotation** ◀ ▶, **Reset/realign after N steps**, **Swing 50–75 %**, **tempo-synced rate** (straight/triplet/dotted + free BPM — replaces Hz).

**Preset layer:** pattern browser (Factory / Presets / User), Seq/Arp **Lock** across sound presets, pattern-only save/load.

---

## 4. Arpeggiator mode — target

Everything above except the Pitch lane, plus the arp patterns. **Patterns**: As Played · Up · Down · Up&Down inclusive · Up&Down exclusive · Random, and from your Bitwig device: **Poly (all notes each step)**, Down&Up, converge up/down, diverge up/down, thumb-up / thumb-down / pinky-up / pinky-down. (The preset contains exactly these 16 pattern icons.)
Other Bitwig arp parameters worth keeping (names taken from the preset): **Octaves**, **Rate mode** (1×, 1.5×, 2/3× base — dotted/triplet), per-step **STEP_n_TRANSPOSE** and **GATE_n** (16 each), **Global Gate**, **Shape**, **Humanize**, **Octave behaviour**, **Overlapping notes**, **Free note start**, **Immediately terminate notes**, **Pressure→Velocity**; and a separate **Note Filter** (min/max key and velocity) device.

### 4.1 The "chord-layer + arp-layer" device (your Bitwig design)
Reading `XXX CUNTHUWU [CHIMI].bwpreset`: it is a **Note FX Layer holding 16 Arpeggiator devices** (plus Chords and Note-Filter devices); the 5-column front panel exposes a few macros — **VELOCITY, ARP RATE, OCTAVE, SHAPE, GATE** — and rows of octave buttons **−2 −1 0 +1 +2**:
* **Big buttons (bottom row)** — *chord layers*: the held chord is played **as-is**, transposed by that many octaves. `0` = the chord as played; `+1` also layers the chord an octave up, `−1` an octave down, etc. Any combination can be on at once.
* **Small "ARP" buttons** — *arp layers*: the held chord is **arpeggiated** at that octave offset. Two rows exist "so the chords can play at the same time as the arpeggiator", e.g. chord on −1 while 0 and +1 arpeggiate the same notes.
* Knobs add rate / shape / gate / velocity and randomisation across all layers.

**FAZE implementation**
* **Layers panel in the Arp view**: row **Chord** `[-2][-1][0][+1][+2]` (toggles) and one or two **Arp** rows with the same five offsets; each layer has its own on/off (and, optionally, level/velocity).
* Engine: per held chord build `chordLayers = {offset}`, `arpLayers = {(row, offset)}`; chord layers emit note-on/off with the keys (sustained, transposed); arp layers feed the arp pool (`pool = chord notes + 12·offset`) and each arp **row** runs its own step clock sharing rate/gate/shape.
* **Open question for you** (§9): the screenshot shows the small buttons as five **pairs** (`−2 −1 | −1 0 | 0 0 | 0 +1 | +1 +2`) with a green "on" in each pair — I cannot tell if those are two arp rows, a *from–to octave range* per row, or something else. I will build the generic version above and adjust once you confirm.
* This is **arpeggiator-only**; it does not exist in Seq mode (as you said).

### 4.2 Detailed arpeggiation view
Its own docked view (not the sequencer lanes): 16-pattern selector (icons), octaves/rate/shape/humanize, the **Layers** grid, per-step **transpose + gate** (Bitwig's STEP_n_TRANSPOSE / GATE_n) and the Note Filter; the same dice/Regen/Auto-Regen applies to its lanes.

---

## 5. UI plan

* **Docked, not modal.** The detail views become a main-area view (like Synth / FX), replacing the OSC panel, so **the modulator strip stays visible and cable-draggable** — required by your brief ("modulators accessible while viewing the sequencer"). Today's pop-out modal hides the strip.
* **Detail button**: replace `⋯` with a **♪ (quaver) icon button in a distinct accent colour** that stands out; the two views get their own buttons (Seq editor / Arp editor).
* **Arp panel look**: background to read as brushed metal, similar to (not identical to) the filter panel; currently too dark.
* **Arp knobs** (Rate/Octaves/Gate, size `sm`): larger, with the value text readable.
* **Top bar knobs** (Oct/Semi/Fine/Glide/Master/8 macros): grow to at least the **Resonance knob** size by enlarging the *top bar only* (everything below keeps its size); macros are also hard to turn → larger hit area + finer drag.
* **Collapsed modulator section**: a chevron collapses the strip to card headers only (mockup saved: `docs/mockups/Collapsed modulator section (tops only).png`); cable drags from the dots keep working.
* Lane editor: reuse `FunctionEditor` paint/drag code (see §166), add dice buttons, Regen/Auto-Regen/Clear/Apply, direction select, length handles, rotation, div.

---

## 6. Engine architecture

### 6.1 Data model (JSON from the UI, parsed natively like today)
```
arpseq: {
  mode: 'seq'|'arp', on, hold, lock,
  playback: { direction, rate:{ sync:'free'|'sync', bpm|division, feel:'straight'|'triplet'|'dotted' },
              swing:50..75, length:1..16, polymetry:bool, resetAfter:0|n },
  lanes: { pitch, octave, velocity, probability, gate, slide },   // each:
     { base:number[16], overlay:(number|null)[16], amount:0..1, length:1..16,
       div:1|2|3|4|6|8|16, rotation:int, locked:boolean[16] }
  velocityPct, pitchTranspose,
  generation: { autoRegenBars:0|1/16..8, chaos:'frozen'|'live', seed },
  scale: { id, root, weights[12], snap },
  arp: { pattern, octaves, rateMode, shape, humanize, stepTranspose[16], stepGate[16], layers:{chord:[bool×5], arp:[[bool×5]…]} }
}
```
Backwards compatibility: today's `ArpSettings` maps onto this (lanes `on/vel/gate/octave/semitone`).

### 6.2 Where it runs
Stays in `ArpEngine.h` inside `processBlock` (sample-accurate note on/off, no allocation). New: a **reference spec in JS** (`dsp/arpseq.js`, pure + seedable) and a **differential harness** (same approach as `test/spectral-warp-diff/`) so C++ and JS emit identical `(sampleOffset, note, on/off, velocity)` streams; plus an MSVC test like `test/voices/voices-test.cpp`.

### 6.3 Clock
Host `ppq/bpm` when playing; internal accumulator otherwise. **Tempo-synced rates and Auto-Regen bars need bar position** (use host ppq, else count internal bars from 4/4 at the internal BPM). Swing delays odd steps by `(swing−50)%` of a step. Per-lane `div` and `length` each keep their own step counter derived from the global step count (polymetry = independent modulo; `resetAfter` zeroes all counters).

### 6.4 Slide (needs DSP work)
Per-step Slide means "glide into *this* note's pitch over *N* ms". The voice frequency smoother is now `glide`-controlled globally; Slide needs the **time constant per note**: extend the native `voicectl` node with a `slide` field (written by the arp when it triggers a step) and have `synth.js` use `max(PITCH_TAU, slide)` per voice. Also decide mono/legato behaviour: Pigments' slide is meaningful mainly with Mono/Legato (retrigger vs. tie) — we already have those voice modes.

### 6.5 Modulating sequencer values (the hard part)
The mod matrix runs **in the Elementary graph**, but the arp runs **natively before it**. To modulate seq parameters (rate, swing, gate scale, pitch transpose, velocity %, each lane's random amount…):
* Add a native Elementary node **`ctlout`** (inverse of `voicectl`): the graph feeds it a modulated value per slot and it writes **atomics**; `ArpEngine` reads them at the top of the next block (**one block of latency — fine**; both run on the same audio thread inside `processBlock`).
* Register new mod **targets** *appended* to `MOD_TARGETS` (never reorder — host automation); the §165-C index-drift lesson applies, and `wire.test.mjs` already checks index parity.
* Because values like *pitch transpose* apply **before the scale** (as in Pigments), modulation stays in key.

### 6.6 Voices
12 voices now (was 6) — enough for arp tails; Mono/Legato exist; Gate > 100 % in Poly rings over later steps.

---

## 7. Fixes / UX items that block "feels right"

1. **Gate must be audible**: with the default 0.4 s amp release, short gates are masked. Options: (a) show the gate lane visually relative to the step *and* add an **"Arp releases envelope fast"** helper (short per-note release when the arp turns a note off — i.e. gate-off = envelope release trigger, not just note-off), (b) leave the engine and document. Needs your call.
2. **Glide taper** (see §0).
3. **Hit-testing/sizes** of arp knobs and macros (§5).
4. **Glide location** — options for later: keep in the top bar; move beside Rate in the arp strip; or per-step **Slide lane** (this plan) replacing a global glide in arp/seq mode. **Not implementing yet.**

---

## 8. Phased plan (each phase shippable + tested)

| Phase | Deliverable | Tests / acceptance |
|---|---|---|
| **P0** | Gate-masking check, glide taper + τ=t/3, larger top-bar/arp knobs, ♪ detail button, metal panel (UI polish, no engine change) | headless layout measurements; gate-vs-release listening note |
| **P1** | Engine refactor to the §6.1 model; **direction** options; **tempo sync + swing**; Probability + Slide data (Slide DSP later); JS reference + diff harness | note streams identical C++/JS; arp-sim tests; 8–20 Hz steadiness |
| **P2** | **Dice**: overlay model, per-lane amount, Regen, Clear/Apply, per-step lock, Auto Regen, Frozen/Live, scale weights | statistical tests (deviation grows with amount; 0 % never changes; lock honoured; seed reproducible) |
| **P3** | **Polymetry**: per-lane length/div/rotation/reset | counter tests; odd-meter examples |
| **P4** | **Docked Seq/Arp views with the modulator strip visible**, `ctlout` node + new mod targets | wire test for target indices; modulate rate/gate and hear it |
| **P5** | **Chord/Arp layers** device + detailed Arp view + the 16 patterns | layer combinations produce the expected note sets; no stuck notes |
| **P6** | Slide DSP, pattern browser/lock/presets, custom scale editor | slide ramps without retrigger click; save/load round trip |

---

## 9. Open questions for you

1. **Dice "amount" feel** — OK with the rules in §3 (deviation size grows with amount; pitch uses scale-degree draws within a reach that grows with amount)? Frozen-by-default, with an optional Live mode?
2. **Bitwig device buttons** — are the small ARP buttons *two rows* of octave offsets, or *from–to octave ranges* per column? (see §4.1)
3. **Gate audibility** — do you want the arp to shorten the amp release when a gate ends (so gate length is always audible), or leave the envelope alone?
4. **Detail views** — docked main-area views (modulators visible) as proposed, replacing the OSC panel while open?
5. **Rate** — move from Hz to tempo-synced divisions (keeping a free BPM option)? Pigments does.
6. **Pitch lane range** — one octave like Pigments plus the separate Octave lane, or a wider single pitch lane?
7. **Glide / Slide** — keep the global Glide in the top bar *and* add the per-step Slide lane, or fold them together in arp/seq mode?
