# Faze — Feature Overview

Faze is a **rolling-sampler-style audio recorder for Windows** (built on Electron 30, React 18, TypeScript, Vite) that quietly captures system audio in the background and lets you snapshot the last N minutes to disk with a single hotkey — the same model as Bird Things' Rolling Sampler. Recordings are saved as compact **WebM/Opus** files. The app is v3.0.0.

---

## 🎙️ Core recording

| Feature | What it does |
|---|---|
| **Rolling buffer mode** (default) | Continuously captures audio in memory; press the hotkey to save whatever is currently in the buffer. Buffer length: 1 min → 1 hr (default 15 min). |
| **Traditional mode** | Hotkey toggles recording on/off and auto-saves the session on stop, like a classical voice recorder. |
| **Two capture backends** | `desktop` (Chromium `desktopCapturer` — screen/window picker with system-audio loopback) *or* `loopback` (true per-output WASAPI via a bundled .NET 8 / NAudio helper). The loopback backend lets you capture from a specific output device — Speakers, Headphones, VoiceMeeter, etc. — without a virtual audio cable. |
| **Streaming capture pipeline** | Both backends feed a single in-renderer `MediaStream` wired to the same `MediaRecorder` + `AnalyserNode`, so save/visualise behaviour is identical regardless of source. WASAPI frames flow through an `AudioWorkletProcessor` decoded into a `MediaStreamAudioDestinationNode`. |
| **WebM / Opus output** | All recordings are small, universally-playable Opus-in-WebM files. Bitrate is user-selectable: 64 / 96 / 128 / 192 / 256 kbps. |

---

## 🔥 Hotkey & tray

| Feature | What it does |
|---|---|
| **Global hotkey** | `Shift+Alt+R` by default, fully rebindable via a text input (Electron accelerator syntax). Presets offered in Settings. |
| **Procedural tray icon** | 16×16 green/red recording indicator, hand-drawn as an RGBA buffer — no PNG assets shipped. |
| **REC overlay badge** | Red dot appears on the tray icon while capturing. |
| **Dynamic tray title** | Live elapsed-time ticker on Windows (`● 0:42`, etc.). |
| **Multi-line tooltip** | Elapsed time, save folder, last save timestamp. |
| **Tray menu** | Show/Hide window, Always-on-top toggle, Open save folder, **Recent saves submenu** (last 5 with relative timestamps), Settings…, Quit. |
| **Balloon / toast save notifications** | Confirms files when the global hotkey fires without the window in focus. |
| **Single-instance lock** | Re-launching while the app is running focuses the existing window rather than opening a duplicate. |

---

## 🌈 Visualizers

Four visualizer modes, switchable from chip-row buttons in the main window, the pop-out, the right-click quick menu, or Settings:

| Mode | What it shows |
|---|---|
| **Oscilloscope ∿** | Live waveform of the most recent AnalyserNode window (2048 samples). |
| **Spectrum ▥** | 1024-bin FFT magnitude bars with a magenta→cyan gradient ramp. |
| **Spectrogram ▦** | Scrolling waterfall — frequency on Y, time on X, same colour ramp. |
| **History ◷** *(new in v3)* | Scrubbable, time-aligned overview of the last N minutes of audio — a peak-track envelope of the rolling buffer. Click-drag to select a sub-range; drag the selection out of the window to drop a `.webm` clip straight into Explorer, a DAW, or anywhere else that accepts file drops. The selection can also be saved via the regular save button. The pop-out window mirrors the same peak track over a new `vizHistory` IPC channel so its history view stays in sync. |

The visualizer code sits behind a hand-rolled analyser (`lib/visualizer.ts`) that adapts three modes onto a single `AudioAnalyser` class. Canvas 2D + Web Audio AnalyserNode keeps paint sub-millisecond and idle CPU ~3%.

---

## 🪟 Window chrome, layout & snapping

| Feature | What it does |
|---|---|
| **Two title-bar modes** | **Custom 26px frameless strip** (pin, dock, layout-cycle, pop-out toggle, settings, minimise/maximise/close) or the **standard OS title bar**. Switchable from Settings — note that switching rebuilds the window. |
| **Two layout profiles** | `full` (HUD + visualizer + footer with source picker + visualizer chips) and `compact` (a tight control row + visualizer). The title bar's ▤ button cycles layouts without opening Settings; chips in the modal apply instantly. |
| **Per-element visibility toggles** | Each of the VU meter, buffer fill bar, source picker, visualizer chips and hotkey hint can be shown or hidden independently. Toggleable from Settings; changes apply immediately. |
| **Magnetic edge snap** | Drag the window near a screen edge and it clicks flush against it. Toggleable. |
| **Snap presets** | One-click chips: Dock top, Dock bottom, Top left, Top right, Centre. Same verbs also reachable from the tray menu and right-click quick menu. |
| **Always-on-top** | A toggle in the title bar / Settings / tray menu. Pin keeps Recorder above your DAW even in fullscreen. |
| **Docking reserves screen space (Windows appbar)** | When docked to the top of a screen with this on, Recorder registers itself as a Windows *application desktop toolbar* — the same mechanism the taskbar uses — so the desktop work area shrinks and other applications lay out **below** the strip instead of being covered by it. Default off (it affects every application). Implemented via `koffi` calling `shell32!SHAppBarMessage`. Includes defensive `reclaimStaleAppBar()` recovery on startup. |
| **Button label modes** | `auto` (shrink labels as the window narrows), `icon` (glyphs only), `text` (always full text). |
| **Custom dropdown listbox** | Source / device pickers are in-DOM custom listboxes rather than native `<select>`, with consistent dark styling. |

---

## 🎨 Themes

Six themes, each with its own *atmosphere* (not just a palette swap) — chrome, accent behaviour, surface treatment, glow intensity, border weight, radius and type stack all change. A new **Themes** submenu was added to the title bar / context menu in v3 for fast access.

| Theme | Vibe |
|---|---|
| **Modern neon** *(default)* | Magenta/cyan on dark navy. The flagship look. |
| **Classic green** | Old-school CRT — green-on-black, monospaced, no radius. |
| **Cyberpunk** | Yellow accents, more luminous glow, instrument-panel feel. |
| **Synthwave** | Orange-magenta gradients, 80s-retro. |
| **Monochrome** | Pure grey scale, almost no glow, restrained. |
| **Kawaii ✿** | Pink/cyan, soft radii, friendliest of the six. |

A **42-token semantic CSS layer** (`--bg-app`, `--accent`, `--border-active`, `--glow`, etc.) sits at the top of `styles.css`. Every theme redefines the tokens; rules consume tokens rather than hard-coding colour. Pencil-test: it'd still look good with the accent colour forced to grey.

---

## 🪟 Pop-out visualizer window

A second **frameless, always-on-top window** that mirrors the main renderer's analyser state over a 30 fps `viz:frame` IPC stream. Designed for keeping an eye on the waveform above a fullscreen DAW.

| Feature | What it does |
|---|---|
| **Open / close from main app** | Toggle from title bar, tray menu, right-click quick menu, or Settings. |
| **Live viz streaming** | Main renderer sends `VizState` (slower-moving) and `VizFrame` (per-paint) payloads; the pop-out is a read-only consumer. |
| **Local transport controls** *(optional)* | Start/stop, save and the visualizer-mode chip row can render inside the pop-out. They dispatch commands back via `viz:command`. |
| **Pop-out always-on-top** | A setting; default on. |
| **Pop-out opacity** | Slider, 20% – 100% — useful when you want it as a passive overlay. |
| **Hide main window while popped out** *(default on)* | Popping out swaps windows instead of leaving two on screen. Recording keeps running; tray icon and hotkey still work; closing the pop-out restores the main window. |
| **Hide only the visualizer while popped out** | Leaves the main window as controls only so it can shrink much further. |
| **History sync** *(v3)* | The peak track from the main app is sent over a new `vizHistory` IPC channel every 200 ms so the pop-out's history view stays in sync and selections can be made there too. |
| **Drag a selection out of the pop-out** *(v3)* | The pop-out proxies the drag request to the main window over `dragExportProxy`, since a drag can only be initiated from the originating window's web contents. |

---

## 🆕 v3 — drag-and-drop export

The headline new feature in 3.0.0: drag any snippet (the whole rolling buffer, **or** a sub-selection from the History visualizer) straight out of the app onto the desktop or into another application — no Save dialog round-trip.

| Aspect | How it works |
|---|---|
| **Native drag** | Implemented in the Electron main process via `webContents.startDrag({ file, icon })`. The icon is a 1×1 transparent PNG to satisfy Windows' minimum-icon-size guard. |
| **Selection-aware** | When the History visualizer has a selection, the dragged clip spans exactly that range. Without a selection, the whole buffered duration is dragged. |
| **Proxy from the pop-out** | The pop-out window can't start a drag directly; it relays the request to the main window over `dragExportProxy`, which forwards it back as `requestDragExport`. The main window becomes the drag origin. |
| **Temp-file strategy** | Decoded-and-re-encoded clips are written to `app.getPath('temp')` as `faze_snippet_HHMMSS.webm`. They're sized to the selection, not the buffer. |
| **Duration correctness** | The save duration is `bufferedDuration × (selection.end − selection.start)`, so the receipt matches what was actually dragged. |
| **Selected-clip vs full-clip save** | The same save pipeline works for both: if a selection exists, `snapshotBuffer(bounds)` returns just that range; if not, it returns the whole buffer. The save toast reflects the actual duration / size. |

---

## 📂 File naming

| Feature | What it does |
|---|---|
| **Filename template** | A free-form text input in Settings; the named file is split into tokens. Default: `faze_{date}_{time}`. |
| **Clickable token chips** | Each supported token is a chip below the input — clicking inserts at the caret. |
| **Supported tokens** | `{date}`, `{time}`, `{year}`, `{month}`, `{day}`, `{hour}`, `{minute}`, `{second}`, `{unix}`, `{mode}` (`rolling`/`traditional`), `{device}` (source / loopback device name), `{counter}` (monotonic, useful for repeat saves within the same second). |
| **Sanitisation** | OS-illegal characters (`/\:*?"<>|`) are stripped; runs of `_` are collapsed; the `.webm` extension is added if missing. |

---

## 🛠️ Settings

All settings live in a JSON file under `%APPDATA%/Faze/` (debuggable in Notepad) and are typed end-to-end through `AppSettings` in `src/shared/types.ts`.

**Sections in the modal:**

- **Recording mode** — rolling vs traditional (locked while active).
- **Capture backend** — desktop vs WASAPI loopback, with help text per option.
- **Recording hotkey** — text input + preset chips.
- **Save folder** — native folder picker.
- **Buffer length** — slider, 60 s → 3600 s, in 30 s steps.
- **Opus bitrate** — 64 / 96 / 128 / 192 / 256 kbps.
- **Default visualizer** — oscilloscope / spectrum / spectrogram / history.
- **Theme** — six theme cards with live preview swatch.
- **Layout** — full vs compact (applies instantly).
- **Title bar** — custom 26px strip vs OS bar (rebuilds the window).
- **Button labels** — auto / icon / text.
- **Interface visibility** — five toggle chips (VU, buffer, picker, viz chips, hint).
- **Window** — Always-on-top, Magnetic edge snap, snap-quick-action chips, Docking reserves screen space (Windows only).
- **Pop-out visualizer** — open/close button, transport buttons inside pop-out, pop-out always-on-top, hide main window while popped out, hide just the visualizer, opacity slider.
- **Filename template** — input + token chips.

---

## ⚙️ Behaviour details worth knowing

- **Settings round-trip** — every UI change goes through `window.api.setSettings(patch)` → main process → JSON write → broadcast `settings:changed` so other windows update.
- **Pop-out relay** — the pop-out has no capture of its own. The WASAPI helper is single-instance, and a second `desktopCapturer` stream would double the cost; the main renderer streams `viz:frame` (30 fps) and the pop-out mirrors.
- **Toast stack** — last 3 in-app toasts, 4 s auto-dismiss, used for save confirmations and errors. Hackable via a `faze:local-toast` DOM event so non-React code can fire one.
- **Right-click quick menu** — context-menu integration over IPC for ad-hoc actions like "Dock top", "Open save folder", "Theme submenu", "Layout submenu".
- **Accessibility** — keyboard focus is visible; controls aren't asked to communicate state by colour alone; `prefers-reduced-motion` respected; device-name strings can contain CJK characters and are truncated gracefully without breaking the layout.
- **Procedural iconography** — every icon is drawn into an RGBA buffer at startup, so the build ships **zero** PNG assets.

---

## 🧰 Tech stack summary

- **Shell:** Electron 30 (Chromium 126)
- **Renderer:** React 18 + Vite 5 (ESM, chrome120 target)
- **Language:** TypeScript 5 everywhere (one `AppSettings` type crosses processes)
- **Loopback helper:** C# / .NET 8 + NAudio's `WasapiLoopbackCapture`, prebuilt `loopback-build/faze-loopback.exe` is committed so first-clone users don't have to bootstrap the SDK
- **FFI:** `koffi` → `shell32!SHAppBarMessage` for the Windows-appbar docking behaviour (no VS Build Tools required)
- **Audio codec:** WebM / Opus via MediaRecorder
- **IPC:** `Uint8Array` for PCM, primitives for everything else, structured-clone zero-copy

---

## 📦 Build / package

- `npm run dev` — Vite + Electron with HMR for the renderer.
- `npm run build` — tsc the main process, vite build the renderer; outputs to `dist/`.
- `npm run package` — `electron-builder` → NSIS installer in `release/`.
- `npm run typecheck` — tsc no-emit across both projects.
- The WASAPI helper is rebuilt with `scripts/build-loopback-helper.sh` only if `native/FazeLoopback/Program.cs` is edited.

---

## 🗺️ In-flight (post v3.0.0)

- **Premium visual redesign — Phases 3-5** *(underway)*: migrate the renderer onto the new token layer so the per-theme override blocks can be deleted and styles.css gets shorter.
- **History visualizer polish** *(Phase F)*: zoom/scroll on the overview, a Save-selection button as a non-drag path, keyboard shortcuts. The pop-out's history mirror is already wired.
- **Roadmap items** *(parked)*: webapp port (for `getDisplayMedia({audio:true})` users; prerequisite for the Android bullet), Android port via Capacitor/Tauri wrapper + `AudioPlaybackCapture` foreground-service, optional mic capture via the existing WASAPI helper, recording-pause hotkey, per-session input gain, in-app audio meter HUD on click, optional upload integrations (SoundCloud / Google Drive / Discord).
