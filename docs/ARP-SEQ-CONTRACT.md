# ARP / SEQ — implementation CONTRACT (all agents build to exactly this)

Companion to `docs/ARP-SEQ-PLAN.md` (the *why*). This file is the *what*: names, units, defaults and the
interfaces between the native engine, the DSP glue, the data layer and the UI. **If you need to deviate, do not — message
the integrator in your final report instead.** Decisions already taken for the open questions of the plan §9:
dice = deviation grows with amount (plan §3 rules); Frozen default + optional Live; docked detail views; tempo-synced rate
(with a free-Hz option); pitch lane ±12 + separate octave lane; keep global Glide in the top bar AND add the per-step Slide lane
(do NOT move Glide next to the arp — that is undecided); Bitwig device generalised to chord row + two arp rows of octave offsets
−2…+2; arp "tight release" ON by default.

## 1. Data model — `ArpSettings` (TypeScript, `src/shared/types.ts`) == the JSON the UI sends via `setArpConfig`
The engine parses `JSON.stringify(synth.arp)` — **same field names, same units**. Arrays are always full length.

```ts
export type ArpMode =                       // arp patterns (the 16 from the Bitwig preset + Pigments' two up/down flavours)
  | 'up' | 'down' | 'updown' | 'updownExcl' | 'downup' | 'random' | 'asPlayed' | 'poly'
  | 'convergeUp' | 'convergeDown' | 'divergeUp' | 'divergeDown'
  | 'thumbUp' | 'thumbDown' | 'pinkyUp' | 'pinkyDown';
export type SeqDirection = 'fwd' | 'bwd' | 'bounce' | 'bounceExcl' | 'random' | 'randomNoRepeat' | 'drunk' | 'converge' | 'diverge';
//  bounce      = ends repeated   (1 2 3 4 4 3 2 1 1 2 …)      bounceExcl = ends not repeated (1 2 3 4 3 2 1 2 …)
//  converge    = outside→in (1 N 2 N-1 …)   diverge = inside→out   drunk = ±1 random walk
export type RateDiv = '1/1' | '1/2' | '1/4' | '1/8' | '1/16' | '1/32';
export type LaneId = 'on' | 'prob' | 'pitch' | 'octave' | 'vel' | 'gate' | 'slide';
export const SEQ_STEPS = 16;
export const LANE_IDS: LaneId[] = ['on','prob','pitch','octave','vel','gate','slide'];

export interface SeqLane {
  base: number[];            // 16 values — what the user drew
  overlay: (number | null)[];// 16 — the dice overlay, NULL = none. Engine-owned; UI receives it via __arpOverlay__ and may display it.
                             //   effective value of a step = overlay[i] ?? base[i]
  amount: number;            // 0..1  — the dice "Random Amount" (0 = this lane is never randomised)
  length: number;            // 1..16 — this lane's own length (only honoured when seq.polymetry, else seq.length is used)
  div: 1 | 2 | 3 | 4 | 6 | 8 | 16; // lane rate divider: the lane advances once per `div` global steps
  rotation: number;          // integer, shifts the lane left/right (wraps within `length`)
  locked: boolean[];         // 16 — per-step random lock (step is immune to dice)
  rollToken: number;         // UI increments → engine re-rolls THIS lane's overlay once
}
// Lane units / ranges / defaults (base[] all set to the default):
//   on     0|1            default 1        prob   0..1        default 1
//   pitch  −12..12 (int)  default 0        octave −2..2 (int) default 0
//   vel    0..1           default 0.8      gate   0.05..4 (fraction of ONE step; 4 = rings across 4 steps)  default 0.6
//   slide  0..1000 ms     default 0

export interface SeqSettings {
  enabled: boolean;          // false = Arp mode, true = Seq mode
  direction: SeqDirection;   // default 'fwd'
  length: number;            // 1..16 global pattern length, default 8
  polymetry: boolean;        // true → every lane uses its own `length`
  resetAfter: number;        // 0 = off; else every N global steps all lane counters realign to step 1
  pitchTranspose: number;    // −24..24 semitones, applied BEFORE scale snapping
  lanes: Record<LaneId, SeqLane>;
}

export interface ArpRate {
  sync: boolean;             // true = tempo-synced division; false = free Hz
  div: RateDiv;              // default '1/16'
  feel: 'straight' | 'triplet' | 'dotted';   // default 'straight'
  hz: number;                // 0.5..20, used when sync=false, default 8
}
export interface ArpLayers {            // octave-offset buttons, index 0..4 ⇔ offset −2,−1,0,+1,+2
  chord: boolean[];                     // 5 — held chord played AS-IS at that offset (sustained with the keys). default all false
  arp: boolean[][];                     // 2×5 — two arp rows; each enabled button arpeggiates the held chord shifted by that offset. default [[F,F,T,F,F],[F,F,F,F,F]]
}
export interface ArpExtras {
  useStepLanes: boolean;                // true → stepTranspose/stepGate apply in ARP mode. default false
  stepTranspose: number[];              // 16 × int −12..12 (semitones added to that arp step)
  stepGate: number[];                   // 16 × 0.05..4 (gate multiplier for that arp step)
  layers: ArpLayers;
  tightRelease: boolean;                // default true: a gate-off cut by the arp also shortens the voice's amp release so Gate is audible
  humanize: number;                     // 0..1 timing+velocity jitter, default 0
  shape: number;                        // −1..1 groove: >0 pushes odd steps late (extra swing), <0 early. default 0
}
export interface ArpGeneration {
  autoRegen: number;                    // 0 = off, else bars: 0.0625 0.125 0.25 0.5 1 2 4 8 (one bar = 4 beats)
  chaos: 'frozen' | 'live';             // frozen: overlay rolled on regen then repeats; live: fresh draw every time a step plays
  seed: number;                         // uint32, default 1; engine advances its own internal state from it
  regenToken: number;                   // UI increments → engine rolls EVERY lane with amount>0
  clearToken: number;                   // UI increments → engine clears all overlays
}
export interface ArpScale { weights: number[]; snap: boolean }   // weights: 12 × 0..1 per pitch class relative to key root (root always 1). snap = also quantise
export interface ArpSettings {
  on: boolean;
  mode: ArpMode;                        // arp pattern, default 'up'
  hold: boolean;
  octaves: number;                      // 1..4, default 1
  rate: ArpRate;
  swing: number;                        // 50..75 (%), default 50
  gate: number;                         // 0.05..4 global gate (fraction of a step) used by ARP mode when !arp.useStepLanes; default 0.6
  velocityPct: number;                  // 0..1: 0 = incoming MIDI velocity only, 1 = step velocity only, default 0.5 (Seq mode); arp mode uses MIDI velocity × vel lane if useStepLanes
  keySnap: boolean; keyRoot: number; keyScale: ScaleId;   // existing fields, unchanged
  seq: SeqSettings;
  arp: ArpExtras;
  generation: ArpGeneration;
  scale: ArpScale;
}
```
`normalizeArpSettings(raw)` must accept the OLD shape (`rateHz`, `seq.steps`, `seq.lanes[]` of {on,velocity,gate,octave,semitone}) and migrate it.

## 2. Native engine — `plugin/ArpEngine.h`
```cpp
struct ArpTransport { double bpm = 120.0; double ppq = 0.0; bool playing = false; bool ppqValid = false; };
constexpr int kArpMods = 8;   // modulation inputs from the graph (one block old): [0] rate (octaves, ×2^v) [1] swing (pts) [2] gate (×(1+v))
                              // [3] transpose (semitones, before scale) [4] velocityPct (add) [5] random (add to every lane amount) [6],[7] reserved
void ArpEngine::process (const juce::MidiBuffer& in, juce::MidiBuffer& out, int numSamples, double sr,
                         const ArpConfig& cfg, const ArpTransport& tr, const std::array<float, kArpMods>& mod);
// side channels read by PluginProcessor::handleMidi when it applies `out` (same block, in order):
std::array<float, 128> slideMsForNote;      // slide (ms) the engine wants for the note-on it just emitted for that MIDI note (0 = none)
std::array<uint8_t, 128> tightForNote;      // 1 = this note-on came from the arp with tightRelease on
std::atomic<int> playhead;                  // current GLOBAL step index (−1 when off) — existing
std::atomic<int> barCount;                  // completed bars since the arp started (4/4, from ppq when valid, else internal clock)
// overlay readback for the UI (lock-free seqlock; audio thread writes, message thread reads):
struct OverlaySnapshot { bool has[7][16]; float v[7][16]; uint32_t rev = 0; };   // lane order = LANE_IDS
bool readOverlay (OverlaySnapshot& dst);    // returns true and fills dst if rev changed since last call
```
`ArpConfig::fromJson` parses the §1 JSON (all fields, with defaults for missing ones). The engine owns the PRNG (xorshift32 from `generation.seed`), the overlays, auto-regen (bar-aligned), token handling
(`regenToken`/`clearToken`/per-lane `rollToken` — act on a CHANGE of the value), chaos frozen/live, polymetry/div/rotation/resetAfter, direction, tempo-synced rate + swing + shape + humanize, probability,
the 16 arp patterns, octave cycling, chord layers (chord notes sustain with the keys, transposed by offset) and arp layers (two rows), key/scale snapping, `pitchTranspose` + `mod[3]` before the scale, gate up to 400 %
(Poly voice mode: ring over later steps; the engine just schedules the note-off later and never double-triggers the same MIDI note without an off first).
Dice rules: plan §3 verbatim (continuous lanes: `clamp(base + (u·2−1)·amount·span)`; octave: replace with prob = amount by base+k, k∈±round(amount·2); pitch: replace with prob = amount by a
scale-weighted degree within `round(amount·11)+1` semitones; prob/on lanes use the continuous rule on prob). `mod[5]` adds to every amount (clamped 0..1).
Seq mode: pitch = lane pitch (+ transpose) relative to EACH held note (poly, max 4 held notes sounding), arp mode: pitch comes from the held-note pool per pattern; all other lanes apply in both modes.
Never allocate on the audio thread; never leave a stuck note (all notes off on disable / hold release / pattern change).

## 3. Native glue — `PluginProcessor.cpp/.h`, `plugin/CtlOut.h` (new), `plugin/VoiceCtl.h`
* Pass real `ArpTransport` (host playhead bpm/ppq/isPlaying) and the mod array to `arp.process`.
* **`ctlout` node** (new `plugin/CtlOut.h`, registered exactly like `voicectl`): `createNode('ctlout', {slot}, [signal])`; each block it stores the last sample of its input into an atomic bank `ctlOutBank[slot]`
  (16 slots) and outputs 0. `PluginProcessor` reads `ctlOutBank[0..7]` at the top of processBlock → `mod` array. (Same audio thread, so one block old.)
* **`voicectl` gets two new fields**: `slide` (ms, per voice) and `tight` (0/1, per voice). `handleMidi`, when it applies a note-on, copies `arp.slideMsForNote[note]` / `arp.tightForNote[note]` into that voice's bank entry
  (note-ons not from the arp reset them to 0). Free-played notes keep using the global `glide`.
* **Messages to the UI** (extend the existing timer push): `window.__arpPlayhead__(step, bar)` and, when `readOverlay` reports a change, `window.__arpOverlay__({lanes:{on:[…],prob:[…],…}})` where each array has 16 entries, `null` = no overlay.
* New host params only if needed; `glide` semantics change in DSP (below), not in the manifest.

## 4. DSP — `dsp/synth.js`, `plugin/dsp.main.js`
* **Glide**: `state.glide` is now **time-to-arrive** in seconds: smoother τ = `max(PITCH_TAU, glide / 3)`; the smoothing runs on **log-frequency** (smooth `log2(freq)` then `2^x`) so wide intervals glide evenly.
* **Slide**: in native-voicectl mode the per-voice τ is `max(glideTau, slideMs / 3000)` using `voiceCtl(vi,'slide')`.
* **Tight release**: when `voiceCtl(vi,'tight')` is 1 the AMP envelope (env1) release time is multiplied by 0.12 for that voice (smoothly; the release param is read when the gate falls).
* **New mod targets** (APPEND to `MOD_TARGETS`, never reorder): `seqRate, seqSwing, seqGate, seqTranspose, seqVelocity, seqRandom`. Because the arp runs natively, these are realised by routing the summed modulation of each target
  into a `ctlout` node (slot 0..5 respectively; build the sources with voice 0's source set, document the limitation) and summing all of them to the graph output at zero gain so they stay alive.
  Units: seqRate ±2 (octaves), seqSwing ±25 (pts), seqGate ±1, seqTranspose ±24 (st), seqVelocity ±1, seqRandom ±1.
  Mirror them in `src/renderer/lib/mod-sources.ts` (`MOD_TARGETS` meta, labels "Seq Rate" …), `ui/translate.ts` `MOD_DST_IDS`, `plugin/manifest.json` (`mod{n}_dst` max) and `ui` knob target registration (the Rate/Swing/Gate knobs of the arp strip get `data-mod-target` + ∿ badge where the UI agent places them).

## 5. UI contracts
* `ArpPanel({ arp, onChange, compact, onOpenDetail })` where `onOpenDetail(which: 'seq' | 'arp')` opens a **docked** detail view (the ♪ button opens the one matching `arp.seq.enabled`).
* Docked views replace the OSC panel in the main area (like the FX view does): `view` ∈ `'osc' | 'fx' | 'arp' | 'seq' | 'arpdetail'` in `PluginApp.tsx`. The modulator strip (`EnvelopePanel`) and the arp strip stay visible so cables can be dragged onto lane/knob targets.
* `SeqEditor({ arp, onChange, onClose })` and `ArpDetail({ arp, onChange, onClose })` are full-width docked panels (no modal).
* Stores: `src/renderer/lib/arpStore.ts` (new, owned by the data agent): `useArpPlayhead(): {step:number, bar:number}` and `useArpOverlay(): Partial<Record<LaneId,(number|null)[]>>`, fed by `window.__arpPlayhead__` / `window.__arpOverlay__` installed in `ui/PluginApp.tsx` (the integration agent wires them).
* Lane editing UI must support: paint-drag, shift-drag proportional edit, per-lane dice (click = `rollToken++`; vertical drag on the dice = `amount`), per-step lock, per-lane length/div/rotation, a Regen button (`regenToken++`), Clear (`clearToken++`), **Apply** (UI copies the received overlay into `base`, then `clearToken++`), Auto-Regen select, Frozen/Live switch, Direction select, Swing, Rate sync controls, Polymetry toggle, Reset-after.
* Modulation targets for the arp strip knobs (rate/swing/gate) via `data-mod-target="seqRate"` etc.

## 6. Ownership (no two agents edit the same file)
engine → `plugin/ArpEngine.h` · glue/dsp → `PluginProcessor.cpp/.h, plugin/CtlOut.h, plugin/VoiceCtl.h, dsp/synth.js, plugin/dsp.main.js, plugin/manifest.json, ui/translate.ts, src/renderer/lib/mod-sources.ts`
· data → `src/shared/types.ts, src/renderer/lib/arpStore.ts, ui/bridge.ts, ui/useBridgeSynth.ts` · seq UI → `components/SeqEditor.tsx, ui/seq-ui.css` · arp UI → `components/ArpPanel.tsx, components/ArpDetail.tsx, ui/arp-ui.css`
· shell → `ui/PluginApp.tsx, components/Knob.tsx, ui/topbar.css, ui/main.tsx, ui/plugin-ui.css` · mod/osc → `components/EnvelopePanel.tsx, components/OscillatorPanel.tsx, ui/modstrip.css`
· themes → `ui/AppMenu.tsx, src/renderer/styles.css, src/renderer/lib/visualizer.ts` · wavetables → `plugin/UserWavetables.*, dsp/wavetables.js, scripts/*`. New CSS goes in your OWN css file; the shell agent imports all of them from `ui/main.tsx`.
Agents do NOT run `plugin/build.sh`, do not run the engine tests, do not commit. They may run `npx tsc -p spike/elementary/ui/tsconfig.json --noEmit` and `node --check` on JS files. C++ cannot be compiled by agents — review it line by line.
