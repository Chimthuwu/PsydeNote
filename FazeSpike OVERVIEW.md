# FazeSpike — Agent Overview

Hand this file to any agent working on the synth. Read it, then read `todo.md` (repo root and
`spike/elementary/todo.md`) — those are the live progress/handoff docs. Keep them updated.

**FazeSpike** = a polyphonic FM / wavetable / sampler synthesizer shipped as a **VST3** and a **Windows
standalone**, built with **JUCE 7 + Elementary Audio** (DSP graph) and a **React/TypeScript WebView UI**.
It lives in `spike/elementary/`. (The repo root is an unrelated Electron audio-recorder app, "Faze"; the root
`overview.md` describes *that* app. The synth shares `src/` components and `src/shared/types.ts`.)

---

## 1. Architecture in one picture

```
 React UI (WebView2)  ──bridge.ts──►  C++ JUCE plugin  ──state JSON──►  QuickJS (dsp.main.js → dsp/synth.js)
 src/renderer/components/*            PluginProcessor.cpp              builds an Elementary graph (el.* nodes)
 spike/elementary/ui/*                WebViewEditor.cpp                  │ instructions batch
        ▲                             ArpEngine.h (native arp/seq)       ▼
        └───── scopes/playhead/overlay ◄── drainScopes() 60 Hz ◄──  Elementary runtime (audio thread)
```

* **State is a flat map** (`state` in PluginProcessor.cpp: `op0_wave`, `fx_*`, `mod{n}_*`, `v{i}_gate/freq`…).
  Host-automatable params come from `plugin/manifest.json` (AudioParameterFloat). UI edits → bridge →
  `state` → debounced `dispatchStateChange()` → JS `renderSynth(state)` → full graph → Elementary reconciles.
* **Graph rebuild cost** is the main perf limiter: it runs on the message thread in QuickJS (~50–140 ms on
  big patches, scales with node count). Prefer fewer nodes; static numbers instead of graph math when a value
  is unmodulated (see the wavetable `staticPos` path).
* **Voices:** 12 (`kNumVoices`, must match `NUM_VOICES` in synth.js). Native voice pool in C++; custom graph
  nodes `voicectl` (gate/freq/vel/kt/slide/tight) and `ctlout` (atomic bank, slots 0..15) bridge C++↔graph.
* **Arp/Seq is native** (`plugin/ArpEngine.h`, audio thread, runs before the voice pool). It reads modulation
  from `ctlout` slots (one block old) — `kArpMods`.
* **Standalone** is the JUCE standalone host with the stock chrome stripped; `winCtl('options')` opens the
  Audio/MIDI dialog directly (no Reset/Save/Load menu). Input bus is on but muted by default.

## 2. Repo map (synth-relevant)

| Path | What |
|---|---|
| `spike/elementary/dsp/synth.js` | **The sound engine.** `renderSynth(state)` → graph. Operators (sine/saw/…/sample/wavetable), FM/PM, filters A/B, FX chain, modulation matrix, master. Also runs in Node for tests. |
| `spike/elementary/plugin/dsp.main.js` | QuickJS entry: maps flat state → synth state (`toSynthState`), calls renderSynth. |
| `spike/elementary/plugin/PluginProcessor.{h,cpp}` | Host params, state, voice pool, samples, wavetable resource registration, scopes, recording, self-recovery. |
| `spike/elementary/plugin/WebViewEditor.cpp` | Bridge events from UI, standalone window chrome. |
| `spike/elementary/plugin/ArpEngine.h` | Arpeggiator + step sequencer (patterns, dice/overlay, polymetry, layers). |
| `spike/elementary/plugin/manifest.json` | Host-visible params + mod source/target limits (cross-checked by `wire.test.mjs`). |
| `spike/elementary/ui/` | Plugin-specific UI: `PluginApp.tsx` (main shell), `bridge.ts`, `translate.ts`, `useBridgeSynth.ts`, css files. |
| `src/renderer/components/` | Shared React components (PresetBar, OscillatorPanel, SamplerBlock, ArpPanel, ArpDetail, ModuleCards, FX…). |
| `src/shared/types.ts` | **Shared types/defaults:** `SynthSettings`, `ArpSettings`, module pool, `MOD_SOURCES/MOD_TARGETS`, normalizers. |
| `spike/elementary/test/` | `engine.test.mjs` (offline-render DSP tests), `wire.test.mjs` (UI↔manifest↔DSP index consistency), `wavetable-bin.test.mjs`. |
| `spike/elementary/installer/` | NSIS installer (`build-installer.sh`). |
| `docs/ARP-SEQ-PLAN.md`, `docs/ARP-SEQ-CONTRACT.md` | Arp/Seq design + the interface contract the engine/UI were built against. |

## 3. Build / test / ship

```bash
cd spike/elementary
npm test                 # engine DSP tests — must print "all passed"
npm run test:wire        # wire consistency (indices, manifest max values)
npx tsc -p ui/tsconfig.json --noEmit     # typecheck UI (from repo root: path is spike/elementary/ui/tsconfig.json)
bash plugin/build.sh     # builds UI bundle + VST3 + Standalone (portable MSVC on Z:, no VS/admin). Release.
bash installer/build-installer.sh        # → installer/dist/FazeSpike - Windows Setup v<ver>.exe
```

* Outputs: `plugin/build/FazeSpike_artefacts/Release/{Standalone/FazeSpike.exe, VST3/FazeSpike.vst3}`
  (the VST3 is also installed per `install-vst3.cmake`). `wavetables.bin` is copied beside both.
* **If the standalone is running**, the link fails (LNK1104). Rename it first:
  `mv FazeSpike.exe FazeSpike.running-<time>.old`, then build. Stale `*.old` are cleaned by later builds.
* **The installer must be rebuilt after every plugin build**; it refuses stale binaries.
* Release naming: `<Product> - <Platform> v<version>.<ext>` (e.g. `FazeSpike - Windows Setup v0.1.0.exe`).
  Never upload toolchain default names. After a GitHub release, list assets and delete stale ones.
* Environment: Windows, Git Bash. `python3` is **not** available (use `python`/`node`). Don't `cat > file`
  without a heredoc (it blocks on stdin). Guard destructive `rm` with `${VAR:?}`.
* Diagnostics log: `%TEMP%\fazespike-ui.log` (rotates at 1 MB; MIDI/heartbeat lines suppressed). Look for
  `[wtdiag][ERROR] applyInstructions #N FAILED` and `[recover]`.

## 4. Hard-won rules (read before touching DSP/state)

1. **A single bad node property fails the whole instruction batch** ("Invalid value for the given node
   property") → total silence, and later batches keep failing. Typical causes: a sample/wavetable
   `path` that is not a registered resource. Never emit a node for a resource that isn't loaded
   (sampler with no sample → `el.const 0`; native zeroes unloaded `opK_sampleversion` in `dispatchStateChange`).
2. `runtime->pruneSharedResources()` drops every registered-but-unused resource, including wavetable frames.
   After pruning, the tracking sets (`registeredWavetableIds`, `registeredWavetableWarpKeys`) are cleared and
   re-ensured. Keep that invariant if you add resource types.
3. `el.log` is **base 10**. Glide uses `Math.log10(2)`. Test: glide regression in `engine.test.mjs`.
4. `el.tapOut/tapIn` deliver the **previous block**. FM/PM now builds modulators first (topological
   `opOrder`) and passes signals directly; tapIn is only the fallback for feedback loops.
5. Mod source/target lists are **append-only index lists**, mirrored in four places: `MOD_SOURCES/MOD_TARGETS`
   in `src/shared/types.ts`, `synth.js`, `ui/translate.ts` / mod-sources, and `manifest.json` dst/src max.
   `wire.test.mjs` cross-checks — change all four together and run it.
6. Seq mod targets sit at indices 76–81 (ctlout slots 0..5); planned: seqOctaves [6], seqPattern [7],
   seqChaos [8]; `kArpMods` is 8 and must grow with them.
7. UI params are written in **real units**; `setValueNotifyingHost` needs normalised (`convertTo0to1`).
8. Don't rebuild the whole graph for things that can be a `const` update — knob drags would otherwise
   queue ~100 ms rebuilds. Debounce is adaptive (`scheduleStateDispatch`).
9. Undo/redo (PresetBar) records every `synth` change coalesced at 500 ms and applied states are tagged via
   `skipRef`, so don't mutate `synth` from effects without going through `onChange`.
10. Multi-agent work: split by **disjoint file ownership** with a written contract (`docs/ARP-SEQ-CONTRACT.md`
    is the template). Tell sub-agents to ignore unrelated mid-run user messages.

## 5. Feature inventory (current)

* **4 operators** (A–D): waveshapes, wavetable (381 built-in tables + user folder, 8-frame morph, two warp
  stages), sampler (load / resample-record / input-record, loop/start/end/reverse), FM/PM matrix with per-pair depth.
* **Filters A/B**, per-op filter mix; **FX chain** (drag-reorder): delay, reverb, compressor (3-band),
  EQ, others; each with mix.
* **Modulation:** ENV1 (amp) + up to 10 added modules in any mix — ENV, LFO (function-shape editor),
  Audio Follower (sidechain or own output). Cable-drag assignment, per-knob depth.
* **Voices:** Poly / Mono / Legato, portamento (exponential taper), macros.
* **Arp / Seq:** 16 arp patterns (18 planned), directions, per-lane dice (Pigments-style, Random Amount,
  Regen, lock), polymetry, slide, Bitwig-style chord/arp layers, docked detail views, host-synced rate.
* **Presets:** factory + user, New (document icon), Save, undo/redo with history dropdown (Ctrl+Z/Y).
* **Themes:** Black ice (default) and Aurora ice only.

## 6. Open work (see `todo.md` for the authoritative list)

Pending from the latest batch: arp **Octaves modulatable**; **LFOs default unipolar** (`types.ts` defaults +
seeded JSON in PluginProcessor.cpp); **FX default mix on enable** (25%; compressor 20% mix, attack 0, release
880 ms); arp patterns → 18 (drop `poly`, add skipUp/repeatUp/walk, migrate saved `poly`→`up`); **pattern
selector slider** (0–100 %, host param `arp_pattern`, mod target, fully synced with the chosen pattern);
**Shape → Chaos** master (rainbow knob, host param `arp_chaos`, scales all dice, 0 % disables dice);
rainbow dice rows under rate/octaves/swing/pattern. Unverified by ear: the whole arp/seq batch, sampler
load/play/record, glide feel, same-block FM change.
Perf idea not done: skip/cache idle voices in the graph to cut rebuild time.

## 7. Working style expected by the owner

* Fast iteration; the owner tests by ear and reports bugs within minutes — rebuild VST3 + standalone +
  installer after changes and say what you did *and what you could not verify*.
* Fix bugs you find without asking; ask only for large/risky/user-visible-behaviour changes.
* Keep `todo.md` current; commit with the attribution trailer lines required by the session.
