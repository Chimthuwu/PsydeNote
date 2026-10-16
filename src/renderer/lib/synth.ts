import type {
  AdsrEnvelope,
  evaluateFunctionShape,
  FilterSettings,
  FunctionShape,
  LfoSettings,
  defaultFunctionShape,
  ModMap,
  ModRoute,
  ModSourceId,
  ModTargetId,
  OperatorId,
  OperatorModEntry,
  OscillatorSlotSettings,
} from '../../shared/types';
import { OPERATOR_IDS, WAVE_MORPH_SHAPES, oscSlotIndex, wouldCreateModCycle } from '../../shared/types';
import type { AnalyserLike } from './visualizer';
import { AudioAnalyser } from './visualizer';

/**
 * Phase 3 SynthEngine — the multi-operator engine.
 *
 * A voice is built from up to FOUR OPERATORS — the four oscillator slots,
 * mixed together. Each operator has its own wave (sine/triangle/sawtooth/
 * square, OR `'sample'` — any oscillator can independently be recording/
 * holding a captured clip instead of running an OscillatorNode; see todo.md
 * §33, "removing the dedicated sampler"), pitch offset and level, and can
 * optionally be phase- or frequency-modulated by any other operator that's
 * sounding the same note (see `OscillatorSlotSettings.mods` in
 * shared/types.ts — Phase-4 style, colour-coded PM + FM knobs per source).
 * This sits ALONGSIDE the Phase 2 envelope + Pigments-style mod-matrix
 * system (ampEnv / modEnv / modRoutes): that system routes slow control
 * signals onto knobs (pitch, voice level); the operator graph below is the
 * audio-rate PM/FM wiring between operators. The two compose freely.
 *
 *   osc1..osc4   (each: source [oscillator OR sample buffer] → levelGain)
 *        │  (PM: raw source → depth gain → shared pmDepthScale → target.detune)
 *        │  (FM: raw source → depth gain → target.frequency/playbackRate)
 *        ▼
 *     voiceMix ──→ ampEnv (ENV1, gain automated 0→1→sustain→0) ──→ voiceGain (voiceLevel + 'oscLevel' routes)
 *                                                                       │
 *     modEnvCarrier(ConstantSource,1) ──→ modEnv (ENV2, free CV) ──────┤ (routed to 'pitch'/'oscLevel' via ∿ menu)
 *                                                                       ▼
 *                                                                    master ──→ analyser ──→ destination
 *
 * FM here is genuine linear frequency modulation (a modulator's raw signal,
 * scaled to Hz, summed into the target's `.frequency` AudioParam — or, for
 * a sample-mode operator, into `.playbackRate`). PM approximates phase
 * modulation by summing a cents-scaled modulator signal into `.detune`
 * instead: Web Audio doesn't expose a raw phase accumulator on
 * `OscillatorNode`, so there's no way to do sample-accurate phase modulation
 * without a custom `AudioWorkletProcessor` oscillator (see todo.md for that
 * as a future phase). Modulating `detune` at audio rate is the standard
 * browser-side approximation, and — unlike `.frequency`/`.playbackRate` for
 * FM — it's on both `OscillatorNode` and `AudioBufferSourceNode`, so it's
 * uniform whether the operator is running an oscillator or a sample.
 *
 * The engine implements `AnalyserLike` (see src/renderer/lib/visualizer.ts)
 * so the existing visualiser code automatically picks up synth audio with no
 * changes on its side.
 */

export type MidiNote = number; // 0..127, MIDI standard

const A4_MIDI = 69;
const A4_HZ = 440;

/** Audio-rate mod depth — a mods amount (0..1 UI) is scaled into the target's native unit. */
const PM_DEPTH_CENTS = 1200; // "PM" deviation into .detune (±1 octave swing at full depth)
const FM_DEPTH_HZ = 2400; // linear-FM deviation into an oscillator's .frequency
const SAMPLE_FM_DEPTH_RATIO = 0.8; // FM deviation into a sample-mode operator's .playbackRate (a ratio, not Hz)

/** Sample-and-hold LFO (todo.md §45): a looping buffer of random held steps. */
const SAMPLE_HOLD_STEPS = 1024; // distinct random values in the looping buffer
const SAMPLE_HOLD_HOLD_SEC = 0.004; // each step held ~4 ms before the next random value

/** Convert a MIDI note to frequency (Hz), with cents of detune. */
export function midiToFreq(midi: MidiNote, cents = 0): number {
  const hz = A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
  // cents are a logarithmic detune; 1200 cents == one octave.
  return hz * Math.pow(2, cents / 1200);
}

/** Bipolar keyboard-tracking mod source: -1 at MIDI 0, 0 at middle C (60), +1 at MIDI 120. */
export function keytrackValue(midi: MidiNote): number {
  return Math.max(-1, Math.min(1, (midi - 60) / 60));
}

/**
 * Wavetable-position knob (todo.md §41) — replaces the old 4-button
 * sine/triangle/sawtooth/square picker with one continuous knob that morphs
 * across the same 4 shapes. Rather than crossfade the raw waveforms (which
 * would alias badly, especially near square/sawtooth), each shape's closed-
 * form Fourier sine-series coefficients are computed and linearly
 * interpolated between the two shapes either side of the knob position, then
 * handed to `AudioContext.createPeriodicWave` — the browser band-limits the
 * result for us, same as it does for the built-in oscillator types.
 */
const WAVE_MORPH_HARMONICS = 32;

/** Sine-series coefficients (index 0 unused, DC) for one of the 4 classic shapes. All are odd functions, so every shape is pure sine terms — no cosine/real component. */
function fourierSineCoeffs(shape: (typeof WAVE_MORPH_SHAPES)[number]): Float32Array {
  const b = new Float32Array(WAVE_MORPH_HARMONICS + 1);
  switch (shape) {
    case 'sine':
      b[1] = 1;
      break;
    case 'square':
      for (let n = 1; n <= WAVE_MORPH_HARMONICS; n++) {
        if (n % 2 === 1) b[n] = 4 / (n * Math.PI);
      }
      break;
    case 'sawtooth':
      for (let n = 1; n <= WAVE_MORPH_HARMONICS; n++) {
        b[n] = ((2 * (n % 2 === 1 ? 1 : -1)) / (n * Math.PI));
      }
      break;
    case 'triangle':
      for (let n = 1; n <= WAVE_MORPH_HARMONICS; n++) {
        if (n % 2 === 1) {
          const k = (n - 1) / 2;
          b[n] = ((8 / (Math.PI * Math.PI * n * n)) * (k % 2 === 0 ? 1 : -1));
        }
      }
      break;
  }
  return b;
}
const MORPH_COEFFS: Record<(typeof WAVE_MORPH_SHAPES)[number], Float32Array> = {
  sine: fourierSineCoeffs('sine'),
  triangle: fourierSineCoeffs('triangle'),
  sawtooth: fourierSineCoeffs('sawtooth'),
  square: fourierSineCoeffs('square'),
};

/** Build the band-limited `PeriodicWave` for a wavetable-position knob value (0..1). Cheap enough to call per `noteOn` — no caching (position doesn't change on a held note, matching the old "wave doesn't retrigger" precedent). */
function functionPeriodicWave(ctx: AudioContext, shape: FunctionShape | undefined): PeriodicWave {
  shape = shape ?? defaultFunctionShape();
  const n = 64;
  const harmonics = 32;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let h = 1; h <= harmonics; h += 1) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i += 1) {
      const phase = i / n;
      const sample = evaluateFunctionShape(shape, phase);
      const angle = Math.PI * 2 * h * phase;
      re += sample * Math.cos(angle);
      im += sample * Math.sin(angle);
    }
    // PeriodicWave uses cosine coefficients in `real` and sine in `imag`.
    real[h] = (2 / n) * re;
    imag[h] = (2 / n) * im;
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

function morphedPeriodicWave(ctx: AudioContext, position: number): PeriodicWave {
  const p = Math.max(0, Math.min(1, position));
  const t = p * (WAVE_MORPH_SHAPES.length - 1);
  const i0 = Math.min(WAVE_MORPH_SHAPES.length - 2, Math.floor(t));
  const i1 = i0 + 1;
  const frac = t - i0;
  const b0 = MORPH_COEFFS[WAVE_MORPH_SHAPES[i0]];
  const b1 = MORPH_COEFFS[WAVE_MORPH_SHAPES[i1]];
  const real = new Float32Array(WAVE_MORPH_HARMONICS + 1);
  const imag = new Float32Array(WAVE_MORPH_HARMONICS + 1);
  for (let n = 1; n <= WAVE_MORPH_HARMONICS; n++) {
    imag[n] = b0[n] * (1 - frac) + b1[n] * frac;
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

/** A source that can play a pitch: an oscillator or the sampler's buffer player. Both expose `.frequency`-ish + `.detune`. */
type OperatorSource = OscillatorNode | AudioBufferSourceNode;

/** An LFO source: a periodic OscillatorNode, or a looping sample-and-hold buffer player. */
type LfoNode = OscillatorNode | AudioBufferSourceNode;

/** Per-voice control-rate tap for LFO-shape modulation (todo.md §66). The
 *  amount-scaled mod sources sum into `bus`; `analyser` (tiny fftSize) lets
 *  the engine's rAF loop read the current summed value and re-pick the LFO's
 *  morphed `PeriodicWave`. `lastIdx` avoids redundant `setPeriodicWave`. */
interface ShapeModTap {
  bus: GainNode;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
  lastIdx: number;
}

/** One live operator inside a voice. */
interface OperatorInstance {
  id: OperatorId;
  source: OperatorSource;
  /** This operator's own contribution to the voice mix. */
  levelGain: GainNode;
  /** Stereo position for this operator. */
  panNode: StereoPannerNode;
  /** Dual-filter crossfade (todo.md §60): panNode's output splits here — one
   *  gain sends toward Filter A's mix bus, the other toward Filter B's,
   *  scaled by the slot's `filterMix` (0 = all A, 1 = all B). */
  filterSplitA: GainNode;
  filterSplitB: GainNode;
  /** PM connections, keyed by SOURCE operator id — lets a live mod-amount
   *  edit find/update/add/remove one connection without touching the others
   *  (see `applyModsLive`). */
  pmGains: Map<OperatorId, GainNode>;
  /** FM connections, keyed by SOURCE operator id. */
  fmGains: Map<OperatorId, GainNode>;
  /** Shared series gain after every PM gain (value 1) — the `${id}ModAmount`
   *  mod-route target scales the operator's overall PM depth (1 + amount·env). */
  pmDepthScale: GainNode | null;
  /** Per-SOURCE PM depth-scale gains (unity pass-through + mod-route signal)
   *  inserted between the source and its pmGain — the `${id}Pm${src}` mod
   *  target multiplies ONE knob's depth (1 + amount·env), like `pmDepthScale`
   *  does for the whole operator. Absent when that knob is at 0 (no edge). */
  pmDepthScales: Map<OperatorId, GainNode>;
  /** Per-SOURCE FM depth-scale gains — the `${id}Fm${src}` mod target. */
  fmDepthScales: Map<OperatorId, GainNode>;
  /** One-render-quantum DelayNodes inserted into cyclic PM edges (mutual
   *  loops + self-modulation) so Web Audio accepts the feedback graph. */
  pmDelays: Map<OperatorId, DelayNode>;
  /** One-render-quantum DelayNodes inserted into cyclic FM edges. */
  fmDelays: Map<OperatorId, DelayNode>;
}

/**
 * Voice record: held inside the engine for retrigger/cleanup. `operators`
 * holds every operator that's actually sounding this note — disabled slots
 * (or an empty sampler) simply never get an entry.
 */
interface Voice {
  midi: MidiNote;
  operators: Map<OperatorId, OperatorInstance>;
  /** Sums every operator's Filter-A-bound share (see `OperatorInstance.filterSplitA`). */
  voiceMixA: GainNode;
  /** Sums every operator's Filter-B-bound share. */
  voiceMixB: GainNode;
  /** Filter A — both cascaded stages. `stage2` runs as `'allpass'` (magnitude-transparent) for a 12 dB/oct slope, or mirrors `stage1`'s type for 24 dB/oct — always present so slope toggles live with no graph rebuild. */
  filterA: { stage1: BiquadFilterNode; stage2: BiquadFilterNode };
  /** Filter B — same shape as Filter A. */
  filterB: { stage1: BiquadFilterNode; stage2: BiquadFilterNode };
  /** ENV 1 — amplitude envelope. The mixed signal passes THROUGH this node; its gain is automated 0→1→sustain→0. */
  ampEnv: GainNode;
  /** ENV 2 — free modulation envelope (pure control signal, no audio input of its own). */
  modEnv: GainNode;
  /** Feeds a constant "1" into modEnv so its automated .gain becomes an actual signal other params can connect to. */
  modEnvCarrier: ConstantSourceNode;
  /** LFO 1 — free-running per-voice modulation source (pure CV). */
  lfo1: LfoNode;
  /** LFO 2 — second independent LFO. */
  lfo2: LfoNode;
  /** Velocity (0..1) — per-voice constant mod source. */
  velocity: ConstantSourceNode;
  /** Keyboard tracking (-1..1) — per-voice constant mod source from the note. */
  keytrack: ConstantSourceNode;
  /** Sample-and-hold — per-voice random stepped mod source (looping buffer). */
  sh: AudioBufferSourceNode;
  /** Random — one fresh value chosen at noteOn, held for the note's life. */
  random: ConstantSourceNode;
  /** Control-rate LFO-shape modulation (todo.md §66): lazily created when a
   *  `lfoNShape` route exists. The route's amount-scaled sources sum into
   *  `bus`; the engine's rAF loop reads `analyser` and re-picks the LFO's
   *  morphed wave. `idx` is the last wave-table index applied (skip redundant
   *  `setPeriodicWave`). Null when no shape route targets that LFO. */
  lfo1ShapeMod: ShapeModTap | null;
  lfo2ShapeMod: ShapeModTap | null;
  /** Final per-voice trim (voiceLevel) + the 'oscLevel' Pigments-route target. */
  voiceGain: GainNode;
  /** Per-route amount scalers: key `${targetId}:${sourceId}` → GainNode between the source envelope and the target AudioParam(s). */
  modScales: Map<string, GainNode>;
  /** Envelope shapes snapshotted at noteOn — live knob edits only affect the next note. */
  ampEnvShape: AdsrEnvelope;
  modEnvShape: AdsrEnvelope;
  startedAt: number;
  /** A release ramp has been scheduled — noteOff is now idempotent. */
  releasing: boolean;
  /** setTimeout handle for the disconnect after the release ramp lands. */
  releaseTimer: number | null;
  disposed: boolean;
}

export interface SynthEngineOptions {
  /** Voice cap. Anything beyond this drops the oldest held voice. */
  voiceLimit: number;
  /** Master output gain (0..1). */
  masterLevel: number;
  /** Overall per-voice trim (0..1) — the base the amp envelope shapes, on top of the operator mix. */
  voiceLevel: number;
  /** ENV 1 — amplitude envelope. */
  ampEnv: AdsrEnvelope;
  /** ENV 2 — modulation envelope. */
  modEnv: AdsrEnvelope;
  /** LFO 1 — free-running per-voice modulation oscillator. */
  lfo1: LfoSettings;
  /** LFO 2 — second independent LFO. */
  lfo2: LfoSettings;
  /** Sample-and-hold rate (Hz) — the per-voice random stepped mod source. */
  shRateHz: number;
  /** Pigments-style modulation routes (target → sources). */
  modRoutes: ModMap;
  /** Dual filters (todo.md §60) — every operator splits between them via its own `filterMix`. */
  filterA: FilterSettings;
  filterB: FilterSettings;
  /** The four operator slots. Any slot can be a sampler (`wave: 'sample'`). */
  oscillators: OscillatorSlotSettings[];
}

export class SynthEngine implements AnalyserLike {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  readonly master: GainNode;
  readonly timeData: Float32Array<ArrayBuffer>;
  readonly freqData: Float32Array<ArrayBuffer>;

  private voices = new Map<MidiNote, Voice>();
  private opts: SynthEngineOptions;
  private oscSlots: OscillatorSlotSettings[];
  private pitchCents = 0; // global transpose (octave/semitone/fine), applied on top of each operator's own offset
  private ampEnvShape: AdsrEnvelope;
  private modEnvShape: AdsrEnvelope;
  private lfo1Shape: LfoSettings;
  private lfo2Shape: LfoSettings;
  private shRateHz: number;
  private sahBuffer: AudioBuffer | null = null;
  private modRoutes: ModMap = {};
  private filterAShape: FilterSettings;
  private filterBShape: FilterSettings;
  /** Captured sample-mode buffers, one per operator — any of the 4
   *  oscillators can independently be recording/holding a clip when its
   *  `wave === 'sample'` (Phase 1.11 — todo.md §33; replaces the old single
   *  dedicated-sampler `sampleBuffer`). */
  private sampleBuffers = new Map<OperatorId, AudioBuffer | null>();

  /**
   * Persistent (not per-voice) monitor taps, one per operator — Bitwig
   * Phase-4-style dedicated per-oscillator visualizers. Every voice's
   * instance of an operator fans an EXTRA connection into
   * `operatorBuses.get(id)`, alongside its normal connection into that
   * voice's mix — the operator's audible signal is unaffected, but the
   * bus (and the AnalyserNode reading it) sees the summed signal of every
   * currently-sounding voice for that operator. `AudioAnalyser` implements
   * `AnalyserLike`, so `VisualizerBoard` consumes it with zero changes on
   * its side — same trick the whole synth is built on.
   */
  private operatorBuses = new Map<OperatorId, GainNode>();
  private operatorAnalysers = new Map<OperatorId, AudioAnalyser>();

  /** Precomputed morphed LFO waves indexed 0..SHAPE_WAVE_STEPS (todo.md §66
   *  — control-rate LFO-shape modulation picks the nearest one instead of
   *  rebuilding a PeriodicWave every frame). Built lazily on first use. */
  private shapeWaveTable: PeriodicWave[] | null = null;
  /** Shared silent sink that keeps the shape-mod analyser buses being pulled
   *  by the audio thread (the same Chromium quirk `operatorBuses` works
   *  around). */
  private shapeModSink: GainNode | null = null;
  /** rAF handle for the control-rate LFO-shape-modulation loop. */
  private shapeRaf = 0;

  private disposed = false;

  constructor(opts: SynthEngineOptions) {
    this.opts = opts;
    this.ampEnvShape = opts.ampEnv;
    this.modEnvShape = opts.modEnv;
    this.lfo1Shape = opts.lfo1;
    this.lfo2Shape = opts.lfo2;
    this.shRateHz = opts.shRateHz;
    this.modRoutes = opts.modRoutes ?? {};
    this.filterAShape = opts.filterA;
    this.filterBShape = opts.filterB;
    this.oscSlots = opts.oscillators;
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });

    this.master = this.ctx.createGain();
    this.master.gain.value = opts.masterLevel;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.82;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -10;

    // The Chromium quirk the capture path uses too: a graph that doesn't
    // reach an AudioDestinationNode is not pulled by the audio thread, and
    // AnalyserNode stays frozen. We feed the destination directly.
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.timeData = new Float32Array(this.analyser.fftSize);
    this.freqData = new Float32Array(this.analyser.frequencyBinCount);

    // One persistent monitor bus + analyser per operator (see the field
    // doc comment above). Each analyser's own output is a dead end unless
    // it also reaches the destination — the same Chromium quirk noted
    // above — so route it through a silent (zero-gain) sink rather than
    // audibly duplicating the signal.
    for (const id of OPERATOR_IDS) {
      const bus = this.ctx.createGain();
      bus.gain.value = 1;
      const analyserWrap = new AudioAnalyser(this.ctx, bus);
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      analyserWrap.analyser.connect(sink);
      sink.connect(this.ctx.destination);
      this.operatorBuses.set(id, bus);
      this.operatorAnalysers.set(id, analyserWrap);
    }
  }

  /** The dedicated per-operator analyser — feed straight into `<VisualizerBoard analyser={…} />`. */
  getOperatorAnalyser(id: OperatorId): AnalyserLike {
    return this.operatorAnalysers.get(id)!;
  }

  /** Standard AnalyserLike sample — used by the visualiser draw loop. */
  sample(): { rms: number } {
    if (this.disposed) return { rms: 0 };
    this.analyser.getFloatTimeDomainData(this.timeData);
    this.analyser.getFloatFrequencyData(this.freqData);
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = this.timeData[i];
      sum += v * v;
    }
    return { rms: Math.sqrt(sum / this.timeData.length) };
  }

  /** Resumes the AudioContext (call from a user-gesture handler). */
  async ensureRunning(): Promise<void> {
    if (this.disposed) return;
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* ignored */ }
    }
  }

  /** Global transpose (octave*1200 + semitone*100 + fineTuneCents). Applied on top of each operator's own pitch offset. */
  setPitchCents(cents: number): void {
    this.pitchCents = cents;
    this.applyPitchLive();
  }

  /** Replace all four oscillator slots. Pitch, level, pan, filter-crossfade, wavetable-position AND PM/FM-depth changes all apply live to held voices — turn any knob and hear it without retriggering the note. Only `wave` and `enabled` stay new-note-only (a running oscillator can't swap its source kind; "wave doesn't retrigger" is long-standing). */
  setOscSlots(slots: OscillatorSlotSettings[]): void {
    this.oscSlots = slots;
    this.applyPitchLive();
    this.applyOscParamsLive();
    this.applyModsLive();
  }

  /** Overall per-voice trim (0..1). Ramps held voices' `voiceGain.gain` live (composes additively with any `oscLevel` mod route on the same param) so the header's Voice knob is audible on a sustained note. */
  setVoiceLevel(level: number): void {
    this.opts.voiceLevel = level;
    const now = this.ctx.currentTime;
    for (const v of this.voices.values()) {
      v.voiceGain.gain.setTargetAtTime(level, now, 0.02);
    }
  }

  setMasterLevel(level: number): void {
    this.opts.masterLevel = level;
    // Smooth ramp to avoid a discrete "jump" audibility when the slider
    // moves quickly. Web Audio can't ramp negative.
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(level, now, 0.02);
  }

  setVoiceLimit(n: number): void {
    this.opts.voiceLimit = Math.max(1, Math.floor(n));
  }

  /** ENV 1 — amplitude envelope. Applies to new notes (held voices keep
   *  their snapshot so release math stays consistent). */
  setAmpEnv(e: AdsrEnvelope): void {
    this.ampEnvShape = e;
  }

  /** ENV 2 — modulation envelope. Applies to new notes (see setAmpEnv). */
  setModEnv(e: AdsrEnvelope): void {
    this.modEnvShape = e;
  }

  /** LFO shapes — rate + waveform apply LIVE to held voices (unlike the envelopes). */
  setLfos(l1: LfoSettings, l2: LfoSettings): void {
    this.lfo1Shape = l1;
    this.lfo2Shape = l2;
    const now = this.ctx.currentTime;
    for (const v of this.voices.values()) {
      this.applyLfoLive(v, 'lfo1', l1, now);
      this.applyLfoLive(v, 'lfo2', l2, now);
    }
  }

  /**
   * Apply one LFO's shape to a held voice live. Same-kind edits (oscillator
   * → oscillator, or buffer → buffer) only touch the node's rate/type; a
   * wave-kind swap (periodic ↔ sample-and-hold) can't change a node's
   * nature in place, so the node is rebuilt and the voice's route graph is
   * re-wired to the replacement.
   */
  private applyLfoLive(v: Voice, slot: 'lfo1' | 'lfo2', lfo: LfoSettings, now: number): void {
    const old = v[slot];
    const wantsBuffer = lfo.wave === 'sample-hold';
    const isBuffer = old instanceof AudioBufferSourceNode;
    if (wantsBuffer === isBuffer) {
      if (old instanceof AudioBufferSourceNode) {
        old.playbackRate.setTargetAtTime(this.sampleHoldRate(lfo.rateHz), now, 0.02);
      } else {
        const osc = old as OscillatorNode;
        // Function mode is rendered into a band-limited PeriodicWave, so the
        // editor can change a held LFO without rebuilding the voice graph.
        osc.setPeriodicWave(lfo.wave === 'function'
          ? functionPeriodicWave(this.ctx, lfo.functionShape)
          : morphedPeriodicWave(this.ctx, lfo.shapePosition));
        osc.frequency.setTargetAtTime(lfo.rateHz, now, 0.02);
      }
      return;
    }
    // Rebuild the node and re-wire any routes that reference this source.
    try { old.stop(); } catch { /* noop */ }
    try { old.disconnect(); } catch { /* noop */ }
    v[slot] = this.buildLfoNode(lfo, now);
    this.applyRoutes(v, this.modRoutes);
  }

  /** Build a fresh per-voice LFO node — an oscillator, or a looping sample-and-hold buffer source. */
  private buildLfoNode(lfo: LfoSettings, now: number): LfoNode {
    if (lfo.wave === 'sample-hold') {
      const src = this.ctx.createBufferSource();
      src.buffer = this.sampleHoldBuffer();
      src.loop = true;
      src.playbackRate.value = this.sampleHoldRate(lfo.rateHz);
      src.start(now);
      return src;
    }
    const osc = this.ctx.createOscillator();
    osc.setPeriodicWave(lfo.wave === 'function'
      ? functionPeriodicWave(this.ctx, lfo.functionShape)
      : morphedPeriodicWave(this.ctx, lfo.shapePosition));
    osc.frequency.value = lfo.rateHz;
    osc.start(now);
    return osc;
  }

  /**
   * Lazily build (and cache) the shared looping buffer of random held steps
   * every sample-and-hold LFO plays from. The step RATE is controlled per
   * node by its playbackRate (see `sampleHoldRate`), so one buffer serves
   * all voices and both LFO slots.
   */
  private sampleHoldBuffer(): AudioBuffer {
    if (this.sahBuffer) return this.sahBuffer;
    const sr = this.ctx.sampleRate;
    const hold = Math.max(1, Math.round(sr * SAMPLE_HOLD_HOLD_SEC));
    const buf = this.ctx.createBuffer(1, SAMPLE_HOLD_STEPS * hold, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < SAMPLE_HOLD_STEPS; i++) {
      data.fill(Math.random() * 2 - 1, i * hold, (i + 1) * hold);
    }
    this.sahBuffer = buf;
    return buf;
  }

  /** playbackRate that yields `rateHz` steps/second given the buffer's baked-in hold length. */
  private sampleHoldRate(rateHz: number): number {
    const sr = this.ctx.sampleRate;
    const hold = Math.max(1, Math.round(sr * SAMPLE_HOLD_HOLD_SEC));
    return (rateHz * hold) / sr;
  }

  /** Build the per-voice sample-and-hold node (always a looping random-step buffer). */
  private buildShNode(now: number): AudioBufferSourceNode {
    return this.buildLfoNode({ rateHz: this.shRateHz, wave: 'sample-hold', shapePosition: 0 }, now) as AudioBufferSourceNode;
  }

  /** Sample-and-hold rate (Hz) — applies LIVE to held voices. */
  setShRate(rateHz: number): void {
    this.shRateHz = rateHz;
    const now = this.ctx.currentTime;
    for (const v of this.voices.values()) {
      v.sh.playbackRate.setTargetAtTime(this.sampleHoldRate(rateHz), now, 0.02);
    }
  }

  // ----- Control-rate LFO-shape modulation (todo.md §66) -------------------
  // Shape (`shapePosition`) has no AudioParam — it's `setPeriodicWave`. So a
  // `lfoNShape` route can't connect a node to a param like every other
  // target; instead its amount-scaled sources sum into a per-voice analyser
  // bus, and this rAF loop reads that bus ~60×/s and re-picks the LFO's
  // morphed wave from a small precomputed table. Slow by mod-system
  // standards, but an LFO shape doesn't need audio-rate precision.

  private static readonly SHAPE_WAVE_STEPS = 48;

  private shapeWaves(): PeriodicWave[] {
    if (!this.shapeWaveTable) {
      const n = SynthEngine.SHAPE_WAVE_STEPS;
      this.shapeWaveTable = Array.from({ length: n + 1 }, (_, i) =>
        morphedPeriodicWave(this.ctx, i / n),
      );
    }
    return this.shapeWaveTable;
  }

  /** Build a per-voice shape-mod tap (bus + tiny analyser, kept alive via the shared silent sink). */
  private makeShapeTap(): ShapeModTap {
    if (!this.shapeModSink) {
      this.shapeModSink = this.ctx.createGain();
      this.shapeModSink.gain.value = 0;
      this.shapeModSink.connect(this.ctx.destination);
    }
    const bus = this.ctx.createGain();
    bus.gain.value = 1;
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 32;
    bus.connect(analyser);
    analyser.connect(this.shapeModSink);
    return { bus, analyser, buf: new Float32Array(new ArrayBuffer(analyser.fftSize * 4)), lastIdx: -1 };
  }

  private teardownShapeTap(tap: ShapeModTap | null): void {
    if (!tap) return;
    try { tap.bus.disconnect(); } catch { /* noop */ }
    try { tap.analyser.disconnect(); } catch { /* noop */ }
  }

  private startShapeLoop(): void {
    if (this.shapeRaf) return;
    const tick = () => {
      this.shapeRaf = 0;
      if (this.disposed) return;
      let anyActive = false;
      for (const v of this.voices.values()) {
        anyActive = this.shapeTickVoice(v, 'lfo1', v.lfo1ShapeMod) || anyActive;
        anyActive = this.shapeTickVoice(v, 'lfo2', v.lfo2ShapeMod) || anyActive;
      }
      if (anyActive) this.shapeRaf = requestAnimationFrame(tick);
    };
    this.shapeRaf = requestAnimationFrame(tick);
  }

  private shapeTickVoice(v: Voice, slot: 'lfo1' | 'lfo2', tap: ShapeModTap | null): boolean {
    if (!tap) return false;
    const node = v[slot];
    if (!(node instanceof OscillatorNode)) return true; // sample-hold LFO: no morph, but keep looping
    tap.analyser.getFloatTimeDomainData(tap.buf);
    const modv = tap.buf[tap.buf.length - 1];
    const base = (slot === 'lfo1' ? this.lfo1Shape : this.lfo2Shape).shapePosition;
    const pos = Math.max(0, Math.min(1, base + modv));
    const idx = Math.round(pos * SynthEngine.SHAPE_WAVE_STEPS);
    if (idx !== tap.lastIdx) {
      node.setPeriodicWave(this.shapeWaves()[idx]);
      tap.lastIdx = idx;
    }
    return true;
  }

  /**
   * Replace the Pigments-style route map. Amount-only edits update the
   * scale gains on held voices live via setTargetAtTime (no graph churn
   * per drag tick); structure edits (adding/removing a source) rebuild
   * each voice's route graph. New notes always pick up the full map.
   */
  setModRoutes(routes: ModMap): void {
    this.modRoutes = routes;
    if (this.voices.size === 0) return;
    const keys = routeKeys(routes);
    const now = this.ctx.currentTime;
    for (const v of this.voices.values()) {
      const oldKeys = [...v.modScales.keys()];
      const sameShape =
        keys.length === oldKeys.length && keys.every((k) => oldKeys.includes(k));
      if (sameShape) {
        for (const [key, g] of v.modScales) {
          const targetId = key.split(':')[0] as ModTargetId;
          const raw = routeAmount(routes, key);
          // Same octave-vs-Hz reconciliation as applyRoutes: dragging a
          // cutoff route to +100% must set the same gain a fresh voice would
          // get, or the amount only "sticks" on the next note.
          const value =
            targetId === 'filterACutoff' || targetId === 'filterBCutoff'
              ? cutoffModGainHz(this.baseCutoffFor(targetId), raw)
              : clampRouteAmount(targetId, raw);
          g.gain.setTargetAtTime(value, now, 0.01);
        }
      } else {
        this.applyRoutes(v, routes);
      }
    }
  }

  /**
   * Dual filters (todo.md §60). Each of Filter A/B's own `stage2` is
   * always present (see the `Voice.filterA`/`filterB` doc), so a slope
   * toggle is just a `.type` flip, no graph rebuild. Cutoff/resonance ramp
   * live via `setTargetAtTime` so turning the knob on a held chord is
   * audible.
   */
  setFilterA(f: FilterSettings): void {
    this.filterAShape = f;
    this.applyFilterUnitLive(f, (v) => v.filterA, 'filterACutoff');
  }
  setFilterB(f: FilterSettings): void {
    this.filterBShape = f;
    this.applyFilterUnitLive(f, (v) => v.filterB, 'filterBCutoff');
  }
  private applyFilterUnitLive(
    f: FilterSettings,
    pick: (v: Voice) => { stage1: BiquadFilterNode; stage2: BiquadFilterNode },
    targetId: 'filterACutoff' | 'filterBCutoff',
  ): void {
    const now = this.ctx.currentTime;
    for (const v of this.voices.values()) {
      const unit = pick(v);
      unit.stage1.type = f.type;
      unit.stage2.type = f.slope === '24' ? f.type : 'allpass';
      unit.stage1.frequency.setTargetAtTime(f.cutoffHz, now, 0.02);
      unit.stage2.frequency.setTargetAtTime(f.cutoffHz, now, 0.02);
      unit.stage1.Q.setTargetAtTime(f.resonance, now, 0.02);
      unit.stage2.Q.setTargetAtTime(f.resonance, now, 0.02);
      // Cutoff mod depth is derived from the base cutoff (cutoffModGainHz), so
      // moving the cutoff knob has to re-derive every route that targets it —
      // otherwise the depth stays pinned to whatever fc was when the route was
      // wired, which is how a ±4-octave sweep silently degrades to a ±4 Hz
      // nudge as soon as you move the cutoff away from that value.
      this.refreshCutoffModGain(v, targetId);
    }
  }

  /** Current base cutoff (Hz) for a cutoff target, from the stored filter shape. */
  private baseCutoffFor(targetId: 'filterACutoff' | 'filterBCutoff'): number {
    return targetId === 'filterACutoff' ? this.filterAShape.cutoffHz : this.filterBShape.cutoffHz;
  }

  /**
   * Re-derive the gain on every live route that modulates a cutoff target,
   * against the filter's current base cutoff. Called from `applyFilterUnitLive`
   * so depth tracks the cutoff knob; see `cutoffModGainHz` for why the gain is
   * a function of fc at all.
   */
  private refreshCutoffModGain(v: Voice, targetId: 'filterACutoff' | 'filterBCutoff'): void {
    if (!targetId) return;
    const base = this.baseCutoffFor(targetId);
    for (const route of this.modRoutes[targetId] ?? []) {
      if (route.amount === 0) continue;
      const g = v.modScales.get(`${targetId}:${route.source}`);
      if (g) g.gain.value = cutoffModGainHz(base, route.amount);
    }
  }

  /** Set the AudioBuffer a given oscillator (in sample mode) plays from. Pass null to clear. */
  setSampleBuffer(id: OperatorId, buffer: AudioBuffer | null): void {
    this.sampleBuffers.set(id, buffer);
  }

  /** Decoded duration of the captured buffer for a given operator (0 if none). */
  sampleDuration(id: OperatorId): number {
    return this.sampleBuffers.get(id)?.duration ?? 0;
  }

  /** Render a given operator's captured buffer as packed Float32 mono samples for the UI. */
  samplePeaks(id: OperatorId, maxPoints = 256): Float32Array {
    const buf = this.sampleBuffers.get(id);
    if (!buf) return new Float32Array(0);
    const data = buf.getChannelData(0);
    if (data.length === 0) return new Float32Array(0);
    const block = Math.max(1, Math.floor(data.length / maxPoints));
    const out = new Float32Array(maxPoints * 2); // [min, max] pairs
    for (let i = 0; i < maxPoints; i++) {
      const start = i * block;
      const end = Math.min(data.length, start + block);
      let lo = Infinity, hi = -Infinity;
      for (let j = start; j < end; j++) {
        const v = data[j];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      out[i * 2] = lo === Infinity ? 0 : lo;
      out[i * 2 + 1] = hi === -Infinity ? 0 : hi;
    }
    return out;
  }

  /** Drop a given operator's captured buffer (the user wants to start over). */
  clearSampleBuffer(id: OperatorId): void {
    this.sampleBuffers.delete(id);
  }

  /** Trigger a note. Idempotent while note is already held. */
  noteOn(midi: MidiNote, velocity = 1): void {
    if (this.disposed) return;
    if (this.voices.has(midi)) return; // already held — silent retrigger

    // Which operators actually sound this note: enabled oscillator slots,
    // plus the sampler if it's enabled AND has a buffer captured/loaded.
    const enabledIds: OperatorId[] = [];
    for (let i = 0; i < 4; i++) {
      const slot = this.oscSlots[i];
      if (!slot?.enabled) continue;
      // A sample-mode slot only sounds once it actually has a captured
      // buffer — an empty sample oscillator is enabled but silent.
      if (slot.wave === 'sample' && this.sampleBuffers.get(OPERATOR_IDS[i]) == null) continue;
      enabledIds.push(OPERATOR_IDS[i]);
    }
    // Nothing enabled (or every sample slot is empty): silent noteOn — the
    // key still lights up visually but there's genuinely nothing to play.
    if (enabledIds.length === 0) return;

    if (this.voices.size >= this.opts.voiceLimit) {
      // Voice-steal the oldest held note.
      let oldestMidi: MidiNote | null = null;
      let oldestAt = Infinity;
      for (const [m, v] of this.voices) {
        if (v.startedAt < oldestAt && v.releaseTimer == null) {
          oldestAt = v.startedAt;
          oldestMidi = m;
        }
      }
      if (oldestMidi !== null) {
        this.scheduleRelease(this.voices.get(oldestMidi)!);
      }
    }

    const now = this.ctx.currentTime;

    const voiceMixA = this.ctx.createGain();
    voiceMixA.gain.value = 1;
    const voiceMixB = this.ctx.createGain();
    voiceMixB.gain.value = 1;

    // Dual filters (todo.md §60): voiceMixA → filterA → ampEnv, voiceMixB →
    // filterB → ampEnv (summed there). Each filter's stage2 is always
    // present — a 12 dB/oct slope is just stage2 running as 'allpass'
    // (transparent to magnitude, so it doesn't touch the sound but means
    // toggling slope live never needs to rebuild the graph).
    const buildFilterUnit = (shape: FilterSettings) => {
      const stage1 = this.ctx.createBiquadFilter();
      const stage2 = this.ctx.createBiquadFilter();
      stage1.type = shape.type;
      stage2.type = shape.slope === '24' ? shape.type : 'allpass';
      stage1.frequency.value = shape.cutoffHz;
      stage2.frequency.value = shape.cutoffHz;
      stage1.Q.value = shape.resonance;
      stage2.Q.value = shape.resonance;
      stage1.connect(stage2);
      return { stage1, stage2 };
    };
    const filterA = buildFilterUnit(this.filterAShape);
    const filterB = buildFilterUnit(this.filterBShape);
    voiceMixA.connect(filterA.stage1);
    voiceMixB.connect(filterB.stage1);

    // ENV 1 (amplitude): both filtered signals sum into this node — its
    // gain is what scheduleEnvelope automates 0→1→sustain→0.
    const ampEnv = this.ctx.createGain();
    ampEnv.gain.value = 0;
    filterA.stage2.connect(ampEnv);
    filterB.stage2.connect(ampEnv);

    // ENV 2 (free mod source): an unconnected GainNode outputs silence no
    // matter how its .gain is automated — a ConstantSourceNode(1) gives it a
    // real input so the automated curve becomes an actual signal.
    const modEnv = this.ctx.createGain();
    modEnv.gain.value = 0;
    const modEnvCarrier = this.ctx.createConstantSource();
    modEnvCarrier.offset.value = 1;
    modEnvCarrier.connect(modEnv);
    modEnvCarrier.start(now);

    // LFOs — free-running per-voice modulation sources (pure CV, routed
    // through applyRoutes exactly like modEnv). A `'sample-hold'` LFO is a
    // looping random-step buffer instead of an oscillator (buildLfoNode).
    const lfo1 = this.buildLfoNode(this.lfo1Shape, now);
    const lfo2 = this.buildLfoNode(this.lfo2Shape, now);

    // Sample-and-hold — per-voice random stepped mod source (looping buffer).
    const sh = this.buildShNode(now);

    // Velocity + keyboard tracking — per-voice constant mod sources.
    const velocitySrc = this.ctx.createConstantSource();
    velocitySrc.offset.value = Math.max(0, Math.min(1, velocity));
    velocitySrc.start(now);
    const keytrackSrc = this.ctx.createConstantSource();
    keytrackSrc.offset.value = keytrackValue(midi);
    keytrackSrc.start(now);
    // Random — one fresh bipolar value per note, held for the note's life
    // (no rate, no movement; "humanise every note"). A plain ConstantSource.
    const randomSrc = this.ctx.createConstantSource();
    randomSrc.offset.value = Math.random() * 2 - 1;
    randomSrc.start(now);

    const voiceGain = this.ctx.createGain();
    voiceGain.gain.value = this.opts.voiceLevel;
    ampEnv.connect(voiceGain);
    voiceGain.connect(this.master);

    const operators = new Map<OperatorId, OperatorInstance>();

    // Pass 1 — build every sounding operator's source + level + pan, and
    // connect it into the voice mix (and its persistent monitor bus, for
    // that operator's dedicated visualizer).
    for (const id of enabledIds) {
      const levelGain = this.ctx.createGain();
      const panNode = this.ctx.createStereoPanner();
      let source: OperatorSource;
      const slot = this.oscSlots[oscSlotIndex(id)];
      levelGain.gain.value = slot.level;
      panNode.pan.value = slot.pan;
      if (slot.wave === 'sample') {
        // AudioBufferSourceNode is single-shot — every noteOn builds a fresh
        // node pointing at the same shared buffer. Looping keeps the sample
        // ringing as long as the key is held.
        const node = this.ctx.createBufferSource();
        node.buffer = this.sampleBuffers.get(id)!;
        node.loop = true;
        source = node;
      } else {
        const osc = this.ctx.createOscillator();
        osc.setPeriodicWave(morphedPeriodicWave(this.ctx, slot.wavetablePosition));
        osc.frequency.value = midiToFreq(midi); // raw Hz — all pitch offset lives in .detune (see retuneOperator)
        source = osc;
      }
      source.connect(levelGain);
      levelGain.connect(panNode);
      // Dual-filter crossfade split (todo.md §60) — filterMix 0 = all A,
      // 1 = all B; a linear crossfade, matching the Pan knob's simplicity.
      const filterSplitA = this.ctx.createGain();
      const filterSplitB = this.ctx.createGain();
      const mix = Math.max(0, Math.min(1, slot.filterMix));
      filterSplitA.gain.value = 1 - mix;
      filterSplitB.gain.value = mix;
      panNode.connect(filterSplitA);
      panNode.connect(filterSplitB);
      filterSplitA.connect(voiceMixA);
      filterSplitB.connect(voiceMixB);
      panNode.connect(this.operatorBuses.get(id)!);
      operators.set(id, {
        id,
        source,
        levelGain,
        panNode,
        filterSplitA,
        filterSplitB,
        pmGains: new Map(),
        fmGains: new Map(),
        pmDepthScale: null,
        pmDepthScales: new Map(),
        fmDepthScales: new Map(),
        pmDelays: new Map(),
        fmDelays: new Map(),
      });
    }

    // Base pitch for every operator (global transpose + its own octave/
    // semitone/fine), before any FM/PM connections layer on top.
    for (const [id, op] of operators) this.retuneOperator(op, id, midi);

    // Pass 2 — wire audio-rate modulation between operators that are BOTH
    // sounding this note. Each operator can be PM'd and/or FM'd by several
    // sources at once (Phase-4's colour-coded knobs), so every source gets
    // its own PM depth gain (fanning into one shared `pmDepthScale` so the
    // `${id}ModAmount` route scales overall PM depth) and its own FM depth
    // gain. Feedback edges — an operator modulating ITSELF, or two operators
    // modulating each other — are legal: `connectModEdge` inserts a
    // one-render-quantum DelayNode so Web Audio accepts the cycle (the UI
    // used to grey those knobs out; the user dropped that — todo.md).
    for (const [id, op] of operators) {
      const slot = this.oscSlots[oscSlotIndex(id)];
      for (const [srcId, entry] of Object.entries(slot.mods ?? {}) as [OperatorId, OperatorModEntry][]) {
        const srcOp = operators.get(srcId);
        if (!srcOp) continue; // modulator isn't sounding this note
        if (entry.pm > 0) this.connectModEdge(op, srcOp, srcId, 'pm', entry);
        if (entry.fm > 0) this.connectModEdge(op, srcOp, srcId, 'fm', entry);
      }
    }

    for (const [, op] of operators) op.source.start(now);

    const voice: Voice = {
      midi,
      operators,
      voiceMixA,
      voiceMixB,
      filterA,
      filterB,
      ampEnv,
      modEnv,
      modEnvCarrier,
      lfo1,
      lfo2,
      sh,
      random: randomSrc,
      lfo1ShapeMod: null,
      lfo2ShapeMod: null,
      velocity: velocitySrc,
      keytrack: keytrackSrc,
      voiceGain,
      modScales: new Map(),
      ampEnvShape: { ...this.ampEnvShape },
      modEnvShape: { ...this.modEnvShape },
      startedAt: now,
      releasing: false,
      releaseTimer: null,
      disposed: false,
    };
    this.voices.set(midi, voice);

    this.scheduleEnvelope(ampEnv.gain, now, voice.ampEnvShape);
    this.scheduleEnvelope(modEnv.gain, now, voice.modEnvShape);
    this.applyRoutes(voice, this.modRoutes);
  }

  /** Release a held note. Silent if not held or already releasing. */
  noteOff(midi: MidiNote): void {
    if (this.disposed) return;
    const v = this.voices.get(midi);
    if (!v) return;
    if (v.releasing) return;
    this.scheduleRelease(v);
  }

  /** Release every held note (panic / computer-keyboard-blur safety). */
  panic(): void {
    for (const v of [...this.voices.values()]) {
      if (!v.releasing) this.scheduleRelease(v);
    }
  }

  /** Currently-held note count — handy for UI ("3 voices"). */
  activeVoiceCount(): number {
    let n = 0;
    for (const v of this.voices.values()) {
      if (!v.releasing) n++;
    }
    return n;
  }

  /** Per-operator pitch offset in cents (semitones * 100), before the global transpose. */
  private operatorCents(id: OperatorId): number {
    return this.oscSlots[oscSlotIndex(id)].pitch * 100;
  }

  /** Retune one live operator to the current global + per-operator pitch. Oscillators via .detune; a sample-mode operator via .playbackRate relative to its own rootHz (its cents are baked in — see midiToFreq). */
  private retuneOperator(op: OperatorInstance, id: OperatorId, midi: MidiNote): void {
    const cents = this.pitchCents + this.operatorCents(id);
    if (op.source instanceof AudioBufferSourceNode) {
      const pitchHz = midiToFreq(midi, cents);
      const rootHz = this.oscSlots[oscSlotIndex(id)].rootHz;
      op.source.playbackRate.value = pitchHz / Math.max(1, rootHz);
    } else {
      op.source.detune.value = cents;
    }
  }

  /** Re-apply pitch to every operator of every held voice — called whenever the global transpose or any slot's pitch/rootHz changes. */
  private applyPitchLive(): void {
    for (const voice of this.voices.values()) {
      for (const [id, op] of voice.operators) {
        this.retuneOperator(op, id, voice.midi);
      }
    }
  }

  /**
   * Re-apply per-operator level / pan / filter-crossfade / wavetable position
   * to every held voice — so turning any of those knobs is audible on a note
   * you're already holding, not just on the next `noteOn`. `.gain`/`.pan`
   * ramp via `setTargetAtTime` (smooth, composes additively with any mod
   * route connected into the same param); a wavetable-position edit
   * re-band-limits the running oscillator in place via `setPeriodicWave`.
   * `wave` and `enabled` deliberately stay new-note-only (a running
   * OscillatorNode can't become an AudioBufferSourceNode, and the "wave
   * doesn't retrigger" precedent predates this).
   */
  private applyOscParamsLive(): void {
    const now = this.ctx.currentTime;
    for (const voice of this.voices.values()) {
      for (const [id, op] of voice.operators) {
        const slot = this.oscSlots[oscSlotIndex(id)];
        op.levelGain.gain.setTargetAtTime(slot.level, now, 0.01);
        op.panNode.pan.setTargetAtTime(Math.max(-1, Math.min(1, slot.pan)), now, 0.01);
        const mix = Math.max(0, Math.min(1, slot.filterMix));
        op.filterSplitA.gain.setTargetAtTime(1 - mix, now, 0.01);
        op.filterSplitB.gain.setTargetAtTime(mix, now, 0.01);
        if (op.source instanceof OscillatorNode && slot.wave !== 'sample') {
          op.source.setPeriodicWave(morphedPeriodicWave(this.ctx, slot.wavetablePosition));
        }
      }
    }
  }

  /** One render quantum (~2.9 ms @ 44.1 kHz) — the smallest delay that lets
   *  a feedback edge (self-modulation, or a mutual PM/FM loop between two
   *  operators) exist in a Web Audio graph, which throws on cycles without a
   *  DelayNode. The classic FM-feedback trick. */
  private modFeedbackDelay(): DelayNode {
    const delay = this.ctx.createDelay(1);
    delay.delayTime.value = 128 / this.ctx.sampleRate;
    return delay;
  }

  /** FM depth gain value for an edge into `op` — Hz for an oscillator target, a playback-rate ratio for a sample target. */
  private fmDepthValue(op: OperatorInstance, depth: number): number {
    return op.source instanceof AudioBufferSourceNode ? depth * SAMPLE_FM_DEPTH_RATIO : depth * FM_DEPTH_HZ;
  }

  /**
   * Wire one PM/FM edge into a live operator:
   *
   *   srcOp.source → depthScale (unity; the `${id}Pm${src}`/`${id}Fm${src}`
   *                  mod-route targets feed its .gain, 1 + amount·env) →
   *   [one-render-quantum DelayNode when the edge is cyclic] →
   *   depth gain (entry.pm·PM_DEPTH_CENTS / entry.fm·FM_DEPTH_HZ) → target
   *   AudioParam (detune / frequency | playbackRate).
   *
   * Shared by `noteOn` (fresh voice) and `applyModsLive` (held-voice knob
   * edit) so the two can never drift: an already-wired edge is ramped to the
   * new depth, a zeroed amount returns false (caller drops it), and a
   * missing edge is built — delay included when `wouldCreateModCycle` says
   * the connection would close a loop.
   */
  private connectModEdge(
    op: OperatorInstance,
    srcOp: OperatorInstance,
    srcId: OperatorId,
    kind: 'pm' | 'fm',
    entry: OperatorModEntry,
  ): boolean {
    const depth = kind === 'pm' ? entry.pm : entry.fm;
    if (!(depth > 0)) return false;
    const now = this.ctx.currentTime;

    if (kind === 'pm') {
      const existing = op.pmGains.get(srcId);
      if (existing) {
        existing.gain.setTargetAtTime(depth * PM_DEPTH_CENTS, now, 0.01);
        return true;
      }
      if (!op.pmDepthScale) {
        op.pmDepthScale = this.ctx.createGain();
        op.pmDepthScale.gain.value = 1;
        op.pmDepthScale.connect(op.source.detune);
      }
      const depthScale = this.ctx.createGain();
      depthScale.gain.value = 1;
      const pmGain = this.ctx.createGain();
      pmGain.gain.value = depth * PM_DEPTH_CENTS;
      srcOp.source.connect(depthScale);
      if (wouldCreateModCycle(op.id, srcId, { oscillators: this.oscSlots })) {
        const delay = this.modFeedbackDelay();
        depthScale.connect(delay);
        delay.connect(pmGain);
        op.pmDelays.set(srcId, delay);
      } else {
        depthScale.connect(pmGain);
      }
      pmGain.connect(op.pmDepthScale);
      op.pmGains.set(srcId, pmGain);
      op.pmDepthScales.set(srcId, depthScale);
      return true;
    }

    const existing = op.fmGains.get(srcId);
    if (existing) {
      existing.gain.setTargetAtTime(this.fmDepthValue(op, depth), now, 0.01);
      return true;
    }
    const depthScale = this.ctx.createGain();
    depthScale.gain.value = 1;
    const fmGain = this.ctx.createGain();
    fmGain.gain.value = this.fmDepthValue(op, depth);
    const targetParam =
      op.source instanceof AudioBufferSourceNode ? op.source.playbackRate : (op.source as OscillatorNode).frequency;
    srcOp.source.connect(depthScale);
    if (wouldCreateModCycle(op.id, srcId, { oscillators: this.oscSlots })) {
      const delay = this.modFeedbackDelay();
      depthScale.connect(delay);
      delay.connect(fmGain);
      op.fmDelays.set(srcId, delay);
    } else {
      depthScale.connect(fmGain);
    }
    fmGain.connect(targetParam);
    op.fmGains.set(srcId, fmGain);
    op.fmDepthScales.set(srcId, depthScale);
    return true;
  }

  /** Tear down one PM/FM edge (depth gain + its depth-scale + its feedback delay) on a live operator. */
  private disconnectModEdge(op: OperatorInstance, srcId: OperatorId, kind: 'pm' | 'fm'): void {
    const gains = kind === 'pm' ? op.pmGains : op.fmGains;
    const scales = kind === 'pm' ? op.pmDepthScales : op.fmDepthScales;
    const delays = kind === 'pm' ? op.pmDelays : op.fmDelays;
    const g = gains.get(srcId);
    if (g) { try { g.disconnect(); } catch { /* noop */ } gains.delete(srcId); }
    const s = scales.get(srcId);
    if (s) { try { s.disconnect(); } catch { /* noop */ } scales.delete(srcId); }
    const d = delays.get(srcId);
    if (d) { try { d.disconnect(); } catch { /* noop */ } delays.delete(srcId); }
  }

  /**
   * Re-sync every held voice's PM + FM graph to the current `oscSlots`
   * `.mods` maps — turning a phase- or frequency-modulation knob is audible
   * on a held note immediately, not just on the next `noteOn`.
   * Reconciliation shape matches `setModRoutes` (drop zeroed connections,
   * ramp existing depths, wire newly-nonzero ones).
   */
  private applyModsLive(): void {
    for (const voice of this.voices.values()) {
      for (const [id, op] of voice.operators) {
        const slot = this.oscSlots[oscSlotIndex(id)];
        const mods = slot.mods ?? {};

        // Drop connections whose source is now absent or zeroed.
        for (const srcId of [...op.pmGains.keys()]) {
          if (!((mods[srcId]?.pm ?? 0) > 0)) this.disconnectModEdge(op, srcId, 'pm');
        }
        for (const srcId of [...op.fmGains.keys()]) {
          if (!((mods[srcId]?.fm ?? 0) > 0)) this.disconnectModEdge(op, srcId, 'fm');
        }

        for (const [srcId, entry] of Object.entries(mods) as [OperatorId, OperatorModEntry][]) {
          const srcOp = voice.operators.get(srcId);
          if (!srcOp) continue; // modulator isn't sounding this note
          if (entry.pm > 0) this.connectModEdge(op, srcOp, srcId, 'pm', entry);
          if (entry.fm > 0) this.connectModEdge(op, srcOp, srcId, 'fm', entry);
        }
      }
    }
  }

  private scheduleRelease(v: Voice): void {
    const now = this.ctx.currentTime;
    const releaseSec = Math.max(v.ampEnvShape.releaseSec, 0.001);
    v.releasing = true;
    // Both envelopes release together, each starting from the value the
    // audio thread is actually at (computed from the linear schedule — an
    // AudioParam's `.value` does NOT reflect scheduled automation).
    // Release length follows the amp envelope's release knob.
    for (const [env, shape] of [
      [v.ampEnv, v.ampEnvShape],
      [v.modEnv, v.modEnvShape],
    ] as const) {
      const val = envelopeValueAt(shape, v.startedAt, now);
      env.gain.cancelScheduledValues(now);
      env.gain.setValueAtTime(val, now);
      if (Math.abs(shape.releaseCurve) < 0.001) {
        env.gain.linearRampToValueAtTime(0, now + releaseSec);
      } else {
        env.gain.setValueCurveAtTime(segmentCurve(val, 0, shape.releaseCurve), now, releaseSec);
      }
    }
    for (const op of v.operators.values()) {
      op.source.stop(now + releaseSec + 0.005);
    }
    v.modEnvCarrier.stop(now + releaseSec + 0.005);
    v.lfo1.stop(now + releaseSec + 0.005);
    v.lfo2.stop(now + releaseSec + 0.005);
    v.sh.stop(now + releaseSec + 0.005);
    v.random.stop(now + releaseSec + 0.005);
    v.velocity.stop(now + releaseSec + 0.005);
    v.keytrack.stop(now + releaseSec + 0.005);
    v.releaseTimer = window.setTimeout(() => {
      for (const g of v.modScales.values()) {
        try { g.disconnect(); } catch { /* noop */ }
      }        for (const op of v.operators.values()) {
          try { op.source.disconnect(); } catch { /* noop */ }
          try { op.levelGain.disconnect(); } catch { /* noop */ }
          try { op.panNode.disconnect(); } catch { /* noop */ }
          try { op.filterSplitA.disconnect(); } catch { /* noop */ }
          try { op.filterSplitB.disconnect(); } catch { /* noop */ }
          for (const g of op.pmGains.values()) { try { g.disconnect(); } catch { /* noop */ } }
          for (const g of op.fmGains.values()) { try { g.disconnect(); } catch { /* noop */ } }
          for (const g of op.pmDepthScales.values()) { try { g.disconnect(); } catch { /* noop */ } }
          for (const g of op.fmDepthScales.values()) { try { g.disconnect(); } catch { /* noop */ } }
          for (const d of op.pmDelays.values()) { try { d.disconnect(); } catch { /* noop */ } }
          for (const d of op.fmDelays.values()) { try { d.disconnect(); } catch { /* noop */ } }
          try { op.pmDepthScale?.disconnect(); } catch { /* noop */ }
        }
      try { v.modEnvCarrier.disconnect(); } catch { /* noop */ }
      try { v.voiceMixA.disconnect(); } catch { /* noop */ }
      try { v.voiceMixB.disconnect(); } catch { /* noop */ }
      try { v.filterA.stage1.disconnect(); } catch { /* noop */ }
      try { v.filterA.stage2.disconnect(); } catch { /* noop */ }
      try { v.filterB.stage1.disconnect(); } catch { /* noop */ }
      try { v.filterB.stage2.disconnect(); } catch { /* noop */ }
      try { v.ampEnv.disconnect(); } catch { /* noop */ }
      try { v.modEnv.disconnect(); } catch { /* noop */ }
      try { v.voiceGain.disconnect(); } catch { /* noop */ }
      try { v.lfo1.disconnect(); } catch { /* noop */ }
      try { v.lfo2.disconnect(); } catch { /* noop */ }
      try { v.sh.disconnect(); } catch { /* noop */ }
      try { v.random.disconnect(); } catch { /* noop */ }
      try { v.velocity.disconnect(); } catch { /* noop */ }
      try { v.keytrack.disconnect(); } catch { /* noop */ }
      this.teardownShapeTap(v.lfo1ShapeMod);
      this.teardownShapeTap(v.lfo2ShapeMod);
      this.voices.delete(v.midi);
    }, releaseSec * 1000 + 30);
  }

  /**
   * Walk an envelope gain through its ADSR shape from t0:
   * 0 →(attack)→ 1 →(decay)→ sustain → (held until release). Each ramp is
   * curved via its `*Curve` field (Vital-style); curve ≈ 0 falls back to a
   * plain linear ramp so `envelopeValueAt` stays exactly predictable at
   * noteOff. A 1 ms floor on attack/decay prevents clicks at 0 values.
   */
  private scheduleEnvelope(param: AudioParam, t0: number, e: AdsrEnvelope): void {
    const attack = Math.max(e.attackSec, 0.001);
    param.cancelScheduledValues(t0);
    param.setValueAtTime(0, t0);
    if (Math.abs(e.attackCurve) < 0.001) {
      param.linearRampToValueAtTime(1, t0 + attack);
    } else {
      param.setValueCurveAtTime(segmentCurve(0, 1, e.attackCurve), t0, attack);
    }
    // sustain === 1 means decay is a no-op (holds at the attack peak).
    if (e.sustainLevel < 0.999) {
      const decay = Math.max(e.decaySec, 0.001);
      const tDecay = t0 + attack;
      if (Math.abs(e.decayCurve) < 0.001) {
        param.linearRampToValueAtTime(e.sustainLevel, tDecay + decay);
      } else {
        param.setValueCurveAtTime(segmentCurve(1, e.sustainLevel, e.decayCurve), tDecay, decay);
      }
    }
  }

  /**
   * (Re)build one voice's modulation graph from the route map. Each route
   * is source envelope → amount scale GainNode → target AudioParam(s).
   * Existing connections are torn down first so a route edit is atomic.
   */
  private applyRoutes(v: Voice, routes: ModMap): void {
    for (const g of v.modScales.values()) {
      try { g.disconnect(); } catch { /* noop */ }
    }
    v.modScales.clear();

    // LFO-shape modulation (todo.md §66) needs a per-voice analyser bus (not
    // an AudioParam). Create it on demand; tear it down when the last shape
    // route for that LFO goes away.
    const wantShape = (id: 'lfo1Shape' | 'lfo2Shape') => (routes[id] ?? []).some((r) => r.amount !== 0);
    if (wantShape('lfo1Shape')) v.lfo1ShapeMod ??= this.makeShapeTap();
    else { this.teardownShapeTap(v.lfo1ShapeMod); v.lfo1ShapeMod = null; }
    if (wantShape('lfo2Shape')) v.lfo2ShapeMod ??= this.makeShapeTap();
    else { this.teardownShapeTap(v.lfo2ShapeMod); v.lfo2ShapeMod = null; }

    for (const [targetId, list] of Object.entries(routes) as [ModTargetId, ModRoute[]][]) {
      for (const route of list ?? []) {
        if (route.amount === 0) continue;
        // ENV 1 → level IS the amp envelope (pre-wired at noteOn); a second
        // connection would double it.
        if (targetId === 'oscLevel' && route.source === 'env1') continue;
        const src =
          route.source === 'env1' ? v.ampEnv
          : route.source === 'env2' ? v.modEnv
          : route.source === 'lfo1' ? v.lfo1
          : route.source === 'lfo2' ? v.lfo2
          : route.source === 'sh' ? v.sh
          : route.source === 'random' ? v.random
          : route.source === 'velocity' ? v.velocity
          : v.keytrack;
        const scale = this.ctx.createGain();
        // Filter cutoff is the one target whose UI unit is NOT the DSP unit:
        // `mod-sources.ts` stores octaves (±4 → labelled ±100%), but an
        // AudioParam only accepts an additive offset. Resolve the octave depth
        // against the voice's base cutoff instead of using the raw amount —
        // see cutoffModGainHz. Every other target is genuinely additive in its
        // native unit and goes through clampRouteAmount unchanged.
        if (targetId === 'filterACutoff' || targetId === 'filterBCutoff') {
          scale.gain.value = cutoffModGainHz(this.baseCutoffFor(targetId), route.amount);
        } else {
          scale.gain.value = clampRouteAmount(targetId, route.amount);
        }
        src.connect(scale);
        if (targetId === 'lfo1Shape') {
          if (v.lfo1ShapeMod) scale.connect(v.lfo1ShapeMod.bus);
        } else if (targetId === 'lfo2Shape') {
          if (v.lfo2ShapeMod) scale.connect(v.lfo2ShapeMod.bus);
        } else if (targetId === 'pitch') {
          // Fan out to every sounding operator's detune (both OscillatorNode
          // and AudioBufferSourceNode expose it) so a pitch route bends the
          // whole voice, not just one oscillator.
          for (const op of v.operators.values()) scale.connect(op.source.detune);
        } else if (targetId === 'filterACutoff') {
          // Fan out to both of Filter A's cascaded stages so a 24 dB/oct
          // slope tracks the modulation together (matches 'pitch' above).
          scale.connect(v.filterA.stage1.frequency);
          scale.connect(v.filterA.stage2.frequency);
        } else if (targetId === 'filterAResonance') {
          scale.connect(v.filterA.stage1.Q);
          scale.connect(v.filterA.stage2.Q);
        } else if (targetId === 'filterBCutoff') {
          scale.connect(v.filterB.stage1.frequency);
          scale.connect(v.filterB.stage2.frequency);
        } else if (targetId === 'filterBResonance') {
          scale.connect(v.filterB.stage1.Q);
          scale.connect(v.filterB.stage2.Q);
        } else {
          const param = this.resolveTargetParam(targetId, v);
          if (param) scale.connect(param);
        }
        v.modScales.set(`${targetId}:${route.source}`, scale);
      }
    }

    if (v.lfo1ShapeMod || v.lfo2ShapeMod) this.startShapeLoop();
  }

  /** Map a mod target id to the live AudioParam on a voice. `'pitch'` and the four filter cutoff/resonance targets fan out in `applyRoutes` instead — none has a single param. */
  private resolveTargetParam(targetId: ModTargetId, v: Voice): AudioParam | null {
    switch (targetId) {
      case 'pitch':
      case 'filterACutoff':
      case 'filterAResonance':
      case 'filterBCutoff':
      case 'filterBResonance':
      case 'lfo1Shape': // control-rate, handled in applyRoutes via a bus
      case 'lfo2Shape':
        return null;
      case 'oscLevel':
        return v.voiceGain.gain;
      // LFO rate — additive Hz into the periodic LFO's .frequency. A
      // sample-hold LFO is a looping buffer whose .playbackRate is a tiny
      // ratio, not Hz, so rate modulation is only offered while the LFO is
      // in its continuous-morph (oscillator) mode.
      case 'lfo1Rate':
        return v.lfo1 instanceof OscillatorNode ? v.lfo1.frequency : null;
      case 'lfo2Rate':
        return v.lfo2 instanceof OscillatorNode ? v.lfo2.frequency : null;
    }
    // Per-operator targets: Level / Pan / ModAmount / Pitch, plus the
    // per-SOURCE PM/FM depth knobs (`${op}Pm${src}` / `${op}Fm${src}`).
    const parsed = parseOperatorTarget(targetId);
    if (!parsed) return null;
    const op = v.operators.get(parsed.op);
    if (!op) return null;
    switch (parsed.kind) {
      case 'level':
        return op.levelGain.gain;
      case 'pan':
        return op.panNode.pan;
      case 'pitch':
        // Both OscillatorNode and AudioBufferSourceNode expose .detune in
        // cents — same param the global 'pitch' route fans out to.
        return op.source.detune;
      case 'modAmount':
        // PM depth only exists if this operator is actually being PM'd this
        // note; otherwise there's nothing to scale.
        return op.pmDepthScale?.gain ?? null;
      case 'pm':
        // Per-knob depth scale exists only while that PM knob is > 0 (an
        // edge is actually wired) — otherwise the route is inert.
        return op.pmDepthScales.get(parsed.src)?.gain ?? null;
      case 'fm':
        return op.fmDepthScales.get(parsed.src)?.gain ?? null;
    }
  }

  /** Tear down the whole engine — call from React effect cleanup. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const v of this.voices.values()) {
      for (const op of v.operators.values()) {
        try { op.source.stop(); } catch { /* noop */ }
        try { op.source.disconnect(); } catch { /* noop */ }
        try { op.levelGain.disconnect(); } catch { /* noop */ }
        try { op.panNode.disconnect(); } catch { /* noop */ }
        try { op.filterSplitA.disconnect(); } catch { /* noop */ }
        try { op.filterSplitB.disconnect(); } catch { /* noop */ }
        for (const g of op.pmGains.values()) { try { g.disconnect(); } catch { /* noop */ } }
        for (const g of op.fmGains.values()) { try { g.disconnect(); } catch { /* noop */ } }
        for (const g of op.pmDepthScales.values()) { try { g.disconnect(); } catch { /* noop */ } }
        for (const g of op.fmDepthScales.values()) { try { g.disconnect(); } catch { /* noop */ } }
        for (const d of op.pmDelays.values()) { try { d.disconnect(); } catch { /* noop */ } }
        for (const d of op.fmDelays.values()) { try { d.disconnect(); } catch { /* noop */ } }
        try { op.pmDepthScale?.disconnect(); } catch { /* noop */ }
      }
      for (const g of v.modScales.values()) {
        try { g.disconnect(); } catch { /* noop */ }
      }
      try { v.modEnvCarrier.stop(); } catch { /* noop */ }
      try { v.modEnvCarrier.disconnect(); } catch { /* noop */ }
      try { v.voiceMixA.disconnect(); } catch { /* noop */ }
      try { v.voiceMixB.disconnect(); } catch { /* noop */ }
      try { v.filterA.stage1.disconnect(); } catch { /* noop */ }
      try { v.filterA.stage2.disconnect(); } catch { /* noop */ }
      try { v.filterB.stage1.disconnect(); } catch { /* noop */ }
      try { v.filterB.stage2.disconnect(); } catch { /* noop */ }
      try { v.ampEnv.disconnect(); } catch { /* noop */ }
      try { v.modEnv.disconnect(); } catch { /* noop */ }
      try { v.voiceGain.disconnect(); } catch { /* noop */ }
      try { v.lfo1.stop(); } catch { /* noop */ }
      try { v.lfo1.disconnect(); } catch { /* noop */ }
      try { v.lfo2.stop(); } catch { /* noop */ }
      try { v.lfo2.disconnect(); } catch { /* noop */ }
      try { v.sh.stop(); } catch { /* noop */ }
      try { v.sh.disconnect(); } catch { /* noop */ }
      try { v.velocity.stop(); } catch { /* noop */ }
      try { v.velocity.disconnect(); } catch { /* noop */ }
      try { v.keytrack.stop(); } catch { /* noop */ }
      try { v.keytrack.disconnect(); } catch { /* noop */ }
      try { v.random.stop(); } catch { /* noop */ }
      try { v.random.disconnect(); } catch { /* noop */ }
      this.teardownShapeTap(v.lfo1ShapeMod);
      this.teardownShapeTap(v.lfo2ShapeMod);
      if (v.releaseTimer != null) window.clearTimeout(v.releaseTimer);
    }
    this.voices.clear();
    if (this.shapeRaf) cancelAnimationFrame(this.shapeRaf);
    try { this.shapeModSink?.disconnect(); } catch { /* noop */ }
    try { this.analyser.disconnect(); } catch { /* noop */ }
    try { this.master.disconnect(); } catch { /* noop */ }
    if (this.ctx.state !== 'closed') {
      try { await this.ctx.close(); } catch { /* noop */ }
    }
  }
}

/** Pick the best codec MediaRecorder will accept for capture (used by the
 *  system-audio sampler hook). */
export function pickMimeForRecording(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return 'audio/webm';
}

// ----- Modulation system helpers -------------------------------------------

/**
 * Sane modulation range per target, in the target's native unit. New
 * targets (pan, per-operator FM/PM amounts…) add an entry here + in
 * `resolveTargetParam` + in `lib/mod-sources.ts` UI metadata.
 */
/** Which operator + parameter a per-operator mod target id refers to. The
 *  `pm`/`fm` kinds also carry the SOURCE operator (`osc1PmOsc2` → { op:
 *  'osc1', kind: 'pm', src: 'osc2' }). */
function parseOperatorTarget(
  targetId: ModTargetId,
): { op: OperatorId; kind: 'level' | 'pan' | 'modAmount' | 'pitch' | 'pm' | 'fm'; src: OperatorId } | null {
  for (const op of OPERATOR_IDS) {
    if (targetId === `${op}Level`) return { op, kind: 'level', src: op };
    if (targetId === `${op}Pan`) return { op, kind: 'pan', src: op };
    if (targetId === `${op}ModAmount`) return { op, kind: 'modAmount', src: op };
    if (targetId === `${op}Pitch`) return { op, kind: 'pitch', src: op };
    if (targetId.startsWith(`${op}Pm`)) {
      const src = targetId.slice(op.length + 2) as OperatorId;
      if (OPERATOR_IDS.includes(src)) return { op, kind: 'pm', src };
    }
    if (targetId.startsWith(`${op}Fm`)) {
      const src = targetId.slice(op.length + 2) as OperatorId;
      if (OPERATOR_IDS.includes(src)) return { op, kind: 'fm', src };
    }
  }
  return null;
}

/**
 * Sane modulation range per target, in the target's native unit. New
 * targets (per-osc pan, FM/PM amounts…) add an entry here + in
 * `resolveTargetParam` + in `lib/mod-sources.ts` UI metadata.
 */
const MOD_ROUTE_RANGES: Record<ModTargetId, { min: number; max: number }> = (() => {
  const base: Record<string, { min: number; max: number }> = {
    pitch: { min: -2400, max: 2400 }, // cents (±2 octaves)
    oscLevel: { min: -1, max: 1 },    // 0..1 scale; negative ducks
    // SS162: OCTAVES. Widened from ±4 to ±10. The cutoff knob spans
    // 20 Hz..20000 Hz (~10 octaves), so ±4 could only ever cover 40% of the
    // knob's range from the default 20000 Hz base — -4 octaves lands at 1250 Hz
    // and the sweep stops far above the floor. ±10 covers the knob end-to-end
    // from ANY base (20 Hz +10 -> 20 kHz, 20 kHz -10 -> 20 Hz), which is what
    // "I should be able to modulate the whole way using an LFO" requires. The
    // DSP clamps the result to 20..20000 so the value can never leave the
    // knob's own range (dsp/synth.js filterParams, SS162).
    filterACutoff: { min: -10, max: 10 },
    filterAResonance: { min: -20, max: 20 },    // Q, additive onto resonance
    filterBCutoff: { min: -10, max: 10 },
    filterBResonance: { min: -20, max: 20 },
    lfo1Rate: { min: -30, max: 30 },   // Hz, additive onto rateHz
    lfo1Shape: { min: -1, max: 1 },     // 0..1 morph position, additive (control-rate)
    lfo2Rate: { min: -30, max: 30 },
    lfo2Shape: { min: -1, max: 1 },
  };
  for (const op of OPERATOR_IDS) {
    base[`${op}Level`] = { min: -1, max: 1 };
    base[`${op}Pan`] = { min: -1, max: 1 };
    base[`${op}ModAmount`] = { min: -1, max: 1 };
    base[`${op}Pitch`] = { min: -2400, max: 2400 }; // cents (±2 octaves)
    for (const src of OPERATOR_IDS) {
      base[`${op}Pm${src}`] = { min: -1, max: 1 }; // × depth (1 + amount·env)
      base[`${op}Fm${src}`] = { min: -1, max: 1 };
    }
  }
  return base as Record<ModTargetId, { min: number; max: number }>;
})();

/** All non-zero route keys ("target:source") in a route map. */
function routeKeys(routes: ModMap): string[] {
  const keys: string[] = [];
  for (const [targetId, list] of Object.entries(routes) as [ModTargetId, ModRoute[]][]) {
    for (const r of list ?? []) {
      if (r.amount !== 0) keys.push(`${targetId}:${r.source}`);
    }
  }
  return keys;
}

/** Amount of the route identified by "target:source" (0 if absent). */
function routeAmount(routes: ModMap, key: string): number {
  const [targetId, source] = key.split(':') as [ModTargetId, ModSourceId];
  for (const r of routes[targetId] ?? []) {
    if (r.source === source) return r.amount;
  }
  return 0;
}

/** Clamp a route amount to the target's sane range. */
function clampRouteAmount(targetId: ModTargetId, amount: number): number {
  const range = MOD_ROUTE_RANGES[targetId];
  return Math.max(range.min, Math.min(range.max, amount));
}

/**
 * Filter-cutoff mod depth, in OCTAVES, expressed as the additive Hz offset
 * that produces it on a `BiquadFilterNode.frequency`.
 *
 * Web Audio's `frequency` is an AudioParam, and the only modulation it
 * natively accepts is an ADDITIVE signal summed onto its value — there is no
 * way to say "multiply my cutoff by 2^amt". But a cutoff LFO is
 * musically an *octave* sweep, and the UI (`lib/mod-sources.ts`) has
 * advertised and stored filter-cutoff amounts in octaves (±4, labelled with
 * `pct(4)`, so ±100%) since todo.md §"Octaves, not Hz".
 *
 * Those two facts disagreed, and nothing reconciled them: `applyRoutes`
 * connected the source straight to `frequency` with
 * `gain = clampRouteAmount(target, amount)`, so a route dialled to a full
 * +100% set gain = 4 and swept the cutoff by **±4 Hz** — inaudible on any
 * filter. That was the user's report: "even when i put the LFO setting on the
 * filter to max(100%) the modulation doesnt ever seem to reach the filters
 * 100% value". (The older ±10000 Hz ceiling had a second, opposite problem:
 * additive ±10000 Hz from a wide-open cutoff slams straight into the Nyquist
 * clamp, so 100% "worked" but pegged instead of sweeping.)
 *
 * Resolving the octave depth against the voice's CURRENT base cutoff gives
 * `fc * (2^amt - 1)`: at +4 octaves that's +15·fc (a 16x lift, which Web
 * Audio clamps at Nyquist only once it really is that extreme), and at -4
 * octaves it's -0.9375·fc, landing on exactly fc/16.
 *
 * Because the result depends on `fc`, the gain has to be recomputed whenever
 * the cutoff knob moves — see `refreshCutoffModGain`, called from
 * `applyFilterUnitLive`. It is intentionally NOT recomputed per block: the
 * cutoff already glides via `setTargetAtTime`, and re-deriving on every
 * control-rate tick would make the depth itself wobble.
 */
function cutoffModGainHz(cutoffHz: number, octaves: number): number {
  return cutoffHz * (Math.pow(2, octaves) - 1);
}

/**
 * Curve (-1..1) → power exponent (Vital-style). 0 = linear (power 1),
 * +1 = strongly convex (power 16, slow→fast), -1 = strongly concave
 * (power 1/16, fast→slow). KEEP IN SYNC with the EnvGraph in
 * EnvelopePanel.tsx.
 */
function curvePower(curve: number): number {
  return Math.pow(2, Math.max(-1, Math.min(1, curve)) * 4);
}

/** Value of one curved segment at normalised time t (0..1), from → to. */
function segmentValue(from: number, to: number, t: number, curve: number): number {
  const power = curvePower(curve);
  const shaped = Math.pow(Math.max(0, Math.min(1, t)), power);
  return from + (to - from) * shaped;
}

/** Sampled curve for `AudioParam.setValueCurveAtTime`. */
const CURVE_SAMPLES = 128;
function segmentCurve(from: number, to: number, curve: number): Float32Array {
  const power = curvePower(curve);
  const out = new Float32Array(CURVE_SAMPLES);
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    const t = i / Math.max(1, CURVE_SAMPLES - 1);
    out[i] = from + (to - from) * Math.pow(t, power);
  }
  return out;
}

/**
 * Where the (possibly curved) ADSR schedule has an envelope at `now` (note
 * started at `startedAt`). Mirrors `scheduleEnvelope` exactly — used at
 * noteOff so the release ramp starts from the value the audio thread is
 * actually at without reading the AudioParam (which does not reflect
 * automation).
 */
function envelopeValueAt(e: AdsrEnvelope, startedAt: number, now: number): number {
  const t = now - startedAt;
  if (t <= 0) return 0;
  const attack = Math.max(e.attackSec, 0.001);
  if (t < attack) return segmentValue(0, 1, t / attack, e.attackCurve);
  const decay = Math.max(e.decaySec, 0.001);
  const t2 = t - attack;
  if (t2 < decay) return segmentValue(1, e.sustainLevel, t2 / decay, e.decayCurve);
  return e.sustainLevel;
}
