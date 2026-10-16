import { useRef, useState } from 'react';
import type { AppSettings, ModTargetId, SynthSettings, Theme, VisualizerMode } from '../../shared/types';
import { modGlowFor } from '../lib/mod-sources';
import { Knob } from './Knob';
import { ModBadge, ModPopover } from './ModPopover';
import { PresetBar } from './PresetBar';

interface Props {
  settings: AppSettings;
  /** Last triggered note (for the readout) — null when nothing is held. */
  lastNoteMidi: number | null;
  /** Active voice count, fed by useSynth. */
  activeVoices: number;
  onChange: (patch: Partial<AppSettings>) => Promise<AppSettings> | void;
  /** All notes off (panic) — moved here from the modulator strip's old title bar. */
  onPanic: () => void;
  activeViewTab?: 'synth' | 'fx';
  onJumpToSynth?: () => void;
  onJumpToFx?: () => void;
}

// Main board: oscilloscope / spectrum / spectrogram. History is recorder-only
// (its peak track never existed in synth mode, so it always showed "Waiting
// for recording to start...") — removed from the main board; the sampler
// operator keeps it as its sample-overview view.
const VIZ_MODES: { value: VisualizerMode; label: string; glyph: string }[] = [
  { value: 'oscilloscope', label: 'Oscilloscope', glyph: '∿' },
  { value: 'spectrum', label: 'Spectrum', glyph: '▥' },
  { value: 'spectrogram', label: 'Spectrogram', glyph: '▦' },
];

const THEMES: { value: Theme; label: string }[] = [
  { value: 'black-ice', label: 'Black ice' },
  { value: 'aurora-ice', label: 'Aurora ice' },
  { value: 'graphite', label: 'Graphite' },
];

const OCTAVE_RANGE = { min: -3, max: 3 };
const SEMITONE_RANGE = { min: -12, max: 12 };

/**
 * Sub-header for synth mode.
 *
 * Sits between the window chrome and the visualiser. The whole-synth master
 * knobs (octave / semitone / fine / voice level / master level) live here in
 * the top-left corner, grouped together — they used to sit at the top of the
 * oscillator panel, mid-screen, which split the "controls for the whole
 * instrument" from the per-operator cards. The header is now:
 *
 *  [ master knobs ]  [ status · voices · last · presets ]  [ viz · theme ]
 *
 * The master knobs write straight into `settings.synth`, so the engine picks
 * them up through the same pipeline as everything else.
 */
export function SynthHeader({ settings, lastNoteMidi, activeVoices, onChange, onPanic }: Props) {
  const synth = settings.synth;
  const changeSynth = (patch: Partial<SynthSettings>) =>
    onChange({ synth: { ...synth, ...patch } });

  // ----- Pigments-style modulation state for the two global targets -----
  // (Fine → `pitch`, Voice → `oscLevel`). The per-operator cards own their
  // own popover state inside OscillatorPanel; these two live here because
  // the knobs they badge now live here.
  const [modOpen, setModOpen] = useState<ModTargetId | null>(null);
  const anchorRefs = useRef<Partial<Record<ModTargetId, HTMLButtonElement | null>>>({});
  const toggleMod = (t: ModTargetId) => setModOpen((m) => (m === t ? null : t));
  const glow = (targetId: ModTargetId) => modGlowFor(targetId, synth.mod?.[targetId] ?? []);

  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

  return (
    <div className="sh-bar" role="toolbar" aria-label="Synth controls">
      {/* ----- Master controls: whole-synth knobs, grouped top-left. ----- */}
      <div className="sh-left">
        <div className="sh-master" role="group" aria-label="Master controls">
          <div className="knob-field">
            <label className="op-knob-label">Octave</label>
            <Knob
              label="Octave"
              value={synth.octave}
              min={OCTAVE_RANGE.min}
              max={OCTAVE_RANGE.max}
              onChange={(v) => changeSynth({ octave: clamp(Math.round(v), OCTAVE_RANGE.min, OCTAVE_RANGE.max) })}
              format={(v) => (v > 0 ? '+' : '') + Math.round(v)}
              color="var(--accent)"
              size="md"
              centerDetent
            />
          </div>
          <div className="knob-field">
            <label className="op-knob-label">Semitone</label>
            <Knob
              label="Semitone"
              value={synth.semitone}
              min={SEMITONE_RANGE.min}
              max={SEMITONE_RANGE.max}
              onChange={(v) => changeSynth({ semitone: clamp(Math.round(v), SEMITONE_RANGE.min, SEMITONE_RANGE.max) })}
              format={(v) => (v > 0 ? '+' : '') + Math.round(v)}
              color="var(--accent)"
              size="md"
              centerDetent
            />
          </div>
          <div className="knob-field">
            <label className="op-knob-label">
              <span>Fine</span>
              <span className="op-knob-right">
                <span className="op-knob-val">{synth.fineTuneCents > 0 ? `+${synth.fineTuneCents}` : synth.fineTuneCents} ¢</span>
                <ModBadge
                  targetId="pitch"
                  routes={synth.mod?.pitch ?? []}
                  isOpen={modOpen === 'pitch'}
                  onClick={() => toggleMod('pitch')}
                  buttonRef={(el) => { anchorRefs.current.pitch = el; }}
                />
              </span>
            </label>
            <Knob
              label="Fine"
              value={synth.fineTuneCents}
              min={-100}
              max={100}
              onChange={(v) => changeSynth({ fineTuneCents: Math.round(v) })}
              format={(v) => (v > 0 ? '+' : '') + Math.round(v)}
              color="var(--accent)"
              size="md"
              centerDetent
              modTarget="pitch"
              modGlow={glow('pitch')}
            />
          </div>
          <div className="knob-field">
            <label className="op-knob-label">
              <span>Voice</span>
              <span className="op-knob-right">
                <span className="op-knob-val">{Math.round(synth.voiceLevel * 100)}</span>
                <ModBadge
                  targetId="oscLevel"
                  routes={synth.mod?.oscLevel ?? []}
                  isOpen={modOpen === 'oscLevel'}
                  onClick={() => toggleMod('oscLevel')}
                  buttonRef={(el) => { anchorRefs.current.oscLevel = el; }}
                />
              </span>
            </label>
            <Knob
              label="Voice"
              value={synth.voiceLevel}
              min={0}
              max={1}
              onChange={(v) => changeSynth({ voiceLevel: v })}
              format={(v) => `${Math.round(v * 100)}`}
              color="var(--accent)"
              size="md"
              modTarget="oscLevel"
              modGlow={glow('oscLevel')}
            />
          </div>
          <div className="knob-field">
            <label className="op-knob-label">
              <span>Master</span>
              <span className="op-knob-val">{Math.round(synth.masterLevel * 100)}</span>
            </label>
            <Knob
              label="Master"
              value={synth.masterLevel}
              min={0}
              max={1}
              onChange={(v) => changeSynth({ masterLevel: v })}
              format={(v) => `${Math.round(v * 100)}`}
              color="var(--accent)"
              size="md"
            />
          </div>
        </div>
      </div>

      {/* ----- Status + presets, centered. ----- */}
      <div className="sh-center">
        <div className="sh-tab-group" role="tablist">
          <button
            type="button"
            className={`sh-tab-btn ${activeViewTab !== 'fx' ? 'is-on' : ''}`}
            onClick={onJumpToSynth}
            title="View Oscillators & Synth engine"
          >
            SYNTH
          </button>
          <button
            type="button"
            className={`sh-tab-btn ${activeViewTab === 'fx' ? 'is-on' : ''}`}
            onClick={onJumpToFx}
            title="View Envelopes, Filters & FX Chain"
          >
            FX &amp; ENVS
          </button>
        </div>
        <span className="sh-meta">
          <em>{activeVoices}</em>
          <span className="sh-meta-lbl">voices</span>
        </span>
        <button
          type="button"
          className="synth-panic"
          onClick={onPanic}
          disabled={activeVoices === 0}
          title="All notes off (panic)"
          aria-label="All notes off (panic)"
        >
          ⏹
        </button>
        {lastNoteMidi != null && (
          <span className="sh-meta" title="Last note">
            <em>{noteLabel(lastNoteMidi)}</em>
            <span className="sh-meta-lbl">last</span>
          </span>
        )}
        <span className="sh-divider" aria-hidden="true" />
        <PresetBar synth={synth} onChange={onChange} />
      </div>

      <div className="sh-right">
        <div className="sh-viz" role="radiogroup" aria-label="Visualizer mode">
          {VIZ_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={`sh-viz-btn ${settings.visualizer === m.value ? 'is-on' : ''}`}
              role="radio"
              aria-checked={settings.visualizer === m.value}
              title={m.label}
              onClick={() => void onChange({ visualizer: m.value })}
            >
              <span aria-hidden="true">{m.glyph}</span>
            </button>
          ))}
        </div>
        <label className="sh-theme" title="Theme">
          <span className="sh-theme-lbl">Theme</span>
          <select
            value={settings.theme}
            onChange={(e) => void onChange({ theme: e.target.value as Theme })}
          >
            {THEMES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>
      </div>

      {/* ----- Modulation popover for the global master targets ----- */}
      {modOpen && (
        <ModPopover
          targetId={modOpen}
          routes={synth.mod?.[modOpen] ?? []}
          anchorEl={anchorRefs.current[modOpen] ?? null}
          onChange={(routes) =>
            changeSynth({ mod: { ...(synth.mod ?? {}), [modOpen]: routes } })
          }
          onClose={() => setModOpen(null)}
        />
      )}
    </div>
  );
}

function noteLabel(midi: number): string {
  const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${PC[midi % 12]}${Math.floor(midi / 12) - 1}`;
}
