import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import type {
  ModMap,
  ModRoute,
  ModTargetId,
  OperatorId,
  OperatorModEntry,
  OperatorModMap,
  OperatorPitch,
  OscillatorSlotSettings,
  SynthSettings,
  Theme,
  VisualizerMode,
} from '../../shared/types';
import { OPERATOR_IDS, WAVE_MORPH_SHAPES, WARP_MODES, waveShapeForPosition } from '../../shared/types';
import { WAVETABLES, REMOVED_WAVETABLE_IDS } from '../../../spike/elementary/dsp/wavetables.js';

// Exclude jumpy wavetables (avg frame-to-frame discontinuity > 0.3)
// Same list as build-wavetables.mjs - tables with hard transitions removed.
const EXCLUDE_JUMPY_IDS = [6, 7, 9, 11, 14, 16, 25, 30, 33, 44, 70, 90, 94, 104, 127, 152, 153, 176, 185, 198, 210, 236, 247, 320, 331, 340, 359, 368];
const FILTERED_WAVETABLES = WAVETABLES.filter(wt => !EXCLUDE_JUMPY_IDS.includes(wt.id) && !REMOVED_WAVETABLE_IDS.has(wt.id));
// ---- User wavetables (flat folder, no categories) -------------------------
// Native pushes the sorted name list via window.__userWavetables__(names[]) after
// every scan and when the UI loads. Table id = USER_WT_BASE_ID + index.
// LIMITATION: presets store the numeric id, so ids shift when files are
// added/removed from the folder (the list is alphabetical).
const USER_WT_BASE_ID = 381;
let userWtNames: string[] = [];
const userWtListeners = new Set<() => void>();
(window as unknown as { __userWavetables__?: (names: string[]) => void }).__userWavetables__ = (names) => {
  userWtNames = Array.isArray(names) ? names.map(String) : [];
  userWtListeners.forEach((l) => l());
};
function subscribeUserWt(cb: () => void) { userWtListeners.add(cb); return () => { userWtListeners.delete(cb); }; }
function getUserWt() { return userWtNames; }
import { modGlowFor } from '../lib/mod-sources';
import { useActiveVoices } from '../lib/voiceStore';

/** The live voice count as a leaf, for when the parent does not pass `activeVoices`. */
function LiveVoiceCount() {
  return <>{useActiveVoices()}</>;
}
import { ModBadge, ModPopover } from './ModPopover';
import { VisualizerBoard } from './VisualizerBoard';
// The OSC card's wavetable graphic (todo.md SS148 item 3). Added by f5f47f6
// at the <WavetableGraphic> call site below but the import was never added,
// so the component was referenced without ever being in scope — TS2304 on
// the plugin typecheck and a hard ReferenceError at runtime (SS149 item 6).
import { WavetableGraphic } from './WavetableGraphic';
import { SamplerBlock } from './SamplerBlock';
import { PitchDial } from './PitchDial';
import { Knob } from './Knob';
import { OPERATOR_COLORS, OPERATOR_LABELS } from '../lib/operator-colors';
import type { AnalyserLike } from '../lib/visualizer';

/**
 * Minimal structural type for the per-operator analyser owner. Was
 * `import type { SynthEngine } from '../lib/synth'` — severed so the
 * Electron-only Web-Audio engine isn't dragged into the VST plugin's
 * typecheck (todo.md §88.A). The plugin always passes `engine={null}` and a
 * `renderVisualizer` override.
 */
export interface OperatorAnalyserOwner {
  getOperatorAnalyser(id: OperatorId): AnalyserLike | null;
}
type SynthEngine = OperatorAnalyserOwner;

/**
 * Sample-record plumbing for any oscillator currently in sample mode
 * (`wave === 'sample'`) — Phase 1.11 (todo.md §33). There's no more
 * dedicated sampler operator; every oscillator card gets a bare Record
 * toggle when its wave is set to Sample. Backend/source selection lives in
 * the Settings modal now, not here.
 */
export interface OperatorCaptureContext {
  /** Which operator is currently recording, if any — only one at a time. */
  recordingId: OperatorId | null;
  /** Live input level 0..1 while recording. */
  level: number;
  /** Elapsed seconds while recording. */
  elapsed: number;
  /** Hard cap in seconds (MAX_SAMPLE_CAPTURE_SECONDS). */
  maxSeconds: number;
  /** Whether a capture source is picked in Settings. */
  hasSource: boolean;
  onToggleRecord: (id: OperatorId) => void;
  sampleDuration: (id: OperatorId) => number;
  samplePeaks: (id: OperatorId, maxPoints: number) => Float32Array;
  clearSampleBuffer: (id: OperatorId) => void;
  /** Bumps on every load/clear so a waveform tile repaints. */
  sampleVersion: number;
  /**
   * 'record' (default, Electron) = capture live audio from a picked source.
   * 'file' (the VST plugin, todo.md §114) = `onToggleRecord` opens a native
   * file picker instead — there's no live level/elapsed/source-picked
   * concept, so `hasSource` is ignored and the button never shows a
   * recording-in-progress state (a decode is effectively instant).
   */
  mode?: 'record' | 'file';
  /**
   * Plugin-only resample recording (todo.md §167 S1): records the synth's own
   * master output into this operator's sampler. Absent in the Electron app.
   * `resampleOp` = operator index being recorded (-1 idle), `resampleSec` its
   * elapsed seconds.
   */
  onResample?: (id: OperatorId, start: boolean) => void;
  /** Recording source for the sampler's Rec button: 0 = the synth's output (resample), 1 = audio input. */
  recSource?: 0 | 1;
  onRecSource?: (s: 0 | 1) => void;
  /** Open the standalone's audio device settings (choose the input device / un-mute it). */
  onAudioSettings?: () => void;
  resampleOp?: number;
  resampleSec?: number;
}

/**
 * Phase 1.7c oscillator panel — the multi-operator editor, Bitwig Phase-4
 * style (see PHASE4-SYNTH-REFERENCE.png + todo.md §22/§26).
 *
 * All five operators (OSC 1-4 + Sampler) render as compact cards
 * simultaneously — no tabs, no click-to-reveal. Every operator is visible
 * and editable at once, which is the whole point of a Phase-4-style
 * instrument: you should be able to see the whole patch — which operator
 * modulates which, at what depth, panned where — in one glance, never one
 * click away. This is also why the panel never scrolls internally: the
 * window has a raised minimum size (see `LAYOUT_MIN_SIZE.full`) that's
 * sized to fit this grid, the envelope/try-it side column and the piano
 * without clipping anything — making the window BIGGER (drag a corner)
 * gives more breathing room, but the floor is already a fully-visible
 * layout, so scrolling is never required.
 *
 * Each operator has a fixed identity colour (lib/operator-colors) that
 * stains its own card; an FM/PM knob is coloured by its SOURCE operator
 * instead, so you can see at a glance which operator modulates which.
 *
 * Everything talks through onChange to the parent (App.tsx writes back to
 * settings). This keeps the panel token-driven for styling and free of any
 * audio-engine state of its own — the engine is the source of truth.
 */
interface Props {
  settings: SynthSettings;
  onChange: (patch: Partial<SynthSettings>) => void;
  /** How many keys/lights are currently held — surfaced for the user. */
  /** Omit in the plugin: the count then reads the voice store itself (lib/voiceStore.ts),
   *  so voice changes do not re-render the whole panel. */
  activeVoices?: number;
  /** Last-held or last-known MIDI note, for the frequency readout. */
  lastNoteMidi: number | null;
  /** Sample-record plumbing for any oscillator in sample mode. */
  capture: OperatorCaptureContext;
  /** Owns the per-operator analyser taps for the dedicated visualizers. */
  engine: SynthEngine | null;
  theme: Theme;
  /** Optional override for each operator's visualizer box — e.g. the VST3
   *  plugin swaps in its own native-scope-backed component (todo.md §73 P7c).
   *  When omitted the built-in `<OperatorVisualizer>` (analyser-backed) renders. */
  renderVisualizer?: (id: OperatorId) => React.ReactNode;
}

// §41: the four classic shapes are now one continuous morph (a
// wavetable-position knob, 0..1 across WAVE_MORPH_SHAPES). 'sample' stays
// a separate discrete toggle — sample mode and wavetable position are
// mutually exclusive per operator, same as the old button picker.
// Short name shown inside the morph knob's readout (Pigments-style).
const WAVE_SHORT: Record<(typeof WAVE_MORPH_SHAPES)[number], string> = {
  sine: 'Sin',
  triangle: 'Tri',
  sawtooth: 'Saw',
  square: 'Sqr',
};

/** Nearest breakpoint's short name for a morph position — the knob readout. */
function waveShortAt(position: number): string {
  return WAVE_SHORT[waveShapeForPosition(position)];
}

// Oscilloscope + spectrogram — history (the recorder's rolling peak track)
// never exists in synth mode, so it always showed "Waiting for recording to
// start...".
const OSC_VIZ_MODES: { value: VisualizerMode; label: string; glyph: string }[] = [
  { value: 'oscilloscope', label: 'Oscilloscope', glyph: '∿' },
  { value: 'spectrogram', label: 'Spectrogram', glyph: '▦' },
];

/** Per-operator pitch dial range, in semitones — matches the global master
 *  octave range (±3 octaves = ±36 semitones; the master knobs themselves
 *  live in SynthHeader's top-left cluster now). */
const OP_PITCH_RANGE = { min: -3 * 12, max: 3 * 12 };

/** MIDI → Hz with engineer-friendly precision. */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const OSC_IDS: OperatorId[] = ['osc1', 'osc2', 'osc3', 'osc4'];

/** Produced by `bindMod(targetId)` — feeds `<ModBadge>` (dots) and a knob's
 *  `onModContext` (right-click → assign popover, todo.md §88.C). */
type ModBind = {
  targetId: ModTargetId;
  routes: ModRoute[];
  onModContext: (el: HTMLElement) => void;
};

const emptyVizModes: Record<OperatorId, VisualizerMode> = {
  osc1: 'oscilloscope',
  osc2: 'oscilloscope',
  osc3: 'oscilloscope',
  osc4: 'oscilloscope',
};

export function OscillatorPanel({
  settings,
  onChange,
  activeVoices,
  lastNoteMidi,
  capture,
  engine,
  theme,
  renderVisualizer,
}: Props) {
  const change = useCallback(
    (patch: Partial<SynthSettings>) => onChange(patch),
    [onChange],
  );

  // Each operator gets its own visualizer mode, independent of the others
  // and of the main board's mode (todo.md §22: toggle "just like the main
  // board", "independently").
  const [vizModes, setVizModes] = useState<Record<OperatorId, VisualizerMode>>(emptyVizModes);
  const setVizMode = useCallback(
    (id: OperatorId, mode: VisualizerMode) => setVizModes((prev) => ({ ...prev, [id]: mode })),
    [],
  );

  // ----- Pigments-style modulation popover (right-click a knob) ------------
  const [modOpen, setModOpen] = useState<ModTargetId | null>(null);
  const anchorRefs = useRef<Partial<Record<ModTargetId, HTMLElement | null>>>({});
  const bindMod = useCallback(
    (targetId: ModTargetId): ModBind => ({
      targetId,
      routes: settings.mod?.[targetId] ?? [],
      onModContext: (el: HTMLElement) => { anchorRefs.current[targetId] = el; setModOpen(targetId); },
    }),
    [settings.mod],
  );

  const lastHz = lastNoteMidi != null ? midiToHz(lastNoteMidi) : null;
  const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const lastLabel =
    lastNoteMidi != null
      ? `${PC[lastNoteMidi % 12]}${Math.floor(lastNoteMidi / 12) - 1}`
      : '—';

  const changeOscSlot = useCallback(
    (index: number, patch: Partial<OscillatorSlotSettings>) => {
      const next = settings.oscillators.slice();
      next[index] = { ...next[index], ...patch };
      onChange({ oscillators: next });
    },
    [onChange, settings.oscillators],
  );

  return (
    <section className="op-panel" aria-label="Oscillators">
      <header className="op-section-title">Oscillator engine</header>

      {/* ----- All four oscillators, always visible + editable, no tabs. */}
      <div className="op-grid">
        {OSC_IDS.map((id, idx) => (
          <OperatorCard
            key={id}
            id={id}
            slot={settings.oscillators[idx]}
            settings={settings}
            onChange={(patch) => changeOscSlot(idx, patch)}
            analyser={engine?.getOperatorAnalyser(id) ?? null}
            theme={theme}
            vizMode={vizModes[id]}
            onVizModeChange={(m) => setVizMode(id, m)}
            bindMod={bindMod}
            capture={capture}
            vizOverride={renderVisualizer ? renderVisualizer(id) : undefined}
          />
        ))}
      </div>

      {/* ----- Status row: voice counter + last note readout. */}
      <footer className="op-row op-row-status">
        <span className="op-status" title="Held notes">
          <em>{activeVoices ?? <LiveVoiceCount />}</em> / {settings.voiceLimit} voices
        </span>
        <span className="op-status" title="Last triggered note">
          Last note: <em>{lastLabel}</em>{lastHz != null && (
            <>
              {' '}
              <span className="op-status-hz">{lastHz.toFixed(1)} Hz</span>
            </>
          )}
        </span>
      </footer>

      {/* ----- Modulation popover (one at a time, Pigments-style) ----- */}
      {modOpen && (
        <ModPopover
          targetId={modOpen}
          routes={settings.mod?.[modOpen] ?? []}
          anchorEl={anchorRefs.current[modOpen] ?? null}
          onChange={(routes) =>
            change({ mod: { ...(settings.mod ?? {}), [modOpen]: routes } })
          }
          onClose={() => setModOpen(null)}
        />
      )}
    </section>
  );
}

/** One oscillator's compact card: enabled toggle, dedicated visualizer, wave, pitch, level/pan, FM/PM. In sample mode (`wave === 'sample'`) a bare Record toggle replaces the need for a dedicated sampler operator (todo.md §33). */
function OperatorCard({
  id,
  slot,
  settings,
  onChange,
  analyser,
  theme,
  vizMode,
  onVizModeChange,
  bindMod,
  capture,
  vizOverride,
}: {
  id: OperatorId;
  slot: OscillatorSlotSettings;
  settings: SynthSettings;
  onChange: (patch: Partial<OscillatorSlotSettings>) => void;
  analyser: AnalyserLike | null;
  theme: Theme;
  vizMode: VisualizerMode;
  onVizModeChange: (mode: VisualizerMode) => void;
  bindMod: (targetId: ModTargetId) => ModBind;
  capture: OperatorCaptureContext;
  vizOverride?: React.ReactNode;
}) {
  const color = OPERATOR_COLORS[id];
  const isSampler = slot.wave === 'sample';
  const userNames = useSyncExternalStore(subscribeUserWt, getUserWt);
  return (
    <div className="op-card" style={{ '--op-color': color } as React.CSSProperties}>
      <div className="op-card-head">
        <span className="op-name">{OPERATOR_LABELS[id]}</span>
        {/* Per-OSC source switch: wavetable engine or sampler (todo.md §167 S0). */}
        <div className="op-src-toggle" role="radiogroup" aria-label="Oscillator source">
          <button type="button" role="radio" aria-checked={!isSampler}
            className={!isSampler ? 'is-on' : ''} onClick={() => onChange({ wave: 'wavetable' })}
            title="Wavetable oscillator">WT</button>
          <button type="button" role="radio" aria-checked={isSampler}
            className={isSampler ? 'is-on' : ''} onClick={() => onChange({ wave: 'sample' })}
            title="Sampler — play a loaded audio file">SMP</button>
        </div>
      </div>

      {vizOverride !== undefined ? (
        <div className="op-viz-row">{vizOverride}</div>
      ) : (
        <OperatorVisualizer analyser={analyser} theme={theme} mode={vizMode} onModeChange={onVizModeChange} />
      )}

      {/* Row-stack card (the user's "OSC LAYOUT 3" mockup + its annotated
         instructions image — todo.md §146: "Two warp modes placed in
         between the PITCH and LEVEL knobs"):

            ┌ Pitch   Warp 1   Warp 2   Level ┐
            │      Wavetable · WT Pos         │
            │      PHASE MOD  Osc1..4         │
            │      FREQ MOD   Osc1..4         │
            └ A/B                        Pan  ┘

         Top and bottom rows are edge-justified (Pitch/Filter A-B at the
         card's left edge, Level/Pan at its right edge); everything between
         them is full-width and centred. Replaces the earlier 3-column
         layout (Pitch+FilterA/B / Warp+WT+PM+FM / Level+Pan stacked full
         height) — that put the warp blocks on their own row below Pitch/
         Level instead of beside them, which is what made the card taller
         than the mockup wants. */}
      <div className="op-body-new">
        {/* ----- Top row: Pitch | Warp 1 | Warp 2 | Level ----- */}
        <div className="op-card-top-row">
          <PitchDial
            value={slot.pitch}
            onChange={(pitch) => onChange({ pitch })}
            color={color}
            min={OP_PITCH_RANGE.min}
            max={OP_PITCH_RANGE.max}
            modTarget={`${id}Pitch`}
            modGlow={modGlowFor(`${id}Pitch`, settings.mod?.[`${id}Pitch`] ?? [])}
            modBadge={<ModBadge {...bindMod(`${id}Pitch`)} />}
            onModContext={bindMod(`${id}Pitch`).onModContext}
          />

          <div className="op-dual-warp-container">
            {/* Warp 1 Box */}
            <div className="op-warp-block">
              <select
                className="op-warp-select"
                value={slot.warpMode ?? 0}
                onChange={(e) => onChange({ warpMode: parseInt(e.target.value, 10) })}
                title="Warp 1 Mode"
              >
                {WARP_MODES.map((wm) => (
                  <option key={wm.id} value={wm.id}>
                    {wm.name}
                  </option>
                ))}
              </select>
              <div className="op-warp-knobs">
                <Knob
                  label="Warp Amt"
                  value={slot.warpAmount ?? 0}
                  min={0}
                  max={1}
                  onChange={(v) => onChange({ warpAmount: v })}
                  format={(v) => `${Math.round(v * 100)}`}
                  color="var(--op-color)"
                  size="sm"
                  modTarget={`${id}WarpAmt`}
                  modGlow={modGlowFor(`${id}WarpAmt`, settings.mod?.[`${id}WarpAmt`] ?? [])}
                  onModContext={bindMod(`${id}WarpAmt`).onModContext}
                  title="Warp 1 Amount"
                />
                {WARP_MODES.find(m => m.id === (slot.warpMode ?? 0))?.param2Name ? (
                  <Knob
                    label={WARP_MODES.find(m => m.id === (slot.warpMode ?? 0))?.param2Name!}
                    value={slot.warpParam2 ?? 0.5}
                    min={0}
                    max={1}
                    onChange={(v) => onChange({ warpParam2: v })}
                    format={(v) => `${Math.round(v * 100)}`}
                    color="var(--op-color)"
                    size="sm"
                    title={`${WARP_MODES.find(m => m.id === (slot.warpMode ?? 0))?.param2Name}`}
                  />
                ) : (
                  <div className="op-knob-placeholder" />
                )}
              </div>
            </div>

            <div className="op-warp-divider" />

            {/* Warp 2 Box */}
            <div className="op-warp-block">
              <select
                className="op-warp-select"
                value={slot.warpMode2 ?? 0}
                onChange={(e) => onChange({ warpMode2: parseInt(e.target.value, 10) })}
                title="Warp 2 Mode"
              >
                {WARP_MODES.map((wm) => (
                  <option key={wm.id} value={wm.id}>
                    {wm.name}
                  </option>
                ))}
              </select>
              <div className="op-warp-knobs">
                <Knob
                  label="Warp Amt"
                  value={slot.warpAmount2 ?? 0}
                  min={0}
                  max={1}
                  onChange={(v) => onChange({ warpAmount2: v })}
                  format={(v) => `${Math.round(v * 100)}`}
                  color="var(--op-color)"
                  size="sm"
                  modTarget={`${id}WarpAmt2`}
                  modGlow={modGlowFor(`${id}WarpAmt2`, settings.mod?.[`${id}WarpAmt2`] ?? [])}
                  onModContext={bindMod(`${id}WarpAmt2`).onModContext}
                  title="Warp 2 Amount"
                />
                {WARP_MODES.find(m => m.id === (slot.warpMode2 ?? 0))?.param2Name ? (
                  <Knob
                    label={WARP_MODES.find(m => m.id === (slot.warpMode2 ?? 0))?.param2Name!}
                    value={slot.warpParam2_2 ?? 0.5}
                    min={0}
                    max={1}
                    onChange={(v) => onChange({ warpParam2_2: v })}
                    format={(v) => `${Math.round(v * 100)}`}
                    color="var(--op-color)"
                    size="sm"
                    title={`${WARP_MODES.find(m => m.id === (slot.warpMode2 ?? 0))?.param2Name}`}
                  />
                ) : (
                  <div className="op-knob-placeholder" />
                )}
              </div>
            </div>
          </div>

          <LevelCell
            id={id}
            level={slot.level}
            onLevel={(level) => onChange({ level })}
            bindMod={bindMod}
            mod={settings.mod}
            color={color}
          />
        </div>
        {isSampler ? (
          <SamplerBlock id={id} slot={slot} capture={capture} onChange={onChange} />
        ) : (
          <>
        {/* ----- Wavetable Graphic ----- */}
        <WavetableGraphic
          id={id}
          slot={slot}
          settings={settings}
          height={48}
        />

        {/* ----- Wavetable select + scan position ----- */}
        <div className="op-wavetable-row">
          <select
            className="op-warp-select"
            value={slot.wtId ?? 0}
            onChange={(e) => onChange({ wave: 'wavetable', wtId: parseInt(e.target.value, 10) })}
            title="Select Wavetable"
          >
            {FILTERED_WAVETABLES.map((wt) => (
              <option key={wt.id} value={wt.id}>
                {wt.name}
              </option>
            ))}
            {userNames.length > 0 && (
              <optgroup label="User">
                {userNames.map((n, i) => (
                  <option key={USER_WT_BASE_ID + i} value={USER_WT_BASE_ID + i}>
                    {n}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            type="button"
            className="op-wt-folder"
            title="Open the wavetable folder — drop in your own .wav tables"
            aria-label="Open wavetable folder"
            onClick={() => (window as unknown as { __fazeOpenWavetableFolder?: () => void }).__fazeOpenWavetableFolder?.()}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="currentColor"/></svg>
          </button>
          <button
            type="button"
            className="op-wt-folder"
            title="Set library folder… — point the synth at your own wavetable library"
            aria-label="Set wavetable library folder"
            onClick={() => (window as unknown as { __fazeSetWavetableLibrary?: () => void }).__fazeSetWavetableLibrary?.()}
          >…</button>
          <button
            type="button"
            className="op-wt-folder"
            title="Rescan the wavetable folder"
            aria-label="Rescan wavetable folder"
            onClick={() => (window as unknown as { __fazeRescanWavetables?: () => void }).__fazeRescanWavetables?.()}
          >↻</button>
        </div>
        {(() => {
          const wtTarget: ModTargetId = `${id}WtPos`;
          const wtRoutes = settings.mod?.[wtTarget] ?? [];
          const wtGlow = modGlowFor(wtTarget, wtRoutes);
          const wtPos = slot.wtPos ?? 0;
          // Modulated reach of the scan position: bipolar sources (LFOs) swing ±amount,
          // unipolar ones (ENV, follower…) move one way by amount. Clamped to the 0..1 slider.
          let lo = wtPos; let hi = wtPos;
          for (const r of wtRoutes) {
            if (!r || !r.amount) continue;
            if (String(r.source).startsWith('lfo')) { lo -= Math.abs(r.amount); hi += Math.abs(r.amount); }
            else if (r.amount > 0) hi += r.amount;
            else lo += r.amount;
          }
          lo = Math.max(0, Math.min(1, lo)); hi = Math.max(0, Math.min(1, hi));
          return (
            <label
              className={`op-wtpos-row ${wtGlow ? 'is-modded' : ''}`}
              title="Wavetable Scan Position — drop an ENV/LFO here to modulate it · right-click to edit routes"
              data-mod-target={wtTarget}
              onContextMenu={(e) => { e.preventDefault(); bindMod(wtTarget).onModContext(e.currentTarget as HTMLElement); }}
              style={{
                '--mod-glow': wtGlow?.color ?? 'transparent',
                '--mod-glow-amt': wtGlow?.amount ?? 0,
              } as React.CSSProperties}
            >
              <span className="op-wtpos-lbl">WT Pos</span>
              <span className="op-wtpos-track">
                <input
                  type="range" className="op-wtpos-slider" min={0} max={1} step={0.001}
                  value={wtPos}
                  onChange={(e) => onChange({ wave: 'wavetable', wtPos: parseFloat(e.target.value) })}
                />
                {wtGlow && hi > lo && (
                  <span className="op-wtpos-range" aria-hidden="true"
                    style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />
                )}
              </span>
              <span className="op-wtpos-val">{wtPos.toFixed(2)}</span>
              <ModBadge {...bindMod(wtTarget)} />
            </label>
          );
        })()}

          </>
        )}

        {/* ----- Filter A/B | Pan row (moved ABOVE the PM/FM knobs; the card no longer has a bottom row) ----- */}
                <div className="op-card-bot-row">
                  {/* SS153 (user): "notice how the text Filter A/B is below the knob
                      but PAN is written above it? Need to make Filter A/B written
                      above the knob since having the text below it displaces the
                      knob itself."
                      PanCell already works this way — its own `.op-knob-label` caps
                      header sits ABOVE the knob, and
                      `.op-panel .knob-field:has(.op-knob-label) .knob-label
                      {display:none}` hides the Knob's own duplicate label below.
                      Filter A/B was a bare `<Knob>`, so it kept the default
                      ring/value/label stack and its label rendered underneath. That
                      label is not cosmetic here: it pushes the 44px knob up, so the
                      two knobs in this row sit at different heights. Wrapping it in
                      the same `.knob-field` + `.op-knob-label` structure PanCell uses
                      puts the label above, lets the :has() rule suppress the
                      duplicate, and lines the two knobs up on one baseline. */}
                  <div className="knob-field">
                    <label className="op-knob-label">
                      <span>Filter A/B</span>
                      <span className="op-knob-right">
                        <ModBadge {...bindMod(`${id}FilterMix`)} />
                      </span>
                    </label>
                    <Knob
                      label="Filter A/B"
                      value={slot.filterMix}
                      min={0}
                      max={1}
                      onChange={(filterMix) => onChange({ filterMix })}
                      format={(v) => (v <= 0 ? 'A' : v >= 1 ? 'B' : `${Math.round((1 - v) * 100)}/${Math.round(v * 100)}`)}
                      color="var(--op-color)"
                      size="lg"
                      modTarget={`${id}FilterMix`}
                      modGlow={modGlowFor(`${id}FilterMix`, settings.mod?.[`${id}FilterMix`] ?? [])}
                      onModContext={bindMod(`${id}FilterMix`).onModContext}
                      title="Filter A/B crossfade"
                    />
                  </div>

          <PanCell
            id={id}
            pan={slot.pan}
            onPan={(pan) => onChange({ pan })}
            bindMod={bindMod}
            mod={settings.mod}
          />
        </div>
        {/* ----- PHASE MOD / FREQ MOD clusters ----- */}
        <ModCluster id={id} kind="pm" mods={slot.mods} settings={settings} onChange={onChange} bindMod={bindMod} />
        <div className="op-mod-spacer" />
        <ModCluster id={id} kind="fm" mods={slot.mods} settings={settings} onChange={onChange} bindMod={bindMod} />

      </div>
    </div>
  );
}

/** Bare Record toggle for an oscillator in sample mode — no backend/source
 *  picker here (that lives in Settings now), just start/stop + a one-line
 *  status. Only one oscillator can record at a time (one MediaRecorder). */
function SampleRecordRow({
  id, capture, slot, onChange,
}: {
  id: OperatorId;
  capture: OperatorCaptureContext;
  slot: OscillatorSlotSettings;
  onChange: (patch: Partial<OscillatorSlotSettings>) => void;
}) {
  const isFile = capture.mode === 'file';
  const isRecording = !isFile && capture.recordingId === id;
  const isBusy = capture.recordingId != null && capture.recordingId !== id;
  const duration = capture.sampleDuration(id);
  const hasBuffer = duration > 0;
  const disabled = isBusy || (!isFile && !isRecording && !capture.hasSource);
  const title = isFile
    ? (isBusy ? 'Another oscillator is loading a file' : 'Load a sample from disk')
    : !capture.hasSource && !isRecording
      ? 'Pick a capture source in Settings first'
      : isBusy
        ? 'Another oscillator is already recording'
        : isRecording
          ? 'Stop & load sample'
          : 'Record what I hear';
  return (
    <div className="op-row op-row-record">
      <button
        type="button"
        className={`op-record-btn ${isRecording ? 'is-rec' : ''}`}
        onClick={() => capture.onToggleRecord(id)}
        disabled={disabled}
        aria-pressed={isRecording}
        title={title}
      >
        <span className="op-record-glyph" aria-hidden="true">{isRecording ? '■' : isFile ? '📁' : '●'}</span>
        <span>
          {isRecording
            ? `Recording ${capture.elapsed.toFixed(1)}s`
            : hasBuffer
              ? `Loaded ${duration.toFixed(2)}s`
              : isFile ? 'Browse…' : 'Record'}
        </span>
      </button>
      {hasBuffer && !isRecording && (
        <>
          {/* Loop/Reverse (Task 6, sampler upgrade) — deliberately just two
              icon toggles, same footprint as the clear button, not a whole
              new control row: this card has no room to spare (Task 1). Start/
              end trim points are fully wired DSP/native/translate-side
              (sampleStart/sampleEnd) but want a waveform+drag-handle editor
              to be usable, not a bare knob — left for a follow-up UI pass. */}
          <button
            type="button"
            className={`op-record-clear ${slot.sampleLoop ? 'is-on' : ''}`}
            onClick={() => onChange({ sampleLoop: !slot.sampleLoop })}
            aria-pressed={!!slot.sampleLoop}
            title={slot.sampleLoop ? 'Loop: on (sustains while held)' : 'Loop: off (plays once)'}
            aria-label="Toggle sample loop"
          >
            ∞
          </button>
          <button
            type="button"
            className={`op-record-clear ${slot.sampleReverse ? 'is-on' : ''}`}
            onClick={() => onChange({ sampleReverse: !slot.sampleReverse })}
            aria-pressed={!!slot.sampleReverse}
            title={slot.sampleReverse ? 'Reverse: on (plays backward)' : 'Reverse: off'}
            aria-label="Toggle sample reverse"
          >
            ◄
          </button>
          <button
            type="button"
            className="op-record-clear"
            onClick={() => capture.clearSampleBuffer(id)}
            title="Clear sample"
            aria-label="Clear sample"
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}

/** Dedicated per-operator live visualizer + its own mode chip row — the same `VisualizerBoard` the main board uses, fed by that operator's persistent analyser tap (see `SynthEngine.getOperatorAnalyser`). */
function OperatorVisualizer({
  analyser,
  theme,
  mode,
  onModeChange,
  modes = OSC_VIZ_MODES,
  samplePeaks = null,
}: {
  analyser: AnalyserLike | null;
  theme: Theme;
  mode: VisualizerMode;
  onModeChange: (mode: VisualizerMode) => void;
  modes?: { value: VisualizerMode; label: string; glyph: string }[];
  samplePeaks?: Float32Array | null;
}) {
  return (
    <div className="op-viz-row">
      <div className="op-viz">
        <VisualizerBoard analyser={analyser} mode={mode} theme={theme} idleText="silent" samplePeaks={samplePeaks} />
      </div>
      <div className="sh-viz op-viz-modes" role="radiogroup" aria-label="Visualizer mode">
        {modes.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={mode === m.value}
            className={`sh-viz-btn ${mode === m.value ? 'is-on' : ''}`}
            title={m.label}
            onClick={() => onModeChange(m.value)}
          >
            <span aria-hidden="true">{m.glyph}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Level knob cell (compact card row A, right). */
function LevelCell({
  id,
  level,
  onLevel,
  bindMod,
  mod,
  color,
}: {
  id: OperatorId;
  level: number;
  onLevel: (level: number) => void;
  bindMod: (targetId: ModTargetId) => ModBind;
  mod: ModMap;
  color: string;
}) {
  return (
    <div className="knob-field">
      <label className="op-knob-label">
        <span>Level</span>
        <span className="op-knob-right"><ModBadge {...bindMod(`${id}Level`)} /></span>
      </label>
      <Knob
        label="Level"
        value={level}
        min={0}
        max={1}
        onChange={onLevel}
        format={(v) => `${Math.round(v * 100)}`}
        color={color}
        size="lg"
        modTarget={`${id}Level`}
        modGlow={modGlowFor(`${id}Level`, mod?.[`${id}Level`] ?? [])}
        onModContext={bindMod(`${id}Level`).onModContext}
      />
    </div>
  );
}

/** Pan knob cell (compact card row B, right). */
function PanCell({
  id,
  pan,
  onPan,
  bindMod,
  mod,
}: {
  id: OperatorId;
  pan: number;
  onPan: (pan: number) => void;
  bindMod: (targetId: ModTargetId) => ModBind;
  mod: ModMap;
}) {
  const panFormat = (v: number) =>
    v === 0 ? 'C' : v < 0 ? `L${Math.round(Math.abs(v) * 100)}` : `R${Math.round(v * 100)}`;
  return (
    <div className="knob-field">
      <label className="op-knob-label">
        <span>Pan</span>
        <span className="op-knob-right"><ModBadge {...bindMod(`${id}Pan`)} /></span>
      </label>
      <Knob
        label="Pan"
        value={pan}
        min={-1}
        max={1}
        onChange={onPan}
        format={panFormat}
        color="var(--accent)"
        size="lg"
        centerDetent
        modTarget={`${id}Pan`}
        modGlow={modGlowFor(`${id}Pan`, mod?.[`${id}Pan`] ?? [])}
        onModContext={bindMod(`${id}Pan`).onModContext}
      />
    </div>
  );
}

/**
 * Phase-4 style modulation cluster: one compact row of colour-coded knobs,
 * one per SOURCE operator — including OSC 1 modulating ITSELF (self-
 * feedback, legal since the engine inserts a one-block DelayNode into
 * cyclic edges). Each knob is tinted with the SOURCE operator's colour, so
 * you can see at a glance who modulates whom; several sources may modulate
 * one operator simultaneously and dragging a knob to zero disconnects it.
 * Every knob is itself a Pigments mod target: drag an ENV/LFO onto it to
 * modulate THAT knob's depth, with the source-colour glow + ∿ popover.
 */
function ModCluster({
  id,
  kind,
  mods,
  settings,
  onChange,
  bindMod,
}: {
  id: OperatorId;
  kind: 'pm' | 'fm';
  mods: OperatorModMap;
  settings: SynthSettings;
  onChange: (patch: { mods: OperatorModMap }) => void;
  bindMod: (targetId: ModTargetId) => ModBind;
}) {
  const setDepth = (source: OperatorId, amount: number) => {
    const next: OperatorModMap = { ...mods };
    const cur: OperatorModEntry = mods[source] ?? { pm: 0, fm: 0 };
    const entry: OperatorModEntry = { pm: kind === 'pm' ? amount : cur.pm, fm: kind === 'fm' ? amount : cur.fm };
    if (entry.pm > 0 || entry.fm > 0) next[source] = entry;
    else delete next[source];
    onChange({ mods: next });
  };
  const depth = (source: OperatorId) => mods[source]?.[kind] ?? 0;
  // Every knob is its own mod target (todo.md §95/§106) — `${id}Pm${src}` /
  // `${id}Fm${src}`, INCLUDING the self pair (src === id) — so a
  // cable/right-click on ONE knob only modulates THAT knob's depth, never
  // its siblings. The self pair's target is real for UI purposes but
  // audibly inert: the audio-rate engine can't yet make an operator
  // modulate itself (see dsp/synth.js's MOD_TARGETS comment), so a route
  // stored there just doesn't reach a signal yet.
  const depthTarget = `${id}ModAmount` as ModTargetId;
  const depthRoutes = settings.mod?.[depthTarget] ?? [];
  const depthGlow = modGlowFor(depthTarget, depthRoutes);
  return (
      <div className={`op-mod-cluster op-mod-cluster--${kind}`}>
        {/* One shared row of source-colour dots instead of an "Osc N" text
            label under every knob (todo.md §88.D — the labels were repeated
            identically under PHASE MOD and FREQ MOD). Only on the PM row. */}
        <div className="op-mod-cluster-heads" aria-hidden="true">
          {OPERATOR_IDS.map((src) => (
            <span key={src} style={{ background: OPERATOR_COLORS[src] }} />
          ))}
        </div>
        <div className="op-mod-cluster-knobs">
          {OPERATOR_IDS.map((src) => {
            const isSelf = src === id;
            const pairTarget = `${id}${kind === 'pm' ? 'Pm' : 'Fm'}${src}` as ModTargetId;
            const pairRoutes = settings.mod?.[pairTarget] ?? [];
            const pairGlow = modGlowFor(pairTarget, pairRoutes);
            return (
              <div className={`op-mod-cluster-knob ${isSelf ? 'is-self' : ''}`} key={`${kind}-${src}`}>
                <Knob
                  label={`${kind === 'pm' ? 'PM' : 'FM'} ${OPERATOR_LABELS[src]}`}
                  value={depth(src)}
                  min={0}
                  max={1}
                  onChange={(v) => setDepth(src, v)}
                  format={(v) => `${Math.round(v * 100)}`}
                  color={OPERATOR_COLORS[src]}
                  size="md"
                  modTarget={pairTarget}
                  modGlow={pairGlow}
                  onModContext={bindMod(pairTarget).onModContext}
                  title={`${kind === 'pm' ? 'Phase' : 'Frequency'} modulation from ${OPERATOR_LABELS[src]}${isSelf ? ' (self-feedback)' : ''}`}
                />
              </div>
            );
          })}
        </div>
        {/* SS155 (user, in one message, three asks): "Move FM knobs slightly
                    closer to PM knobs. make FM and PM knobs bigger you can move the
                    text 'Freq Mod' UNDERNEITH the FM knobs".
                    The caption renders last in the DOM for both clusters; CSS then
                    sends PM's back ABOVE its knobs via `order: -1`
                    (`.op-mod-cluster--pm`) and leaves FM's underneath, which is what
                    he asked for and what actually pulls the FM row up towards PM.

                    Tried it the other way first -- BOTH captions below, on the theory
                    that two knob rows at different heights looked untidy. Measured:
                    that made the PM-to-FM knob gap go 14px -> 29px, i.e. the exact
                    opposite of "closer", because PM's caption ended up sitting in the
                    gap between the two clusters. The rows never needed to line up:
                    each knob's own label travels with its knob, and PM/FM are two
                    separate rows, so there is no shared baseline to preserve.
                    Left as a class hook so either side can be flipped in CSS alone. */}
                <span
                  className="op-mod-cluster-lbl"
                  title="Right-click to modulate this operator's overall PM/FM depth"
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); bindMod(`${id}ModAmount`).onModContext(e.currentTarget as HTMLElement); }}
                >
          {kind === 'pm' ? 'Phase mod' : 'Freq mod'}
          <ModBadge {...bindMod(`${id}ModAmount`)} />
        </span>
      </div>
    );
}


