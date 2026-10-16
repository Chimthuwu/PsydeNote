import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { TitleBar } from './components/TitleBar';
import { SettingsPanel } from './components/SettingsPanel';
import { ToastStack } from './components/ToastStack';
import { SynthView } from './components/SynthView';
import { useSettings } from './hooks/useSettings';
import { useSynth } from './hooks/useSynth';
import { SMOOTHING_FOR_MODE } from './lib/visualizer';
import { AnalyserLike } from './lib/visualizer';
import { AppSettings } from '../shared/types';

/**
 * Phase 1.6: synth is the only UI surface.
 *
 * The recorder-as-separate-view was retired at the user's explicit
 * request:
 *
 *   "i cant get back to the synth. We shouldnt be able to go into the
 *    faze that was a whole seperate app ..."
 *
 * Settings still carries `appMode`, `recordMode`, `captureBackend`,
 * `sourceId`, `loopbackDeviceId`, `saveFolder`, `hotkey`, `theme`, etc.
 * for forward-compat — the recorder pipeline in `useCapture`,
 * `audio-capture.ts`, `loopback-capture.ts`, and `recorder.ts` is still
 * loadable so a future sub-project (Phase 1.7, system-audio sampler) can
 *   reuse the capture plumbing as the *source* feeding the synth's
 *   sample buffer. But none of that surfaces here.
 *
 * What the user sees now: the synth header + visualiser + oscillator
 * controls + piano. Settings can be opened; theme, visualizer mode,
 * "synth" settings, layout, hotkey (no-op), filename template, etc.
 */

const VIZ_FRAME_MS = 33;

export default function App() {
  const { settings, loaded, update } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const synth = useSynth(settings.synth);

  // Active analyser for the visualizer + pop-out bridge. We use the synth's
  // analyser unconditionally now; the recorder path is materially dead in
  // the UI surface, so there's no second source to fall back to.
  const activeAnalyser: AnalyserLike | null = synth.engine;

  // Toast surface — local-toast events from `faze:local-toast` plus any
  // recorder events that the IPC hook still emits (it does, but main has
  // no events to forward because nothing captures).
  const [toasts, setToasts] = useState<{ id: number; kind: 'saved' | 'error'; message: string }[]>([]);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as any;
      const id = Date.now() + Math.random();
      setToasts((t) => [...t, { id, ...detail }].slice(-3));
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
    };
    window.addEventListener('faze:local-toast', handler);
    return () => window.removeEventListener('faze:local-toast', handler);
  }, []);

  // Per-knob effects that mirror AppSettings into the synth engine.
  useEffect(() => {
    if (loaded) window.api.setAlwaysOnTop(settings.alwaysOnTop);
  }, [settings.alwaysOnTop, loaded]);
  useEffect(() => {
    const node = activeAnalyser?.analyser;
    if (node && typeof node.smoothingTimeConstant === 'number') {
      node.smoothingTimeConstant = SMOOTHING_FOR_MODE[settings.visualizer];
    }
  }, [activeAnalyser, settings.visualizer]);

  // Settings-panel chrome
  const openSettingsPanel = useCallback(() => setSettingsOpen(true), []);
  const closeSettingsPanel = useCallback(() => setSettingsOpen(false), []);
  useEffect(() => window.api.onOpenSettingsRequest(() => openSettingsPanel()), [openSettingsPanel]);

  // ----- Pop-out bridge ----------------------------------------------------
  // Streams every analyser frame to the pop-out window while it's open, so
  // the pop-out visualizer stays in sync with the synth.
  const analyserRef = useRef<AnalyserLike | null>(null);
  analyserRef.current = activeAnalyser;
  const popoutOpen = loaded && settings.popoutOpen;
  const togglePopout = useCallback(() => { void window.api.togglePopout(); }, []);

  useEffect(() => {
    if (!popoutOpen) return;
    const id = setInterval(() => {
      const a = analyserRef.current;
      if (!a) return;
      a.sample();
      window.api.sendVizFrame({
        time: a.timeData,
        freq: a.freqData,
        minDecibels: a.analyser.minDecibels,
        maxDecibels: a.analyser.maxDecibels,
      });
    }, VIZ_FRAME_MS);
    return () => clearInterval(id);
  }, [popoutOpen]);

  // Slower state — bufferedSeconds is 0 in synth mode, but the pop-out
  // mirror still asks for it so it can render a consistent UI.
  useEffect(() => {
    if (!popoutOpen) return;
    window.api.sendVizState({
      // Repurposed for the synth (todo.md §55): "capturing" now means "is
      // the synth actually sounding" so the pop-out's dot/title reflect
      // real activity instead of being permanently stuck on "recording".
      capturing: synth.activeVoices > 0,
      hasSource: !!activeAnalyser,
      canSave: false,
      bufferedSeconds: 0,
      bufferSeconds: settings.bufferSeconds,
      recordMode: settings.recordMode,
      theme: settings.theme,
      visualizer: settings.visualizer,
      rms: synth.engine?.sample().rms ?? 0,
    });
  }, [popoutOpen, activeAnalyser, synth.engine, synth.activeVoices, settings.bufferSeconds,
      settings.recordMode, settings.theme, settings.visualizer]);

  // The recorder-only peakBuffer / vizHistory channel is a no-op in synth
  // mode (the pop-out's history mode reads from the recorder's peak track).
  // We intentionally do NOT subscribe here.

  // Commands the pop-out sends back. With recording retired at the UI,
  // most of these are inert: `toggle-capture` and `save` go to nowhere,
  // and `set-visualizer` is the only useful one.
  useEffect(
    () =>
      window.api.onVizCommand((c) => {
        if (c.type === 'set-visualizer') void update({ visualizer: c.mode });
        // selection-change is recorder-only (history peak track) — ignored
        // in synth mode.
      }),
    [update],
  );

  // Right-click anywhere except a form field triggers the OS context menu
  // (Phase 9-era behaviour — kept in synth mode for consistency).
  const handleContextMenu = useCallback((e: MouseEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    window.api.showContextMenu();
  }, []);

  if (!loaded) {
    return <div className="loading">Loading…</div>;
  }

  const themeClass = `theme-${settings.theme}`;
  const customChrome = settings.titleBarMode === 'custom';

  // The theme class has to reach <html>, not just the inner `.app` div: the
  // root element is where the tokens must be DEFINED for descendants to inherit
  // them, and it paints `var(--bg-app)` as the window background. With the class
  // only on `.app`, `html` resolved against `:root`'s bare Aurora-ice `#070a1c` —
  // a blue-grey lighter than all three themes, which showed as a haze wherever
  // `.app` failed to cover the viewport (scrollbar gutters, overscroll).
  // Mirroring it here matches what the plugin already does in `PluginApp.tsx`.
  useEffect(() => {
    document.documentElement.className = themeClass;
    return () => { document.documentElement.className = ''; };
  }, [themeClass]);

  return (
    <div
      className={`app ${themeClass} mode-synth ${customChrome ? 'has-custom-titlebar' : ''}`}
      onContextMenu={handleContextMenu}
    >
      {customChrome && (
        <TitleBar
          settings={settings}
          onUpdate={update}
          capturing={true}
          popoutOpen={popoutOpen}
          onTogglePopout={togglePopout}
          onOpenSettings={openSettingsPanel}
        />
      )}

      <SynthView settings={settings} onChange={update} />

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onUpdate={update as (p: Partial<AppSettings>) => Promise<AppSettings>}
          onClose={closeSettingsPanel}
          onPickFolder={() => window.api.pickFolder()}
          active={false}
          loopbackSupported={true}
          popoutOpen={popoutOpen}
          onTogglePopout={togglePopout}
        />
      )}

      <ToastStack toasts={toasts} />
    </div>
  );
}
