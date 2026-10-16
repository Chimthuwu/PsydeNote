# Elementary VST spike

**Question this answers:** does [Elementary Audio](https://elementary.audio)'s
declarative DSP model fit Faze's synth well enough to port the engine to it
and ship a VST3 — keeping the React UI, rewriting only the audio?

**Scope:** OSC 1 (one selectable band-limited wave) + amplitude ADSR + master +
global transpose, played polyphonically from a keyboard. That's the Phase 1 /
Phase 2a slice of `../../todo.md`. Nothing else — no OSC 2–4, filters, FM/PM,
mod matrix, sampler. The point is the *paradigm*, not feature parity.

---

## Run it (no build tools needed)

```bash
cd spike/elementary
npm install
npm run dev            # opens http://localhost:5174
```

Click **Start audio**, play with the mouse or the QWERTY row
(`A W S E D F T G Y H U J K`, `Z`/`X` shift octave). Twist the ADSR and wave
controls while holding a chord.

---

## What the browser preview shares with the VST3

```
dsp/synth.js      ← the entire Elementary graph. Runs BYTE-FOR-BYTE identical
                    in the browser (web/main.js) and the plugin (plugin/dsp.main.js).
dsp/allocator.js  ← voice allocation. Browser uses it directly; the plugin has
                    a ~60-line C++ port (plugin/Voices.h) because allocation
                    must run on the audio thread.
```

Only the **host harness** differs: `web/main.js` (WebRenderer + AudioWorklet)
vs `plugin/` (JUCE + QuickJS + native `elem::Runtime`). That split — portable
DSP, swappable host — is Elementary's core promise, and this spike is built to
test whether it actually holds.

The `plugin/` harness is **staged, not compiled** — this machine has no C++
toolchain. See [`plugin/BUILD.md`](plugin/BUILD.md) for the install + build path.

---

## Web Audio → Elementary, the mapping that matters

How Faze's current `lib/synth.ts` constructs map onto Elementary:

| Faze (`synth.ts`) | Elementary (`dsp/synth.js`) | Notes |
|---|---|---|
| `new OscillatorNode({type})` | `el.cycle` / `el.bleptriangle` / `el.blepsaw` / `el.blepsquare` | Elementary's saw/square/tri are **band-limited** (BLEP). `el.cycle` is the sine. |
| `PeriodicWave` morphing (§41) | not ported | wavetable scan → `el.table` + a phase ramp; a later spike |
| per-voice `GainNode` + `setValueAtTime`/`linearRampToValueAtTime` ADSR (§23.2) | `el.adsr(a, d, s, r, gate)` | one node. Elementary's is **exponential**; Faze's has per-segment curve control (`attackCurve`…) — that nuance is not in `el.adsr`, you'd build it from `el.smooth` + `el.select` if you need it |
| `osc.detune.setTargetAtTime(...)` | `el.smooth(el.tau2pole(τ), el.const({key, value}))` | **this is the important idiom.** Any value a human drags must be a smoothed `const` ref or you get zipper noise — see below |
| `voices: Map<MidiNote, Voice>` + steal-oldest (§1.3) | `dsp/allocator.js` / `plugin/Voices.h` | stays imperative; Elementary graphs are stateless w.r.t. "which note is where" |
| `StereoPannerNode` | `el.pan` / manual `el.mul` L/R | for OSC 2–4 later |
| `BiquadFilterNode` | `el.lowpass` / `el.svf` | Phase 4 |
| analyser tap for the visualizer | `el.snapshot` / `el.meter` / render-to-ScriptProcessor | Elementary can emit data back to JS; the per-op visualizer story needs its own spike |
| Electron main process, IPC, tray, pop-out, settings JSON | **deleted** | the DAW owns the window, MIDI, transport, automation, and state |

### The zipper-noise finding (from your test)

Your first run: *"the ADSR values make the sound kinda rough when adjusting them
while a note is held."* That was real, and informative — not a browser
limitation. The first cut passed ADSR params as **plain numbers baked into the
graph**, so every slider tick triggered a graph *reconcile*. Fixed by making
every continuous control a **smoothed `el.const` ref** (`ctrl()` in
`dsp/synth.js`): now a slider drag writes 8 props (one per voice) with zero
nodes added, and the value glides over ~25 ms. Verified via render stats:

```
ADSR param change:  nodesAdded: 0,  propsWritten: 8      ← prop update, smooth
wave switch:         nodesAdded: 20, edgesAdded: 37       ← structural, will glitch a held note
```

This is exactly the `setTargetAtTime` discipline `todo.md` §2c already calls
for — Elementary just makes you opt in explicitly. **Takeaway for the port:**
every knob = a smoothed ref, always. Wave/structural switches will still click a
held note (Faze's own engine snapshots envelope shape per-note for the same
reason, §23.6) — acceptable.

---

## Verdict inputs (fill these in after playing)

- [ ] Does writing DSP as `state → signal graph` feel natural, or fight you?
- [ ] Is `el.adsr`'s exponential-only shape good enough, or do you need the
      curve control back?
- [ ] Latency/feel of note-on through the graph — acceptable?
- [ ] Any missing primitive you'd hit in Phase 3–8 (check the mapping table)?

If it feels right → next step is `plugin/BUILD.md` (install toolchain, compile,
load in a DAW). If it doesn't → **iPlug2** with a webview UI is the fallback,
same UI-preservation story, C++ DSP.

---

## UI polish (later — noted, not done here)

The preview UI is deliberately throwaway vanilla JS. For the real thing the
existing React components (`Knob`, `EnvelopePanel`, `PitchDial`,
`VisualizerBoard`, the 42-token theme layer) port into the webview mostly
intact. [`profmitchell/AudioUI`](https://github.com/profmitchell/AudioUI)
(MIT, React + Tailwind/shadcn, has a knob / ADSR editor / XY pad / filter
display / preset browser **and a JUCE 8 WebView integration**) is worth a look
as a component base — caveat: it's pre-styled on shadcn, which is in tension
with Faze's token-driven theming, so components would need restyling to keep
the pencil-test.

---

## Files

```
dsp/synth.js         portable Elementary graph (shared with the plugin)
dsp/allocator.js     portable voice allocator (shared with the browser)
web/main.js          browser host: WebRenderer + state + re-render
web/keyboard.js      on-screen + QWERTY keyboard
index.html           the preview page + throwaway styling
plugin/              staged JUCE VST3 harness — see plugin/BUILD.md
  CMakeLists.txt       IS_SYNTH / NEEDS_MIDI_INPUT
  PluginProcessor.*    srvb harness (MIT) + MIDI→VoicePool→state plumbing
  Voices.h             C++ port of dsp/allocator.js
  WebViewEditor.*      srvb's webview editor (MIT), renamed
  dsp.main.js          native DSP entry — imports ../dsp/synth.js verbatim
  manifest.json        host parameter declarations
```

Adapted from [`elemaudio/srvb`](https://github.com/elemaudio/srvb) (MIT).
