import { SCALES, type ScaleId } from './scales';
// Shared types between main and renderer processes.
// Single source of truth so the IPC contract stays in sync.

export type Theme = 'black-ice' | 'aurora-ice' | 'graphite';
export type VisualizerMode = 'oscilloscope' | 'spectrum' | 'spectrogram' | 'history';
export type RecordMode = 'rolling' | 'traditional';
/**
 * Where audio comes from:
 *   - 'desktop'   = pick a screen/window from Electron desktopCapturer
 *   - 'loopback'  = per-output WASAPI loopback via the bundled NAudio helper
 */
export type CaptureBackend = 'desktop' | 'loopback';

/**
 * The waveform choices every `OscillatorSlotSettings` picks from.
 * `'sample'` (Phase 1.11 — todo.md §33) turns that oscillator into a
 * sampler: instead of a generated waveform it plays back whatever's been
 * recorded into its own buffer (see `SynthEngine.setSampleBuffer`), pitched
 * off `OscillatorSlotSettings.rootHz`. There's no separate dedicated
 * sampler operator any more — any of the 4 oscillators can be one.
 * `'wavetable'` (Task 4, multi-agent work order) is a REAL multi-frame
 * wavetable oscillator — plugin-engine only (dsp/synth.js wave===5,
 * dsp/wavetables.js) — distinct from the `wavetablePosition` knob below,
 * which just morphs the 4 fixed shapes and predates this. Old-Electron-
 * renderer code (`lib/synth.ts`) never constructs or handles this value;
 * it's inert there, same as any other value it doesn't switch on.
 */
export type OscWave = 'sine' | 'triangle' | 'sawtooth' | 'square' | 'sample' | 'wavetable';

/** @deprecated alias for `OscWave` — the two unified in Phase 1.11 once the dedicated sampler operator went away. Kept so old imports don't break. */
export type Wave = OscWave;

/**
 * Shape order the wavetable-position knob morphs across (todo.md §41) —
 * `wavetablePosition` 0..1 maps onto this array's index range. Shared
 * between `synth.ts` (builds the interpolated `PeriodicWave`) and
 * `OscillatorPanel.tsx` (the knob's glyph/label at each breakpoint).
 */
export const WAVE_MORPH_SHAPES = ['sine', 'triangle', 'sawtooth', 'square'] as const;

/** The `wavetablePosition` a legacy discrete `OscWave` corresponds to — used for settings migration and the default slots (keeps existing patches sounding the same after §41). */
export function wavePositionForShape(wave: OscWave): number {
  const i = WAVE_MORPH_SHAPES.indexOf(wave as (typeof WAVE_MORPH_SHAPES)[number]);
  return i < 0 ? 0 : i / (WAVE_MORPH_SHAPES.length - 1);
}

/**
 * The discrete shape nearest a `wavetablePosition` value (0..1) — the
 * inverse of `wavePositionForShape`. The engine only reads `wave` to test
 * `=== 'sample'`, so the UI uses this to keep the stored `wave` field in
 * sync with the morph knob (normalization round-trips and the preset
 * browser's one-line summary both read `wave`, and a stale 'sine' while
 * the position knob sits at 0.8 would read wrong).
 */
export function waveShapeForPosition(position: number): (typeof WAVE_MORPH_SHAPES)[number] {
  const i = Math.round(Math.max(0, Math.min(1, position)) * (WAVE_MORPH_SHAPES.length - 1));
  return WAVE_MORPH_SHAPES[i];
}

/** A breakpoint in a Pigments-style Function generator. `time` is normalized 0..1, `level` is bipolar -1..1, and `curve` warps the segment starting at this point (-1 = fast→slow, +1 = slow→fast). */
export interface FunctionPoint {
  time: number;
  level: number;
  curve: number;
}

/** Hard cap on a `FunctionShape`'s point count — MUST match dsp/synth.js's
 *  `functionSignal` slice (kept as a literal there rather than an import;
 *  see that file's comment). Sized for the step/ramp paint tools' worst
 *  case: 32 grid columns (the editor's own max) at the Ctrl+Alt "half as
 *  long" double resolution × 2 points/column = 128. */
export const MAX_FUNCTION_POINTS = 128;

/** Shared breakpoint shape used by LFOs and (later) envelopes. Up to
 *  `MAX_FUNCTION_POINTS` points are supported. */
export interface FunctionShape {
  points: FunctionPoint[];
  /** One-shot draw-tool hint; evaluation always loops for LFOs. */
  drawMode?: 'edit' | 'line' | 'ramp' | 'saw';
  bipolar?: boolean;
  /** Editor grid line counts, time (X) and level (Y) axes independently —
   *  purely a drawing/snapping aid, never read by the audio path. 1..32,
   *  default 8 either way (todo.md — user: "cap at 32 for now", "default
   *  the grid at like 8x8"). */
  gridX?: number;
  gridY?: number;
}

/**
 * LFO waveform. The first four are `OscillatorNode.type` shapes;
 * `'sample-hold'` is a random stepped signal — a looping buffer of held
 * random values stepped at the LFO's rate — not a periodic oscillator.
 * `'function'` is the editable Pigments-style breakpoint generator.
 */
export type LfoWave = 'sine' | 'triangle' | 'sawtooth' | 'square' | 'sample-hold' | 'function';

export const DEFAULT_FUNCTION_SHAPE: FunctionShape = {
  points: [
    { time: 0, level: 0, curve: 0 },
    { time: 0.5, level: 1, curve: 0 },
    { time: 1, level: 0, curve: 0 },
  ],
  drawMode: 'edit',
  bipolar: false,
  gridX: 8,
  gridY: 8,
};

function clampGrid(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(32, Math.round(v))) : fallback;
}

/** Keep function points finite, ordered, and bounded without mutating the input. */
export function normalizeFunctionShape(value: unknown, fallback: FunctionShape = DEFAULT_FUNCTION_SHAPE): FunctionShape {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const points = Array.isArray(raw.points) ? raw.points : fallback.points;
  const normalized = points
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .slice(0, MAX_FUNCTION_POINTS)
    .map((p, index) => {
      const num = (v: unknown, d: number) => typeof v === 'number' && Number.isFinite(v) ? v : d;
      return {
        time: Math.max(0, Math.min(1, num(p.time, index / Math.max(1, points.length - 1)))),
        level: Math.max(-1, Math.min(1, num(p.level, 0))),
        curve: Math.max(-1, Math.min(1, num(p.curve, 0))),
      };
    })
    .sort((a, b) => a.time - b.time);
  const usable = normalized.length >= 2 ? normalized : fallback.points.map((p) => ({ ...p }));
  if (usable[0].time > 0) usable.unshift({ ...usable[0], time: 0 });
  if (usable[usable.length - 1].time < 1) usable.push({ ...usable[usable.length - 1], time: 1 });
  return {
    points: usable.slice(0, MAX_FUNCTION_POINTS),
    drawMode: raw.drawMode === 'line' || raw.drawMode === 'ramp' || raw.drawMode === 'saw' ? raw.drawMode : 'edit',
    // A stored shape that predates the field was bipolar; only a brand-new LFO (no
    // points) takes the fallback's polarity (unipolar by default).
    bipolar: typeof raw.bipolar === 'boolean' ? raw.bipolar : Array.isArray(raw.points) ? true : fallback.bipolar !== false,
    gridX: clampGrid(raw.gridX, fallback.gridX ?? 8),
    gridY: clampGrid(raw.gridY, fallback.gridY ?? 8),
  };
}

/** Evaluate a normalized breakpoint shape at phase 0..1. Curves use the same power convention as ADSR. */
export function evaluateFunctionShape(shape: FunctionShape, phase: number): number {
  const points = normalizeFunctionShape(shape).points;
  const x = ((phase % 1) + 1) % 1;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (x <= b.time || i === points.length - 2) {
      const span = Math.max(1e-6, b.time - a.time);
      const t = Math.max(0, Math.min(1, (x - a.time) / span));
      const power = Math.pow(2, Math.max(-1, Math.min(1, a.curve)) * 4);
      const shaped = Math.pow(t, power);
      const value = a.level + (b.level - a.level) * shaped;
      return value; // SS164: final-segment value; unipolar range-normalisation happens below
    }
  }
  // SS164: same range-relative fix as dsp/synth.js functionSignal — this
    // mirror of the curve assumed bipolar -1..1 levels, but DEFAULT_FUNCTION_
    // SHAPE authors 0..1, so a unipolar shape was squashed into the top half.
      // Normalising against the shape's own min/max keeps both conventions using
      // their full span, and keeps the two implementations in agreement. Like the
      // DSP version, the result is the FULL 0..1 range -- no ±0.5 recentring, which
      // would halve the travel in the other direction.
      if (shape?.bipolar === false) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const p of points) {
          const l = p.level || 0;
          if (l < lo) lo = l;
          if (l > hi) hi = l;
        }
        const span = hi - lo;
        if (span > 1e-6) return points[points.length - 1].level / span;
      }
      return points[points.length - 1].level;
}

/** Default-function copy for callers that need an independent editable value. */
export function defaultFunctionShape(): FunctionShape {
  return normalizeFunctionShape(DEFAULT_FUNCTION_SHAPE);
}

/**
 * Exact breakpoint reproduction of one of the legacy discrete LFO shapes
 * (sine/triangle/sawtooth/square) — used to migrate old presets once the LFO
 * editor dropped its separate continuous-morph UI in favor of "every LFO is
 * a Function" (see `normalizeLfo`). Triangle/sawtooth/square are exact
 * (straight-line segments only); sine is a 33-point sampling since it has no
 * exact breakpoint form — dense enough to read smoothly in the editor and on
 * the live graph.
 */
export function functionShapeForLegacyWave(wave: 'sine' | 'triangle' | 'sawtooth' | 'square'): FunctionShape {
  switch (wave) {
    case 'triangle':
      return {
        points: [
          { time: 0, level: 0, curve: 0 },
          { time: 0.25, level: 1, curve: 0 },
          { time: 0.75, level: -1, curve: 0 },
          { time: 1, level: 0, curve: 0 },
        ],
        drawMode: 'edit',
        bipolar: true,
      };
    case 'sawtooth':
      return {
        points: [
          { time: 0, level: -1, curve: 0 },
          { time: 1, level: 1, curve: 0 },
        ],
        drawMode: 'edit',
        bipolar: true,
      };
    case 'square':
      // Colocated same-time points make a near-vertical edge — the same
      // trick a hand-drawn step in the Function editor uses.
      return {
        points: [
          { time: 0, level: 1, curve: 0 },
          { time: 0.5, level: 1, curve: 0 },
          { time: 0.5, level: -1, curve: 0 },
          { time: 1, level: -1, curve: 0 },
        ],
        drawMode: 'edit',
        bipolar: true,
      };
    case 'sine':
    default: {
      const N = 33;
      const points: FunctionPoint[] = Array.from({ length: N }, (_, i) => {
        const t = i / (N - 1);
        return { time: t, level: Math.sin(t * Math.PI * 2), curve: 0 };
      });
      return { points, drawMode: 'edit', bipolar: true };
    }
  }
}

/**
 * Every periodic LFO is a Function now — there's no more discrete
 * sine/triangle/sawtooth/square pick in the UI, just `'function'` (editable
 * breakpoints) or `'sample-hold'` (stepped random). `normalizeLfo` migrates
 * any of those legacy `wave` strings straight into a matching `functionShape`
 * so an old preset keeps sounding the same instead of jumping to a generic
 * default bump.
 */
export interface LfoSettings {
  /** Cycles per second (when `sync` is off). */
  rateHz: number;
  /** Tempo-sync the rate to the host (rate scaled by bpm/120 — approximate). */
  sync: boolean;
  /**
   * "New value per note" — the LFO emits ONE fresh random value latched at
   * note-on and held for the note (the old Random source, folded in). When
   * true, `wave` / `rateHz` are ignored.
   */
  perNote: boolean;
  /** `'sample-hold'` selects the stepped-random generator; `'function'` is
   *  everything else (the only periodic mode a fresh patch can pick). The
   *  wider `LfoWave` union (sine/triangle/sawtooth/square) still exists for
   *  `normalizeLfo`'s migration path and `translate.ts`'s DSP wave-index
   *  encoding, but nothing new is ever written as one of those. */
  wave: LfoWave;
  /** @deprecated Unused now that the continuous morph UI is gone — kept only
   *  so very old settings blobs still parse; never read or written. */
  shapePosition: number;
  /** Editable breakpoint data, used whenever `wave !== 'sample-hold'`. */
  functionShape?: FunctionShape;
}

/*
 * Pigments-style function data is intentionally separate from `AdsrEnvelope`.
 * This lets the first LFO ship without changing the existing ADSR scheduling;
 * the same editor/evaluator can be attached to envelopes in the next slice.
 */

/**
 * Audio-rate modulation depth from one SOURCE operator — Bitwig Phase-4
 * style, where each source gets its own colour-coded knobs on the target
 * (see PHASE4-SYNTH-REFERENCE.png + todo.md §22/§30/§31).
 *
 *   - `pm` — phase modulation: the modulator's signal (scaled in cents) is
 *     summed into the target's `detune`. `detune` exists on both
 *     `OscillatorNode` and `AudioBufferSourceNode`, so it works identically
 *     whether the target is a generated waveform or a `'sample'` operator.
 *   - `fm` — frequency modulation: the modulator's signal (Hz, or a
 *     playback-rate ratio for a `'sample'` operator) is summed into the
 *     target's `frequency` / `playbackRate`.
 */
export interface OperatorModEntry {
  pm: number; // 0..1
  fm: number; // 0..1
}

/** Per-source audio-rate modulation for one operator. */
export type OperatorModMap = Partial<Record<OperatorId, OperatorModEntry>>;

/**
 * Identifies one of the four operators a voice can build. Phase 1.11
 * (todo.md §33) removed the dedicated 5th `'sampler'` operator — any
 * oscillator can be a sampler now via `wave: 'sample'` — so this is just
 * the 4 oscillator slots.
 */
export type OperatorId = 'osc1' | 'osc2' | 'osc3' | 'osc4';

/** Fixed iteration order used everywhere an operator list is needed. */
export const OPERATOR_IDS: readonly OperatorId[] = ['osc1', 'osc2', 'osc3', 'osc4'];

/**
 * Hard cap on a `'sample'`-mode oscillator's recording, in seconds —
 * toggle-record-on, toggle-off, capped at 5 minutes (todo.md §33). Not a
 * user setting like the old sampler's 3/5/8s length chips were; the user
 * asked for a single fixed ceiling instead.
 */
export const MAX_SAMPLE_CAPTURE_SECONDS = 300;

/** Maps an operator id to its index in `SynthSettings.oscillators`. */
export function oscSlotIndex(id: OperatorId): number {
  return OPERATOR_IDS.indexOf(id);
}

/**
 * Per-operator pitch offset in semitones, on top of the synth's global
 * octave/semitone/fine (keyboard transpose). Continuous — fractional
 * semitones are cents — so one knob drives it, with Shift / Ctrl /
 * Shift+Ctrl for finer drag precision (todo.md §31). Replaces the old
 * `octave`/`semitone`/`fineCents` struct + separate Fine slider.
 */
export type OperatorPitch = number;

/** One of the four oscillator slots in the multi-operator engine. Any slot can be a sampler (`wave: 'sample'`) instead of a generated waveform — see `OscWave`. */
export interface OscillatorSlotSettings {
  /** Whether this operator sounds (and is available as a modulation source) at all. */
  enabled: boolean;
  wave: OscWave;
  /**
   * Continuous morph position (0..1) across the classic 4 shapes in order
   * sine → triangle → sawtooth → square (todo.md §41, replacing the old
   * discrete 4-button wave picker). Only meaningful when `wave !== 'sample'`
   * — the engine builds a band-limited `PeriodicWave` by interpolating the
   * Fourier coefficients of the two shapes either side of this position
   * (see `synth.ts`'s `morphedPeriodicWave`), not by crossfading raw
   * waveforms (which would alias). 0 = pure sine (today's default).
   */
  wavetablePosition: number;
  pitch: OperatorPitch;
  /** This operator's own contribution to the voice mix, 0..1. */
  level: number;
  /** Stereo position, -1 (hard left) .. 1 (hard right). */
  pan: number;
  /**
   * Fundamental frequency the operator's captured buffer was recorded
   * against — only meaningful when `wave === 'sample'`. Playback pitch is
   * `midiToFreq(playedNote) / rootHz`, so a key at C4 plays the sample
   * back at its recorded pitch when this is set to the sample's actual
   * fundamental (261.6 Hz for a C4-pitched source, 440 for A4, etc.).
   */
  rootHz: number;
  /**
   * Which built-in table (dsp/wavetables.js, plugin-engine only) this
   * operator scans — only meaningful when `wave === 'wavetable'`. Optional:
   * absent/undefined means table 0, so nothing that builds
   * `OscillatorSlotSettings` without it needs updating.
   */
  wtId?: number;
  /**
   * Continuous 0..1 scan position across `wtId`'s frames (Task 4) — a real
   * multi-frame wavetable read, distinct from `wavetablePosition` above
   * (which morphs 4 fixed shapes and predates this). Also a mod-matrix
   * target (`op{k}WtPos`). Optional for the same reason as `wtId`.
   */
  wtPos?: number;
  /** Warp mode for Wavetable / Phase warping (0..29). 0 = None / Bypass. */
  warpMode?: number;
  /** Primary warp amount (0..1). */
  warpAmount?: number;
  /** Secondary warp parameter (0..1) — e.g. PWM width, Quantize steps, Formant center, etc. */
  warpParam2?: number;
  /** Secondary Warp mode for Wavetable / Phase warping (0..29). */
  warpMode2?: number;
  /** Secondary warp amount (0..1). */
  warpAmount2?: number;
  /** Secondary warp parameter 2 (0..1). */
  warpParam2_2?: number;
  /**
   * Simpler-style sample playback shaping (Task 6, sampler upgrade,
   * multi-agent work order) — only meaningful when `wave === 'sample'`.
   * All optional: absent means the old one-shot-from-the-top behaviour
   * (§114's original scope), so nothing that builds
   * `OscillatorSlotSettings` without them needs updating.
   */
  /** Sustain the sample for as long as the note is held, wrapping back to
   *  `sampleStart` at `sampleEnd` — off means play through once (one-shot). */
  sampleLoop?: boolean;
  /** 0..1 fraction of the file's length to start playback from. */
  sampleStart?: number;
  /** 0..1 fraction of the file's length to stop/loop-wrap at (>= sampleStart). */
  sampleEnd?: number;
  /** Play the file backward from its last sample. Ignores sampleStart/
   *  sampleEnd/sampleLoop for now — combining reverse with trim/loop needs
   *  a native DSP change, not just new properties (see dsp/synth.js). */
  sampleReverse?: boolean;
  /** Phase-modulation depth per SOURCE operator (Phase-4 colour-coded knobs). */
  mods: OperatorModMap;
  /**
   * Crossfade between Filter A and Filter B (todo.md §60 — dual filters for
   * a polysynth). 0 = fully Filter A (the default — "by default all Oscs
   * are routed into filter A"), 1 = fully Filter B, in between splits this
   * operator's signal into both filter chains at complementary gains
   * (equal-power-ish linear crossfade, matching the Pan knob's simplicity).
   */
  filterMix: number;
}

export interface WarpModeDefinition {
  id: number;
  name: string;
  domain: 'none' | 'phase' | 'spectral' | 'wave';
  param2Name?: string;
}

export const WARP_MODES: WarpModeDefinition[] = [
  { id: 0, name: 'None', domain: 'none' },
  { id: 1, name: 'Bend +', domain: 'phase', param2Name: 'Center' },
  { id: 2, name: 'Bend -', domain: 'phase', param2Name: 'Center' },
  { id: 3, name: 'Asymmetry', domain: 'phase', param2Name: 'Skew' },
  { id: 4, name: 'Sync', domain: 'phase', param2Name: 'Cycles' },
  { id: 5, name: 'Mirror', domain: 'phase', param2Name: 'Center' },
  { id: 6, name: 'Reflect', domain: 'phase', param2Name: 'Segments' },
  { id: 7, name: 'PWM', domain: 'phase', param2Name: 'Width' },
  { id: 8, name: 'Quantize', domain: 'phase', param2Name: 'Steps' },
  { id: 9, name: 'Squeeze / Expand', domain: 'phase', param2Name: 'Curve' },
  { id: 10, name: 'FM-Like', domain: 'phase', param2Name: 'Ratio' },
  { id: 11, name: 'Wavefold', domain: 'phase', param2Name: 'Drive' },
  { id: 12, name: 'Shear', domain: 'phase', param2Name: 'Offset' },
  { id: 13, name: 'Formant', domain: 'spectral', param2Name: 'Center' },
  { id: 14, name: 'Bitcrush', domain: 'phase', param2Name: 'Bits' },
  { id: 15, name: 'Wave Rectify', domain: 'phase', param2Name: 'Mode' },
  { id: 16, name: 'Harmonic Stretch', domain: 'spectral', param2Name: 'Factor' },
  { id: 17, name: 'Comb / Ripple', domain: 'spectral', param2Name: 'Freq' },
  { id: 18, name: 'Inharmonic Stretch', domain: 'spectral', param2Name: 'Shift' },
  { id: 19, name: 'Smear', domain: 'spectral', param2Name: 'Radius' },
  { id: 20, name: 'Phase Disperse', domain: 'spectral', param2Name: 'Curve' },
  { id: 21, name: 'Spectral Freeze', domain: 'spectral', param2Name: 'Hold' },
  { id: 22, name: 'Odd / Even', domain: 'spectral', param2Name: 'Balance' },
  { id: 23, name: 'Harmonic Shift', domain: 'spectral', param2Name: 'Shift' },
  { id: 24, name: 'Spectral Fold', domain: 'spectral', param2Name: 'Cutoff' },
  { id: 25, name: 'Harmonic Random', domain: 'spectral', param2Name: 'Seed' },
  { id: 26, name: 'Phase Randomize', domain: 'spectral', param2Name: 'Seed' },
  { id: 27, name: 'Harmonic Rotate', domain: 'spectral', param2Name: 'Speed' },
  { id: 28, name: 'Spectral Warp', domain: 'spectral', param2Name: 'Curve' },
];

/**
 * Which top-level view the app shows.
 *   - 'synth'    = the new instrument (Phase 1+). Default on first launch.
 *   - 'recorder' = the original recorder capture/HUD/visualizer flow.
 *
 * Both modes remain fully functional. Synth is a renderer-only addition: the
 * synthesiser does NOT record itself in Phase 1; the recorder mode captures
 * system audio exactly like before. See `todo.md` for the migration plan.
 */
export type AppMode = 'synth' | 'recorder';

/**
 * How much chrome the main window shows.
 *   - 'full'    = title bar + HUD + visualizer + footer (the original layout)
 *   - 'compact' = title bar + a single control row + visualizer
 */
export type UiLayout = 'full' | 'compact';

/** 'system' = the OS title bar; 'custom' = our own 26px frameless strip. */
export type TitleBarMode = 'system' | 'custom';

/** How button labels are rendered as the window narrows. */
export type LabelMode = 'auto' | 'icon' | 'text';

/** Where a snap request should put the window on its current display. */
export type SnapTarget =
  | 'top'
  | 'top-left'
  | 'top-right'
  | 'bottom'
  | 'left'
  | 'right'
  | 'center';

/** A source the user can pick for system audio capture (desktopCapturer). */
export interface CaptureSource {
  /** Stable id from Electron's desktopCapturer. */
  id: string;
  /** Human-readable name shown in the dropdown ("Entire Screen", "Spotify.exe", …). */
  name: string;
  /** 'screen' or 'window'. */
  kind: 'screen' | 'window' | 'app';
  /** Optional thumbnail as a data URL. */
  thumbnail?: string;
}

/** A render endpoint exposed by the WASAPI loopback helper. */
export interface LoopbackDevice {
  /** WASAPI device endpoint id (GUID string). */
  id: string;
  /** User-visible name ("Speakers (Realtek)", "Headphones (Corsair HS55)", …). */
  name: string;
  /** True if this is the system-default playback device. */
  isDefault: boolean;
  /** Best-known sample rate. */
  sampleRate: number;
  channelCount: number;
}

/** Persisted user settings. */
export interface AppSettings {
  /** Global hotkey, e.g. "Shift+Alt+R". */
  hotkey: string;
  /** Absolute path to a folder where recordings are written. */
  saveFolder: string;
  /** Which capture backend to use (desktopCapturer vs WASAPI loopback). */
  captureBackend: CaptureBackend;
  /** Last selected capture source id (desktop backend), or null for "no source yet". */
  sourceId: string | null;
  /** Last selected loopback device id (loopback backend), or null. */
  loopbackDeviceId: string | null;
  /** Rolling vs traditional recording. */
  recordMode: RecordMode;
  /** Visual theme. */
  theme: Theme;
  /** Active visualizer mode. */
  visualizer: VisualizerMode;
  /** Buffer length in seconds, applies to rolling mode. */
  bufferSeconds: number;
  /** Opus bitrate kbps. */
  bitrateKbps: number;
  /** Whether the main window stays above other applications. */
  alwaysOnTop: boolean;
  /** Template used to name saved recordings. */
  fileNameTemplate: string;

  // ----- Interface ---------------------------------------------------------
  // Everything below is presentation-only: it changes how much room the app
  // takes up, never what it records. Each knob is user-facing so nobody is
  // stuck with a layout that doesn't suit their screen.

  /** How much chrome the main window shows. */
  uiLayout: UiLayout;
  /** OS title bar vs our own minimal strip (applies on window re-create). */
  titleBarMode: TitleBarMode;
  /** Button label strategy as the window narrows. */
  labelMode: LabelMode;
  /** Show the VU meter row in the HUD. */
  showVu: boolean;
  /** Show the rolling-buffer fill bar in the HUD. */
  showBuffer: boolean;
  /** Show the source / output-device picker in the footer. */
  showSourcePicker: boolean;
  /** Show the oscilloscope / spectrum / spectrogram chip row. */
  showVizChips: boolean;
  /** Show the "Hotkey: …" hint line. */
  showHint: boolean;
  /** Snap the window to a screen edge when dragged near one. */
  magneticSnap: boolean;
  /**
   * When docked to the top of a screen, register as a Windows appbar so the
   * desktop work area shrinks and other applications lay out *below* the strip
   * instead of being covered by it — the same mechanism the taskbar uses.
   *
   * Off by default: it changes the desktop layout for every application, which
   * is not something to opt a user into silently.
   */
  dockReservesSpace: boolean;
  /** Re-open the pop-out visualizer window on launch. */
  popoutOpen: boolean;
  /** Keep the pop-out above other windows. */
  popoutAlwaysOnTop: boolean;
  /** Pop-out window opacity, 0.2–1. */
  popoutOpacity: number;
  /** Render transport buttons inside the pop-out. */
  popoutControls: boolean;
  /** Hide the main window's visualizer while the pop-out is open. */
  hideBoardWhenPopped: boolean;
  /**
   * Hide the *whole* main window while the pop-out is open, so popping out
   * swaps windows instead of leaving two on screen. The tray icon and the
   * global hotkey still work, and closing the pop-out brings the main window
   * back — as does Show from the tray menu.
   */
  hideMainWhenPopped: boolean;

  // ----- Synthesizer (Phase 1+) ------------------------------------------
  // The synth is renderer-only — no IPC needed. It has its own AudioContext
  // and feeds the existing AnalyserNode-based visualiser, so the rest of the
  // application (themes, pop-out, settings persistence) works unchanged.

  /** Which top-level view the user is in. */
  appMode: AppMode;
  /** All synth parameters grouped so they read as one block in settings. */
  synth: SynthSettings;
}

/**
 * ADSR envelope parameters.
 *
 * `attackSec` / `decaySec` / `releaseSec` are in seconds (clamped to
 * >= 1 ms at the engine); `sustainLevel` is 0..1.
 *
 * Each ramp segment also has a `*Curve` (-1..1, Vital-style): 0 = linear,
 * > 0 = convex (slow start, fast end), < 0 = concave (fast start, slow
 * end). The engine maps a curve to a power exponent via
 * `curvePower(c) = 2^(c*4)` and shapes the segment as `t^power`.
 */
export interface AdsrEnvelope {
  attackSec: number;
  decaySec: number;
  sustainLevel: number;
  releaseSec: number;
  attackCurve: number;
  decayCurve: number;
  releaseCurve: number;
  /** 'adsr' (default) = the four-stage envelope above. 'multi' = `shape` played
   *  once from note-on over `durationSec`, holding its last point for as long as
   *  the note is held, then released over `releaseSec` (dsp/synth.js envSignal).
   *  Absent means 'adsr', so every existing preset keeps its behaviour. */
  mode?: 'adsr' | 'multi';
  /** The breakpoint shape for 'multi' — the SAME type the LFO Function editor
   *  edits, so the editor is reused as-is. Not a flat host param: it travels
   *  through the `setEnvShape` bridge verb, like `lfo*_functionShape`. */
  shape?: FunctionShape;
  /** How long `shape` takes to play through, in seconds. */
  durationSec?: number;
}

/**
 * Modulation sources available to the Pigments-style mod system.
 *
 * env1/env2 are the envelopes, lfo1/lfo2 the LFOs, `sh` the rate-clocked
 * random sample-and-hold source, `random` a single fresh random value
 * chosen per note and held for that note's life (no rate, no movement —
 * "humanise every note"), `velocity` the note's 0..1 velocity, and
 * `keytrack` a bipolar (-1..1) value derived from the note's pitch (0 at
 * middle C). The engine's route wiring and the UI metadata in
 * `src/renderer/lib/mod-sources.ts` are source-agnostic (a source is just
 * a signal feeding an amount-scaled AudioParam).
 */
// Modulator roster (todo.md §88.A): 3 envelopes, 3 LFOs, velocity, keyboard.
// The standalone Sample&Hold + Random sources are gone — an LFO does S&H via
// its `wave`, and "new value per note" via `perNote`.
// 8 Macro knobs (todo.md §111) — plain held values (no envelope shape), each
// mappable to any target exactly like an ENV/LFO. Live in the header, not a
// mod-card, so they read as one knob per macro rather than a mod source card.
export type MacroIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const NUM_MACROS = 8;
export type ModSourceId =
  | 'env1' | 'env2' | 'env3'
  | 'lfo1' | 'lfo2' | 'lfo3'
  | 'velocity' | 'keytrack'
  | `macro${MacroIndex}`
  // Optional modulators added with the "+" tile (plugin engine only).
  | 'audiofollower' | 'env4' | 'env5' | 'lfo4' | 'lfo5' | 'lfo6'
  | 'env6' | 'env7' | 'env8' | 'lfo7' | 'lfo8'
  | 'audiofollower2' | 'audiofollower3' | 'audiofollower4'
  | 'env9' | 'env10' | 'env11' | 'lfo9' | 'lfo10'
  | 'audiofollower5' | 'audiofollower6' | 'audiofollower7' | 'audiofollower8' | 'audiofollower9' | 'audiofollower10';

/** Audio Follower — follows the level of the plugin's sidechain INPUT within
 *  a frequency band and outputs a 0..1 modulation signal. */
export interface AudioFollowerSettings {
  /** Band low edge, Hz (20..20000). */
  loHz: number;
  /** Band high edge, Hz (20..20000). */
  hiHz: number;
  attackMs: number;
  releaseMs: number;
  /** Input gain into the follower, dB (-24..+48). */
  gainDb: number;
  /** What it listens to: 0 = the host sidechain input, 1 = the synth's own output. */
  source: number;
}

/** The optional modulators a patch has ADDED (the "+" tile). A key being
 *  present means the module exists; removing it also drops its routes. */
export interface ModuleSet {
  audioFollower?: AudioFollowerSettings;
  audioFollower2?: AudioFollowerSettings;
  audioFollower3?: AudioFollowerSettings;
  audioFollower4?: AudioFollowerSettings;
  audioFollower5?: AudioFollowerSettings;
  audioFollower6?: AudioFollowerSettings;
  audioFollower7?: AudioFollowerSettings;
  audioFollower8?: AudioFollowerSettings;
  audioFollower9?: AudioFollowerSettings;
  audioFollower10?: AudioFollowerSettings;
  env4?: AdsrEnvelope;
  env5?: AdsrEnvelope;
  env6?: AdsrEnvelope;
  env7?: AdsrEnvelope;
  env8?: AdsrEnvelope;
  env9?: AdsrEnvelope;
  env10?: AdsrEnvelope;
  env11?: AdsrEnvelope;
  lfo4?: LfoSettings;
  lfo5?: LfoSettings;
  lfo6?: LfoSettings;
  lfo7?: LfoSettings;
  lfo8?: LfoSettings;
  lfo9?: LfoSettings;
  lfo10?: LfoSettings;
  /** Presence markers for the original modulators (their settings still live
   *  in modEnv / modEnv3 / lfo1..3): a fresh patch opens with only ENV 1. */
  env2?: true;
  env3?: true;
  lfo1?: true;
  lfo2?: true;
  lfo3?: true;
}
/** ENV 1 (amp) is permanent; the grid has room for this many ADDED modulators in
 *  ANY mix of types (12 cells = ENV 1 + 10 modulators + the "+" tile). */
export const MAX_ADDED_MODULES = 10;
export const AF_MODULE_IDS = ['audioFollower', 'audioFollower2', 'audioFollower3', 'audioFollower4', 'audioFollower5', 'audioFollower6', 'audioFollower7', 'audioFollower8', 'audioFollower9', 'audioFollower10'] as const;
export const EXTRA_ENV_IDS = ['env4', 'env5', 'env6', 'env7', 'env8', 'env9', 'env10', 'env11'] as const;
export const EXTRA_LFO_IDS = ['lfo4', 'lfo5', 'lfo6', 'lfo7', 'lfo8', 'lfo9', 'lfo10'] as const;
export type ModuleId = keyof ModuleSet;

/** Filter slope — one BiquadFilterNode (12 dB/oct) or two cascaded (24 dB/oct). */
export type FilterSlope = '12' | '24';
export type FilterType = 'lowpass' | 'highpass' | 'bandpass';

/**
 * The voice filter (todo.md Phase 4) — one filter per voice, after the
 * operator mix and before the amp envelope. There's no dedicated "filter
 * envelope": ENV 2 (the free mod envelope) already exists for exactly this
 * job, so cutoff/resonance are just two more Pigments mod targets
 * (`filterCutoff` / `filterResonance`) — route ENV 2 (or an LFO, velocity,
 * keytrack…) onto Cutoff via the ∿ badge like any other knob. Keytrack
 * likewise needs no dedicated knob: the `keytrack` mod source already
 * exists — route it onto Cutoff for classic "brighter up the keyboard".
 *
 * Defaults to fully open (20 kHz, low resonance) so shipping this feature
 * doesn't mute any existing patch — the filter is always in the signal
 * path, but inaudible until the cutoff is dialed down.
 */
export interface FilterSettings {
  type: FilterType;
  slope: FilterSlope;
  /** Hz, 20..20000. */
  cutoffHz: number;
  /** Q factor. ~0.707 = no resonant peak (Butterworth); higher self-resonates. */
  resonance: number;
}

/**
 * One source → target modulation route.
 *
 * `amount` is in the TARGET's native unit (cents for pitch, 0..1 scale
 * for level) so the popover can show "+350 ct" instead of abstract 0..1.
 */
export interface ModRoute {
  source: ModSourceId;
  amount: number;
  /**
   * When `false`, the route is muted/bypassed — kept in the patch (amount,
   * position preserved) but contributes nothing to the sound. Absent =
   * enabled (the common case; avoids churning every existing patch/preset).
   */
  enabled?: boolean;
}

/**
 * Modulatable targets. The two global targets (`pitch`, `oscLevel`), then
 * per-operator: `level`, `pan`, `modAmount` (overall PM depth), `pitch`
 * (that operator's own pitch dial), and a per-SOURCE knob for every PM/FM
 * depth knob (`osc1PmOsc2` = OSC 1's phase-mod knob whose source is OSC 2;
 * `osc1FmOsc1` = OSC 1 frequency-modulating itself). New targets (LFO
 * rate…) get added here, then in `SynthEngine.resolveTargetParam` +
 * `MOD_ROUTE_RANGES` (lib/synth.ts) and in `MOD_TARGETS`
 * (lib/mod-sources.ts). `filter{A,B}Cutoff`/`filter{A,B}Resonance`
 * (Phase 4, doubled up in §60's dual-filter pass) are each filter's two
 * knobs — like `pitch`, they fan out to more than one live AudioParam
 * (both cascaded stages of that filter), so `resolveTargetParam` returns
 * null for them and `applyRoutes` special-cases them instead.
 *
 * NOT in this union: a per-operator Filter A/B crossfader mod target. The
 * crossfade needs two AudioParams (toA/toB gains) to move in lockstep from
 * one modulation amount, which the existing "one route → one AudioParam
 * (or a fixed fan-out set)" model can't express without the two gains
 * drifting out of sync under audio-rate modulation — `filterMix` stays a
 * static per-operator knob for now (§60).
 */
export type ModTargetId =
  | 'seqRate'
  | 'seqSwing'
  | 'seqGate'
  | 'seqTranspose'
  | 'seqVelocity'
  | 'seqRandom'
  | 'seqOctaves'
  | 'seqPattern'
  | 'seqChaos'
  | 'pitch'
  | 'oscLevel'
  | 'filterACutoff'
  | 'filterAResonance'
  | 'filterBCutoff'
  | 'filterBResonance'
  // LFO 1/2 rate + shape are themselves modulatable. Rate maps to the live
  // LFO node's .frequency / .playbackRate (additive Hz). Shape has no
  // AudioParam (it's `setPeriodicWave`), so `applyRoutes` sends it to a
  // per-voice analyser bus that the engine's control-rate loop reads to
  // re-pick the morphed wave (see `SynthEngine` LFO-shape modulation).
  | 'lfo1Rate'
  | 'lfo1Shape'
  | 'lfo2Rate'
  | 'lfo2Shape'
  | 'lfo3Rate'
  | 'lfo3Shape'
  | `${OperatorId}Level`
  | `${OperatorId}Pan`
  | `${OperatorId}ModAmount`
  | `${OperatorId}Pitch`
  | `${OperatorId}Wave`
  | `${OperatorId}FilterMix`
  | `${OperatorId}WtPos`
  | `${OperatorId}WarpAmt`
  | `${OperatorId}WarpAmt2`
  | `${OperatorId}Pm${OperatorId}`
  | `${OperatorId}Fm${OperatorId}`;

/**
 * Pigments-style mod data model — routes grouped per target. There is NO
 * modulation matrix: a parameter either has routes attached or it doesn't,
 * and the routes live next to the parameter they affect.
 */
export type ModMap = Partial<Record<ModTargetId, ModRoute[]>>;

/**
 * The multi-operator engine. A voice is built from up to four operator
 * slots mixed together, each with its own wave/pitch/level (any slot can
 * be a sampler instead of a generated waveform — see `OscWave` — since
 * Phase 1.11 removed the old dedicated 5th sampler operator), and each
 * optionally phase/frequency-modulated by any other enabled operator (see
 * `OperatorModMap` / `OperatorId` near the top of this file). This sits
 * ALONGSIDE the Phase 2 envelope + Pigments-style mod-matrix system below
 * (`ampEnv` / `modEnv` / `lfo1` / `lfo2` / `mod`): that system routes slow
 * control signals onto knobs; `oscillators` describes the audio-rate
 * operator graph itself. The two compose freely — e.g. ENV2 can still bend
 * `pitch` (applied to every sounding operator's detune) while an
 * oscillator separately phase-modulates another oscillator at audio rate.
 */
export interface SynthSettings {
  /** Global octave offset (~C4 / MIDI 60). Range: -3..+3. Transposes every operator + the visible keyboard. */
  octave: number;
  /** Global semitone offset. Range: -12..+12. */
  semitone: number;
  /** Global fine-tune in cents. -100..+100. */
  fineTuneCents: number;
  /** Voice mode: 0 = poly, 1 = mono (retriggers), 2 = legato (no retrigger on overlap). */
  voiceMode: number;
  /** Portamento / glide time in seconds (0 = off). Range 0..5. */
  glideSec: number;
  /**
   * Overall per-voice trim (0..1), applied after the operator mix and the
   * amplitude envelope, before the master bus. This is the `'oscLevel'`
   * mod-route target — it fills the role the old single-oscillator's level
   * slider played, now that each operator has its own `level`.
   */
  voiceLevel: number;
  /** Master bus gain (0..1). Feeds both the analysers and the speakers. */
  masterLevel: number;
  /** How many simultaneous voices (polyphony cap). Phase 1.5: 16, plenty. */
  voiceLimit: number;
  /**
   * Global velocity curve — reshapes how pointer position on a piano key
   * maps to note velocity (todo.md §44). -1 = soft (light clicks already
   * loud), 0 = linear, +1 = hard (only the deepest clicks reach full
   * velocity). QWERTY notes are unaffected (fixed velocity, no position).
   * See `applyVelocityCurve` below for the exact mapping.
   */
  velocityCurve: number;

  /**
   * Transfer curves for the Velocity / Keyboard MOD SOURCES (todo.md §88.E —
   * distinct from `velocityCurve`, which only shapes the piano pointer). Each
   * -1..1: 0 linear, +1 exponential (slow to rise), -1 logarithmic (fast to
   * rise). Applied as a `pow` exponent `2^(c*2)` on the source's 0..1
   * magnitude before it drives any route.
   */
  velCurve: number;
  keyCurve: number;

  /**
   * ENV 1 — the amplitude envelope. Always routed to the voice level
   * (shapes the operator mix on top of `voiceLevel`).
   */
  ampEnv: AdsrEnvelope;
  /**
   * ENV 2 — the modulation envelope. Not wired to anything by default;
   * the user routes it to a target via the ∿ mod menu on a knob. Both
   * envelopes are always running per voice (they share the same note
   * lifecycle), so a route change is instant.
   */
  modEnv: AdsrEnvelope;
  /** ENV 3 — a third free modulation envelope (todo.md §88.A). */
  modEnv3: AdsrEnvelope;
  /** LFO 1 — free-running per-voice oscillator, routable like ENV 2. */
  lfo1: LfoSettings;
  /** LFO 2 — a second independent LFO. */
  lfo2: LfoSettings;
  /** LFO 3 — a third independent LFO. */
  lfo3: LfoSettings;
  /** Optional modulators added with the "+" tile (absent = not added). */
  modules: ModuleSet;
  /** Pigments-style modulation routes, keyed by target. */
  mod: ModMap;
  /**
   * 8 Macro knobs (todo.md §111), 0..1 each, index 0 = Macro 1. Plain held
   * values — no shape, no envelope — routable via `mod` exactly like any
   * other `ModSourceId`. Live in the header, always visible regardless of
   * which tab (OSCILLATORS / MASTER FX) is active.
   */
  macros: number[];
  /**
   * Dual filters (todo.md §60 — "since this is a polysynth we can have two
   * filters"). Every operator's signal splits between them via its own
   * `filterMix` crossfader (0 = all Filter A, the default). Both chains sum
   * before the amp envelope — see `SynthEngine`'s dual-filter doc.
   */
  filterA: FilterSettings;
  filterB: FilterSettings;

  /** The four operator slots — see `OscillatorSlotSettings`. Any slot can be a sampler (`wave: 'sample'`). */
  oscillators: OscillatorSlotSettings[];

  /**
   * Master-bus effects (todo.md §79). These run AFTER the summed voice mix
   * and master gain — the per-voice dual filter is a timbre stage, this is
   * an insert chain on the stereo output. Both effects default to `mix: 0`
   * (fully dry) so adding this feature is silent on every existing patch.
   */
  fx: FxSettings;

  /**
   * Arpeggiator (todo.md §166 v1 — Pigments-style, scope trimmed to Arp
   * mode only for the first cut; Seq mode / per-step lanes are the planned
   * v2). Plays the currently HELD notes (piano or host MIDI) back in a
   * pattern instead of straight through — purely a UI/JS-timer note
   * re-triggering layer today (calls the existing noteOn/noteOff), not yet
   * the sample-accurate audio-thread engine §166-E describes; good enough
   * to actually hear and iterate on, not a mockup.
   */
  arp: ArpSettings;
}

// ---------------------------------------------------------------------------
// Arp / Seq data model — the JSON the UI sends via setArpConfig; the native
// engine parses JSON.stringify(synth.arp) (same names, same units).
// See docs/ARP-SEQ-CONTRACT.md §1.
// ---------------------------------------------------------------------------
/** 18 arp patterns. `poly` was removed — it fired the whole chord at once
 *  instead of picking an index, so it was a chord mode, not a pattern; a saved
 *  `poly` migrates to `up` (see normalizeArpSettings). ORDER IS SIGNIFICANT:
 *  it must match ArpConfig::Mode in plugin/ArpEngine.h one-for-one, because the
 *  pattern selector maps a 0..1 position onto this index. */
export type ArpMode =
  | 'up' | 'down' | 'updown' | 'updownExcl' | 'downup' | 'random' | 'asPlayed'
  | 'convergeUp' | 'convergeDown' | 'divergeUp' | 'divergeDown'
  | 'thumbUp' | 'thumbDown' | 'pinkyUp' | 'pinkyDown'
  | 'skipUp' | 'repeatUp' | 'walk';
export type SeqDirection = 'fwd' | 'bwd' | 'bounce' | 'bounceExcl' | 'random' | 'randomNoRepeat' | 'drunk' | 'converge' | 'diverge';
export type RateDiv = '1/1' | '1/2' | '1/4' | '1/8' | '1/16' | '1/32';
export type LaneId = 'on' | 'prob' | 'pitch' | 'octave' | 'vel' | 'gate' | 'slide';
export const SEQ_STEPS = 16;
export const LANE_IDS: LaneId[] = ['on', 'prob', 'pitch', 'octave', 'vel', 'gate', 'slide'];

/** Dice direction for a lane: 'neg' = roll down only, 'pos' = roll up only, 'both' = either way. */
export type DicePolarity = 'neg' | 'both' | 'pos';
export const DICE_POLARITIES: DicePolarity[] = ['neg', 'both', 'pos'];

export interface SeqLane {
  /** 16 values — what the user drew. */
  base: number[];
  /** 16 — the dice overlay, null = none. Engine-owned. Effective = overlay[i] ?? base[i]. */
  overlay: (number | null)[];
  /** 0..1 dice "Random Amount". */
  amount: number;
  /** 1..16 — this lane's own length (only honoured when seq.polymetry). */
  length: number;
  /** Lane advances once per `div` global steps. */
  div: 1 | 2 | 3 | 4 | 6 | 8 | 16;
  /** Integer shift, wraps within `length`. */
  rotation: number;
  /** 16 — per-step random lock. */
  locked: boolean[];
  /** UI increments -> engine re-rolls THIS lane's overlay once. */
  rollToken: number;
  /** Dice direction (the -, +, -+ toggle). */
  dicePolarity: DicePolarity;
}

export interface SeqSettings {
  /** false = Arp mode, true = Seq mode. */
  enabled: boolean;
  direction: SeqDirection;
  /** 1..16 global pattern length. */
  length: number;
  polymetry: boolean;
  /** 0 = off; else every N global steps all lane counters realign. */
  resetAfter: number;
  /** -24..24 semitones, applied before scale snapping. */
  pitchTranspose: number;
  lanes: Record<LaneId, SeqLane>;
}

export interface ArpRate {
  sync: boolean;
  div: RateDiv;
  feel: 'straight' | 'triplet' | 'dotted';
  /** 0.5..20, used when sync=false. */
  hz: number;
}
export interface ArpLayers {
  /** 5 buttons, offsets -2,-1,0,+1,+2 — held chord played as-is. */
  chord: boolean[];
  /** 2 x 5 — arp rows. */
  arp: boolean[][];
}
export interface ArpExtras {
  useStepLanes: boolean;
  /** 16 x int -12..12 */
  stepTranspose: number[];
  /** 16 x 0..4 — how much SHORTER than the Gate knob each step plays.
   *
   *  This is a SHORTEN amount, not a note length: 0 = play at the Gate knob's
   *  length, 1 = half, 2 = a third, 4 = a fifth (near-staccato). It reads
   *  bottom-up as "how much do I want to shorten this step", which is the axis
   *  you actually reach for when writing a sequence (user: "start from the
   *  lowest value ... at the bottom at zero, and when we turn it up the gate
   *  gets like a shorter decay time").
   *
   *  Length itself is the Gate KNOB's job and still goes to 400 % — so the
   *  division is clean: the knob sets the note, the lane only pulls it in.
   *  The effective factor is `1 / (1 + value)`, which is why 100 % reads as
   *  exactly half and 200 % as half again.
   *
   *  LEGACY: `stepGate` (16 x 0.05..4, higher = LONGER) was this field's
   *  previous form. It is still read for migration only — see
   *  `normalizeArpSettings`, which converts an old patch's ratios into the
   *  equivalent shorten amounts so it keeps its exact sound. Never write it. */
  stepShorten: number[];
  /** 16 x 0..1 — per-step velocity. 1 = the held note's own velocity (neutral,
   *  so an untouched lane changes nothing); lower = softer. */
  stepVel: number[];
  /** 16 x 0..1000 ms — per-step portamento into the note. 0 = no slide. */
  stepSlide: number[];
  /** Per-lane dice amounts 0..1, index 0 = transpose, 1 = gate. This is NOT the
   *  per-knob `generation.knobDice`: a lane already IS a 16-step sequence, so
   *  its randomness is expressed by the lane's own steps rather than by a live
   *  per-step draw. The amount here is how much the REGEN roll is allowed to
   *  move each step — i.e. it feeds the existing lane-dice overlay machinery
   *  (`effAmount`), the same gate Chaos scales, rather than a second parallel
   *  system. A lane with amount 0 is a plain hand-drawn lane. */
  laneDice: number[];
  /** Per-lane direction flags, same order: 1 = bipolar, 0 = one-way. */
  laneDiceBipolar: number[];
  layers: ArpLayers;
  tightRelease: boolean;
  /** Seq mode: true = every held note sounds on every step (the chord stab). false = one note per step, picked by the pattern. */
  chordHit: boolean;
  /** 0..1 */
  humanize: number;
  /** -1..1 */
  shape: number;
}
export interface ArpGeneration {
  /** 0 = off, else bars (0.0625 .. 8). */
  autoRegen: number;
  chaos: 'frozen' | 'live';
  /** Chaos master 0..1 (host param `arp_chaos`, mod target seqChaos): scales
   *  EVERY lane's dice amount. 1 = the lanes' own amounts, 0 = dice off. */
  chaosAmount: number;
  /** Per-knob dice for the CONTINUOUS arp parameters, each 0..1, drawn once per
   *  step. Order matches `KnobDice` in `plugin/ArpEngine.h`:
   *  [rate, octaves, swing, pattern, gate].
   *
   *  This is deliberately NOT the lane-dice mechanism. A lane is a 16-step
   *  overlay the user can lock per step; these are single knobs with one amount
   *  each and a live draw, so there is no per-step array to lock. Both are
   *  scaled by the same `chaosAmount`, so Chaos at 0 means "no randomness
   *  anywhere" rather than two separate dials.
   *
   *  A saved patch from before this field existed normalizes to all-zero
   *  (feature off) — see `normalizeArpSettings`. */
  knobDice: number[];
  /** Per-knob dice DIRECTION, one flag per knob, in the same order as
   *  `knobDice`. 1 = bipolar (the draw may go either way), 0 = one-way.
   *
   *  This is not cosmetic — it changes what the engine draws:
   *  - **rate** is jittered as a multiplicative FACTOR (see `ArpEngine.h`). With
   *    both directions it wanders around the dial; one-way it can only speed up
   *    (or only slow down).
   *  - **octaves** picks +/- a whole octave; one-way means always up or down.
   *  - **swing** offsets in percentage points, both ways or one.
   *  - **pattern** jumps to a DIFFERENT pattern per step; direction has no
   *    meaning for it (it is not an ordered axis), so its flag is stored but
   *    ignored — kept in the array so the UI can offer it uniformly and so
   *    changing the knob count can't silently shift another knob's setting.
   *  - **gate** shortens/lengthens the note; one-way means only ever shorter
   *    (safer) or only ever longer.
   *
   *  Defaults to all-1 (bipolar): a fresh dice reads as "randomise this" and
   *  moves in both directions, which is the most musical reading. An old patch
   *  normalizes to bipolar too, not to one-way, because a dice that can only
   *  go one way would be a surprise. */
  knobDiceBipolar: number[];
  seed: number;
  regenToken: number;
  clearToken: number;
}
export interface ArpScale {
  /** 12 x 0..1 per pitch class relative to the key root. */
  weights: number[];
  snap: boolean;
}
/** The blue arp row (Arp row 2): its own clock and knobs. The green row (row 1)
 *  uses the top-level rate / octaves / swing / gate and generation.chaosAmount. */
export interface ArpBlueRow {
  rate: ArpRate;
  /** The blue row's own pattern (its selector). Lowest = Up, highest = Walk, in ARP_MODES order. */
  pattern: ArpMode;
  octaves: number;
  /** 50..75 % */
  swing: number;
  /** 0.05..4 */
  gate: number;
  /** 0..1, scales this row's dice (the green row's Chaos is generation.chaosAmount). */
  chaosAmount: number;
  /** Same indexing as generation.knobDice (KNOB_DICE_KEYS). Pattern is global, so its entry is unused. */
  knobDice: number[];
  knobDiceBipolar: number[];
}

export interface ArpSettings {
  on: boolean;
  mode: ArpMode;
  hold: boolean;
  /** 1..4 */
  octaves: number;
  rate: ArpRate;
  /** 50..75 % */
  swing: number;
  /** 0.05..4 */
  gate: number;
  /** 0..1 */
  velocityPct: number;
  keySnap: boolean;
  keyRoot: number;
  keyScale: ScaleId;
  seq: SeqSettings;
  arp: ArpExtras;
  generation: ArpGeneration;
  blue: ArpBlueRow;
  scale: ArpScale;
}

const LANE_DEFAULT: Record<LaneId, number> = { on: 1, prob: 1, pitch: 0, octave: 0, vel: 0.8, gate: 0.6, slide: 0 };
const LANE_RANGE: Record<LaneId, [number, number, boolean]> = {
  on: [0, 1, true], prob: [0, 1, false], pitch: [-12, 12, true], octave: [-2, 2, true],
  vel: [0, 1, false], gate: [0.05, 4, false], slide: [0, 1000, false],
};
const LANE_DIVS = [1, 2, 3, 4, 6, 8, 16] as const;
export const ARP_MODES: ArpMode[] = [
  'up', 'down', 'updown', 'updownExcl', 'downup', 'random', 'asPlayed',
  'convergeUp', 'convergeDown', 'divergeUp', 'divergeDown', 'thumbUp', 'thumbDown', 'pinkyUp', 'pinkyDown',
  'skipUp', 'repeatUp', 'walk',
];
/** 0..1 selector position <-> pattern index (the `arp_pattern` host param). */
export const arpModeToPos = (m: ArpMode): number => {
  const i = ARP_MODES.indexOf(m);
  return i < 0 ? 0 : i / (ARP_MODES.length - 1);
};
export const arpPosToMode = (pos: number): ArpMode =>
  ARP_MODES[Math.max(0, Math.min(ARP_MODES.length - 1,
    Math.round(Math.max(0, Math.min(1, pos)) * (ARP_MODES.length - 1))))];
const SEQ_DIRECTIONS: SeqDirection[] = ['fwd', 'bwd', 'bounce', 'bounceExcl', 'random', 'randomNoRepeat', 'drunk', 'converge', 'diverge'];
const RATE_DIVS: RateDiv[] = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32'];
const AUTO_REGEN_BARS = [0, 0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8];
/** How many arp knobs carry their own dice. MUST equal `kKnobDice` in
 *  `spike/elementary/plugin/ArpEngine.h` — the C++ side indexes `knobDice` by
 *  the `KnobDice` enum there, so a count mismatch would read past the array.
 *  Order: rate, octaves, swing, pattern, gate.
 *
 *  The Pattern dice lives under the PATTERN card's selector rather than in the
 *  Timing row (it dice the pattern, not the timing), but it shares this array
 *  so one normalisation and one engine read cover all of them. */
export const KNOB_DICE_COUNT = 5;

/** How many STEP LANES carry their own dice. Index 0 = transpose, 1 = gate. */
export const LANE_DICE_COUNT = 2;

/** Index of each dice in `knobDice` / `knobDiceBipolar`. Mirrors the `KnobDice`
 *  enum in `ArpEngine.h`; the labels are what the UI renders. */
export const KNOB_DICE_KEYS = ['rate', 'octaves', 'swing', 'pattern', 'gate'] as const;
export type KnobDiceKey = typeof KNOB_DICE_KEYS[number];

export function defaultSeqLane(id: LaneId): SeqLane {
  return {
    base: Array.from({ length: SEQ_STEPS }, () => LANE_DEFAULT[id]),
    overlay: Array.from({ length: SEQ_STEPS }, () => null),
    amount: 0,
    length: SEQ_STEPS,
    div: 1,
    rotation: 0,
    locked: Array.from({ length: SEQ_STEPS }, () => false),
    rollToken: 0,
    dicePolarity: 'pos',
  };
}

export function defaultSeqSettings(): SeqSettings {
  const lanes = {} as Record<LaneId, SeqLane>;
  for (const id of LANE_IDS) lanes[id] = defaultSeqLane(id);
  return {
    enabled: false,
    direction: 'fwd',
    length: 8,
    polymetry: true,
    resetAfter: 0,
    pitchTranspose: 0,
    lanes,
  };
}

export function defaultArpSettings(): ArpSettings {
  return {
    on: false,
    mode: 'up',
    hold: false,
    octaves: 1,
    rate: { sync: true, div: '1/16', feel: 'straight', hz: 8 },
    swing: 50,
    gate: 0.6,
    velocityPct: 0.5,
    keySnap: false,
    keyRoot: 0,
    keyScale: 'major',
    seq: defaultSeqSettings(),
    arp: {
      useStepLanes: false,
      stepTranspose: Array.from({ length: SEQ_STEPS }, () => 0),
      // Shorten lanes default to 0 = "play at the Gate knob's length", which is
      // the neutral value. A lane defaulting to anything else would alter every
      // existing song on load with no visible cause.
      stepShorten: Array.from({ length: SEQ_STEPS }, () => 0),
      stepVel: Array.from({ length: SEQ_STEPS }, () => 1),
      stepSlide: Array.from({ length: SEQ_STEPS }, () => 0),
      laneDice: [0, 0],
      laneDiceBipolar: [1, 1],
      layers: {
        chord: [false, false, false, false, false],
        arp: [[false, false, true, false, false], [false, false, false, false, false]],
      },
      tightRelease: true,
      chordHit: false,
      humanize: 0,
      shape: 0,
    },
    generation: { autoRegen: 2, chaos: 'live', chaosAmount: 1, knobDice: Array.from({ length: KNOB_DICE_COUNT }, () => 0), knobDiceBipolar: Array.from({ length: KNOB_DICE_COUNT }, () => 1), seed: 1, regenToken: 0, clearToken: 0 },
    blue: {
      rate: { sync: true, div: '1/16', feel: 'straight', hz: 8 },
      pattern: 'up',
      octaves: 1,
      swing: 50,
      gate: 0.6,
      chaosAmount: 1,
      knobDice: Array.from({ length: KNOB_DICE_COUNT }, () => 0),
      knobDiceBipolar: Array.from({ length: KNOB_DICE_COUNT }, () => 1),
    },
    scale: { weights: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], snap: false },
  };
}


/** Stereo feedback delay on the master bus. */
export interface DelayFxSettings {
  enabled: boolean;
  /** Delay time, 1..2000 ms. */
  timeMs: number;
  /** Feedback amount, 0..0.95. */
  feedback: number;
  /** Wet-path high-cut (tone/damp) — lowpass on the echoes, 0 (dark) .. 1 (open). */
  tone: number;
  /** Wet-path low-cut — highpass on the echoes, 0 (off ~20 Hz) .. 1 (~800 Hz). */
  locut: number;
  /** Time-modulation depth (chorus / tape wow), 0 .. 1. */
  mod: number;
  /** Modulation LFO rate, 0.05 .. 5 Hz. */
  rate: number;
  /** Stereo width — L/R cross-feed toward ping-pong, 0 .. 1. */
  width: number;
  /** Diffusion — allpass smear on the repeats, 0 (clean) .. 1 (smeared). */
  diffusion: number;
  /** Wet mix, 0 (bypassed) .. 1. */
  mix: number;
}

/** Schroeder-style reverb on the master bus. */
export interface ReverbFxSettings {
  enabled: boolean;
  /** Room size — scales the comb delay lengths, 0 (tight) .. 1 (large). */
  size: number;
  /** Decay / tail length — comb feedback, 0 (short) .. 1 (long). */
  decay: number;
  /** High-frequency damping (high-cut on the tail), 0 (bright) .. 1 (dark). */
  damp: number;
  /** Low-cut on the tail, 0 (off) .. 1 (~800 Hz). */
  locut: number;
  /** Tail-modulation depth (movement in the reverb), 0 .. 1. */
  mod: number;
  /** Modulation LFO rate, 0.05 .. 5 Hz. */
  rate: number;
  /** Stereo width of the reflection field, 0 (mono) .. 1 (wide). */
  width: number;
  /** Diffusion — extra allpass smear / density, 0 .. 1. */
  diffusion: number;
  /** Wet mix, 0 (bypassed) .. 1. */
  mix: number;
}

/** Stereo soft-clipping distortion on the master bus. */
export interface DistortionFxSettings {
  enabled: boolean;
  /** Input drive, 0 (clean) .. 1 (heavy saturation). */
  drive: number;
  /** Post-shaper tone, 0 (dark) .. 1 (open). */
  tone: number;
  /** Wet mix, 0 (bypassed) .. 1. */
  mix: number;
}

/** Stereo chorus on the master bus. */
export interface ChorusFxSettings {
  enabled: boolean;
  /** Modulation LFO rate, 0.05..5 Hz. */
  rate: number;
  /** Delay-time modulation depth, 0..1. */
  depth: number;
  /** Stereo width — L/R LFO phase offset, 0 (mono) .. 1 (wide). */
  width: number;
  /** Wet mix, 0 (bypassed) .. 1. */
  mix: number;
}

/** Stereo feedback flanger on the master bus. */
export interface FlangerFxSettings {
  enabled: boolean;
  /** LFO rate, 0.05..5 Hz. */
  rate: number;
  /** Delay-time modulation depth, 0..1. */
  depth: number;
  /** Feedback amount, 0..0.9. */
  feedback: number;
  /** Stereo width — L/R LFO phase offset, 0 (mono) .. 1 (wide). */
  width: number;
  /** Wet mix, 0 (bypassed) .. 1. */
  mix: number;
}

/** 3-band DOOM Upward Compressor settings. */
export interface CompressorFxSettings {
  enabled: boolean;
  /** Low-mid crossover frequency (100..800 Hz). */
  lowFreq: number;
  /** Mid-high crossover frequency (1000..10000 Hz). */
  highFreq: number;

  // LOW Band
  lowFloorDb: number;      // -120 to -12 dB (default -55 dB)
  lowCeilingDb: number;    // -24 to 0 dB (default 0 dB)
  lowAmount: number;       // 0 to 1 (default 0.5)
  lowAttackMs: number;     // 0 to 100 ms (default 0 ms)
  lowReleaseMs: number;    // 1 to 1000 ms (default 120 ms)

  // MID Band
  midFloorDb: number;      // -120 to -12 dB (default -55 dB)
  midCeilingDb: number;    // -24 to 0 dB (default 0 dB)
  midAmount: number;       // 0 to 1 (default 0.5)
  midAttackMs: number;     // 0 to 100 ms (default 0 ms)
  midReleaseMs: number;    // 1 to 1000 ms (default 120 ms)

  // HIGH Band
  highFloorDb: number;     // -120 to -12 dB (default -55 dB)
  highCeilingDb: number;   // -24 to 0 dB (default 0 dB)
  highAmount: number;      // 0 to 1 (default 0.5)
  highAttackMs: number;    // 0 to 100 ms (default 0 ms)
  highReleaseMs: number;   // 1 to 1000 ms (default 120 ms)

  /** Global Drive / Saturation boost, 0..1. */
  drive: number;
  /** Global Tanh Crush distortion, 0..1. */
  crush: number;
  /** Post-compression makeup gain (0..2, default 1 = 0dB). */
  gain: number;
  /** Wet mix, 0..1. */
  mix: number;

  // Legacy fields kept for backward compatibility
  threshold?: number;
  ratio?: number;
  attackMs?: number;
  releaseMs?: number;
}

/** Stereo multi-stage phaser on the master bus. */
export interface PhaserFxSettings {
  enabled: boolean;
  /** LFO rate, 0.05..5 Hz. */
  rate: number;
  /** Modulation depth, 0..1. */
  depth: number;
  /** Feedback amount, 0..0.9. */
  feedback: number;
  /** Number of all-pass stages, 2..8. */
  stages: number;
  /** Wet mix, 0..1. */
  mix: number;
}

/** A parametric EQ band type — 'bell' (peak) is the everyday case; the two
 *  shelves are meant for one band each at the extremes of the spectrum
 *  (todo.md — user wants a FabFilter Pro-Q-style graphic editor: "no knobs
 *  at all... controllable in the graphic pane" — double-click adds a bell,
 *  a band's type only needs to change via the popout editor, not a knob). */
export type EqBandType = 'bell' | 'lowshelf' | 'highshelf' | 'lowpass' | 'highpass' | 'notch';

export const MAX_EQ_BANDS = 8;
export const EQ_FREQ_MIN = 20;
export const EQ_FREQ_MAX = 20000;
export const EQ_GAIN_MIN = -18;
export const EQ_GAIN_MAX = 18;
export const EQ_Q_MIN = 0.1;
export const EQ_Q_MAX = 18;

export interface EqBand {
  /** Stable identity across edits (styles.css `.knob-mod-plus` and the LFO
   *  `FunctionPoint` both learned this lesson already) — an array INDEX
   *  breaks the moment an earlier band is deleted, since every later band
   *  silently becomes "a different point" mid-drag. */
  id: string;
  /** Center (bell) or corner (shelf) frequency, Hz. */
  freq: number;
  /** Gain at this band, dB. */
  gain: number;
  /** Resonance/bandwidth — higher Q narrows a bell, steepens a shelf. */
  q: number;
  type: EqBandType;
}

let eqBandIdSeq = 0;
/** `Date.now()` alone can collide if two bands are added in the same
 *  millisecond (a fast double-double-click); the counter breaks the tie. */
export function newEqBandId(): string {
  eqBandIdSeq += 1;
  return `eqb_${Date.now().toString(36)}_${eqBandIdSeq}`;
}

/** Real parametric EQ on the master bus — an arbitrary (0..`MAX_EQ_BANDS`)
 *  set of bell/shelf bands, each with its own freq/gain/Q, editable only
 *  through the graphic pane (todo.md — replaces the old fixed 3-band
 *  low/mid/high shelf-gain design, which had no frequency or Q control at
 *  all). `mix` stays wired at the native/flat-param level (host automation,
 *  parallel-EQ use) but isn't exposed as a UI knob — with zero bands the
 *  chain is transparent regardless of mix, so a fresh EQ defaults to fully
 *  wet and "just works" the instant a band is added. */
export interface EqFxSettings {
  enabled: boolean;
  mix: number;
  bands: EqBand[];
}

/**
 * A master-FX chain slot's occupant (todo.md §113 — reorderable chain
 * infra). `'off'` is an empty slot. More types (distortion, chorus,
 * flanger, phaser, EQ, compressor) get appended here as they're built —
 * each keeps its OWN settings object (like `delay`/`reverb` below), so
 * adding a type never touches this union's existing members.
 */
export type FxChainSlotType = 'off' | 'delay' | 'reverb' | 'distortion' | 'chorus' | 'flanger' | 'compressor' | 'phaser' | 'eq';
export const NUM_FX_SLOTS = 8;

export interface FxSettings {
  delay: DelayFxSettings;
  reverb: ReverbFxSettings;
  distortion: DistortionFxSettings;
  chorus: ChorusFxSettings;
  flanger: FlangerFxSettings;
  compressor: CompressorFxSettings;
  phaser: PhaserFxSettings;
  eq: EqFxSettings;
  /**
   * Chain order (todo.md §113) — `NUM_FX_SLOTS` entries, processed in array   *  order. Each entry names which settings object runs in that position;
   *  `'off'` is a spare slot. A fresh patch defaults every slot to `'off'`;
   *  existing patches with an explicit chain keep their saved order.


   */
  chain: FxChainSlotType[];
}

/** Minimum velocity the piano-key pointer mapping ever emits (still audibly quiet, never a silent 0). */
export const VELOCITY_MIN = 0.2;

/**
 * Apply the global velocity curve to a normalized click position `rel`
 * (0 = top of the key, 1 = bottom). `curve` is -1 (soft) .. +1 (hard),
 * 0 = linear. Returns VELOCITY_MIN..1.
 *
 * The curve is applied as a power exponent `2^(curve*2)` (0.25..4):
 *   - curve < 0 → exponent < 1 → light clicks rise toward full velocity fast
 *   - curve > 0 → exponent > 1 → velocity stays low until the click is deep
 * Both endpoints are preserved (top = VELOCITY_MIN, bottom = 1) — only the
 * middle of the key's travel reshapes.
 */
export function applyVelocityCurve(rel: number, curve: number): number {
  const c = Math.max(-1, Math.min(1, curve));
  const r = Math.max(0, Math.min(1, rel));
  const power = Math.pow(2, c * 2);
  return VELOCITY_MIN + (1 - VELOCITY_MIN) * Math.pow(r, power);
}

function defaultOperatorPitch(): OperatorPitch {
  return 0;
}

/**
 * Default oscillator slots.
 *
 * The on/off checkbox is gone (todo.md — "oscillators don't need the on/off
 * check mark, they should all be on, always"): every slot is ALWAYS
 * enabled, and the way you silence one is its level knob at 0. Default
 * levels are therefore 0 across the board — the init patch is a blank
 * canvas, you dial in what you want. Slots stay sawtooth/sine/sine/sine
 * with the Phase-4 stereo spread so raising a level is instantly musical.
 */
export function defaultOscillatorSlots(): OscillatorSlotSettings[] {
  return [
    { enabled: true, wave: 'wavetable', wtId: 0, wtPos: 0, wavetablePosition: wavePositionForShape('sine'), pitch: defaultOperatorPitch(), level: 1, pan: 0, rootHz: 440, mods: {}, filterMix: 0 },
    { enabled: true, wave: 'wavetable', wtId: 0, wtPos: 0, wavetablePosition: wavePositionForShape('sine'), pitch: defaultOperatorPitch(), level: 0, pan: -0.4, rootHz: 440, mods: {}, filterMix: 0 },
    { enabled: true, wave: 'wavetable', wtId: 0, wtPos: 0, wavetablePosition: wavePositionForShape('sine'), pitch: defaultOperatorPitch(), level: 0, pan: 0.4, rootHz: 440, mods: {}, filterMix: 0 },
    { enabled: true, wave: 'wavetable', wtId: 0, wtPos: 0, wavetablePosition: wavePositionForShape('sine'), pitch: defaultOperatorPitch(), level: 0, pan: 0, rootHz: 440, mods: {}, filterMix: 0 },
  ];
}

/** Operators that `source` currently phase-modulates (amount > 0). */
function modulatedTargetsOf(
  source: OperatorId,
  synth: Pick<SynthSettings, 'oscillators'>,
): OperatorId[] {
  const out: OperatorId[] = [];
  for (const op of OPERATOR_IDS) {
    const slot = synth.oscillators[oscSlotIndex(op)];
    const entry = (slot?.mods ?? {})[source];
    if (entry && (entry.pm > 0 || entry.fm > 0)) out.push(op);
  }
  return out;
}

/**
 * True if routing `candidate` → `target` would close a phase-modulation
 * cycle. Web Audio forbids cyclic graphs without a DelayNode in the loop,
 * so the engine and the UI both use this to refuse cyclic routes before
 * they'd silently fail to connect. With several simultaneous sources per
 * operator this is a small reachability check rather than the old
 * single-source chain-following.
 */
export function wouldCreateModCycle(
  target: OperatorId,
  candidate: OperatorId,
  synth: Pick<SynthSettings, 'oscillators'>,
): boolean {
  if (target === candidate) return true;
  const stack: OperatorId[] = [target];
  const seen = new Set<OperatorId>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const t of modulatedTargetsOf(cur, synth)) {
      if (t === candidate) return true;
      stack.push(t);
    }
  }
  return false;
}

/** Operator ids `target` may safely receive phase-modulation from right now. */
export function safeModSourceOptions(
  target: OperatorId,
  synth: Pick<SynthSettings, 'oscillators'>,
): OperatorId[] {
  return OPERATOR_IDS.filter((id) => id !== target && !wouldCreateModCycle(target, id, synth));
}

function normalizeAdsr(v: unknown, fallback: AdsrEnvelope): AdsrEnvelope {
  const e = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const num = (n: unknown, d: number) => (typeof n === 'number' && Number.isFinite(n) ? n : d);
  const curve = (n: unknown, d: number) => Math.max(-1, Math.min(1, num(n, d)));
  return {
    attackSec: Math.max(0, num(e.attackSec, fallback.attackSec)),
    decaySec: Math.max(0, num(e.decaySec, fallback.decaySec)),
    sustainLevel: Math.max(0, Math.min(1, num(e.sustainLevel, fallback.sustainLevel))),
    releaseSec: Math.max(0, num(e.releaseSec, fallback.releaseSec)),
    attackCurve: curve(e.attackCurve, fallback.attackCurve),
    decayCurve: curve(e.decayCurve, fallback.decayCurve),
    releaseCurve: curve(e.releaseCurve, fallback.releaseCurve),
  };
}

const MOD_SOURCE_IDS: readonly ModSourceId[] = [
  'env1', 'env2', 'env3', 'lfo1', 'lfo2', 'lfo3', 'velocity', 'keytrack',
  'macro1', 'macro2', 'macro3', 'macro4', 'macro5', 'macro6', 'macro7', 'macro8',
  'audiofollower', 'env4', 'env5', 'lfo4', 'lfo5', 'lfo6',
  'env6', 'env7', 'env8', 'lfo7', 'lfo8',
  'audiofollower2', 'audiofollower3', 'audiofollower4',
  'env9', 'env10', 'env11', 'lfo9', 'lfo10',
  'audiofollower5', 'audiofollower6', 'audiofollower7', 'audiofollower8', 'audiofollower9', 'audiofollower10',
];

export const DEFAULT_AUDIO_FOLLOWER: AudioFollowerSettings = { loHz: 20, hiHz: 20000, attackMs: 5, releaseMs: 50, gainDb: 15, source: 1 };
export const DEFAULT_MODULE_ENV: AdsrEnvelope = { attackSec: 0.01, decaySec: 0.3, sustainLevel: 0.4, releaseSec: 0.6, attackCurve: 0, decayCurve: 0, releaseCurve: 0 };
const MODULE_LFO_DEFAULTS: Record<(typeof EXTRA_LFO_IDS)[number], { rateHz: number; shape: 'sine' | 'triangle' | 'sawtooth' | 'square' }> = {
  lfo4: { rateHz: 4, shape: 'sine' }, lfo5: { rateHz: 0.5, shape: 'triangle' }, lfo6: { rateHz: 1, shape: 'sawtooth' },
  lfo7: { rateHz: 2, shape: 'sine' }, lfo8: { rateHz: 0.25, shape: 'triangle' },
  lfo9: { rateHz: 3, shape: 'sawtooth' }, lfo10: { rateHz: 0.75, shape: 'sine' },
};
/** Fresh settings for an added LFO instance (LFO 4-8). */
export function defaultModuleLfo(id: (typeof EXTRA_LFO_IDS)[number]): LfoSettings {
  const d = MODULE_LFO_DEFAULTS[id];
  return { rateHz: d.rateHz, sync: false, perNote: false, wave: 'function', shapePosition: 0, functionShape: functionShapeForLegacyWave(d.shape) };
}

function normalizeModules(v: unknown): ModuleSet {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, any>;
  const out: Record<string, unknown> = {};
  const clampNum = (x: unknown, lo: number, hi: number, d: number) =>
    typeof x === 'number' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d;
  for (const id of AF_MODULE_IDS) {
    const a = r[id];
    if (!a || typeof a !== 'object') continue;
    const lo = clampNum(a.loHz, 20, 20000, 20);
    const hi = clampNum(a.hiHz, 20, 20000, 20000);
    out[id] = {
      loHz: Math.min(lo, hi), hiHz: Math.max(lo, hi),
      attackMs: clampNum(a.attackMs, 0.1, 500, 5),
      releaseMs: clampNum(a.releaseMs, 1, 3000, 120),
      gainDb: clampNum(a.gainDb, -24, 48, 12),
      source: Math.round(clampNum(a.source, 0, 1, 0)),
    };
  }
  for (const id of EXTRA_ENV_IDS) if (r[id]) out[id] = normalizeAdsr(r[id], DEFAULT_MODULE_ENV);
  for (const id of EXTRA_LFO_IDS) if (r[id]) out[id] = normalizeLfo(r[id], defaultModuleLfo(id));
  for (const k of ['env2', 'env3', 'lfo1', 'lfo2', 'lfo3'] as const) if (r[k]) out[k] = true;
  return out as ModuleSet;
}

/** Clamp/pad a persisted macro array to exactly `NUM_MACROS` entries, each 0..1. */
function normalizeMacros(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : [];
  return Array.from({ length: NUM_MACROS }, (_, i) => {
    const n = arr[i];
    return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  });
}

/** Drop routes whose source no longer exists (`sh` / `random` retired, §88.A)
 *  and any non-array/garbage entries. */
function normalizeModMap(v: unknown): ModMap {
  if (!v || typeof v !== 'object') return {};
  const out: ModMap = {};
  for (const [target, routes] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(routes)) continue;
    const kept = routes.filter(
      (r): r is ModRoute =>
        !!r && typeof r === 'object'
        && MOD_SOURCE_IDS.includes((r as ModRoute).source)
        && typeof (r as ModRoute).amount === 'number',
    );
    if (kept.length) (out as Record<string, ModRoute[]>)[target] = kept;
  }
  return out;
}

const LEGACY_LFO_WAVES = ['sine', 'triangle', 'sawtooth', 'square'] as const;
function isLegacyLfoWave(w: unknown): w is (typeof LEGACY_LFO_WAVES)[number] {
  return typeof w === 'string' && (LEGACY_LFO_WAVES as readonly string[]).includes(w);
}

function normalizeLfo(v: unknown, fallback: LfoSettings): LfoSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const num = (n: unknown, d: number, lo: number, hi: number) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  const waves: LfoWave[] = ['sine', 'triangle', 'sawtooth', 'square', 'sample-hold', 'function'];
  const rawWave = waves.includes(o.wave as LfoWave) ? (o.wave as LfoWave) : fallback.wave;
  // Every LFO is a Function now — the editor dropped its separate
  // continuous-morph UI (no more discrete sine/triangle/sawtooth/square
  // pick), so any of those legacy values coerces to 'function' here, with a
  // matching breakpoint shape synthesized so an existing patch keeps
  // sounding the same instead of jumping to a generic default bump.
  const wave: LfoWave = rawWave === 'sample-hold' ? 'sample-hold' : 'function';
  const functionShape = normalizeFunctionShape(
    o.functionShape,
    isLegacyLfoWave(rawWave) ? functionShapeForLegacyWave(rawWave) : (fallback.functionShape ?? defaultFunctionShape()),
  );
  return {
    rateHz: num(o.rateHz, fallback.rateHz, 0.01, 20000), // up to 20 kHz — audio-rate LFO (kHz unit, todo.md)
    sync: typeof o.sync === 'boolean' ? o.sync : !!fallback.sync,
    perNote: typeof o.perNote === 'boolean' ? o.perNote : !!fallback.perNote,
    wave,
    shapePosition: num(o.shapePosition, fallback.shapePosition, 0, 1),
    functionShape,
  };
}

function normalizeFilter(v: unknown, fallback: FilterSettings): FilterSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const num = (n: unknown, d: number, lo: number, hi: number) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  const types: FilterType[] = ['lowpass', 'highpass', 'bandpass'];
  const slopes: FilterSlope[] = ['12', '24'];
  return {
    type: types.includes(o.type as FilterType) ? (o.type as FilterType) : fallback.type,
    slope: slopes.includes(o.slope as FilterSlope) ? (o.slope as FilterSlope) : fallback.slope,
    cutoffHz: num(o.cutoffHz, fallback.cutoffHz, 20, 20000),
    resonance: num(o.resonance, fallback.resonance, 0.0001, 24),
  };
}

const FX_CHAIN_TYPES: FxChainSlotType[] = ['off', 'delay', 'reverb', 'distortion', 'chorus', 'flanger', 'compressor', 'phaser', 'eq'];
const DEFAULT_FX_CHAIN: FxChainSlotType[] = ['off', 'off', 'off', 'off', 'off', 'off', 'off', 'off'];

/** Clamp/pad a persisted chain to exactly `NUM_FX_SLOTS` entries, dropping
 *  unknown slot types to 'off' rather than throwing the whole array out. */
function normalizeFxChain(v: unknown): FxChainSlotType[] {
  const arr = Array.isArray(v) ? v : DEFAULT_FX_CHAIN;
  return Array.from({ length: NUM_FX_SLOTS }, (_, i) => {
    const t = arr[i];
    return FX_CHAIN_TYPES.includes(t as FxChainSlotType) ? (t as FxChainSlotType) : 'off';
  });
}

function normalizeEqBand(v: unknown): EqBand | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const num = (n: unknown, def: number, lo: number, hi: number) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
  const validTypes: EqBandType[] = ['bell', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'notch'];
  const type: EqBandType = validTypes.includes(o.type as EqBandType) ? (o.type as EqBandType) : 'bell';
  return {
    id: typeof o.id === 'string' && o.id ? o.id : newEqBandId(),
    freq: num(o.freq, 1000, EQ_FREQ_MIN, EQ_FREQ_MAX),
    gain: num(o.gain, 0, EQ_GAIN_MIN, EQ_GAIN_MAX),
    q: num(o.q, 0.7, EQ_Q_MIN, EQ_Q_MAX),
    type,
  };
}

export function normalizeEqBands(v: unknown): EqBand[] {
  const arr = Array.isArray(v) ? v : [];
  return arr
    .map(normalizeEqBand)
    .filter((b): b is EqBand => b !== null)
    .slice(0, MAX_EQ_BANDS);
}

function normalizeFx(v: unknown): FxSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d = (o.delay && typeof o.delay === 'object' ? o.delay : {}) as Record<string, unknown>;
  const rv = (o.reverb && typeof o.reverb === 'object' ? o.reverb : {}) as Record<string, unknown>;
  const ds = (o.distortion && typeof o.distortion === 'object' ? o.distortion : {}) as Record<string, unknown>;
  const ch = (o.chorus && typeof o.chorus === 'object' ? o.chorus : {}) as Record<string, unknown>;
  const fl = (o.flanger && typeof o.flanger === 'object' ? o.flanger : {}) as Record<string, unknown>;
  const cm = (o.compressor && typeof o.compressor === 'object' ? o.compressor : {}) as Record<string, unknown>;
  const ph = (o.phaser && typeof o.phaser === 'object' ? o.phaser : {}) as Record<string, unknown>;
  const eq = (o.eq && typeof o.eq === 'object' ? o.eq : {}) as Record<string, unknown>;
  const chain = normalizeFxChain(o.chain);
  const enabledFor = (value: unknown, type: FxChainSlotType) =>
    typeof value === 'boolean' ? value : chain.includes(type);
  const num = (n: unknown, def: number, lo: number, hi: number) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
  return {
    chain,
    delay: {
      enabled: enabledFor(d.enabled, 'delay'),
      timeMs: num(d.timeMs, 300, 1, 2000),
      feedback: num(d.feedback, 0.3, 0, 0.95),
      tone: num(d.tone, 0.7, 0, 1),
      locut: num(d.locut, 0.05, 0, 1),
      mod: num(d.mod, 0, 0, 1),
      rate: num(d.rate, 0.6, 0.05, 5),
      width: num(d.width, 0.3, 0, 1),
      diffusion: num(d.diffusion, 0.2, 0, 1),
      mix: num(d.mix, 0, 0, 1),
    },
    reverb: {
      enabled: enabledFor(rv.enabled, 'reverb'),
      size: num(rv.size, 0.5, 0, 1),
      decay: num(rv.decay, 0.5, 0, 1),
      damp: num(rv.damp, 0.5, 0, 1),
      locut: num(rv.locut, 0.05, 0, 1),
      mod: num(rv.mod, 0.15, 0, 1),
      rate: num(rv.rate, 0.5, 0.05, 5),
      width: num(rv.width, 0.5, 0, 1),
      diffusion: num(rv.diffusion, 0.4, 0, 1),
      mix: num(rv.mix, 0, 0, 1),
    },
    distortion: {
      enabled: enabledFor(ds.enabled, 'distortion'),
      drive: num(ds.drive, 0.35, 0, 1),
      tone: num(ds.tone, 0.7, 0, 1),
      mix: num(ds.mix, 0, 0, 1),
    },
    chorus: {
      enabled: enabledFor(ch.enabled, 'chorus'),
      rate: num(ch.rate, 0.35, 0.05, 5),
      depth: num(ch.depth, 0.45, 0, 1),
      width: num(ch.width, 0.65, 0, 1),
      mix: num(ch.mix, 0, 0, 1),
    },
    flanger: {
      enabled: enabledFor(fl.enabled, 'flanger'),
      rate: num(fl.rate, 0.25, 0.05, 5),
      depth: num(fl.depth, 0.55, 0, 1),
      feedback: num(fl.feedback, 0.45, 0, 0.9),
      width: num(fl.width, 0.7, 0, 1),
      mix: num(fl.mix, 0, 0, 1),
    },
    compressor: {
      enabled: enabledFor(cm.enabled, 'compressor'),
      lowFreq: num(cm.lowFreq, 250, 100, 800),
      highFreq: num(cm.highFreq, 2500, 1000, 10000),

      lowFloorDb: num(cm.lowFloorDb ?? (cm.threshold != null ? -120 + (cm.threshold as number) * 108 : -55), -55, -120, -12),
      lowCeilingDb: num(cm.lowCeilingDb, 0, -24, 0),
      lowAmount: num(cm.lowAmount ?? (cm.ratio != null ? cm.ratio as number : 0.5), 0.5, 0, 1),
      lowAttackMs: num(cm.lowAttackMs ?? (cm.attackMs != null ? cm.attackMs as number : 0), 0, 0, 100),
      lowReleaseMs: num(cm.lowReleaseMs ?? (cm.releaseMs != null ? cm.releaseMs as number : 120), 120, 1, 1000),

      midFloorDb: num(cm.midFloorDb ?? (cm.threshold != null ? -120 + (cm.threshold as number) * 108 : -55), -55, -120, -12),
      midCeilingDb: num(cm.midCeilingDb, 0, -24, 0),
      midAmount: num(cm.midAmount ?? (cm.ratio != null ? cm.ratio as number : 0.5), 0.5, 0, 1),
      midAttackMs: num(cm.midAttackMs ?? (cm.attackMs != null ? cm.attackMs as number : 0), 0, 0, 100),
      midReleaseMs: num(cm.midReleaseMs ?? (cm.releaseMs != null ? cm.releaseMs as number : 120), 120, 1, 1000),

      highFloorDb: num(cm.highFloorDb ?? (cm.threshold != null ? -120 + (cm.threshold as number) * 108 : -55), -55, -120, -12),
      highCeilingDb: num(cm.highCeilingDb, 0, -24, 0),
      highAmount: num(cm.highAmount ?? (cm.ratio != null ? cm.ratio as number : 0.5), 0.5, 0, 1),
      highAttackMs: num(cm.highAttackMs ?? (cm.attackMs != null ? cm.attackMs as number : 0), 0, 0, 100),
      highReleaseMs: num(cm.highReleaseMs ?? (cm.releaseMs != null ? cm.releaseMs as number : 120), 120, 1, 1000),

      drive: num(cm.drive, 0, 0, 1),
      crush: num(cm.crush, 0, 0, 1),
      gain: num(cm.gain, 1.0, 0, 2),
      mix: num(cm.mix, 0, 0, 1),

      threshold: cm.threshold != null ? num(cm.threshold, 0.5, 0, 1) : undefined,
      ratio: cm.ratio != null ? num(cm.ratio, 0.4, 0, 1) : undefined,
      attackMs: cm.attackMs != null ? num(cm.attackMs, 0, 0, 100) : undefined,
      releaseMs: cm.releaseMs != null ? num(cm.releaseMs, 120, 1, 1000) : undefined,
    },
    phaser: {
      enabled: enabledFor(ph.enabled, 'phaser'),
      rate: num(ph.rate, 0.35, 0.05, 5),
      depth: num(ph.depth, 0.65, 0, 1),
      feedback: num(ph.feedback, 0.35, 0, 0.9),
      stages: Math.round(num(ph.stages, 4, 2, 8)),
      mix: num(ph.mix, 0, 0, 1),
    },
    eq: {
      enabled: enabledFor(eq.enabled, 'eq'),
      mix: num(eq.mix, 1, 0, 1),
      bands: normalizeEqBands(eq.bands),
    },
  };
}

/**
 * Migrate/repair a persisted `synth` block into the current shape. Handles
 * three cases: (a) a Phase-1.5-era file (flat `wave` / `oscillatorLevel` /
 * `sampleRootHz` / `sampleMaxSeconds`, no `oscillators` array) — folds it
 * into osc1 (and enables the sampler slot if the old wave was `'sample'`);
 * (b) a new-shape file missing/short an array — defaults pad it; (c) minor
 * per-field corruption (out-of-range numbers, unknown enum values) — clamped
 * back to sane defaults rather than the whole block being thrown out.
 */
export function normalizeSynthSettings(raw: unknown): SynthSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const isLegacyFlatShape = !Array.isArray(r.oscillators) && typeof r.wave === 'string';

  const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    return Math.max(lo, Math.min(hi, n));
  };
  const normalizePitch = (v: unknown): OperatorPitch => {
    if (typeof v === 'number' && Number.isFinite(v)) return clampNum(v, -36, 36, 0);
    if (v && typeof v === 'object') {
      // Legacy { octave, semitone, fineCents } struct → continuous semitones.
      const p = v as Record<string, any>;
      return clampNum((p.octave ?? 0) * 12 + (p.semitone ?? 0) + (p.fineCents ?? 0) / 100, -36, 36, 0);
    }
    return 0;
  };
  const normalizeWave = (v: unknown, fallback: OscWave): OscWave => {
    const waves: OscWave[] = ['sine', 'triangle', 'sawtooth', 'square', 'sample'];
    return waves.includes(v as OscWave) ? (v as OscWave) : fallback;
  };
  const normalizeModSource = (v: unknown, selfId: OperatorId): OperatorId | null => {
    if (v == null || v === selfId || !OPERATOR_IDS.includes(v as OperatorId)) return null;
    return v as OperatorId;
  };
  const normalizeMods = (
    v: unknown,
    selfId: OperatorId,
    legacySource: unknown,
    legacyMode: unknown,
    legacyAmount: unknown,
  ): OperatorModMap => {
    const out: OperatorModMap = {};
    const put = (src: OperatorId, pm: number, fm: number) => {
      const e: OperatorModEntry = { pm: clampNum(pm, 0, 1, 0), fm: clampNum(fm, 0, 1, 0) };
      if (e.pm > 0 || e.fm > 0) out[src] = e;
    };
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (!OPERATOR_IDS.includes(k as OperatorId) || k === selfId) continue;
        if (val && typeof val === 'object') {
          const o = val as Record<string, any>;
          put(k as OperatorId, o.pm ?? 0, o.fm ?? 0);
        } else if (typeof val === 'number') {
          put(k as OperatorId, val, 0); // §30 plain-number shape = PM only
        }
      }
    } else {
      // Legacy single-source shape (modSource + modMode + modAmount).
      const src = normalizeModSource(legacySource, selfId);
      const amt = clampNum(legacyAmount, 0, 1, 0);
      if (src && amt > 0) put(src, legacyMode === 'pm' ? amt : 0, legacyMode === 'fm' ? amt : 0);
    }
    return out;
  };

  // §33: old files may still have a `sampler` sub-object (the dedicated 5th
  // operator, removed in Phase 1.11) or an old flat `wave: 'sample'` shape.
  // There's no single oscillator slot to fold an old *dedicated* sampler's
  // settings into (any of the 4 could be "the" sampler now), so that
  // sub-object's settings are intentionally dropped — captured sample
  // buffers were never persisted to the settings file anyway (runtime-only,
  // in the engine), so this only loses a pan/level/rootHz tweak, not audio.
  // The flat legacy shape DOES fold cleanly, though: `wave === 'sample'` is
  // now a completely normal osc1 wave choice.
  let oscillators: OscillatorSlotSettings[];
  if (Array.isArray(r.oscillators)) {
    const fallback = defaultOscillatorSlots();
    oscillators = [0, 1, 2, 3].map((i) => {
      const slot = (r.oscillators[i] && typeof r.oscillators[i] === 'object' ? r.oscillators[i] : {}) as Record<string, any>;
      const fb = fallback[i];
      const wave = normalizeWave(slot.wave, fb.wave);
      // The on/off checkbox is retired: every slot is always on. A slot that
      // used to be `enabled: false` migrates to level 0 — the "off" state
      // IS level 0 now, so a previously-disabled operator stays silent
      // instead of suddenly sounding with its old stored level.
      const wasDisabled = typeof slot.enabled === 'boolean' && slot.enabled === false;
      return {
        enabled: true,
        level: wasDisabled ? 0 : clampNum(slot.level, 0, 1, fb.level),
        wave,
        // §41: old files predate this field — fall back to the position the
        // slot's discrete `wave` used to mean, so upgrading doesn't change
        // how existing patches sound.
        wavetablePosition: clampNum(slot.wavetablePosition, 0, 1, wavePositionForShape(wave)),
        pitch: normalizePitch(slot.pitch),
        pan: clampNum(slot.pan, -1, 1, fb.pan),
        rootHz: clampNum(slot.rootHz, 20, 8000, fb.rootHz),
        mods: normalizeMods(slot.mods, OPERATOR_IDS[i], slot.modSource, slot.modMode, slot.modAmount),
        filterMix: clampNum(slot.filterMix, 0, 1, fb.filterMix),
        wtId: Math.max(0, Math.floor(clampNum(slot.wtId, 0, 1000, fb.wtId ?? 0))),
        wtPos: clampNum(slot.wtPos, 0, 1, fb.wtPos ?? 0),
        warpMode: Math.max(0, Math.floor(clampNum(slot.warpMode, 0, 29, fb.warpMode ?? 0))),
        warpAmount: clampNum(slot.warpAmount, 0, 1, fb.warpAmount ?? 0),
        warpParam2: clampNum(slot.warpParam2, 0, 1, fb.warpParam2 ?? 0.5),
        warpMode2: Math.max(0, Math.floor(clampNum(slot.warpMode2, 0, 29, fb.warpMode2 ?? 0))),
        warpAmount2: clampNum(slot.warpAmount2, 0, 1, fb.warpAmount2 ?? 0),
        warpParam2_2: clampNum(slot.warpParam2_2, 0, 1, fb.warpParam2_2 ?? 0.5),
      };
    });
  } else if (isLegacyFlatShape) {
    const fallback = defaultOscillatorSlots();
    const oldWave = r.wave as string;
    oscillators = [
      {
        enabled: true,
        wave: normalizeWave(oldWave, 'sawtooth'),
        wavetablePosition: wavePositionForShape(normalizeWave(oldWave, 'sawtooth')),
        pitch: defaultOperatorPitch(),
        level: clampNum(r.oscillatorLevel, 0, 1, 0.7),
        pan: 0,
        rootHz: clampNum(r.sampleRootHz, 20, 8000, 440),
        mods: {},
        filterMix: 0,
      },
      fallback[1],
      fallback[2],
      fallback[3],
    ];
  } else {
    oscillators = defaultOscillatorSlots();
  }

  return {
    octave: clampNum(r.octave, -3, 3, 0),
    semitone: clampNum(r.semitone, -12, 12, 0),
    fineTuneCents: clampNum(r.fineTuneCents, -100, 100, 0),
    voiceMode: Math.round(clampNum(r.voiceMode, 0, 2, 0)),
    glideSec: clampNum(r.glideSec, 0, 5, 0),
    voiceLevel: clampNum(r.voiceLevel ?? r.oscillatorLevel, 0, 1, 0.7),
    masterLevel: clampNum(r.masterLevel, 0, 1, 0.8),
    voiceLimit: Math.max(1, Math.min(32, typeof r.voiceLimit === 'number' ? r.voiceLimit : 16)),
    velocityCurve: clampNum(r.velocityCurve, -1, 1, 0),
    velCurve: clampNum(r.velCurve, -1, 1, 0),
    keyCurve: clampNum(r.keyCurve, -1, 1, 0),
    ampEnv: normalizeAdsr(r.ampEnv, { attackSec: 0.005, decaySec: 0.2, sustainLevel: 0.7, releaseSec: 0.4, attackCurve: 0, decayCurve: 0, releaseCurve: 0 }),
    modEnv: normalizeAdsr(r.modEnv, { attackSec: 0.01, decaySec: 0.25, sustainLevel: 0.5, releaseSec: 0.5, attackCurve: 0, decayCurve: 0, releaseCurve: 0 }),
    modEnv3: normalizeAdsr(r.modEnv3, { attackSec: 0.01, decaySec: 0.3, sustainLevel: 0.4, releaseSec: 0.6, attackCurve: 0, decayCurve: 0, releaseCurve: 0 }),
    lfo1: normalizeLfo(r.lfo1, { rateHz: 4, sync: false, perNote: false, wave: 'function', shapePosition: 0, functionShape: functionShapeForLegacyWave('sine') }),
    lfo2: normalizeLfo(r.lfo2, { rateHz: 0.5, sync: false, perNote: false, wave: 'function', shapePosition: 0, functionShape: functionShapeForLegacyWave('triangle') }),
    lfo3: normalizeLfo(r.lfo3, { rateHz: 2, sync: false, perNote: false, wave: 'function', shapePosition: 0, functionShape: functionShapeForLegacyWave('sawtooth') }),
    modules: normalizeModules(r.modules),
    mod: normalizeModMap(r.mod),
    macros: normalizeMacros(r.macros),
    // §60: dual filters. Old files had a single `filter` block — fold it
    // into Filter A (every operator already defaults to filterMix: 0, i.e.
    // "all Filter A", so this reproduces the old single-filter sound
    // exactly); Filter B falls back to the same wide-open default as A did.
    filterA: normalizeFilter(r.filterA ?? r.filter, { type: 'lowpass', slope: '12', cutoffHz: 20000, resonance: 0.707 }),
    filterB: normalizeFilter(r.filterB, { type: 'lowpass', slope: '12', cutoffHz: 20000, resonance: 0.707 }),
    fx: normalizeFx(r.fx),
    oscillators,
    arp: normalizeArpSettings(r.arp),
  };
}

// --- Arp / Seq normalisation (also migrates the pre-lane shape) ---
function aNum(v: unknown, lo: number, hi: number, def: number, int = false): number {
  if (typeof v !== 'number' || !isFinite(v)) return def;
  const c = Math.max(lo, Math.min(hi, v));
  return int ? Math.round(c) : c;
}
function aBool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}
function aArr(v: unknown, n: number, f: (x: unknown, i: number) => any): any[] {
  const a = Array.isArray(v) ? v : [];
  return Array.from({ length: n }, (_, i) => f(a[i], i));
}

function normalizeSeqLane(id: LaneId, raw: unknown, legacyBase?: number[]): SeqLane {
  const d = defaultSeqLane(id);
  const [lo, hi, isInt] = LANE_RANGE[id];
  const r = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {};
  const rawBase = Array.isArray(r.base) ? r.base : legacyBase;
  const div = (LANE_DIVS as readonly number[]).includes(r.div) ? (r.div as SeqLane['div']) : d.div;
  return {
    base: aArr(rawBase, SEQ_STEPS, (x) => aNum(x, lo, hi, LANE_DEFAULT[id], isInt)),
    overlay: aArr(r.overlay, SEQ_STEPS, (x) => (typeof x === 'number' && isFinite(x) ? aNum(x, lo, hi, LANE_DEFAULT[id], isInt) : null)),
    amount: aNum(r.amount, 0, 1, 0),
    length: aNum(r.length, 1, SEQ_STEPS, d.length, true),
    div,
    rotation: aNum(r.rotation, -64, 64, 0, true),
    locked: aArr(r.locked, SEQ_STEPS, (x) => aBool(x, false)),
    rollToken: aNum(r.rollToken, 0, 2147483647, 0, true),
    dicePolarity: DICE_POLARITIES.includes(r.dicePolarity as DicePolarity) ? (r.dicePolarity as DicePolarity) : 'pos',
  };
}

function normalizeSeq(raw: unknown): SeqSettings {
  const d = defaultSeqSettings();
  const r = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {};
  // Old shape: lanes is an ARRAY of {on,velocity,gate,octave,semitone}; `steps` is the length.
  const legacy: Partial<Record<LaneId, number[]>> = {};
  if (Array.isArray(r.lanes)) {
    const L = r.lanes as any[];
    const col = (key: string, lo: number, hi: number, def: number, int: boolean) =>
      Array.from({ length: SEQ_STEPS }, (_, i) => aNum(L[i]?.[key], lo, hi, def, int));
    legacy.on = Array.from({ length: SEQ_STEPS }, (_, i) => (L[i] && L[i].on === false ? 0 : 1));
    legacy.vel = col('velocity', 0, 1, 0.8, false);
    legacy.gate = col('gate', 0.05, 4, 0.6, false);
    legacy.octave = col('octave', -2, 2, 0, true);
    legacy.pitch = col('semitone', -12, 12, 0, true);
  }
  const rl = r.lanes && !Array.isArray(r.lanes) && typeof r.lanes === 'object' ? (r.lanes as Record<string, unknown>) : {};
  const lanes = {} as Record<LaneId, SeqLane>;
  for (const id of LANE_IDS) lanes[id] = normalizeSeqLane(id, rl[id], legacy[id]);
  return {
    enabled: aBool(r.enabled, d.enabled),
    direction: SEQ_DIRECTIONS.includes(r.direction) ? r.direction : d.direction,
    length: aNum(r.length ?? r.steps, 1, SEQ_STEPS, d.length, true),
    polymetry: aBool(r.polymetry, d.polymetry),
    resetAfter: aNum(r.resetAfter, 0, 256, 0, true),
    pitchTranspose: aNum(r.pitchTranspose, -24, 24, 0, true),
    lanes,
  };
}

export function normalizeArpSettings(raw: unknown): ArpSettings {
  const d = defaultArpSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, any>;
  const rateObj = !!r.rate && typeof r.rate === 'object';
  const rr = rateObj ? (r.rate as Record<string, any>) : {};
  const ex = r.arp && typeof r.arp === 'object' ? (r.arp as Record<string, any>) : {};
  const ly = ex.layers && typeof ex.layers === 'object' ? (ex.layers as Record<string, any>) : {};
  const gn = r.generation && typeof r.generation === 'object' ? (r.generation as Record<string, any>) : {};
  const bl = r.blue && typeof r.blue === 'object' ? (r.blue as Record<string, any>) : {};
  const blRate = bl.rate && typeof bl.rate === 'object' ? (bl.rate as Record<string, any>) : {};
  const sc = r.scale && typeof r.scale === 'object' ? (r.scale as Record<string, any>) : {};
  const rawRows: unknown[] = Array.isArray(ly.arp) ? ly.arp : [];
  // Old `rateHz` becomes the free-Hz rate (sync off) unless a new-style rate object is present.
  const legacyHz = typeof r.rateHz === 'number' && isFinite(r.rateHz);
  return {
    on: aBool(r.on, d.on),
    // `poly` was retired; it falls through to the default anyway now that it is
    // out of ARP_MODES, but say so explicitly so the intent survives.
    mode: r.mode === 'poly' ? 'up' : (ARP_MODES.includes(r.mode) ? r.mode : d.mode),
    hold: aBool(r.hold, d.hold),
    octaves: aNum(r.octaves, 1, 4, d.octaves, true),
    rate: {
      sync: rateObj ? aBool(rr.sync, d.rate.sync) : legacyHz ? false : d.rate.sync,
      div: RATE_DIVS.includes(rr.div) ? rr.div : d.rate.div,
      feel: rr.feel === 'triplet' || rr.feel === 'dotted' || rr.feel === 'straight' ? rr.feel : d.rate.feel,
      hz: aNum(rateObj ? rr.hz : legacyHz ? r.rateHz : undefined, 0.5, 20, d.rate.hz),
    },
    swing: aNum(r.swing, 50, 75, d.swing),
    gate: aNum(r.gate, 0.05, 4, d.gate),
    velocityPct: aNum(r.velocityPct, 0, 1, d.velocityPct),
    keySnap: aBool(r.keySnap, d.keySnap),
    keyRoot: typeof r.keyRoot === 'number' && isFinite(r.keyRoot) ? ((Math.round(r.keyRoot) % 12) + 12) % 12 : d.keyRoot,
    keyScale: SCALES.some((x) => x.id === r.keyScale) ? r.keyScale : d.keyScale,
    seq: normalizeSeq(r.seq),
    arp: {
      // `useStepLanes` was REMOVED as a live gate: the lanes are always live in
      // arp mode (the user: "if the values are all at 0 its not active, we dont
      // need the extra active button"), but nothing in the UI ever WROTE the
      // flag — its only value was the `false` default — so the engine's two
      // `cfg.useStepLanes ? ... : ...` reads silently discarded `stepTranspose`
      // and `stepGate` on every load. Painting a lane did nothing at all, which
      // is also why its dice looked dead: `laneDice` is never read by the
      // engine either, so that card is decorative. Normalizing the flag away
      // would be a lie; the engine is the fix site, see ArpEngine.h.
      useStepLanes: true,
      stepTranspose: aArr(ex.stepTranspose, SEQ_STEPS, (x) => aNum(x, -12, 12, 0, true)),
      // MIGRATION: `stepGate` was a per-step note LENGTH (0.05..4, higher =
      // longer, default 0.6) and is now a SHORTEN amount (0..4, higher =
      // shorter, default 0). They are not the same axis, so an old patch cannot
      // simply be carried over — it has to be CONVERTED, or every existing song
      // would load with its notes silently stretched to 5x.
      //
      // The conversion preserves the sound rather than the number: an old step
      // played at ratio R relative to a 0.6 baseline now plays at
      // `0.6 * 1 / (1 + shorten)`, so `shorten = 0.6 / R - 1`. That is exact for
      // the common cases and clamped to the new 0..4 range; a step that was
      // already longer than 60 % maps to a negative shorten, which the new axis
      // cannot express (it cannot lengthen past the knob) and clamps to 0 — the
      // Gate KNOB is the control for length from here on, which is the point of
      // the split.
      stepShorten: aArr(ex.stepShorten, SEQ_STEPS, (x, i) => {
        if (typeof x === 'number' && isFinite(x)) return aNum(x, 0, 4, 0);
        const legacy = Array.isArray(ex.stepGate) ? ex.stepGate[i] : undefined;
        if (typeof legacy !== 'number' || !isFinite(legacy) || legacy <= 0) return 0;
        return Math.max(0, Math.min(4, Math.round((0.6 / legacy - 1) * 1000) / 1000));
      }),
      // Velocity defaults to 1 = "play at the held note's own velocity", so an
      // untouched lane is a strict no-op. Defaulting to anything else would
      // change how every existing song sounds on load.
      stepVel: aArr(ex.stepVel, SEQ_STEPS, (x) => aNum(x, 0, 1, 1)),
      stepSlide: aArr(ex.stepSlide, SEQ_STEPS, (x) => aNum(x, 0, 1000, 0)),
      layers: {
        chord: aArr(ly.chord, 5, (x, i) => aBool(x, d.arp.layers.chord[i])),
        arp: [0, 1].map((row) =>
          aArr(rawRows[row], 5, (x, i) => aBool(x, Array.isArray(rawRows[row]) ? false : d.arp.layers.arp[row][i])),
        ),
      },
      // Lane dice: rebuilt to the full width (2), defaulting to 0 (off) so no
      // existing song's lanes start moving on their own. Direction defaults to
      // bipolar for the same reason as the per-knob flags.
      laneDice: aArr(ex.laneDice, LANE_DICE_COUNT, (x) => aNum(x, 0, 1, 0)),
      laneDiceBipolar: aArr(ex.laneDiceBipolar, LANE_DICE_COUNT, (x) => (aNum(x, 0, 1, 1) >= 0.5 ? 1 : 0)),
      tightRelease: aBool(ex.tightRelease, d.arp.tightRelease),
      chordHit: aBool(ex.chordHit, d.arp.chordHit),
      humanize: aNum(ex.humanize, 0, 1, 0),
      shape: aNum(ex.shape, -1, 1, 0),
    },
    generation: {
      // Defaults: regenerate every 2 bars, and Live (a fresh draw each step). A saved value always wins.
      autoRegen: AUTO_REGEN_BARS.includes(gn.autoRegen) ? gn.autoRegen : 2,
      chaos: gn.chaos === 'frozen' ? 'frozen' : 'live',
      chaosAmount: aNum(gn.chaosAmount, 0, 1, 1, false),
      // Always rebuilt to the FULL width (4), never truncated to whatever the
      // patch happened to carry — the engine indexes `knobDice[kDiceRate..]` by
      // a constant, so a short array would read `undefined` mid-song and
      // silently produce no dice for the missing knobs. A patch saved before
      // this field existed yields all-zero = feature off, which is the correct
      // default (it must not switch randomness ON in someone's old song).
      knobDice: aArr(gn.knobDice, KNOB_DICE_COUNT, () => 0),
      // Default every direction flag to BIPOLAR (1), not 0: a patch saved
      // before this field existed had no direction concept, and "randomise
      // both ways" is the safe musical default — a dice that could only ever
      // subtract would silently change the feel of an existing song.
      knobDiceBipolar: aArr(gn.knobDiceBipolar, KNOB_DICE_COUNT, (x) => (aNum(x, 0, 1, 1) >= 0.5 ? 1 : 0)),
      seed: aNum(gn.seed, 0, 4294967295, 1, true),
      regenToken: aNum(gn.regenToken, 0, 2147483647, 0, true),
      clearToken: aNum(gn.clearToken, 0, 2147483647, 0, true),
    },
    // A patch saved before the blue row existed gets the defaults, which is silent
    // (blue has no layer on by default), so it does not change an old song.
    blue: {
      rate: {
        sync: aBool(blRate.sync, d.blue.rate.sync),
        div: RATE_DIVS.includes(blRate.div) ? blRate.div : d.blue.rate.div,
        feel: blRate.feel === 'triplet' || blRate.feel === 'dotted' || blRate.feel === 'straight' ? blRate.feel : d.blue.rate.feel,
        hz: aNum(blRate.hz, 0.5, 20, d.blue.rate.hz),
      },
      pattern: ARP_MODES.includes(bl.pattern) ? bl.pattern : d.blue.pattern,
      octaves: aNum(bl.octaves, 1, 4, d.blue.octaves, true),
      swing: aNum(bl.swing, 50, 75, d.blue.swing),
      gate: aNum(bl.gate, 0.05, 4, d.blue.gate),
      chaosAmount: aNum(bl.chaosAmount, 0, 1, d.blue.chaosAmount, false),
      knobDice: aArr(bl.knobDice, KNOB_DICE_COUNT, () => 0),
      knobDiceBipolar: aArr(bl.knobDiceBipolar, KNOB_DICE_COUNT, (x) => (aNum(x, 0, 1, 1) >= 0.5 ? 1 : 0)),
    },
    scale: {
      weights: aArr(sc.weights, 12, (x, i) => (i === 0 ? 1 : aNum(x, 0, 1, d.scale.weights[i]))),
      snap: aBool(sc.snap, d.scale.snap),
    },
  };
}


export const DEFAULT_SETTINGS: AppSettings = {
  hotkey: 'Shift+Alt+R',
  saveFolder: '',
  captureBackend: 'desktop',
  sourceId: null,
  loopbackDeviceId: null,
  recordMode: 'rolling',
  theme: 'aurora-ice',
  visualizer: 'oscilloscope',
  bufferSeconds: 15 * 60,
  bitrateKbps: 96,
  alwaysOnTop: false,
  fileNameTemplate: 'faze_{date}_{time}',

  uiLayout: 'full',
  titleBarMode: 'custom',
  labelMode: 'auto',
  showVu: true,
  showBuffer: true,
  // Off by default: the device lives in the right-click quick menu and in
  // Settings, and on a short window the footer strip was costing the
  // visualizer more height than the picker was worth.
  showSourcePicker: false,
  showVizChips: true,
  showHint: true,
  magneticSnap: true,
  dockReservesSpace: false,
  popoutOpen: false,
  popoutAlwaysOnTop: true,
  popoutOpacity: 1,
  popoutControls: true,
  hideBoardWhenPopped: false,
  hideMainWhenPopped: true,

  // ----- Synth defaults -----------------------------------------------------
  // Synth is the new landing surface in v3. Existing recorder users still get
  // the recorder intact — `appMode` toggles between them. The synth is
  // renderer-only and shares the visualiser / theme / settings plumbing.
  appMode: 'synth',
  synth: {
    octave: 0,
    semitone: 0,
    fineTuneCents: 0,
    voiceMode: 0,
    glideSec: 0,
    voiceLevel: 0.7,
    masterLevel: 0.8,
    voiceLimit: 16,
    velocityCurve: 0,
    velCurve: 0,
    keyCurve: 0,
    ampEnv: { attackSec: 0.005, decaySec: 0.2, sustainLevel: 0.7, releaseSec: 0.4, attackCurve: 0, decayCurve: 0, releaseCurve: 0 },
    modEnv: { attackSec: 0.01, decaySec: 0.25, sustainLevel: 0.5, releaseSec: 0.5, attackCurve: 0, decayCurve: 0, releaseCurve: 0 },
    modEnv3: { attackSec: 0.01, decaySec: 0.3, sustainLevel: 0.4, releaseSec: 0.6, attackCurve: 0, decayCurve: 0, releaseCurve: 0 },
    lfo1: { rateHz: 4, sync: false, perNote: false, wave: 'function', shapePosition: 0, functionShape: functionShapeForLegacyWave('sine') },
    lfo2: { rateHz: 0.5, sync: false, perNote: false, wave: 'function', shapePosition: 0, functionShape: functionShapeForLegacyWave('triangle') },
    lfo3: { rateHz: 2, sync: false, perNote: false, wave: 'function', shapePosition: 0, functionShape: functionShapeForLegacyWave('sawtooth') },
    modules: {},
    mod: {},
    macros: [0, 0, 0, 0, 0, 0, 0, 0],
    filterA: { type: 'lowpass', slope: '12', cutoffHz: 20000, resonance: 0.707 },
    filterB: { type: 'lowpass', slope: '12', cutoffHz: 20000, resonance: 0.707 },
    fx: {
      chain: ['off', 'off', 'off', 'off', 'off', 'off', 'off', 'off'],
      delay: { enabled: false, timeMs: 300, feedback: 0.3, tone: 0.7, locut: 0.05, mod: 0, rate: 0.6, width: 0.3, diffusion: 0.2, mix: 0 },
      reverb: { enabled: false, size: 0.5, decay: 0.5, damp: 0.5, locut: 0.05, mod: 0.15, rate: 0.5, width: 0.5, diffusion: 0.4, mix: 0 },
      distortion: { enabled: false, drive: 0.35, tone: 0.7, mix: 0 },
      chorus: { enabled: false, rate: 0.35, depth: 0.45, width: 0.65, mix: 0 },
      flanger: { enabled: false, rate: 0.25, depth: 0.55, feedback: 0.45, width: 0.7, mix: 0 },
      compressor: {
        enabled: false,
        lowFreq: 250,
        highFreq: 2500,

        lowFloorDb: -55,
        lowCeilingDb: 0,
        lowAmount: 0.5,
        lowAttackMs: 0,
        lowReleaseMs: 120,

        midFloorDb: -55,
        midCeilingDb: 0,
        midAmount: 0.5,
        midAttackMs: 0,
        midReleaseMs: 120,

        highFloorDb: -55,
        highCeilingDb: 0,
        highAmount: 0.5,
        highAttackMs: 0,
        highReleaseMs: 120,

        drive: 0,
        crush: 0,
        gain: 1.0,
        mix: 0,
      },
      phaser: { enabled: false, rate: 0.35, depth: 0.65, feedback: 0.35, stages: 4, mix: 0 },
      eq: { enabled: true, mix: 1, bands: [] },
    },
    oscillators: defaultOscillatorSlots(),
    arp: defaultArpSettings(),
  },
};

/**
 * Minimum window size per layout, in CSS px. `bar` is deliberately tiny — it
 * only has to fit one row of icon buttons — and main clamps the window to
 * these numbers whenever the layout changes.
 */
export const LAYOUT_MIN_SIZE: Record<UiLayout, { width: number; height: number }> = {
  // 'full' is the synth's only real layout now. This floor used to be
  // 1180x770 — sized for when the controls column was shorter — but the
  // envelope column (ENV/LFO/S&H/keyboard sources) since grew taller than
  // that budget, so at 770 the window was ALREADY clipping the bottom of
  // the controls and the piano with no way to reach them (todo.md §54).
  // `.synth-root` now scrolls once `.synth-board` hits its own min-height,
  // so it's safe to let the OS-level floor go much lower — the user can
  // shrink the window a lot further and just scroll for the rest instead
  // of losing access to controls entirely.
  full: { width: 1000, height: 600 },
  compact: { width: 200, height: 32 },
};

/**
 * Tokens supported in `fileNameTemplate`. The renderer surfaces these as
 * clickable chips; main's save.ts substitutes them at save time.
 */
export const FILENAME_TOKENS = [
  { token: '{date}', label: 'date', example: '2026-08-15' },
  { token: '{time}', label: 'time', example: '14-32-05' },
  { token: '{year}', label: 'year', example: '2026' },
  { token: '{month}', label: 'month', example: '08' },
  { token: '{day}', label: 'day', example: '15' },
  { token: '{hour}', label: 'hour', example: '14' },
  { token: '{minute}', label: 'minute', example: '32' },
  { token: '{second}', label: 'second', example: '05' },
  { token: '{unix}', label: 'unix', example: '1755276725' },
  { token: '{mode}', label: 'mode', example: 'rolling' },
  { token: '{device}', label: 'device', example: 'Speakers' },
  { token: '{counter}', label: 'counter', example: '0003' },
] as const;

/** Result of saving a recording. */
export interface SaveResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  fileName?: string;
  error?: string;
}

/**
 * A saved synth patch — a named snapshot of `SynthSettings`, stored
 * SEPARATELY from the persisted `AppSettings` (todo.md §50). `AppSettings`
 * still always opens as the init patch on launch (§49); presets are the way
 * a user keeps a patch they like. The name is unique (case-insensitive).
 */
export interface SynthPreset {
  name: string;
  /** ms epoch when the preset was first created. */
  createdAt: number;
  /** ms epoch of the last save to this name (overwrites keep the name). */
  updatedAt: number;
  synth: SynthSettings;
}

/** Result of a preset save/delete — carries the refreshed list so the caller never re-fetches. */
export interface PresetResult {
  ok: boolean;
  presets: SynthPreset[];
  error?: string;
}

/** Channels used on the IPC bus. */
export const IpcChannel = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  sourcesList: 'sources:list',
  sourcesPick: 'sources:pick',
  folderPick: 'folder:pick',
  saveRecording: 'recording:save',
  dragExport: 'drag:export',
  recordingEvent: 'recording:event',
  hotkeySet: 'hotkey:set',
  loopbackList: 'loopback:list',
  loopbackStart: 'loopback:start',
  loopbackStop: 'loopback:stop',
  loopbackSamples: 'loopback:samples',
  loopbackEvent: 'loopback:event',
  windowSetAlwaysOnTop: 'window:set-always-on-top',
  openSettings: 'window:open-settings',
  traySetCapturing: 'tray:set-capturing',
  settingsChanged: 'settings:changed',
  windowControl: 'window:control',
  windowSnap: 'window:snap',
  windowTempExpand: 'window:temp-expand',
  windowState: 'window:state',
  contextMenu: 'window:context-menu',
  popoutToggle: 'popout:toggle',
  popoutState: 'popout:state',
  vizFrame: 'viz:frame',
  vizState: 'viz:state',
  vizCommand: 'viz:command',
  vizHistory: 'viz:history',
  dragExportProxy: 'drag:export-proxy',
  requestDragExport: 'drag:request-export',
  dragPrepare: 'drag:prepare',
  dragExportPrepared: 'drag:export-prepared',
  presetsList: 'presets:list',
  presetsSave: 'presets:save',
  presetsDelete: 'presets:delete',
} as const;

/** Simple window verbs the custom title bar can ask main to perform. */
export type WindowAction = 'minimize' | 'maximize' | 'restore-or-max' | 'hide' | 'close';

/** What the main renderer streams to the pop-out visualizer, ~30×/s. */
export interface VizFrame {
  /** Time-domain samples, one AnalyserNode fftSize window. */
  time: Float32Array;
  /** Frequency bins in dB. */
  freq: Float32Array;
  minDecibels: number;
  maxDecibels: number;
}

/** Slower-moving state the pop-out mirrors (sent only when it changes). */
export interface VizState {
  /**
   * Recorder-era name, synth-era meaning (todo.md §55): the synth doesn't
   * "capture", but this field drives the pop-out's activity dot/label, so
   * it's repurposed as "is the synth currently sounding" (activeVoices > 0)
   * rather than renaming the wire field.
   */
  capturing: boolean;
  hasSource: boolean;
  /** Always false in synth mode — there's nothing to save from the pop-out. */
  canSave: boolean;
  bufferedSeconds: number;
  bufferSeconds: number;
  recordMode: RecordMode;
  theme: Theme;
  visualizer: VisualizerMode;
  rms: number;
}

/** Commands the pop-out sends back to the main renderer. */
export type VizCommand =
  | { type: 'toggle-capture' }
  | { type: 'save' }
  | { type: 'set-visualizer'; mode: VisualizerMode }
  | { type: 'selection-change'; selection: [number, number] | null };

export type RecorderEvent =
  | { type: 'saved'; path: string; bytes: number; durationSec: number }
  | { type: 'error'; message: string }
  | { type: 'hotkey-pressed' };

export type LoopbackEvent =
  | { type: 'started'; deviceId: string; deviceName: string }
  | { type: 'stopped' }
  | { type: 'error'; message: string };
