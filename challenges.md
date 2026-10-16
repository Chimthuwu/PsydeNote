# Faze/FM Synth Development Challenges

## 1. Wavetable Architecture & DSP Sync (The "Fake Wavetable" Issue)
A critical issue surfaced regarding the Wavetable engine when users apply **Warp Modes**. 

**What we tried:**
- We implemented a discrete `wave === 'wavetable'` (ID 5) mode, separating it from the legacy 4-shape morph. 
- We added an `esw-tables.json` import to dynamically load external Wavetable frames.
- We implemented a `generateWavetableFrames` and `applySpectralWarp` logic in QuickJS (`wavetables.js`), which caches warped frames under complex resource keys (e.g., `wavetable:1:0:w13_0.5...`).

**Why it hasn't worked (The Crash & Silence):**
- The C++ backend (`PluginProcessor.cpp`) only pre-registers the two base built-in tables (`tableId=0` and `tableId=1`) into the `elem::Runtime`'s `SharedResourceMap` at startup.
- When a user selects a Warp Mode, the headless QuickJS engine generates the DSP graph requiring the new warped resource keys. However, the C++ runtime **never receives the dynamically generated Float32Arrays** from QuickJS. QuickJS caches them locally in `frameCache`, but Elementary Audio requires them to be registered via `runtime->addSharedResource` in C++. 
- As a result, Elementary queries a missing resource path, yielding complete silence (or a crash/hang if the C++ bridge chokes on the missing resource). This creates the illusion of a "broken or fake" wavetable implementation.

**Solution Path Required:**
We either need to compute wavetable warps entirely on the C++ side and inject them on the fly, OR we need a mechanism for QuickJS to pass generated `Float32Array` buffers back across the bridge to C++ so `PluginProcessor` can register them before evaluating the graph.

## 2. Oscillator Panel Layout & Grid Constraints
The visual layout of the Oscillator Panel presented severe challenges due to strict CSS grid limitations and overlapping elements.

**What we tried:**
- We initially used CSS hacks like `transform: translateY(84px)` to push the Phase Modulation (PM) and Frequency Modulation (FM) knob clusters down out of the way of the Sampler toggle.
- When the user added dual Warp boxes, we tried squeezing them into the middle column.

**Why it hasn't worked:**
- The translation hacks pulled the Mod clusters outside their bounding boxes, causing them to step over the Pan and Filter A/B knobs at the bottom of the card.
- Scaling the UI (`--ui-scale: 1.2` hardcoded override) compounded this, pushing elements off-screen and resulting in clipping where `overflow: hidden` was applied.

**The Fix:**
- We completely stripped out the `Sampler` toggle mode from the bottom row, as the user strictly requested Wavetable-only defaults (`wave: 'wavetable'` on INIT).
- We removed the `translateY` hacks and implemented `justify-content: flex-start` with clean flexbox spacing, packing the Mod clusters safely between the Wavetable/Warp controls and the footer knobs.

## 3. FX Chain Strip & Macro Knob Clipping
The `EnvelopePanel` at the bottom of the synth utilizes a strict CSS grid (`grid-auto-rows: 66px`). 

**What we tried:**
- We injected the global Plugin Macro knobs alongside the FX Chain Strip into the 3rd row of the envelope grid.

**Why it hasn't worked:**
- Injecting the Macros forced the container height to exceed `66px`. Because the `.synth-scroll` wrapper aggressively hides overflow to maintain the GUI bounds, the FX Chain Strip was physically clipped in half horizontally, obscuring the text and toggles.

**The Fix:**
- We removed the Macros from the bottom FX panel entirely.
- We rehoused them into the top `sh-bar` (Header), shifting the Preset browser to the far right (replacing redundant Zoom/Voices info) to make adequate room. This allowed the FX Chain to comfortably inhabit its intended 66px grid row.

## 4. Compressor Attack/Release UX & Event Hit-Testing
The custom canvas-based `FxViz.tsx` visualization created interaction dead-zones.

**What we tried:**
- We implemented graphical sliders/arcs for the Multiband Compressor (Attack, Release, Amount, Floor, Target). 

**Why it hasn't worked:**
- The generic `<FxUnit>` automated knob generator was still outputting physical Knobs for Attack and Release at the bottom of the component, creating redundancy.
- The pointer hit-testing in `FxViz.tsx` (`onDown`, `onMove`) only bound drag events to the `FloorDb` handles. Dragging the `Amount` arcs or `Target` (Ceiling) lines yielded no response.

**The Fix:**
- We wrote a targeted Python patch to intercept the `Amount` (AMT) arc bounding boxes and `CeilingDb` lines in `FxViz.tsx`.
- We mapped pointer offsets explicitly to `(b + 'Amount')` and `(b + 'CeilingDb')` drag modes, binding them directly to the `onChange` state emitter. We successfully stripped the redundant UI overlay knobs.
