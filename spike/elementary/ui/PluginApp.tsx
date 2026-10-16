// Plugin UI root (todo.md §73).
//
// Real Faze synth surface driven by the native param bridge. Visualizers
// (P7c) are Faze's own <Scope>, fed by native el.scope frames (scopeStore);
// right-click a scope to switch its mode, right-click empty space for the
// theme picker + options.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArpSettings, LaneId, ModMap, ModRoute, ModSourceId, ModTargetId, OperatorId, Theme } from '../../../src/shared/types';
import type { OperatorCaptureContext } from '../../../src/renderer/components/OscillatorPanel';
import { OscillatorPanel } from '../../../src/renderer/components/OscillatorPanel';
import { ArpPanel } from '../../../src/renderer/components/ArpPanel';
import { SeqEditor } from '../../../src/renderer/components/SeqEditor';
import { setArpPlayhead, setArpOverlay } from '../../../src/renderer/lib/arpStore';
import { useActiveVoices, useHeldNotes, useVoiceBurst } from '../../../src/renderer/lib/voiceStore';
import { EnvelopePanel, SourceDot } from '../../../src/renderer/components/EnvelopePanel';
import { FxPanel, FxChainStrip } from './FxPanel';
import { PianoKeyboard } from '../../../src/renderer/components/PianoKeyboard';
import { Knob } from '../../../src/renderer/components/Knob';
import { ModPopover, SourceRoutesPopover } from '../../../src/renderer/components/ModPopover';
import { getScopeRms } from './scopeStore';
import { MOD_SOURCES, MACRO_IDS, setModRouteAmount, setActiveModules, presentSources } from '../../../src/renderer/lib/mod-sources';
import { useBridgeSynth } from './useBridgeSynth';
import { useCableDrag } from './useCableDrag';
import { useModHoverEdit } from './useModHoverEdit';
import { Wave3D } from './Wave3D';
import { Scope, type ScopeMode } from './Scope';
import { AppMenu, normalizeTheme } from './AppMenu';
import { PresetBar } from '../../../src/renderer/components/PresetBar';
import { bridge } from './bridge';
import { snapOffsetToKey } from '../../../src/shared/scales';

const OP_COLORS: Record<OperatorId, string> = {
  osc1: '#37e0d8', osc2: '#e05fb0', osc3: '#f0a030', osc4: '#5fd06a',
};
const OP_SCOPE: Record<OperatorId, string> = { osc1: 'op0', osc2: 'op1', osc3: 'op2', osc4: 'op3' };
const OP_INDEX: Record<OperatorId, number> = { osc1: 0, osc2: 1, osc3: 2, osc4: 3 };

/** Decode the C++ side's base64 int8[256] waveform preview (same encoding
 *  drainScopes uses for live scope frames) into a -1..1 Float32Array,
 *  nearest-index resampled to whatever width the UI asks for. */
function decodePeaks(base64: string, maxPoints: number): Float32Array {
  const out = new Float32Array(maxPoints);
  if (!base64) return out;
  let bytes: Uint8Array;
  try {
    const bin = atob(base64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  } catch {
    return out;
  }
  if (bytes.length === 0) return out;
  for (let i = 0; i < maxPoints; i += 1) {
    const idx = Math.min(bytes.length - 1, Math.floor((i * bytes.length) / maxPoints));
    out[i] = ((bytes[idx] << 24) >> 24) / 127; // reinterpret as signed int8
  }
  return out;
}

const PIANO_START = 36;
const PIANO_END = 84;

function loadJSON<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function saveJSON(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
}

// The OSC cards' wavetable-folder button is in shared code with no bridge
// access; this is its hook (no-op in the Electron app, which never sets it).
(window as unknown as { __fazeOpenWavetableFolder?: () => void }).__fazeOpenWavetableFolder =
  () => bridge.openWavetableFolder();
(window as unknown as { __fazeSetWavetableLibrary?: () => void }).__fazeSetWavetableLibrary =
  () => bridge.setWavetableLibrary();
(window as unknown as { __fazeRescanWavetables?: () => void }).__fazeRescanWavetables =
  () => bridge.rescanWavetables();

/* ---- Leaves that read the voice store (src/renderer/lib/voiceStore.ts). ----
   The voice readout changes several times a second while the arp plays. These
   subscribe on their own, so only they re-render, not PluginApp. */

/** Piano: lights the keys held by the voice pool, plus the UI's own presses. */
function LivePiano({ uiHeldNotes, arpOn, ...rest }: Omit<React.ComponentProps<typeof PianoKeyboard>, 'activeNotes'> & {
  uiHeldNotes: ReadonlySet<number>;
  arpOn: boolean;
}) {
  const heldNotes = useHeldNotes();
  const activeNotes = useMemo(
    () => (arpOn ? new Set<number>([...uiHeldNotes, ...heldNotes]) : heldNotes),
    [arpOn, uiHeldNotes, heldNotes],
  );
  return <PianoKeyboard {...rest} activeNotes={activeNotes} />;
}

/** FX panel: the level follows active voices; a burst fires each time the held-note count grows. */
function LiveFxPanel(props: Omit<React.ComponentProps<typeof FxPanel>, 'level' | 'trigger'>) {
  const activeVoices = useActiveVoices();
  const burst = useVoiceBurst();
  // Placeholder level until a native scope tap lands (todo.md §86 follow-up).
  return <FxPanel {...props} level={activeVoices > 0 ? 0.55 : 0.07} trigger={burst} />;
}

export function PluginApp() {
  // Standalone app (not a DAW): there is no OS title bar any more, so the
  // header is the drag handle and carries Options / minimise / close.
  const [isStandalone, setIsStandalone] = useState(() => bridge.isStandalone());
  useEffect(() => bridge.onStandalone(() => setIsStandalone(true)), []);
  const winDragging = useRef(false);
  const { synth, change, noteOn, noteOff, samples } = useBridgeSynth();
  // Raw UI piano press/release tracking — independent of `heldNotes` (which
  // only reflects the native voice-pool's ACTUAL gate state). Needed because
  // while the arp is on, PianoKeyboard presses deliberately do NOT call
  // noteOn/noteOff (the arp owns triggering), so `heldNotes` would never
  // see them and the arp would have nothing to play from its own keyboard.
  const [uiHeldNotes, setUiHeldNotes] = useState<Set<number>>(() => new Set());
  // The arp/seq now runs natively in processBlock (sample-accurate, todo.md
  // §166-E); the UI only pushes its settings and receives the playhead. The
  // piano always sends raw notes, which the native engine takes over while
  // the arp is on.
  useEffect(() => {
    bridge.setArpConfig(JSON.stringify(synth.arp));
  }, [synth.arp]);
  useEffect(() => {
    // Native -> UI: current global step + completed-bar count, and the dice
    // overlay ({lanes:{on:[..],prob:[..],..}}, null = no overlay for a step).
    const w = window as unknown as {
      __arpPlayhead__?: (step: number, bar: number) => void;
      __arpOverlay__?: (msg: { lanes?: Partial<Record<LaneId, (number | null)[]>> }) => void;
    };
    w.__arpPlayhead__ = (step, bar) => setArpPlayhead(step, bar ?? 0);
    w.__arpOverlay__ = (msg) => setArpOverlay(msg?.lanes ?? {});
    return () => { setArpPlayhead(-1, 0); setArpOverlay({}); };
  }, []);

  // Native resample-recording readout (todo.md §167 S1): which op is recording + elapsed.
  // Sampler Rec source: 0 = resample the synth's own output, 1 = the audio input.
  const [recSource, setRecSource] = useState<0 | 1>(() => (loadJSON<number>('faze.recSource', 0) === 1 ? 1 : 0));
  const setRecSourcePersist = useCallback((v: 0 | 1) => { setRecSource(v); saveJSON('faze.recSource', v); }, []);
  const [resample, setResample] = useState<{ op: number; sec: number }>({ op: -1, sec: 0 });
  useEffect(() => {
    (window as unknown as { __resampleState__?: (op: number, tenths: number) => void }).__resampleState__ =
      (op, tenths) => setResample({ op, sec: Math.max(0, tenths) / 10 });
  }, []);

  // Sampler file-load (todo.md §114) — 'file' mode: onToggleRecord opens a
  // native file picker instead of starting a live capture. Rebuilt whenever
  // `samples` changes so sampleDuration/samplePeaks close over fresh data;
  // the callbacks themselves (onToggleRecord/clearSampleBuffer) are stable.
  const capture: OperatorCaptureContext = useMemo(() => ({
    mode: 'file',
    recordingId: null,
    level: 0,
    elapsed: 0,
    maxSeconds: 300,
    hasSource: true,
    onToggleRecord: (id) => bridge.pickSampleFile(OP_INDEX[id]),
    clearSampleBuffer: (id) => bridge.clearSampleFile(OP_INDEX[id]),
    sampleDuration: (id) => samples[OP_INDEX[id]]?.duration ?? 0,
    samplePeaks: (id, maxPoints) => decodePeaks(samples[OP_INDEX[id]]?.peaksBase64 ?? '', maxPoints),
    sampleVersion: samples.reduce((sum, s) => sum + s.version, 0),
    onResample: (id, start) => bridge.resampleRec(OP_INDEX[id], start, recSource),
    recSource,
    onRecSource: setRecSourcePersist,
    onAudioSettings: () => bridge.winCtl('options'),
    resampleOp: resample.op,
    resampleSec: resample.sec,
  }), [samples, resample, recSource, setRecSourcePersist]);

  // Only Black ice + Aurora ice remain; the stored theme is normalised on load.
  const [theme, setThemeState] = useState<Theme>(() => normalizeTheme(loadJSON<string>('faze.theme', 'black-ice')));
  const setTheme = useCallback((t: Theme) => { const n = normalizeTheme(t); setThemeState(n); saveJSON('faze.theme', n); }, []);
  // ModPopover/SourceRoutesPopover portal straight to document.body (to
  // escape their card's overflow:hidden) — that puts them OUTSIDE the
  // `.app.theme-${theme}` div, so the theme's CSS custom properties never
  // cascade to them and they always render in :root's bare defaults
  // (todo.md §100, user: "the modulation popup menu needs to follow the
  // theme styles" — screenshot showed a blue popover on a red theme).
  // Mirroring the theme class onto <body> gives portaled content the same
  // token overrides without changing how any portal is written.
  useEffect(() => {
    document.body.className = `theme-${theme}`;
    // ...and onto <html>, which is where the theme's tokens must be DEFINED for
    // every descendant to inherit them. `html` also paints `var(--bg-app)` as
    // the window background (styles.css), and with the class only on <body> it
    // resolved against `:root`'s bare Aurora-ice `#070a1c` — a blue-grey
    // lighter than all three themes, which showed as a haze wherever <body>
    // failed to cover the viewport (scrollbar gutters, overscroll, popout).
    document.documentElement.className = `theme-${theme}`;
    return () => {
      document.body.className = '';
      document.documentElement.className = '';
    };
  }, [theme]);

  const [mainMode, setMainMode] = useState<ScopeMode>(() => loadJSON<ScopeMode>('faze.viz.main', 'scope'));
  const [opModes, setOpModes] = useState<Record<OperatorId, ScopeMode>>(
    () => loadJSON('faze.viz.ops', { osc1: 'scope', osc2: 'scope', osc3: 'scope', osc4: 'scope' }),
  );
  // The last 2D mode per oscillator, so right-clicking the 3D view returns to it.
  const lastTwoD = useRef<Partial<Record<OperatorId, ScopeMode>>>({});
  const setOpMode = useCallback((id: OperatorId, m: ScopeMode) => {
    if (m !== 'wave3d') lastTwoD.current[id] = m;
    setOpModes((prev) => { const next = { ...prev, [id]: m }; saveJSON('faze.viz.ops', next); return next; });
  }, []);

  // Zoom readout (todo.md §100, user: "can you make the current zoom level
  // display somewhere?" — grew out of the "app opens too zoomed in" report,
  // so this is as much a diagnostic as a feature). Chromium/WebView2 fold
  // page zoom (Ctrl+scroll) into `devicePixelRatio` alongside any OS-level
  // display scaling, so this reads as "100%" only when BOTH are unscaled —
  // on a scaled display it'll show that display's scale at rest, with
  // further Ctrl+scroll changes moving it from there. That's still exactly
  // the signal needed here: whether the OS scale is 100% or not, the
  // number changes live with Ctrl+scroll, so "did zoom change" is always
  // answerable at a glance. `resize` fires on a zoom change in Chromium.
  const [zoomPct, setZoomPct] = useState(() => Math.round((window.devicePixelRatio || 1) * 100));
  useEffect(() => {
    const onResize = () => setZoomPct(Math.round((window.devicePixelRatio || 1) * 100));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  type View = 'osc' | 'fx' | 'seq';
  const [view, setView] = useState<View>(() => {
    const v = loadJSON<string>('faze.view', 'osc');
    return v === 'fx' || v === 'seq' ? v : 'osc';
  });
  // The lower mini panel: the arp strip (true) or the FX chain (false). Separate from the main view.
  const [miniArp, setMiniArp] = useState<boolean>(() => loadJSON<boolean>('faze.miniArp', false));
  const toggleMiniArp = useCallback(() => setMiniArp((m) => { saveJSON('faze.miniArp', !m); return !m; }), []);
  const setViewPersist = useCallback((v: View) => { setView(v); saveJSON('faze.view', v); }, []);
  const patchArp = useCallback((patch: Partial<ArpSettings>) => change({ arp: { ...synth.arp, ...patch } }), [change, synth.arp]);
  // The sequencer is the one detail view (MEGA ARP). Toggling Seq/Arp on the strip no longer
  // swaps it: the editor shows which mode is active.
  useEffect(() => {
  }, [view, setViewPersist]);
  // MEGA ARP: the sequencer is the single detailed view. The old standalone ARP detail is archived,
  // so every detail request opens the sequencer.
  // Scale Weights overlay on the sequencer: collapses the mod cards while it is open.
  const [seqWeightsEditing, setSeqWeightsEditing] = useState(false);

  // Glide: exponential knob taper. The knob position v (0..1) maps to
  // seconds = 5 * v^3, so the short times (where glide is musical) get most
  // of the travel; synth.glideSec stays in real seconds.
  const GLIDE_MAX = 5;
  const glidePos = Math.cbrt(Math.max(0, Math.min(1, synth.glideSec / GLIDE_MAX)));
  const fmtGlide = (pos: number) => {
    const sec = GLIDE_MAX * pos * pos * pos;
    return sec < 0.005 ? 'off' : sec < 1 ? `${Math.round(sec * 1000)}ms` : `${sec.toFixed(2)}s`;
  };

  // Pigments-style cable routing — drag an ENV/LFO/S&H dot onto a knob
  // (scroll wheel while hovering sets the depth — todo.md §81), OR click a
  // source then click a knob (todo.md §91/92 click-to-assign — `assignSource`).
  const applyMod = useCallback((m: ModMap) => change({ mod: m }), [change]);
  const {
    cableSource, dragColor, amountLabel, handleSourceDragStart, pathRef, endDotRef, amtRef,
    assignSource, assignColor, cancelAssign,
  } = useCableDrag(synth.mod, applyMod);

  // Plain hover over a routed knob → applied-only quick editor (§81); plain
  // hover-and-SCROLL (no popover, no drag) adjusts the amount directly when
  // exactly one route is active (todo.md — user: this used to only work
  // mid-cable-drag "audition" mode).
  const adjustHoveredRoute = useCallback(
    (target: ModTargetId, source: ModSourceId, amount: number) =>
      applyMod(setModRouteAmount(synth.mod, source, target, amount)),
    [applyMod, synth.mod],
  );
  const hoverEdit = useModHoverEdit(synth.mod, cableSource != null || assignSource != null, adjustHoveredRoute);

  // Right-click a source dot (overview row or its own card) → its active-
  // routes list (todo.md §91/92, "right-click inside a modulator → that
  // operator's active-routes list"). Owned here since both the header's
  // overview row and every card inside <EnvelopePanel> need to open it.
  const [routesOpen, setRoutesOpen] = useState<ModSourceId | null>(null);
  const routesAnchor = useRef<Partial<Record<ModSourceId, HTMLElement | null>>>({});
  const openSourceRoutes = useCallback((source: ModSourceId, anchor: HTMLElement) => {
    routesAnchor.current[source] = anchor;
    setRoutesOpen(source);
  }, []);
  const setTargetRoutes = useCallback(
    (target: ModTargetId, routes: ModRoute[]) =>
      applyMod({ ...(synth.mod ?? {}), [target]: routes }),
    [applyMod, synth.mod],
  );

  // Optional "+" modulators: tell the shared mod popovers which exist, and
  // feed the Audio Follower card's meter from the native `af` scope tap.
  setActiveModules(presentSources(synth.modules, synth.mod));
  const afLevel = useCallback((scope: string) => getScopeRms(scope), []);

  const panic = useCallback(() => { for (let n = 0; n < 128; n += 1) noteOff(n); }, [noteOff]);

  // 8 Macro knobs (todo.md §111) — plain 0..1 held values, each a real
  // ModSourceId (`macro1..macro8`) routable to any target exactly like an
  // ENV/LFO. The knob sets its own value directly; the adjacent SourceDot
  // is the drag-to-route / right-click-routes handle, same split every
  // other source card uses (a value control and a cable handle are always
  // separate hit-targets here, since both start on pointerdown).
  const setMacro = useCallback((i: number, v: number) => {
    const next = synth.macros.slice();
    next[i] = v;
    change({ macros: next });
  }, [synth.macros, change]);

  // FX feed (burst + level) comes from the voice store inside <LiveFxPanel>, so
  // voice changes do not re-render the app. See LiveFxPanel below.
  // Tab dot: any of the 8 effects actually mixed in, not just delay/reverb
  // (stale from before todo.md §117-124 added distortion/chorus/flanger/
  // compressor/phaser/eq — found while wiring the FX chain strip).
  const anyFxWet = (['delay', 'reverb', 'distortion', 'chorus', 'flanger', 'compressor', 'phaser', 'eq'] as const)
    .some((k) => synth.fx[k].enabled !== false && synth.fx[k].mix > 0);

  const [pianoStart, pianoEnd] = useMemo(() => {
    const shift = synth.octave * 12 + synth.semitone;
    return [PIANO_START + shift, PIANO_END + shift];
  }, [synth.octave, synth.semitone]);

  const renderVisualizer = useCallback(
    (id: OperatorId) => (opModes[id] === 'wave3d' ? (
      <Wave3D
        source={OP_SCOPE[id]}
        color={OP_COLORS[id]}
        onBack={() => setOpMode(id, lastTwoD.current[id] ?? 'scope')}
      />
    ) : (
      <Scope
        source={OP_SCOPE[id]}
        mode={opModes[id]}
        onChangeMode={(m) => setOpMode(id, m)}
        color={OP_COLORS[id]}
      />
    )),
    [opModes, setOpMode],
  );

  return (
    <div
      className={`app theme-${theme} mode-synth`}
      onContextMenu={(e) => {
        // The theme/options menu itself now only opens from <header>'s own
        // handler below (todo.md — user: "the [theme] menu tends to get in
        // the way quite a lot… I only wanted it to appear if right-clicked
        // at the very top area"). This outer handler still runs for every
        // OTHER right-click in the app (oscillators, modulators, FX, piano,
        // the Function editor) — it just suppresses the native WebView2
        // context menu (Inspect Element etc.) and cancels an in-progress
        // click-to-assign drag, without opening anything of its own.
        e.preventDefault();
        cancelAssign();
      }}
    >
      <div
        className={`synth-root ${cableSource || assignSource ? 'is-mod-dragging' : ''}`}
        style={{ '--drag-color': dragColor ?? assignColor } as React.CSSProperties}
      >
        <header
          className="plugin-header"
          onPointerDown={(e) => {
            if (!isStandalone || e.button !== 0) return;
            if ((e.target as Element).closest('.knob,button,select,input,.preset-bar,.plugin-macro,.plugin-winctl')) return;
            winDragging.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            bridge.winDrag('start');
          }}
          onPointerMove={() => { if (winDragging.current) bridge.winDrag('move'); }}
          onPointerUp={(e) => {
            winDragging.current = false;
            try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
          }}
          onContextMenu={(e) => {
            // The ONE place the theme/options menu is allowed to open
            // (todo.md — see the outer `.app` handler's comment above).
            // stopPropagation so the outer handler's own preventDefault-only
            // pass doesn't also run redundantly.
            e.preventDefault();
            e.stopPropagation();
            cancelAssign();
            setMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          <span className="plugin-brand">PsydeNote</span>
          <div className="plugin-globals">
            <Knob label="Oct" size="lg" value={synth.octave} min={-3} max={3}
              onChange={(v) => change({ octave: Math.round(v) })} centerDetent />
            <Knob label="Semi" size="lg" value={synth.semitone} min={-12} max={12}
              onChange={(v) => change({ semitone: Math.round(v) })} centerDetent />
            <Knob label="Fine" size="lg" value={synth.fineTuneCents} min={-100} max={100}
              onChange={(v) => change({ fineTuneCents: Math.round(v) })} centerDetent
              format={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}c`} />
            <Knob label="Glide" size="lg" value={glidePos} min={0} max={1}
              onChange={(v) => change({ glideSec: GLIDE_MAX * v * v * v })}
              format={fmtGlide}
              parse={(s) => {
                // typed value: "250ms" / "0.25s" / "0.25" (seconds) -> knob position
                const t = s.trim().toLowerCase();
                const n = parseFloat(t);
                if (!Number.isFinite(n)) return NaN;
                const sec = t.endsWith('ms') ? n / 1000 : n;
                return Math.cbrt(Math.max(0, Math.min(GLIDE_MAX, sec)) / GLIDE_MAX);
              }} />
            <Knob label="Master" size="lg" value={synth.masterLevel} min={0} max={1}
              onChange={(v) => change({ masterLevel: v })} format={(v) => v.toFixed(2)} />
          </div>
          
            <div className="plugin-macros" role="list" aria-label="Macros">
              {MACRO_IDS.map((source, i) => (
                <span key={source} className="plugin-macro" role="listitem"
                  style={{ '--src': MOD_SOURCES[source].color } as React.CSSProperties}>
                  <SourceDot
                    source={source}
                    armed={assignSource === source}
                    onSourceDragStart={handleSourceDragStart}
                    onSourceContext={openSourceRoutes}
                  />
                  <Knob
                    value={synth.macros[i] ?? 0}
                    min={0}
                    max={1}
                    size="lg"
                    color={MOD_SOURCES[source].color}
                    onChange={(v) => setMacro(i, v)}
                    format={(v) => Math.round(v * 100).toString()}
                    title={`${MOD_SOURCES[source].label} — drag to set; drag its dot onto a knob to route it`}
                  />
                </span>
              ))}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
              <button
                type="button"
                className="key-sync-btn"
                onClick={() => change({
                  oscillators: synth.oscillators.map((o) => ({
                    ...o,
                    pitch: snapOffsetToKey(Math.round(o.pitch), synth.arp.keyScale),
                  })),
                })}
                title="Key sync — snap all 4 OSC pitch knobs to the nearest notes of the arp's key signature"
              >
                Key
              </button>
              <PresetBar synth={synth} onChange={(patch) => change(patch.synth ?? {})} />
            </div>
            {isStandalone && (
              <div className="plugin-winctl">
                <button type="button" title="Audio / MIDI settings, save/load state" onClick={() => bridge.winCtl('options')}>⚙</button>
                <button type="button" title="Minimise" onClick={() => bridge.winCtl('min')}>–</button>
                <button type="button" className="is-close" title="Close" onClick={() => bridge.winCtl('close')}>✕</button>
              </div>
            )}

        </header>

        <div className="synth-scroll">
          <section className="synth-controls">
            {/* Rendered on every view so everything below starts at the same y
                (todo: FX/Synth alignment, cause (a)). */}
            {/* The detailed Seq / Arp views drop the visualizer: their lanes need the height (no inner scrollbar). */}
            {view !== 'seq' && (
            <div className="main-viz">
              <Scope source="main" mode={mainMode}
                onChangeMode={(m) => { setMainMode(m); saveJSON('faze.viz.main', m); }}
                color="var(--accent)" />
            </div>
            )}

            {view === 'seq' ? (
              <SeqEditor arp={synth.arp} onChange={patchArp} onClose={() => setViewPersist('osc')}
                onWeightsEditChange={setSeqWeightsEditing} />
            ) : view !== 'fx' ? (
              <OscillatorPanel
                settings={synth}
                onChange={change}
                lastNoteMidi={null}
                capture={capture}
                engine={null}
                theme={theme}
                renderVisualizer={renderVisualizer}
              />
            ) : (
              <LiveFxPanel fx={synth.fx} onChange={change} />
            )}

            <EnvelopePanel
              forceCollapsed={seqWeightsEditing}
              ampEnv={synth.ampEnv}
              modEnv={synth.modEnv}
              modEnv3={synth.modEnv3}
              lfo1={synth.lfo1}
              lfo2={synth.lfo2}
              lfo3={synth.lfo3}
              velCurve={synth.velCurve}
              keyCurve={synth.keyCurve}
              filterA={synth.filterA}
              filterB={synth.filterB}
              mod={synth.mod}
              modules={synth.modules}
              afLevel={afLevel}
              onChange={change}
              onSourceDragStart={handleSourceDragStart}
              armedSource={assignSource}
              onSourceContext={openSourceRoutes}
              renderFxChain={() => (
                  <>
                    {miniArp ? (
                      <ArpPanel compact arp={synth.arp} onChange={patchArp} mod={synth.mod} onModChange={applyMod} />
                    ) : (
                      <FxChainStrip
                        fx={synth.fx}
                        onChange={change}
                        anyFxWet={anyFxWet}
                      />
                    )}
                    {/* Always rendered, in every view — the FX/Arp switches must never
                        disappear (user: "this button needs to always be visible"). */}
                    <div className="view-switch">
                      <button
                        type="button"
                        className={`fx-chain-view-toggle ${view !== 'osc' ? 'is-on' : ''}`}
                        onClick={() => setViewPersist(view === 'osc' ? 'fx' : view === 'fx' ? 'seq' : 'osc')}
                        title="Main view: Synth, then FX, then Arp (the sequencer)"
                      >
                        {view === 'osc' ? 'Synth' : view === 'fx' ? 'FX' : 'Arp'}
                        {anyFxWet && view !== 'fx' && <span className="fx-tab-dot" aria-hidden="true" />}
                      </button>
                      <button
                        type="button"
                        className={`fx-chain-view-toggle ${miniArp ? 'is-on' : ''}`}
                        onClick={toggleMiniArp}
                        title="Lower panel: the arp strip or the FX chain"
                      >
                        {miniArp ? 'FX' : 'Arp'}
                      </button>
                      <button
                        type="button"
                        className={`plugin-voice-mode vm-${['poly', 'mono', 'legato'][synth.voiceMode] ?? 'poly'}`}
                        title="Voice mode: Poly / Mono (retrigger) / Legato (no retrigger on overlap) — click to cycle"
                        onClick={() => change({ voiceMode: (synth.voiceMode + 1) % 3 })}
                      >
                        {['POLY', 'MONO', 'LEGATO'][synth.voiceMode] ?? 'POLY'}
                      </button>
                    </div>
                  </>
                )}
            />
          </section>
        </div>

        <footer className="synth-keys">
          {/* Own component: the held-note readout re-renders the keyboard only, not the app. */}
          <LivePiano
            startMidi={pianoStart}
            endMidi={pianoEnd}
            arpOn={synth.arp.on}
            uiHeldNotes={uiHeldNotes}
            onNoteOn={(midi, velocity) => {
              setUiHeldNotes((prev) => new Set(prev).add(midi));
              noteOn(midi, velocity);
            }}
            onNoteOff={(midi) => {
              setUiHeldNotes((prev) => { if (!prev.has(midi)) return prev; const n = new Set(prev); n.delete(midi); return n; });
              noteOff(midi);
            }}
            velocityCurve={synth.velocityCurve}
          />
        </footer>

        {/* Cable overlay — drawn imperatively (no re-render per pointermove). */}
        {cableSource && (
          <svg className="mod-cable-layer" aria-hidden="true">
            <path
              ref={pathRef}
              className="mod-cable"
              style={{ stroke: MOD_SOURCES[cableSource].color } as React.CSSProperties}
            />
            <circle
              ref={endDotRef}
              className="mod-cable-end"
              style={{ fill: MOD_SOURCES[cableSource].color } as React.CSSProperties}
            />
          </svg>
        )}
        {cableSource && (
          <div
            ref={amtRef}
            className="mod-cable-amt"
            hidden={!amountLabel}
            style={{ '--src': MOD_SOURCES[cableSource].color } as React.CSSProperties}
          >
            {amountLabel} <span className="mod-cable-amt-hint">scroll ↕</span>
          </div>
        )}

        {/* Plain-hover quick editor — applied routes only (§81). */}
        {hoverEdit.hoverTarget && hoverEdit.hoverAnchor && (
          <ModPopover
            appliedOnly
            targetId={hoverEdit.hoverTarget}
            routes={synth.mod?.[hoverEdit.hoverTarget] ?? []}
            anchorEl={hoverEdit.hoverAnchor}
            onChange={(routes) => setTargetRoutes(hoverEdit.hoverTarget!, routes)}
            onClose={hoverEdit.close}
            onPointerEnter={hoverEdit.onPopoverEnter}
            onPointerLeave={hoverEdit.onPopoverLeave}
          />
        )}

        {/* Right-click a source dot → its active-routes list (§91/92). */}
        {routesOpen && (
          <SourceRoutesPopover
            // key forces a full remount on every source switch — otherwise
            // React reuses the same instance (and its in-progress drag ref)
            // across sources that happen to share a routed target, letting
            // a stale drag corrupt the wrong route (found in review).
            key={routesOpen}
            sourceId={routesOpen}
            mod={synth.mod}
            anchorEl={routesAnchor.current[routesOpen] ?? null}
            onChange={applyMod}
            onClose={() => setRoutesOpen(null)}
          />
        )}
      </div>

      {menu && (
        <AppMenu
          x={menu.x}
          y={menu.y}
          theme={theme}
          onTheme={setTheme}
          onPanic={panic}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
