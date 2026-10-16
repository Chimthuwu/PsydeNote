# Building the VST3

**Status: builds and loads.** `FAEZ.vst3` + a Standalone `.exe`
compile clean and the plugin instantiates, opens its editor, and runs the
native↔JS bridge. Built on this machine with **no Visual Studio and no admin**,
using a portable MSVC toolchain on `Z:`.

## Toolchain (what's installed, all off C:)

| Tool | Location | How it got there |
|---|---|---|
| MSVC 14.44 + Windows SDK 10.0.26100 | `Z:\msvc\msvc\` | `portable-msvc.py` (mmozeiko) — `python portable-msvc.py --accept-license --vs 2022 --host x64 --target x64`. ~1.2 GB, no admin. |
| CMake 4.4 + Ninja | `%APPDATA%\Python\Python311\Scripts` | `pip install --user cmake ninja` |

C: footprint of all the above: ~0.

## Submodules

Already added to the repo (`.gitmodules`):

```
spike/elementary/plugin/juce/        -> juce-framework/JUCE @ 7.0.9
spike/elementary/plugin/elementary/  -> elemaudio/elementary (+ its nested
                                        cli/choc, which bundles QuickJS — we
                                        use that, no separate choc submodule)
```

Fresh clone: `git submodule update --init --recursive spike/elementary/plugin/juce spike/elementary/plugin/elementary`

## Build

```bash
cd spike/elementary
npm install
npm run build:plugin-assets     # bundles dsp.main.js + manifest.json + index.html -> dist/

cd plugin
./build.sh                       # Release; ./build.sh Debug for a debug build
```

`build.sh` sources `Z:\msvc\msvc\setup_x64.bat`, puts the pip CMake/Ninja on
PATH, and runs `cmake -G Ninja` + `cmake --build`. Key flags it passes:
`-DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl -DCMAKE_POLICY_VERSION_MINIMUM=3.5`
(the last one because CMake 4 dropped `<3.5` policy compat and some deps
declare old minimums).

## Artefacts

```
build/FAEZ_artefacts/Release/VST3/FAEZ.vst3/...
build/FAEZ_artefacts/Release/Standalone/FAEZ.exe
```

Each gets `dist/` copied next to it (per-format layout handled in
`CMakeLists.txt`; `getAssetsDirectory()` in `PluginProcessor.cpp` checks both
the VST3 `Contents/Resources/dist` shape and the Standalone `<exe dir>/dist`
shape).

**Auto-installed** after every build straight to
`C:\Program Files\Common Files\VST3\FAEZ.vst3` — the standard
system path every DAW scans, no custom location needed.

That folder is admin-only by default and the build runs unelevated, so write
access was granted once:

```
icacls "C:\Program Files\Common Files\VST3" /grant "Serge:(OI)(CI)M"
```

(run in an admin shell — already done on this machine). After that,
`COPY_PLUGIN_AFTER_BUILD` + `VST3_COPY_DIR` (`$ENV{CommonProgramFiles}/VST3`)
just work. Every `./build.sh` refreshes the plugin in place — rescan + reload
in the DAW.

Fallback if you ever move to a machine without that grant: configure with
`-DVST3_COPY_DIR="$ENV{LOCALAPPDATA}/Programs/Common/VST3"` and add that folder
as a plug-in location in the DAW.

## Assets are embedded, not on disk

`dsp.main.js`, `index.html`, `manifest.json` are compiled into the binary via
`juce_add_binary_data` (see `Assets.h`). An earlier version read them from
`Contents/Resources/dist` at runtime and 404'd in Bitwig because a hosted VST3
resolves `currentExecutableFile` differently than a standalone. Embedding
removes the path lookup entirely. `npm run build:plugin-assets` (run by
`build.sh`) regenerates `dist/` before each compile so the embedded copy is
fresh.

## Dev mode (hot reload)

```bash
cd spike/elementary/plugin
./build.sh Debug   # once, with ELEM_DEV_LOCALHOST... (see note)
```

To actually enable localhost mode, configure with `-DELEM_DEV_LOCALHOST=1` and
run `npm run dev` (Vite on :5174) alongside — the plugin then fetches
`dsp.main.js` / `manifest.json` / the UI from the dev server. Not wired into
`build.sh` yet.

## What's proven vs. not

Proven: compiles, links, `moduleinfo.json` generates (JUCE's helper loads the
VST3 and enumerates it as `Instrument|Synth`), Standalone runs without
crashing, editor webview loads, `ready → dispatchStateChange → __receiveStateChange__`
round-trips (the placeholder UI shows live `wave` / `master`).

Not yet heard: audio out on a MIDI note. The chain
(`handleMidi → VoicePool → handleAsyncUpdate → jsContext → renderSynth →
runtime->process`) is each-link-verified except JUCE's standard MIDI-buffer
delivery. Load the `.vst3` in a DAW and play it to close that loop.

## Known rough edges

- **Block-rate MIDI** — note timing quantised to the audio block.
- **Spin-lock voice snapshot** (`PluginProcessor.h`) — spike-grade; a
  lock-free double buffer is the production move.
- **`getTailLengthSeconds()` hard-coded to 3 s** — should track Release.
- **No real UI** — placeholder `plugin/index.html`. The React port is a later
  phase; automation via the host param list works now.
- The `elem::VariableDelayNode` template-instantiation notes during the build
  are warnings from Elementary's runtime, not errors.
