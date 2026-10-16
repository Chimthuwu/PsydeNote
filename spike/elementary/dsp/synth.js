// ---------------------------------------------------------------------------
// Portable Elementary DSP — the Faze synth engine, ported from
// src/renderer/lib/synth.ts. Runs BYTE-FOR-BYTE identically in the browser
// preview (web/main.js) and the VST3 plugin harness (plugin/dsp.main.js).
//
// Port status (tracks todo.md §68.6):
//   [x] P1  OSC 1 + amp ADSR + master + global transpose
//   [x] P2  four operators + per-op wave / level / pan / pitch
//   [x] P3  FM / PM matrix (any op -> any op, cycles allowed)
//   [x] P4  dual filter (A/B per voice, per-op crossfade, 12/24 dB)
//   [x] P5  ENV 2 + LFO 1/2 + S&H + random + velocity + keytrack + mod matrix
//           (DSP + regression harness + browser UI + plugin params — todo.md §72)
//   [ ] P6  host params / automation / poly modulation
//   [ ] P7  React UI in the webview
//   [ ] P8  presets + state chunk
// ---------------------------------------------------------------------------
import { el, createNode } from '@elemaudio/core';
import { WAVETABLES, WARP_MODES, NUM_FRAMES as WT_NUM_FRAMES, wavetableResourceKey } from './wavetables.js';

/** Discrete generated-wave choices (index order = the `op*_wave` param
 *  value, indices 0-3). Index 4 is the sampler (§114), index 5 is a real
 *  wavetable oscillator (Task 4, see WAVETABLES/wave===5 below) — both are
 *  handled as their own branches in `voiceSignal`, not through this array. */
export const WAVES = ['sine', 'triangle', 'sawtooth', 'square'];
export const NUM_OPERATORS = 4;
export { WAVETABLES };

const MIN_SEG = 0.001; // ADSR segment floor (matches synth.ts)
const TWO_PI = 2 * Math.PI;
const SCOPE_SIZE = 512; // samples per el.scope frame (256-8192 per the runtime)
// The relocated main visualizer (todo.md §96) renders ~5x wider than a
// per-operator scope (~1200px vs ~240px) — the same 512-sample buffer
// spread across that width still looks comparatively thin on detail even
// after the render-side fixes (lineTo interpolation, round joins,
// todo.md §101/§102 — user: per-op scopes "look slightly better" now, the
// big combined one "still looks a lil whack"). Bump ONLY main's buffer,
// not the 4 per-op ones (bandwidth-conscious — this quadruples ONE of the
// 5 scope streams' payload, not all of them; the timer is already at 30Hz,
// see PluginProcessor.cpp, so keep an eye on bridge load if this needs to
// go further).
const MAIN_SCOPE_SIZE = 1024; // 1024 -> ~47 frames/s (2048 was ~23/s: the real reason the main viz looked steppy)
const EQ_SCOPE_SIZE = 2048; // matches Recordr's AnalyserNode fftSize

// Mod depths — a 0..1 UI amount scales into the target's native unit.
// PM is TRUE phase modulation (the DX7 model): the modulator's bipolar output
// is added to the carrier's phase. PM_INDEX cycles of phase deviation at full
// depth ⇒ a high modulation index ⇒ bright, clangorous FM timbres.
// FM is linear frequency deviation in Hz (synth.ts's FM_DEPTH_HZ).
export const PM_INDEX = 2.0;
export const FM_DEPTH_HZ = 2400;

// Smoothing time constants (s). Elementary `const` nodes step at block
// boundaries; any value a human drags must be de-zippered (synth.ts §2c).
const CTRL_TAU = 0.025;
const PITCH_TAU = 0.004;
const HEADROOM_VOICES = 6;

function ctrl(key, value, tau = CTRL_TAU) {
  return el.smooth(el.tau2pole(tau), el.const({ key, value }));
}

/**
 * Per-voice note state (gate / freq / vel / keytrack). In the VST3 the audio
 * thread owns this state: the host's `voicectl` node (PluginProcessor.cpp)
 * reads it straight from the voice pool every block, so a note-on/off never
 * waits for the debounced state snapshot + a ~50 ms QuickJS reconcile (that
 * path made the arp/seq late and jittery, and dropped short gates). The
 * harness (plugin/dsp.main.js) opts in via `__FAZE_NATIVE_VOICECTL__`; the
 * browser preview keeps the plain `el.const` so this file stays shared.
 */
const nativeVoiceCtl = () => globalThis.__FAZE_NATIVE_VOICECTL__ === true;
function voiceCtl(vi, field, value) {
  return nativeVoiceCtl()
    ? createNode('voicectl', { key: `v${vi}:${field}:ctl`, voice: vi, field }, [])
    : el.const({ key: `v${vi}:${field}`, value });
}

/** Same smoothing as `ctrl`, for a value that is already a node. */
function ctrlNode(node, tau = CTRL_TAU) {
  return el.smooth(el.tau2pole(tau), node);
}

/** Band-limited oscillator (no modulation) for a discrete wave index. */
function blepOsc(waveIndex, freqNode) {
  switch (waveIndex) {
    case 0:  return el.cycle(freqNode);
    case 1:  return el.bleptriangle(freqNode);
    case 3:  return el.blepsquare(freqNode);
    default: return el.blepsaw(freqNode);
  }
}

/**
 * Phase-accumulator oscillator for operators that take part in modulation.
 * `el.phasor` accumulates sample-accurately even under audio-rate frequency
 * input, and `phaseOffset` (bipolar, in cycles) is added before the wave
 * lookup — that's real phase modulation. Non-sine shapes are naive (not
 * band-limited) and will alias under heavy modulation, same as synth.ts.
 */
function fmOsc(waveIndex, freqNode, phaseOffset) {
  let ph = el.phasor(freqNode); // 0..1 ramp
  if (phaseOffset) ph = el.add(ph, phaseOffset);
  const wrapped = el.mod(ph, 1); // keep in 0..1 for the shape maths
  switch (waveIndex) {
    case 1:  return el.sub(1, el.mul(4, el.abs(el.sub(wrapped, 0.5)))); // triangle (-1..1)
    case 2:  return el.sub(el.mul(2, wrapped), 1);                      // sawtooth
    case 3:  return el.select(el.le(wrapped, 0.5), 1, -1);              // square
    default: return el.sin(el.mul(TWO_PI, ph));                         // sine
  }
}

/** Real N-frame wavetable oscillator (§115, Task 4). Reads continuous phase
 *  ramp at the operator's frequency (`el.phasor(base)`); `posNode` is a 0..1
 *  scan position across the table's `WT_NUM_FRAMES` single-cycle frames.
 *  Crossfades the two nearest frames with triangular weights. */
function wavetableOsc(
  keyPrefix, wtId, phaseNode, posNode,
  warpMode = 0, warpAmount = 0, warpParam2 = 0.5,
  warpMode2 = 0, warpAmount2 = 0, warpParam2_2 = 0.5,
  staticPos = null
) {
  // PERF: with an UNMODULATED position (the common case) the frame weights are plain numbers, so only the
  // frames around it need a table + weight node — 4 instead of 8, and no per-frame max/sub/abs chain
  // (~70 fewer nodes per operator per voice; the reconcile cost scales with node count and runs in the
  // slow embedded JS engine on every state change). The outer ±1 frames stay at weight 0 so a frame leaves
  // the graph only after its (smoothed) weight has already faded out.
  if (staticPos != null) {
    const sp = Math.max(0, Math.min(1, staticPos)) * (WT_NUM_FRAMES - 1);
    const lo = Math.max(0, Math.floor(sp) - 1);
    const hi = Math.min(WT_NUM_FRAMES - 1, Math.ceil(sp) + 1);
    let acc2 = null;
    for (let f = lo; f <= hi; f += 1) {
      const w = Math.max(0, 1 - Math.abs(sp - f));
      const resKey = wavetableResourceKey(wtId, f, warpMode, warpAmount, warpParam2, warpMode2, warpAmount2, warpParam2_2);
      const tbl = el.table({ key: `${keyPrefix}:${f}:w${warpMode}_${warpMode2}`, path: resKey }, phaseNode);
      const term = el.mul(tbl, ctrl(`${keyPrefix}:wf${f}`, w));
      acc2 = acc2 ? el.add(acc2, term) : term;
    }
    return acc2;
  }
  const scaledPos = el.mul(posNode, WT_NUM_FRAMES - 1);
  let acc = null;
  for (let f = 0; f < WT_NUM_FRAMES; f += 1) {
    const wgt = el.max(0, el.sub(1, el.abs(el.sub(scaledPos, f))));
    const resKey = wavetableResourceKey(wtId, f, warpMode, warpAmount, warpParam2, warpMode2, warpAmount2, warpParam2_2);
    const term = el.mul(el.table({ key: `${keyPrefix}:${f}:w${warpMode}_${warpMode2}`, path: resKey }, phaseNode), wgt);
    acc = acc ? el.add(acc, term) : term;
  }
  return acc;
}

export function midiToFreq(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

function panGains(pan) {
  const theta = ((Math.max(-1, Math.min(1, pan)) + 1) / 2) * (Math.PI / 2);
  return [Math.cos(theta), Math.sin(theta)];
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Filter types (index = the `filter*_type` param value). */
export const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass'];

function biquad(type, fc, q, x) {
  switch (type) {
    case 1:  return el.highpass(fc, q, x);
    case 2:  return el.bandpass(fc, q, x);
    default: return el.lowpass(fc, q, x);
  }
}

/**
 * One filter (A or B). `p` is a bundle of shared smoothed param nodes + plain
 * type/slope. 24 dB/oct = two cascaded biquads; 12 dB = one. (synth.ts keeps
 * an always-present allpass stage 2 to avoid a reconcile on slope toggle — a
 * reconcile is fine here, slope is a rare click.)
 */
function applyFilter(p, x) {
  let y = biquad(p.type, p.fc, p.q, x);
  if (p.slope >= 24) y = biquad(p.type, p.fc, p.q, y);
  return y;
}

// ---------------------------------------------------------------------------
// P5 — modulation. Sources are per-voice control signals; the matrix is a
// fixed list of {src, dst, amt} slots (synth.ts's Pigments per-knob model is
// a UI presentation of the same data — that comes back with the real UI in P7).
// ---------------------------------------------------------------------------
// 3 envelopes, 3 LFOs, velocity, keyboard (todo.md §88.A — S&H + Random
// retired; an LFO does S&H via its wave and "new value per note" via
// `perNote`). Index order = the `mod{n}_src` param value. 8 Macros APPENDED
// (todo.md §111) — same append-only rule as MOD_TARGETS below: this index
// order is live host automation, never reorder existing entries.
export const MOD_SOURCES = [
  'env1', 'env2', 'env3', 'lfo1', 'lfo2', 'lfo3', 'velocity', 'keytrack',
  'macro1', 'macro2', 'macro3', 'macro4', 'macro5', 'macro6', 'macro7', 'macro8',
  // Optional, user-added modulators (the "+" tile). APPENDED, never reorder.
  // They are only built into the graph when their state object exists (the
  // UI/host sets it while the module is added); a route to an absent module
  // is a no-op. 'audiofollower' is global (one sidechain), the rest per-voice.
  'audiofollower', 'env4', 'env5', 'lfo4', 'lfo5', 'lfo6',
  // More instances of each type (user can add any number up to these caps).
  // Index order is live host automation: APPEND only.
  'env6', 'env7', 'env8', 'lfo7', 'lfo8',
  'audiofollower2', 'audiofollower3', 'audiofollower4',
  // Pool grown so ANY mix of up to 10 added modulators is possible (APPEND only).
  'env9', 'env10', 'env11', 'lfo9', 'lfo10',
  'audiofollower5', 'audiofollower6', 'audiofollower7', 'audiofollower8', 'audiofollower9', 'audiofollower10',
];
export const MOD_TARGETS = [
  'off', 'pitch',
  'op1Level', 'op2Level', 'op3Level', 'op4Level',
  'op1Pitch', 'op2Pitch', 'op3Pitch', 'op4Pitch',
  'op1Pan', 'op2Pan', 'op3Pan', 'op4Pan',
  'op1ModAmount', 'op2ModAmount', 'op3ModAmount', 'op4ModAmount',
  'op1Wave', 'op2Wave', 'op3Wave', 'op4Wave',
  'op1FilterMix', 'op2FilterMix', 'op3FilterMix', 'op4FilterMix',
  'filterACutoff', 'filterAReso', 'filterBCutoff', 'filterBReso',
  'lfo1Rate', 'lfo2Rate',
  // Per-SOURCE PM/FM depth knobs (todo.md §95) — lets an ENV/LFO modulate
  // ONE operator's PM/FM-from-one-specific-source knob, instead of only
  // the whole-operator `opNModAmount` shared by all 4. APPENDED, never
  // reordered — every index above is a live host-automatable slot value
  // in existing patches/automation; inserting here would silently remap
  // them. No self-modulation entries (opNPmN/opNFmN): the audio-rate PM/FM
  // loop below skips s===k (an operator can't currently phase/freq-
  // modulate itself in this engine), so a depth-mod target for a
  // nonexistent signal would be a knob that visibly does nothing — left
  // out until self-FM/PM itself is implemented.
  'op1Pm2', 'op1Fm2', 'op1Pm3', 'op1Fm3', 'op1Pm4', 'op1Fm4',
  'op2Pm1', 'op2Fm1', 'op2Pm3', 'op2Fm3', 'op2Pm4', 'op2Fm4',
  'op3Pm1', 'op3Fm1', 'op3Pm2', 'op3Fm2', 'op3Pm4', 'op3Fm4',
  'op4Pm1', 'op4Fm1', 'op4Pm2', 'op4Fm2', 'op4Pm3', 'op4Fm3',
  // Self PM & Self FM targets
  'op1Pm1', 'op1Fm1', 'op2Pm2', 'op2Fm2', 'op3Pm3', 'op3Fm3', 'op4Pm4', 'op4Fm4',
  // Wavetable scan position & Dual Warp amounts
  'op1WtPos', 'op2WtPos', 'op3WtPos', 'op4WtPos',
  'op1WarpAmt', 'op2WarpAmt', 'op3WarpAmt', 'op4WarpAmt',
  'op1WarpAmt2', 'op2WarpAmt2', 'op3WarpAmt2', 'op4WarpAmt2',
  // Native arp/seq targets (APPEND only). Realised via `ctlout` slots 0..5 (see
  // SEQ_TARGETS / renderSynth): the arp runs in C++, the graph only supplies the
  // summed modulation. LIMITATION: built from voice 0's source set, so
  // per-voice sources (velocity, keytrack, envelopes, voice-phased LFOs) follow voice 0.
  'seqRate', 'seqSwing', 'seqGate', 'seqTranspose', 'seqVelocity', 'seqRandom',
  // APPENDED (ctlout slots 6..8): arp Octaves, the pattern-selector position and the
  // Chaos master. kArpMods in ArpEngine.h grew to 9 to match.
  'seqOctaves', 'seqPattern', 'seqChaos',
];
// target -> [ctlout slot, full-scale span in engine units]. The wire carries amount/span
// clamped to +-1, so multiplying by the span restores real units (octaves, pts, x, st, add, add).
const SEQ_TARGETS = [['seqRate', 2], ['seqSwing', 25], ['seqGate', 1], ['seqTranspose', 24], ['seqVelocity', 1], ['seqRandom', 1],
  // Octaves spans the whole 1..4 knob from any base; pattern and chaos are 0..1 fractions.
  ['seqOctaves', 3], ['seqPattern', 1], ['seqChaos', 1]];
// Full-scale (amt = ±1) swing of the filter mod targets. MUST equal the UI
// popover ranges (mod-sources.ts: cutoff ±10 octaves, reso ±20) -- the wire
// carries amount/span clamped to ±1, so these spans are what turn it back
// into real units. (Was ×1 octave / ×12 Q: 100% in the UI gave ±1 octave.)
export const FILTER_CUTOFF_OCT_SPAN = 10;
export const FILTER_Q_SPAN = 20;
const T = Object.fromEntries(MOD_TARGETS.map((n, i) => [n, i]));
export const NUM_MOD_SLOTS = 24; // todo.md §108 — was 8, silently dropped routes past the 8th

const LFO_WAVES = ['sine', 'triangle', 'sawtooth', 'square', 'sample-hold', 'function'];

/** Evaluate a bounded breakpoint function at a normalized phase. The graph is
 * deliberately expressed as Elementary selects rather than a runtime table,
 * so the same shape works in the browser renderer and the native plugin
 * without a custom resource. `curve` uses the same power mapping as ADSR. */
function functionSignal(shape, phase, keyPrefix = 'fn') {
  const fallback = [{ time: 0, level: 0, curve: 0 }, { time: 1, level: 0, curve: 0 }];
  // 128 MUST match shared/types.ts's MAX_FUNCTION_POINTS (kept a literal
  // here rather than an import — this file is bundled standalone, see the
  // header comment).
  const points = Array.isArray(shape?.points) && shape.points.length >= 2 ? shape.points.slice(0, 128) : fallback;
  // KEY COLLISION FIX: this was `fn:last:${points.length}` — a GLOBAL key, so two
  // function shapes with the SAME number of points (two LFOs, or an LFO and a
  // multi-point envelope) resolved to one shared el.const node and fought over
  // its value. `keyPrefix` is per voice + per source, so they stay separate.
  let out = el.const({ key: `${keyPrefix}:last:${points.length}`, value: points[points.length - 1].level || 0 });
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const a = points[i];
    const b = points[i + 1];
    const span = Math.max(1e-6, b.time - a.time);
    const t = el.max(0, el.min(1, el.div(el.sub(phase, a.time), span)));
    const power = Math.pow(2, clamp(a.curve || 0, -1, 1) * 4);
    const value = el.add(a.level, el.mul(b.level - a.level, el.pow(t, power)));
    out = el.select(el.le(phase, b.time), value, out);
  }
  // SS164 (user: "...it goes about yhalf way. i tried like making it bipolar
  // and still ddoesnt").
  //
  // This line ASSUMED the point `level`s are bipolar -1..1 (which is what the
  // type comment says) and remaps a unipolar shape from that assumption. But
  // the shipped default shape -- DEFAULT_FUNCTION_SHAPE in shared/types.ts --
  // has levels 0, 1, 0, i.e. UNIPOLAR. So `(out + 1) / 2` compressed 0..1 into
  // 0.5..1 and THREW AWAY HALF THE SWING: a -10 octave amount only ever
  // reached -5, landing at 625 Hz from a 20 kHz base instead of the 20 Hz floor.
  // That is precisely the "goes about half way" report, and it is why toggling
  // bipolar ON appeared not to help -- the unipolar path was the broken one.
  //
  // Fixed by normalising against the shape's OWN actual range instead of a
  // hardcoded -1..1. A unipolar shape keeps its full 0..1 swing — NOT remapped
  // to ±0.5, which would throw away half the travel again in the other
  // direction. With a negative amount, an LFO spanning 0..1 drives the cutoff
  // across the knob's entire range: 0 -> the 20 kHz base, 1 -> the 20 Hz floor.
  //
  // (First attempt here normalised to (v-lo)/span - 0.5, i.e. ±0.5. Measured,
  // that reproduced the SAME half-swing loss from the other side — a -10
  // amount only reached -5. Unipolar must occupy the full 0..1, so the -0.5
  // offset is simply absent.)
  if (shape?.bipolar === false) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) {
      const l = p.level || 0;
      if (l < lo) lo = l;
      if (l > hi) hi = l;
    }
    const span = hi - lo;
    // A flat shape has no range to normalise against -- leave it untouched
    // rather than dividing by zero.
    if (span > 1e-6) return el.div(el.sub(out, lo), span);
  }
  return out;
}

/**
 * One envelope. Two shapes:
 *
 *   'adsr'  — the classic four-stage `el.adsr` (unchanged, still the default).
 *   'multi' — an arbitrary breakpoint shape (the same `FunctionShape` the LFO
 *             Function editor already edits) played ONCE from note-on over
 *             `durationSec`, holding its last point for as long as the note is
 *             held, then released over `releaseSec`.
 *
 * The multi path needs "seconds since THIS voice's note-on", which has one
 * awkward requirement: it has to keep counting after the gate falls, or the
 * shape snaps back to its first point the instant you let go and the release
 * tail plays from the wrong level. `el.counter(gate)` RESETS on gate-low
 * (measured), so it cannot be used. `el.time()` is a free-running sample
 * counter, and `el.latch(gate, el.time())` captures its value at note-on, so
 * the difference is a per-voice clock that survives the gate — which is
 * exactly what this needs, with no custom node.
 *
 * Holding at the end falls out of `functionSignal` for free: `phase` clamps at
 * 1 and the shape evaluates to its final point's level. The release is then a
 * plain gate-with-release multiplier (an ADSR with instant attack and full
 * sustain), so the tail starts from wherever the shape actually was.
 */
function envSignal(keyPrefix, e, gateNode, sampleRate, adsrFallback) {
  const pts = e && e.shape && Array.isArray(e.shape.points) ? e.shape.points : null;
  if (!e || e.mode !== 'multi' || !pts || pts.length < 2) return adsrFallback();

  const dur = Math.max(0.01, e.durationSec ?? 1);
  const now = el.time();
  const t = el.div(el.sub(now, el.latch(gateNode, now)), Math.max(1, sampleRate));
  const phase = el.min(1, el.div(t, dur));
  const shape = functionSignal(e.shape, phase, `${keyPrefix}:env`);
  const rel = el.adsr(
    MIN_SEG, MIN_SEG, 1,
    ctrl(`${keyPrefix}:mrel`, Math.max(MIN_SEG, e.releaseSec ?? 0.4)),
    gateNode,
  );
  return el.mul(shape, rel);
}

/** One LFO's per-voice control signal (bipolar, roughly -1..1).
 *  `perNote` → one random value latched at note-on, held for the note (the
 *  old Random source). `sync` → rate scaled by bpm/120 (approximate tempo
 *  sync). `wave` index 4 = the classic rate-clocked sample & hold; index 5
 *  is the editable breakpoint function. */
function lfoSignal(vi, which, lfo, gateNode, bpm) {
  lfo = lfo || { rateHz: 2, wave: 0 };
  if (lfo.perNote) {
    return el.latch(gateNode, el.noise({ key: `v${vi}:${which}:pn` }));
  }
  const baseRate = Math.max(0.01, lfo.rateHz ?? 2);
  const rate = ctrl(`v${vi}:${which}:rate`, lfo.sync ? baseRate * ((bpm || 120) / 120) : baseRate);
  const w = lfo.wave | 0;
  if (w === 4) {
    // sample & hold: new random step each cycle
    return el.latch(el.train(rate), el.noise({ key: `v${vi}:${which}:sh` }));
  }
  if (w === 5) {
    return functionSignal(lfo.functionShape, el.phasor(rate), `v${vi}:${which}:fn`);
  }
  if (w === 0) return el.cycle(rate);
  const ph = el.phasor(rate);
  if (w === 1) return el.sub(1, el.mul(4, el.abs(el.sub(ph, 0.5)))); // triangle
  if (w === 2) return el.sub(el.mul(2, ph), 1); // saw
  return el.select(el.le(ph, 0.5), 1, -1); // square
}

/**
 * Build the per-voice modulation sources. `gateNode` is the 0/1 note gate,
 * `velNode`/`keytrackNode` are per-note constants.
 */
/** Transfer curve for the Velocity / Keyboard sources (todo.md §88.E):
 *  `pow(x, 2^(c*2))` on the 0..1 magnitude, sign preserved when bipolar. */
function shapeCurve(x, c, bipolar) {
  c = clamp(c || 0, -1, 1);
  if (Math.abs(c) < 0.01) return x;
  const p = Math.pow(2, c * 2); // 0.25 (log) .. 4 (exp)
  if (!bipolar) return el.pow(el.max(0, x), p);
  const mag = el.pow(el.abs(x), p);
  return el.select(el.ge(x, 0), mag, el.mul(mag, -1));
}

/**
 * Audio Follower (sidechain) — a global 0..1 control signal that follows the
 * level of the plugin's AUDIO INPUT (the host's sidechain bus; silence when
 * none is routed). Mono-sum -> high-pass(lo) -> low-pass(hi) -> rectify ->
 * attack/release envelope follower -> gain -> clamp. The band is the pair of
 * draggable markers on the card. Built once per renderSynth (keys are global).
 */
function audioFollowerSignal(id, af) {
  const lo = clamp(af.loHz ?? 20, 20, 20000);
  const hi = clamp(af.hiHz ?? 20000, 20, 20000);
  // Input source: 0 = the host's sidechain bus, 1 = the synth's own final
  // output (one-block feedback tap; works in the standalone and with no
  // sidechain routed).
  const x = (af.source | 0) === 1
    ? el.tapIn({ name: 'faze:master' })
    : el.mul(0.5, el.add(el.in({ channel: 0 }), el.in({ channel: 1 })));
  const hp = el.highpass(ctrl(`af:${id}:lo`, Math.min(lo, hi)), 0.707, x);
  const bp = el.lowpass(ctrl(`af:${id}:hi`, Math.max(lo, hi)), 0.707, hp);
  const atk = Math.max(0.0001, (af.attackMs ?? 5) / 1000);
  const rel = Math.max(0.001, (af.releaseMs ?? 120) / 1000);
  const env = el.env(
    el.tau2pole(ctrl(`af:${id}:atk`, atk)),
    el.tau2pole(ctrl(`af:${id}:rel`, rel)),
    el.abs(bp),
  );
  const gain = Math.pow(10, clamp(af.gainDb ?? 12, -24, 48) / 20);
  return el.min(1, el.mul(env, ctrl(`af:${id}:gain`, gain)));
}

let afCache = new Map(); // id -> follower node, for the renderSynth call in progress
const afNode = (id, af) => {
  if (!afCache.has(id)) afCache.set(id, audioFollowerSignal(id, af));
  return afCache.get(id);
};

function extraSources(vi, state, adsr, gateNode, bpm) {
  const out = {};
  for (const [id, cfg] of Object.entries(state.extra || {})) {
    if (!cfg) continue;
    if (id.startsWith('env')) out[id] = adsr(id, cfg);
    else if (id.startsWith('lfo')) out[id] = lfoSignal(vi, id, cfg, gateNode, bpm);
    else if (id.startsWith('audiofollower')) out[id] = afNode(id, cfg);
  }
  return out;
}

function buildSources(vi, state, gateNode, velNode, keytrackNode) {
  const sr = state.sampleRate || 44100;
  const adsr = (pfx, e) => envSignal(`v${vi}:${pfx}`, e, gateNode, sr, () => el.adsr(
    ctrl(`${pfx}:a:${vi}`, Math.max(MIN_SEG, e.attackSec)),
    ctrl(`${pfx}:d:${vi}`, Math.max(MIN_SEG, e.decaySec)),
    ctrl(`${pfx}:s:${vi}`, clamp(e.sustainLevel, 0, 1)),
    ctrl(`${pfx}:r:${vi}`, Math.max(MIN_SEG, e.releaseSec)),
    gateNode,
  ));
  const D = { attackSec: 0.005, decaySec: 0.2, sustainLevel: 0.7, releaseSec: 0.4 };
  const bpm = state.bpm || 120;
  const macros = state.macros || [];
  const routedFrom = (id) => {
    const idx = MOD_SOURCES.indexOf(id);
    return (state.mod || []).some((m) => (m.src | 0) === idx && (m.dst | 0) > 0 && Math.abs(m.amt || 0) >= 1e-4);
  };
  const wants = (id) => !state.modOn || state.modOn[id] || routedFrom(id);
  // 8 Macro knobs (todo.md §111) — plain global 0..1 held values, NOT
  // per-voice (unlike every other source here): same `ctrl` key regardless
  // of `vi`, so every voice reads the identical shared/smoothed node
  // instead of spawning 16 redundant copies of a value that never differs
  // per-voice.
  const macroSources = {};
  for (let m = 0; m < 8; m++) macroSources[`macro${m + 1}`] = ctrl(`macro${m + 1}`, clamp(macros[m] || 0, 0, 1));
  return {
    env1: adsr('env', state.env || D),
    // ENV 2/3 + LFO 1-3 are optional modules now (only ENV 1 is always there).
    // Built when the module is switched on (state.modOn) OR a route reads it;
    // callers without `modOn` (tests, browser preview) keep the old always-on.
    ...(wants('env2') ? { env2: adsr('env2', state.modEnv || D) } : {}),
    ...(wants('env3') ? { env3: adsr('env3', state.modEnv3 || D) } : {}),
    ...(wants('lfo1') ? { lfo1: lfoSignal(vi, 'lfo1', state.lfo1, gateNode, bpm) } : {}),
    ...(wants('lfo2') ? { lfo2: lfoSignal(vi, 'lfo2', state.lfo2, gateNode, bpm) } : {}),
    ...(wants('lfo3') ? { lfo3: lfoSignal(vi, 'lfo3', state.lfo3, gateNode, bpm) } : {}),
    velocity: shapeCurve(velNode, state.velCurve, false),
    keytrack: shapeCurve(keytrackNode, state.keyCurve, true),
    ...macroSources,
    // Optional modules (the "+" pool): `state.extra` maps a source id
    // (env4..8, lfo4..8, audiofollower[2-4]) to its settings. Absent = not
    // added = no nodes.
    ...extraSources(vi, state, adsr, gateNode, bpm),
  };
}

/** Does any slot route into `targetIdx` with a non-negligible amount? Cheap
 *  existence check (no `el.*` node construction) — used to decide whether a
 *  PM/FM pair needs to be built into the graph even when its static knob
 *  sits at 0 (todo.md — a mod route must be able to summon depth from
 *  nothing, not just scale depth that's already there). */
function hasModRoute(slots, targetIdx) {
  for (const s of slots || []) {
    if ((s.dst | 0) === targetIdx && Math.abs(s.amt || 0) >= 1e-4) return true;
  }
  return false;
}

/** Sum `source · amount` over the matrix slots that hit `targetIdx`. null if none. */
function modSignal(sources, slots, targetIdx) {
  let acc = null;
  for (const s of slots || []) {
    if ((s.dst | 0) !== targetIdx || Math.abs(s.amt || 0) < 1e-4) continue;
    const src = sources[MOD_SOURCES[s.src | 0]];
    if (!src) continue;
    const t = el.mul(src, s.amt);
    acc = acc ? el.add(acc, t) : t;
  }
  return acc;
}

/**
 * Per-voice filter params with cutoff/reso modulation folded in. The base
 * fc/q are shared `ctrl` refs (one smoothed value feeds all voices); the
 * modulation multiplies in per-voice so each voice's envelope/LFO moves its
 * own filter.
 */
function filterParams(prefix, f, sources, slots, cutoffTarget, resoTarget) {
  let fc = ctrl(`${prefix}:fc`, clamp(f.cutoff ?? 20000, 20, 20000));
  const fcMod = modSignal(sources, slots, cutoffTarget); // amount in octaves
  // The octave math here was always right; the CLAMP was the bug. It capped
  // fc at the same 20000 Hz the base cutoff is already clamped to -- and
  // 20000 Hz is the DEFAULT (`DEFAULT_FILTER.cutoff`, and `filterIsBypassed`
  // returns true for it), so out of the box any UPWARD modulation was clipped
  // straight back to the value it started from: 20000 * 2^1, 2^2 and 2^4 all
  // SS162 (user: "I dont want it to go past 20Khz but i should be able to
  // modulate the whole way using an LFO").
  //
  // SS156 raised this ceiling to 24000 to give upward sweeps somewhere to go,
  // which solved "the LFO only ever goes down" but overshot: 24 kHz is above
  // the cutoff knob's own top of 20 kHz, so the sweep ran past the end of the
  // parameter it is sweeping. The ceiling is now the knob's maximum, so the
  // modulated value can never leave the range the user can dial by hand.
  //
  // That alone is not enough, and this is the part worth being explicit about:
  // with the ceiling at 20 kHz the clamp becomes a wall that positive amounts
  // hit immediately, and the real limit is the AMOUNT RANGE. `filterACutoff`
  // is specified in octaves (-4..+4), but the cutoff knob spans 20 Hz..20 kHz
  // which is ~10 octaves. So at the default 20000 Hz base, -4 octaves lands at
  // 1250 Hz — the sweep stops 60x above the bottom of the knob and the user
  // cannot cover the range however hard they dial. Widening the route range to
  // +/-10 octaves means ±10 covers the knob end-to-end from ANY base position
  // (20 Hz base +10 -> 20 kHz, 20 kHz base -10 -> 20 Hz), which is what "modulate
  // the whole way" requires. ±4 could never do this; it was a mismatch between
  // the unit the route speaks in (octaves) and the size of the thing it sweeps.
  if (fcMod) fc = el.min(20000, el.max(20, el.mul(fc, el.pow(2, el.mul(fcMod, FILTER_CUTOFF_OCT_SPAN)))));

  let q = ctrl(`${prefix}:q`, clamp(f.resonance ?? 0.7, 0.3, 24));
  const qMod = modSignal(sources, slots, resoTarget);
  if (qMod) q = el.min(24, el.max(0.3, el.add(q, el.mul(qMod, FILTER_Q_SPAN))));

  return { type: f.type | 0, slope: (f.slope | 0) >= 24 ? 24 : 12, fc, q };
}

/** Is any live (non-zero) mod route pointing at any of `targets`? */
function hasRouteTo(state, ...targets) {
  const routes = state && state.mod;
  if (!Array.isArray(routes)) return false;
  for (const r of routes) {
    if (!r || r.dst <= 0) continue;
    if (Math.abs(r.amt) <= 1e-4) continue;
    if (targets.includes(r.dst)) return true;
  }
  return false;
}

/**
 * Is this filter effectively a no-op? (LP wide open at default Q.)
 *
 * `modulated` = is anything routed to this filter's CUTOFF or RESONANCE target?
 *
 * SS161 (user: "the LFO to Filter A (and probably B) still isnt fixed, LFO
 * barely modulates the filter frequency at all"). SS156 fixed the CLAMP and
 * was verified working in isolation — at fc=1000 an LFO at +4 octaves moves the
 * spectral centroid 55.0 -> 137.6 and -4 octaves -> 90.9. So the octave maths
 * was never still broken.
 *
 * What was still broken is THIS function. It is the gate that decides whether
 * the filter is built into the voice graph at all (renderSynth: `if
 * (!filterIsBypassed(state.filterA))`), and it looks ONLY at the static base
 * cutoff. The default filter is `{type: 0, cutoff: 20000}`, which trips the
 * test, so at defaults **no filter is instantiated whatsoever** — and a
 * bypassed filter has no `fc` signal to modulate, so an LFO routed to
 * `filterACutoff` is silently dropped on the floor. Measured at the default:
 * fc 20000 with the LFO at 0 and at +4 octaves give a bit-identical centroid
 * of 142.4. That is the "still isn't fixed" report, and it is why the earlier
 * fix looked like it hadn't landed: the test that proved the clamp fixed ran at
 * fc=1000, where the filter exists, so it never exercised the default case
 * that actually fails.
 *
 * A filter with modulation on it is never a no-op: the whole point of routing
 * an LFO to the cutoff is to move it away from 20000. So any live route to
 * either of its targets must force the filter to be built.
 */
function filterIsBypassed(f, modulated = false) {
  if (modulated) return false;
  return (f.type | 0) === 0 && (f.cutoff ?? 20000) >= 19999;
}

/**
 * Build one voice: 4 operators + FM/PM matrix, split through the dual filter,
 * shaped by the amp ADSR. Returns [left, right].
 *
 * Modulation routing uses named taps (el.tapIn/el.tapOut): every operator
 * publishes its raw bipolar oscillator on a per-voice tap, and any operator's
 * frequency can read any tap — so op A↔op B feedback (a cycle) resolves
 * against the previous block, exactly the one-render-quantum-delay trick
 * synth.ts uses on cyclic FM/PM edges (§68.5).
 *
 * The dual filter (synth.ts §60): each operator's post-level signal splits
 * between Filter A and Filter B by its own `filterMix` (0 = all A). Both
 * chains run in stereo (so per-op pan survives) and sum before the envelope.
 */
function voiceSignal(vi, state, v, transpose) {
  const ops = state.operators;
  const slots = state.mod || [];
  const tap = (k) => `v${vi}:opmod:${k}`;
  const modEntry = (k, s) => (ops[k].mods && ops[k].mods[s]) || {};
  const amt = (m, key) => Math.max(0, Math.min(1, m[key] || 0));

  const gateNode = voiceCtl(vi, 'gate', v.gate);
  const midi = 69 + 12 * Math.log2(Math.max(1, v.freq) / 440);

  // The Pigments mod sources (2 ADSRs, 2 LFOs, S&H, random, …) are only worth
  // building when the matrix actually references them. With no routes — the
  // common case — this is ~20 skipped `el.*` allocations per voice, which
  // meaningfully shrinks the per-reconcile `renderSynth` cost (§73). `modSignal`
  // already no-ops on an empty slot list, so `src` can be null.
  const src = slots.length
    ? buildSources(
        vi,
        state,
        gateNode,
        ctrlNode(voiceCtl(vi, 'vel', clamp(v.vel ?? 1, 0, 1))),
        ctrlNode(voiceCtl(vi, 'kt', clamp((midi - 60) / 60, -1, 1))),
      )
    : null;

  // Global pitch mod → voice frequency. `gPitch` is a fraction (-1..1) of
  // the popover's full ±2400ct (±24 semitone) range (translate.ts's
  // dspSpan) — semitones = gPitch·24, ratio = 2^(semitones/12) = 2^(gPitch·2).
  // Was 2^(gPitch/12) (treating gPitch as literal semitones), which combined
  // with the ±1-clamped DSP amt meant no route could ever exceed ±1
  // semitone regardless of the dialed-in amount — a bug (todo.md: reported
  // as pitch mod being "totally inaudible").
  const gPitch = modSignal(src, slots, T.pitch);
  // Portamento: the glide time (s) IS the one-pole time constant of the note
  // frequency smoother (never below PITCH_TAU). A shared el.const so turning
  // the knob is a prop update, not a graph rebuild.
  // `state.glide` is TIME-TO-ARRIVE (s): tau = max(PITCH_TAU, glide / 3) (~95 % there
  // after `glide`). Smoothing runs on log2(freq) so wide intervals glide evenly.
  // Native mode: an arp step's Slide (ms, per voice) can lengthen it for that voice.
  const glideTau = el.const({ key: 'glide', value: Math.max(PITCH_TAU, (state.glide ?? 0) / 3) });
  let voiceFreqNode;
  if (nativeVoiceCtl()) {
    const tau = el.max(glideTau, el.div(voiceCtl(vi, 'slide', 0), 3000));
    // NOTE: Elementary's `log` node is BASE 10 (std::log10), not natural log — dividing by
    // Math.LN2 here made every note ~f^0.43 (A440 -> 14 Hz). log2(x) = log10(x) / log10(2).
    const logF = el.div(el.log(el.max(1, el.mul(voiceCtl(vi, 'freq', v.freq), transpose))), Math.log10(2));
    voiceFreqNode = el.pow(2, el.smooth(el.tau2pole(tau), logF));
  } else {
    // Browser preview / offline tests: the original linear smoother (log-domain smoothing starts from 2^0 = 1 Hz
    // and changes the attack transient; only the plugin's native path needs the even-interval glide).
    voiceFreqNode = el.smooth(el.tau2pole(glideTau), el.const({ key: `v${vi}:freq`, value: Math.max(1, v.freq * transpose) }));
  }
  if (gPitch) voiceFreqNode = el.mul(voiceFreqNode, el.pow(2, el.mul(gPitch, 2)));

  // Per-op pitch and level (0..1) with modulation folded in. Same ±24-
  // semitone full-scale mapping as gPitch above.
  const ratio = (k) => {
    let r = ctrl(`v${vi}:op${k}:ratio`, Math.pow(2, (ops[k].semis || 0) / 12), PITCH_TAU);
    const m = modSignal(src, slots, T[`op${k + 1}Pitch`]);
    return m ? el.mul(r, el.pow(2, el.mul(m, 2))) : r;
  };
  const level = (k) => {
    let l = ctrl(`v${vi}:op${k}:lvl`, clamp(ops[k].level, 0, 1));
    const m = modSignal(src, slots, T[`op${k + 1}Level`]);
    return m ? el.max(0, el.add(l, m)) : l;
  };
  // Per-op overall PM/FM depth mod (`opNModAmount`) — a multiplicative `1 + m`
  // on every PM/FM contribution into that operator, used as the FALLBACK
  // when a specific (target,source) pair has no depth mod of its own.
  // `panSignal` folds a pan mod (`opNPan`) into an equal-power gain pair.
  const depthScale = (k) => {
    const m = modSignal(src, slots, T[`op${k + 1}ModAmount`]);
    return m ? el.max(0, el.add(1, m)) : null;
  };
  // Per-SOURCE depth mod (`opNPmS`/`opNFmS`, todo.md §95) — modulating ONE
  // PM/FM knob is ADDITIVE onto that (target,source) pair's own depth
  // fraction (0..1 of PM_INDEX/FM_DEPTH_HZ), REPLACING the shared
  // `depthScale` fallback for that pair (no stacking, per user's call).
  // Was multiplicative (`1+m` scaling the existing `pm`/`fm` knob value) —
  // which meant a knob sitting at 0% could never be driven up by a mod
  // route at all (0 · anything is still 0), reported as "LFO on PM/FM
  // barely does anything, same with the filter" even at 100% mod depth.
  // Additive lets a route inject depth from a bare 0% base, matching how
  // every other continuous target (Level, Pan, WtPos) already works.
  const pairDepthMod = (k, s, kind) => modSignal(src, slots, T[`op${k + 1}${kind}${s + 1}`]);
  const panSignal = (k) => {
    const m = modSignal(src, slots, T[`op${k + 1}Pan`]);
    if (!m) return null;
    const base = ctrl(`v${vi}:op${k}:pan`, clamp(ops[k].pan || 0, -1, 1));
    const p = el.max(-1, el.min(1, el.add(base, m)));
    const theta = el.mul(el.add(p, 1), Math.PI / 4);
    return [el.cos(theta), el.sin(theta)];
  };

  const filtA = filterParams('filtA', state.filterA, src, slots, T.filterACutoff, T.filterAReso);
  const filtB = filterParams('filtB', state.filterB, src, slots, T.filterBCutoff, T.filterBReso);

  // Which operators take part in modulation this render? Those use the
  // phase-accumulator oscillator (sample-accurate under audio-rate mod);
  // the rest keep the band-limited BLEP oscillator.
  const involved = new Array(NUM_OPERATORS).fill(false);
  const edge = Array.from({ length: NUM_OPERATORS }, () => new Array(NUM_OPERATORS).fill(false)); // edge[k][s]: s modulates k
  for (let k = 0; k < NUM_OPERATORS; k++) {
    for (let s = 0; s < NUM_OPERATORS; s++) {
      const m = modEntry(k, s);
      const pmRouted = hasModRoute(slots, T[`op${k + 1}Pm${s + 1}`]);
      const fmRouted = hasModRoute(slots, T[`op${k + 1}Fm${s + 1}`]);
      if (amt(m, 'pm') > 0 || amt(m, 'fm') > 0 || pmRouted || fmRouted) {
        involved[k] = true; // target
        involved[s] = true; // source
        if (s !== k) edge[k][s] = true;
      }
    }
  }
  // Build MODULATORS BEFORE the operators they modulate and feed them in directly (same block).
  // The old scheme read every modulator through `tapIn`, which delivers the PREVIOUS block's
  // value: FM/PM arrived one audio block (~5-10 ms) late, so at every note start the sidebands
  // bloomed in after the carrier — it sounded like a hidden envelope on the FM amount. The delayed
  // tap is now only the fallback for genuine feedback loops (op A <-> op B).
  const opOrder = [];
  {
    const left = new Set(Array.from({ length: NUM_OPERATORS }, (_, i) => i));
    while (left.size) {
      let pick = -1;
      for (const k of left) {
        let ready = true;
        for (const s of left) if (s !== k && edge[k][s]) { ready = false; break; }
        if (ready) { pick = k; break; }
      }
      if (pick < 0) pick = Math.min(...left); // a cycle: break it at the lowest index
      opOrder.push(pick);
      left.delete(pick);
    }
  }
  const opRaw = new Array(NUM_OPERATORS).fill(null); // each built operator's raw (pre-level) signal

  // An operator only earns a place in the graph if it can be heard: a
  // non-zero level, or it's an FM/PM source/target, or a mod route drives its
  // level/pitch. A default 1-oscillator patch therefore runs 1 osc per voice,
  // not 4 — 8 idle voices × 4 BLEP oscillators pinned a whole core (§73).
  // Raising a level from 0 rebuilds that operator into the graph (one click,
  // same as the existing FM `involved` reconcile).
  const levelModded = (k) =>
    modSignal(src, slots, T[`op${k + 1}Level`]) != null ||
    modSignal(src, slots, T[`op${k + 1}Pitch`]) != null;
  const contributes = (k) =>
    involved[k] || (ops[k].level ?? 0) > 1e-4 || levelModded(k);

  // Stereo A/B filter-bus shares.
  const aL = []; const aR = [];
  const bL = []; const bR = [];
  const usesB = ops.some((o) => (o.filterMix ?? 0) > 0.001)
    || [0, 1, 2, 3].some((k) => modSignal(src, slots, T[`op${k + 1}FilterMix`]) != null);

  // Per-operator dry mono tap (post-level, pre-pan/filter) — summed across
  // voices in renderSynth and fed to `el.scope` so each operator card shows
  // its own live waveform (todo.md §73 P7c). `null` for a skipped operator.
  const opMono = new Array(NUM_OPERATORS).fill(null);

  for (const k of opOrder) {
    if (!contributes(k)) continue;
    const base = el.mul(voiceFreqNode, ratio(k));

    // Sum PM (phase, in cycles) + FM (Hz) contributions from other operators.
    let pmSum = null;
    let fmSum = null;
    const dScale = depthScale(k); // opNModAmount mod — multiplicative
    for (let s = 0; s < NUM_OPERATORS; s++) {
      const m = modEntry(k, s);
      const pm = amt(m, 'pm');
      const fm = amt(m, 'fm');
      const pmMod = pairDepthMod(k, s, 'Pm'); // additive fraction of PM_INDEX, or null
      const fmMod = pairDepthMod(k, s, 'Fm'); // additive fraction of FM_DEPTH_HZ, or null
      if (pm <= 0 && fm <= 0 && !pmMod && !fmMod) continue;
      const msrc = opRaw[s] ?? el.tapIn({ name: tap(s) }); // same-block signal when already built; previous-block tap only for feedback loops
      if (pm > 0 || pmMod) {
        const base = ctrl(`v${vi}:op${k}:pm:${s}`, pm * PM_INDEX);
        const depth = pmMod
          ? el.max(0, el.min(PM_INDEX, el.add(base, el.mul(pmMod, PM_INDEX))))
          : (dScale ? el.mul(base, dScale) : base);
        pmSum = pmSum ? el.add(pmSum, el.mul(msrc, depth)) : el.mul(msrc, depth);
      }
      if (fm > 0 || fmMod) {
        const base = ctrl(`v${vi}:op${k}:fm:${s}`, fm * FM_DEPTH_HZ);
        const depth = fmMod
          ? el.max(0, el.min(FM_DEPTH_HZ, el.add(base, el.mul(fmMod, FM_DEPTH_HZ))))
          : (dScale ? el.mul(base, dScale) : base);
        fmSum = fmSum ? el.add(fmSum, el.mul(msrc, depth)) : el.mul(msrc, depth);
      }
    }

    const wave = ops[k].wave | 0;
    let raw;
    // Sample mode with NOTHING loaded: the path `sample:opK:0` is never a registered resource, and Elementary
    // rejects a node whose resource is missing — failing the ENTIRE instruction batch (the whole synth goes
    // silent and later batches keep failing against a graph that was never built). Render silence instead.
    const hasSample = (ops[k].sampleVersion | 0) > 0;
    if (wave === 4 && !hasSample) {
      raw = el.const({ key: `v${vi}:op${k}:nosmp`, value: 0 });
    } else if (wave === 4) {
      const rootHz = Math.max(1, ops[k].rootHz || 440);
      const version = ops[k].sampleVersion | 0;
      const sampleFrames = Math.max(0, ops[k].sampleFrames | 0);
      const baseRate = el.div(base, rootHz);
      let mode;
      let startOffset;
      let stopOffset;
      let rateNode;
      if (ops[k].sampleReverse) {
        mode = 'trigger';
        startOffset = Math.max(0, sampleFrames - 1);
        stopOffset = 0;
        rateNode = el.mul(-1, baseRate);
      } else {
        const startFrac = clamp(ops[k].sampleStart ?? 0, 0, 1);
        const endFrac = clamp(ops[k].sampleEnd ?? 1, startFrac, 1);
        mode = ops[k].sampleLoop ? 'loop' : 'trigger';
        startOffset = Math.round(startFrac * sampleFrames);
        stopOffset = Math.round((1 - endFrac) * sampleFrames);
        rateNode = baseRate;
      }
      raw = el.sample(
        { key: `v${vi}:op${k}:smp`, path: `sample:op${k}:${version}`, mode, startOffset, stopOffset },
        gateNode,
        rateNode,
      );
    } else if (wave === 5) {
      const wtId = clamp(ops[k].wtId | 0, 0, WAVETABLES.length - 1 + 255);
      let wtPos = ctrl(`v${vi}:op${k}:wtpos`, clamp(ops[k].wtPos ?? 0, 0, 1));
      const wtPosMod = modSignal(src, slots, T[`op${k + 1}WtPos`]);
      if (wtPosMod) wtPos = el.max(0, el.min(1, el.add(wtPos, wtPosMod)));

      const warpMode = clamp(ops[k].warpMode | 0, 0, WARP_MODES.length - 1);
      let warpAmtVal = clamp(ops[k].warpAmount ?? 0, 0, 1);
      const warpAmtMod = modSignal(src, slots, T[`op${k + 1}WarpAmt`]);
      const warpAmtCtrl = ctrl(`v${vi}:op${k}:warpamt`, warpAmtVal);
      const warpAmtNode = warpAmtMod ? el.max(0, el.min(1, el.add(warpAmtCtrl, warpAmtMod))) : warpAmtCtrl;
      const warpP2 = clamp(ops[k].warpParam2 ?? 0.5, 0, 1);

      const warpMode2 = clamp(ops[k].warpMode2 | 0, 0, WARP_MODES.length - 1);
      let warpAmtVal2 = clamp(ops[k].warpAmount2 ?? 0, 0, 1);
      const warpAmtMod2 = modSignal(src, slots, T[`op${k + 1}WarpAmt2`]);
      const warpAmtCtrl2 = ctrl(`v${vi}:op${k}:warpamt2`, warpAmtVal2);
      const warpAmtNode2 = warpAmtMod2 ? el.max(0, el.min(1, el.add(warpAmtCtrl2, warpAmtMod2))) : warpAmtCtrl2;
      const warpP2_2 = clamp(ops[k].warpParam2_2 ?? 0.5, 0, 1);

      const freq = el.max(1, fmSum ? el.add(base, fmSum) : base);
      let ph = el.phasor(freq);
      if (pmSum) ph = el.mod(el.add(ph, pmSum), 1); // same phase-offset + rewrap fmOsc uses

      // Dynamic phase-domain warps (Warp 1)
      if (warpMode === 4) { // Sync
        const syncMul = el.add(1, el.mul(warpAmtNode, 1 + warpP2 * 15));
        ph = el.mod(el.mul(ph, syncMul), 1);
      } else if (warpMode === 3) { // Asymmetry
        const kAsym = el.mul(warpAmtNode, 0.99);
        ph = el.add(el.mul(ph, el.sub(1, kAsym)), el.mul(el.mul(ph, ph), kAsym));
      } else if (warpMode === 8) { // Quantize
        const steps = el.max(2, el.floor(el.add(2, el.mul(warpAmtNode, 30))));
        ph = el.div(el.floor(el.mul(ph, steps)), steps);
      }

      // Dynamic phase-domain warps (Warp 2)
      if (warpMode2 === 4) { // Sync
        const syncMul2 = el.add(1, el.mul(warpAmtNode2, 1 + warpP2_2 * 15));
        ph = el.mod(el.mul(ph, syncMul2), 1);
      } else if (warpMode2 === 3) { // Asymmetry
        const kAsym2 = el.mul(warpAmtNode2, 0.99);
        ph = el.add(el.mul(ph, el.sub(1, kAsym2)), el.mul(el.mul(ph, ph), kAsym2));
      } else if (warpMode2 === 8) { // Quantize
        const steps2 = el.max(2, el.floor(el.add(2, el.mul(warpAmtNode2, 30))));
        ph = el.div(el.floor(el.mul(ph, steps2)), steps2);
      }

      raw = wavetableOsc(`v${vi}:op${k}:wt`, wtId, ph, wtPos, warpMode, warpAmtVal, warpP2, warpMode2, warpAmtVal2, warpP2_2,
        wtPosMod ? null : clamp(ops[k].wtPos ?? 0, 0, 1));
      if (involved[k]) raw = el.tapOut({ name: tap(k) }, raw);
    } else {
      // Wave-morph mod (`opNWave`) — a continuous 0..3 position that
      // cross-fades the 4 discrete shapes with triangular weights. Only built
      // when a route exists (4 oscillators instead of 1).
      const waveMod = modSignal(src, slots, T[`op${k + 1}Wave`]);
      const morphBlep = (freqNode) => {
        const pos = el.max(0, el.min(3, el.add(wave, waveMod)));
        let acc = null;
        for (let wi = 0; wi < 4; wi += 1) {
          const wgt = el.max(0, el.sub(1, el.abs(el.sub(pos, wi))));
          const term = el.mul(blepOsc(wi, freqNode), wgt);
          acc = acc ? el.add(acc, term) : term;
        }
        return acc;
      };
      if (involved[k]) {
        const freq = el.max(1, fmSum ? el.add(base, fmSum) : base);
        raw = fmOsc(wave, freq, pmSum); // wave-morph mod not applied on FM/PM path
        // Publish on this op's tap so modulators can read it next block.
        raw = el.tapOut({ name: tap(k) }, raw);
      } else {
        raw = waveMod ? morphBlep(base) : blepOsc(wave, base);
      }
    }

    opRaw[k] = raw;
    const mono = el.mul(raw, level(k));
    opMono[k] = mono;
    const pmod = panSignal(k);
    let pL;
    let pR;
    if (pmod) {
      pL = el.mul(mono, pmod[0]);
      pR = el.mul(mono, pmod[1]);
    } else {
      const [gl, gr] = panGains(ops[k].pan || 0);
      pL = el.mul(mono, ctrl(`v${vi}:op${k}:pl`, gl));
      pR = el.mul(mono, ctrl(`v${vi}:op${k}:pr`, gr));
    }

    if (usesB) {
      let fmix = ctrl(`v${vi}:op${k}:fmix`, clamp(ops[k].filterMix ?? 0, 0, 1));
      // Per-op Filter A/B crossfade mod (`opNFilterMix`). Only ONE signal
      // drives both toA/toB, so unlike Web Audio there's no drift risk (§60).
      const fmixMod = modSignal(src, slots, T[`op${k + 1}FilterMix`]);
      if (fmixMod) fmix = el.max(0, el.min(1, el.add(fmix, fmixMod)));
      const toA = el.sub(1, fmix);
      aL.push(el.mul(pL, toA)); aR.push(el.mul(pR, toA));
      bL.push(el.mul(pL, fmix)); bR.push(el.mul(pR, fmix));
    } else {
      aL.push(pL); aR.push(pR);
    }
  }

  // Every operator skipped (all silent) — emit a silent voice so the amp
  // envelope + summing math still have something to multiply.
  if (aL.length === 0) {
    aL.push(el.const({ key: `v${vi}:silent`, value: 0 }));
    aR.push(el.const({ key: `v${vi}:silentR`, value: 0 }));
  }

  // Filter A/B in stereo, then sum.
  let sumL = el.add(...aL);
  let sumR = el.add(...aR);
  if (!filterIsBypassed(state.filterA, hasRouteTo(state, T.filterACutoff, T.filterAReso))) {
    sumL = applyFilter(filtA, sumL);
    sumR = applyFilter(filtA, sumR);
  }
  if (usesB) {
    let bl = el.add(...bL);
    let br = el.add(...bR);
    if (!filterIsBypassed(state.filterB, hasRouteTo(state, T.filterBCutoff, T.filterBReso))) {
      bl = applyFilter(filtB, bl);
      br = applyFilter(filtB, br);
    }
    sumL = el.add(sumL, bl);
    sumR = el.add(sumR, br);
  }

  // Tight release (arp): a voice flagged 'tight' releases 8x faster (x0.12) so the
  // arp's Gate length is audible. The flag is set at note-on, so it has settled
  // (smoothed) long before the gate falls.
  let ampRel = ctrl(`env:r:${vi}`, Math.max(MIN_SEG, state.env.releaseSec));
  if (nativeVoiceCtl()) {
    ampRel = el.max(MIN_SEG, el.mul(ampRel, el.sub(1, el.mul(0.88, ctrlNode(voiceCtl(vi, 'tight', 0), 0.01)))));
  }
  // ENV 1 (amp) takes the same multi-point path as the modulation envelopes.
  // `ampRel` (the arp's tight-release shortening) only applies to the ADSR
  // branch — the multi branch owns its own release inside envSignal.
  const ampGate = voiceCtl(vi, 'gate', state.voices[vi].gate);
  const amp = envSignal(`v${vi}:env`, state.env, ampGate, state.sampleRate || 44100, () => el.adsr(
    ctrl(`env:a:${vi}`, Math.max(MIN_SEG, state.env.attackSec)),
    ctrl(`env:d:${vi}`, Math.max(MIN_SEG, state.env.decaySec)),
    ctrl(`env:s:${vi}`, Math.max(0, Math.min(1, state.env.sustainLevel))),
    ampRel,
    ampGate,
  ));

  // Native arp modulation (voice 0's sources only): summed per seq target.
  let seq = null;
  if (vi === 0 && nativeVoiceCtl()) {
    seq = SEQ_TARGETS.map(([name]) => modSignal(src, slots, T[name]));
  }

  return {
    lr: [el.mul(sumL, amp), el.mul(sumR, amp)],
    ops: opMono.map((m) => (m ? el.mul(m, amp) : null)),
    seq,
  };
}

const DEFAULT_FILTER = { type: 0, cutoff: 20000, resonance: 0.7, slope: 12 };

// ---------------------------------------------------------------------------
// Master-bus FX (todo.md §79 / §68.6 P8b). Runs AFTER the summed voice mix
// and master gain — the per-voice dual filter is a timbre stage; this is an
// insert chain on the stereo output. First pass: delay -> reverb. Each unit
// is skipped entirely when its `mix` is 0 so the reconcile stays cheap (same
// discipline as the P5 mod-matrix skip, todo.md §73).
// ---------------------------------------------------------------------------
const FX_DELAY_MAXSAMPS = 200000; // ~2 s at 96 kHz / ~4 s at 48 kHz
const FX_COMB_TUNINGS = [1557, 1617, 1491, 1422]; // Freeverb-ish, samples @ 44.1k
const FX_AP_TUNINGS = [556, 225];
const FX_REVERB_SPREAD = 23; // L/R comb-length offset for stereo width

/** Schroeder allpass from a feedback comb: H(z) = (-g + z^-D)/(1 - g·z^-D). */
function fxAllpass(x, delaySamps, g, key) {
  const comb = el.delay({ size: 8192 }, el.const({ key, value: delaySamps }), g, x);
  return el.add(el.mul(-g, x), el.mul(1 - g * g, comb));
}

/** Shared wet-path colour + stereo width for both FX (todo.md §86).
 *  `hiOpen` 0 (dark) .. 1 (full range); `loCut` 0 (~20 Hz) .. 1 (~800 Hz);
 *  `diffusion` adds an allpass smear; `width` mid/side widens. */
function fxColor(L, R, { hiOpen = 1, loCut = 0, diffusion = 0, width = 0 }, key) {
  const hi = clamp(hiOpen, 0, 1);
  if (hi < 0.999) {
    const pole = el.tau2pole(0.00001 + (1 - hi) * 0.0006);
    L = el.smooth(pole, L); R = el.smooth(pole, R);
  }
  const hp = 20 * Math.pow(40, clamp(loCut, 0, 1)); // 20 .. 800 Hz
  if (hp > 25) { L = el.highpass(hp, 0.7, L); R = el.highpass(hp, 0.7, R); }
  const diff = clamp(diffusion, 0, 1);
  if (diff > 0.02) {
    L = fxAllpass(L, 311, 0.28 + diff * 0.5, `${key}:apL`);
    R = fxAllpass(R, 421, 0.28 + diff * 0.5, `${key}:apR`);
  }
  const w = clamp(width, 0, 1);
  if (w > 0.01) {
    const mid = el.mul(el.add(L, R), 0.5);
    const side = el.mul(el.sub(L, R), 0.5 + w * 1.1);
    L = el.add(mid, side); R = el.sub(mid, side);
  }
  return [L, R];
}

/** Stereo feedback delay. TIME is a `el.const` + a small LFO (`mod`/`rate`)
 *  around it (chorus/wow); the `el.delay` feedback is sample-accurate. Wet
 *  colour (tone/locut/diffusion/width) is applied after via `fxColor`. */
function fxStereoDelay(inL, inR, d) {
  const baseT = el.ms2samps(el.const({ key: 'fx:dly:t', value: clamp(d.timeMs, 1, 2000) }));
  const rate = el.const({ key: 'fx:dly:rate', value: clamp(d.rate ?? 0.6, 0.05, 5) });
  const modSamps = el.ms2samps(el.const({ key: 'fx:dly:mod', value: clamp(d.mod ?? 0, 0, 1) * 8 }));
  const tL = el.add(baseT, el.mul(el.cycle(rate), modSamps));
  const tR = el.add(el.mul(baseT, 1.018), el.mul(el.cycle(el.mul(rate, 1.04)), modSamps));
  const fb = ctrl('fx:dly:fb', clamp(d.feedback, 0, 0.95));
  const wetL = el.delay({ size: FX_DELAY_MAXSAMPS }, tL, fb, inL);
  const wetR = el.delay({ size: FX_DELAY_MAXSAMPS }, tR, fb, inR);
  return fxColor(wetL, wetR, {
    hiOpen: clamp(d.tone ?? 1, 0, 1),
    loCut: clamp(d.locut ?? 0, 0, 1),
    diffusion: clamp(d.diffusion ?? 0, 0, 1),
    width: clamp(d.width ?? 0, 0, 1),
  }, 'fx:dly');
}

/** One reverb channel: N parallel feedback combs (lengths scaled by `size`,
 *  wobbled by `mod`/`rate`) → in-loop damping (`damp`) → series allpass
 *  diffusers (`diffusion` deepens them) → DC block. */
function fxReverbChannel(x, rv, spread, kp) {
  const sizeMul = 0.7 + 0.9 * clamp(rv.size, 0, 1);
  const fb = 0.72 + 0.26 * clamp(rv.decay, 0, 1);
  const rate = el.const({ key: `${kp}:rate`, value: clamp(rv.rate ?? 0.5, 0.05, 5) });
  const modSamps = el.const({ key: `${kp}:mod`, value: clamp(rv.mod ?? 0, 0, 1) * 40 });
  let acc = null;
  FX_COMB_TUNINGS.forEach((n, i) => {
    const dsamps = Math.max(1, Math.round((n + spread) * sizeMul));
    const dsig = el.add(
      el.const({ key: `${kp}:c${i}`, value: dsamps }),
      el.mul(el.cycle(el.mul(rate, 1 + i * 0.07)), modSamps),
    );
    const c = el.delay({ size: 32768 }, dsig, fb, x);
    acc = acc ? el.add(acc, c) : c;
  });
  let y = el.mul(acc, 1 / FX_COMB_TUNINGS.length);
  y = el.smooth(el.tau2pole(0.00002 + clamp(rv.damp, 0, 1) * 0.0016), y);
  const apG = 0.42 + clamp(rv.diffusion ?? 0.4, 0, 1) * 0.4;
  FX_AP_TUNINGS.forEach((n, i) => {
    y = fxAllpass(y, Math.max(1, Math.round((n + spread) * sizeMul)), apG, `${kp}:a${i}`);
  });
  return el.dcblock(y);
}

/** Default chain order — matches the old hardcoded delay-then-reverb series
 *  exactly, so patches with no `chain` field (old saves, or the offline test
 *  harness's ad-hoc `{delay, reverb}` literals) sound identical to before. */
const DEFAULT_FX_CHAIN = ['delay', 'reverb'];
export const NUM_FX_SLOTS = 8; // todo.md §113 — room for future effect types

function applyDelaySlot(outL, outR, dly) {
  if (dly.enabled === false || (dly.mix ?? 0) <= 1e-4) return [outL, outR];
  const [wL, wR] = fxStereoDelay(outL, outR, dly);
  const m = ctrl('fx:dly:mix', clamp(dly.mix, 0, 1));
  return [
    el.add(el.mul(outL, el.sub(1, m)), el.mul(wL, m)),
    el.add(el.mul(outR, el.sub(1, m)), el.mul(wR, m)),
  ];
}

function applyReverbSlot(outL, outR, rv) {
  if (rv.enabled === false || (rv.mix ?? 0) <= 1e-4) return [outL, outR];
  const spread = Math.round(FX_REVERB_SPREAD * (0.4 + 1.6 * clamp(rv.width ?? 0.5, 0, 1)));
  let wL = fxReverbChannel(outL, rv, 0, 'fx:rv:l');
  let wR = fxReverbChannel(outR, rv, spread, 'fx:rv:r');
  [wL, wR] = fxColor(wL, wR, {
    hiOpen: 1, // damp is already in the comb loop
    loCut: clamp(rv.locut ?? 0, 0, 1),
    diffusion: 0, // diffusion deepens the in-channel allpasses instead
    width: clamp(rv.width ?? 0, 0, 1),
  }, 'fx:rv');
  const m = ctrl('fx:rv:mix', clamp(rv.mix, 0, 1));
  return [
    el.add(el.mul(outL, el.sub(1, m)), el.mul(wL, m)),
    el.add(el.mul(outR, el.sub(1, m)), el.mul(wR, m)),
  ];
}

/** Stereo soft-clipping distortion. The drive is normalized to a useful
 * musical range before tanh; a light post-shaper low-pass keeps the bright
 * harmonics controllable without adding another effect type. */
function applyDistortionSlot(outL, outR, ds) {
  if (ds.enabled === false || (ds.mix ?? 0) <= 1e-4 || (ds.drive ?? 0) <= 1e-4) return [outL, outR];
  const drive = 1 + clamp(ds.drive, 0, 1) * 39;
  const wetL = el.tanh(el.mul(outL, drive));
  const wetR = el.tanh(el.mul(outR, drive));
  const tone = clamp(ds.tone ?? 0.7, 0, 1);
  const cutoff = 700 + tone * 19300;
  const shapedL = el.lowpass(cutoff, 0.707, wetL);
  const shapedR = el.lowpass(cutoff, 0.707, wetR);
  const m = ctrl('fx:dist:mix', clamp(ds.mix, 0, 1));
  return [
    el.add(el.mul(outL, el.sub(1, m)), el.mul(shapedL, m)),
    el.add(el.mul(outR, el.sub(1, m)), el.mul(shapedR, m)),
  ];
}

/** Stereo chorus: two short modulated taps with opposing LFO phase. The
 * delay time stays in the classic 14..30 ms range; width controls how far the
 * left/right modulation diverges, while depth controls the excursion. */
function applyChorusSlot(outL, outR, ch) {
  if (ch.enabled === false || (ch.mix ?? 0) <= 1e-4 || (ch.depth ?? 0) <= 1e-4) return [outL, outR];
  const rate = el.const({ key: 'fx:chorus:rate', value: clamp(ch.rate ?? 0.35, 0.05, 5) });
  const lfo = el.cycle(rate);
  const depthSamps = el.ms2samps(el.const({ key: 'fx:chorus:depth', value: 3 + clamp(ch.depth, 0, 1) * 9 }));
  const baseSamps = el.ms2samps(el.const({ key: 'fx:chorus:base', value: 18 }));
  const spread = clamp(ch.width ?? 0.65, 0, 1);
  const leftTime = el.add(baseSamps, el.mul(lfo, depthSamps));
  const rightTime = el.add(baseSamps, el.mul(lfo, el.mul(-spread, depthSamps)));
  const wetL = el.delay({ size: 4096 }, leftTime, 0, outL);
  const wetR = el.delay({ size: 4096 }, rightTime, 0, outR);
  const m = ctrl('fx:chorus:mix', clamp(ch.mix, 0, 1));
  return [
    el.add(el.mul(outL, el.sub(1, m)), el.mul(wetL, m)),
    el.add(el.mul(outR, el.sub(1, m)), el.mul(wetR, m)),
  ];
}

/** Stereo flanger: a very short, feedback-fed modulated delay. The opposing
 * L/R LFO motion and feedback create the characteristic moving comb notches. */
function applyFlangerSlot(outL, outR, fl) {
  if (fl.enabled === false || (fl.mix ?? 0) <= 1e-4) return [outL, outR];
  const rate = el.const({ key: 'fx:flanger:rate', value: clamp(fl.rate ?? 0.25, 0.05, 5) });
  const lfo = el.cycle(rate);
  const depthSamps = el.ms2samps(el.const({ key: 'fx:flanger:depth', value: clamp(fl.depth, 0, 1) * 3.5 }));
  const baseSamps = el.ms2samps(el.const({ key: 'fx:flanger:base', value: 1.2 }));
  const spread = clamp(fl.width ?? 0.7, 0, 1);
  const leftTime = el.add(baseSamps, el.mul(lfo, depthSamps));
  const rightTime = el.add(baseSamps, el.mul(lfo, el.mul(-spread, depthSamps)));
  const feedback = clamp(fl.feedback ?? 0.45, 0, 0.9);
  const wetL = el.delay({ size: 4096 }, leftTime, feedback, outL);
  const wetR = el.delay({ size: 4096 }, rightTime, feedback, outR);
  const m = ctrl('fx:flanger:mix', clamp(fl.mix, 0, 1));
  return [
    el.add(el.mul(outL, el.sub(1, m)), el.mul(wetL, m)),
    el.add(el.mul(outR, el.sub(1, m)), el.mul(wetR, m)),
  ];
}

/** Output ceiling for the compressor's wet path, in dBFS (todo.md §165 item 1
 *  / P0-C). The old tail was a bare `tanh` whose asymptote is 0 dBFS, so a hot
 *  setting could reach full scale. -1 dBFS leaves a little headroom. */
const COMP_CEILING_DB = -1;

/** Stereo 3-band DOOM-style upward compressor.
 *  Reference implementation: https://github.com/mantisvex/doom-comp
 *  Independent per-band envelope followers, floor clamping, ceiling target,
 *  drive, crush distortion, and safety limiter. */
function applyCompressorSlot(outL, outR, cm) {
  if (cm.enabled === false || (cm.mix ?? 0) <= 1e-4) return [outL, outR];

  const lowFreq = clamp(cm.lowFreq ?? 250, 100, 800);
  const highFreq = clamp(cm.highFreq ?? 2500, 1000, 10000);

  // Per-band upward boost ceiling is the band's own `floorDb` (todo.md §165
  // item 1 / P0-C): gainDb = (ceilingDb - max(envDb, floorDb)) * amount, so
  // `-floorDb * amount` IS the max boost. A separate maxBoostDb clamp was
  // considered and rejected — it would make the floor control inert for every
  // floor below -maxBoost, i.e. most of its range. The loudness bound lives on
  // the OUTPUT instead (COMP_CEILING_DB + the auto loudness compensation below).
  const lowFloorDb = clamp(cm.lowFloorDb ?? -55, -120, -12);
  const lowCeilingDb = clamp(cm.lowCeilingDb ?? 0, -24, 0);
  const lowAmount = clamp(cm.lowAmount ?? 0.5, 0, 1);
  const lowAtkSec = clamp(cm.lowAttackMs ?? 0, 0, 100) / 1000;
  const lowRelSec = clamp(cm.lowReleaseMs ?? 120, 1, 1000) / 1000;

  const midFloorDb = clamp(cm.midFloorDb ?? -55, -120, -12);
  const midCeilingDb = clamp(cm.midCeilingDb ?? 0, -24, 0);
  const midAmount = clamp(cm.midAmount ?? 0.5, 0, 1);
  const midAtkSec = clamp(cm.midAttackMs ?? 0, 0, 100) / 1000;
  const midRelSec = clamp(cm.midReleaseMs ?? 120, 1, 1000) / 1000;

  const highFloorDb = clamp(cm.highFloorDb ?? -55, -120, -12);
  const highCeilingDb = clamp(cm.highCeilingDb ?? 0, -24, 0);
  const highAmount = clamp(cm.highAmount ?? 0.5, 0, 1);
  const highAtkSec = clamp(cm.highAttackMs ?? 0, 0, 100) / 1000;
  const highRelSec = clamp(cm.highReleaseMs ?? 120, 1, 1000) / 1000;

  const driveVal = clamp(cm.drive ?? 0, 0, 1);
  const crushVal = clamp(cm.crush ?? 0, 0, 1);
  const gainVal = clamp(cm.gain ?? 1.0, 0, 2);
  const mixVal = clamp(cm.mix ?? 0, 0, 1);

  // 3-Band Split (low-pass, band-pass, high-pass)
  const b1L = el.lowpass(lowFreq, 0.707, outL);
  const b1R = el.lowpass(lowFreq, 0.707, outR);

  const b2L = el.highpass(lowFreq, 0.707, el.lowpass(highFreq, 0.707, outL));
  const b2R = el.highpass(lowFreq, 0.707, el.lowpass(highFreq, 0.707, outR));

  const b3L = el.highpass(highFreq, 0.707, outL);
  const b3R = el.highpass(highFreq, 0.707, outR);

  // Uncompressed band sum: same filters, same delay as the compressed sum, so
  // the mix crossfade below blends two in-phase signals and cannot cancel.
  const drySumL = el.add(b1L, b2L, b3L);
  const drySumR = el.add(b1R, b2R, b3R);

  // DOOM Upward Compression for one band with independent envelope
  const doomCompressBand = (bSignal, atkSec, relSec, floorDb, ceilingDb, amount) => {
    if (amount <= 1e-4) return bSignal;
    const envLin = el.max(1e-6, el.env(atkSec, relSec, bSignal));
    const envDb = el.gain2db(envLin);
    const clampedEnvDb = el.max(envDb, floorDb);
    const rawGainDb = el.mul(el.sub(ceilingDb, clampedEnvDb), amount);
    const gainLin = el.db2gain(rawGainDb);
    return el.mul(bSignal, gainLin);
  };

  const c1L = doomCompressBand(b1L, lowAtkSec, lowRelSec, lowFloorDb, lowCeilingDb, lowAmount);
  const c1R = doomCompressBand(b1R, lowAtkSec, lowRelSec, lowFloorDb, lowCeilingDb, lowAmount);

  const c2L = doomCompressBand(b2L, midAtkSec, midRelSec, midFloorDb, midCeilingDb, midAmount);
  const c2R = doomCompressBand(b2R, midAtkSec, midRelSec, midFloorDb, midCeilingDb, midAmount);

  const c3L = doomCompressBand(b3L, highAtkSec, highRelSec, highFloorDb, highCeilingDb, highAmount);
  const c3R = doomCompressBand(b3R, highAtkSec, highRelSec, highFloorDb, highCeilingDb, highAmount);

  // Sum bands
  let sumL = el.add(c1L, c2L, c3L);
  let sumR = el.add(c1R, c2R, c3R);

  // Drive boost (up to +24 dB)
  if (driveVal > 1e-4) {
    const driveGain = el.db2gain(driveVal * 24);
    sumL = el.mul(sumL, driveGain);
    sumR = el.mul(sumR, driveGain);
  }

  // Tanh Crush
  if (crushVal > 1e-4) {
    const shapedL = el.tanh(sumL);
    const shapedR = el.tanh(sumR);
    sumL = el.add(el.mul(sumL, 1 - crushVal), el.mul(shapedL, crushVal));
    sumR = el.add(el.mul(sumR, 1 - crushVal), el.mul(shapedR, crushVal));
  }

  // Makeup gain + output ceiling. `tanh(x/ceil)*ceil` is near-linear well
  // below the ceiling and asymptotes to -1 dBFS instead of the old 0 dBFS, so
  // no setting of drive/gain/crush can push the wet path to full scale
  // (todo.md §165 item 1 / P0-C).
  const ceilLin = Math.pow(10, COMP_CEILING_DB / 20);
  let wetL = el.mul(el.tanh(el.div(el.mul(sumL, gainVal), ceilLin)), ceilLin);
  let wetR = el.mul(el.tanh(el.div(el.mul(sumR, gainVal), ceilLin)), ceilLin);

  // NO loudness compensation (removed 2026-10-09 at the user's request): the
  // upward-compressed wet path really is louder than the dry (+16..+41 dB at
  // mix 100%), and `mix` is that volume control. The UI warns instead: the
  // compressor's container goes white -> yellow -> orange -> blood red as mix
  // rises (FxPanel mixWarnColor). Only the -1 dBFS output ceiling above stays.

  // Crossfade against the uncompressed band sum, not the raw input — the two
  // share the crossover's phase, so no `mix` setting can make them cancel.
  const m = ctrl('fx:comp:mix', clamp(mixVal, 0, 1));
  return [
    el.add(el.mul(drySumL, el.sub(1, m)), el.mul(wetL, m)),
    el.add(el.mul(drySumR, el.sub(1, m)), el.mul(wetR, m)),
  ];
}

/** Stereo multi-stage phaser: LFO-modulated all-pass sections with feedback. */
function applyPhaserSlot(outL, outR, ph) {
  if (ph.enabled === false || (ph.mix ?? 0) <= 1e-4 || (ph.depth ?? 0) <= 1e-4) return [outL, outR];
  const rate = el.const({ key: 'fx:phaser:rate', value: clamp(ph.rate ?? 0.35, 0.05, 5) });
  const lfo = el.cycle(rate);
  const depth = clamp(ph.depth ?? 0.65, 0, 1);
  const stages = Math.max(2, Math.min(8, Math.round(ph.stages ?? 4)));
  const feedback = clamp(ph.feedback ?? 0.35, 0, 0.9);
  const base = el.ms2samps(el.const({ key: 'fx:phaser:base', value: 0.7 }));
  const excursion = el.ms2samps(el.const({ key: 'fx:phaser:depth', value: 2.2 * depth }));
  const run = (input, sign, side) => {
    let y = input;
    for (let i = 0; i < stages; i += 1) {
      const phase = i * 0.19;
      const motion = el.mul(el.cycle(el.add(rate, phase * 0.01)), el.mul(sign, excursion));
      const time = el.add(base, motion);
      const g = 0.25 + feedback * 0.65;
      const delayed = el.delay({ size: 4096 }, time, 0, y);
      y = el.add(el.mul(y, -g), el.mul(delayed, 1 - g * g));
    }
    return y;
  };
  const wetL = el.mul(run(outL, 1, 'l'), 0.5);
  const wetR = el.mul(run(outR, -1, 'r'), 0.5);
  const m = ctrl('fx:phaser:mix', clamp(ph.mix, 0, 1));
  return [
    el.add(el.mul(outL, el.sub(1, m)), el.mul(wetL, m)),
    el.add(el.mul(outR, el.sub(1, m)), el.mul(wetR, m)),
  ];
}

/**
 * Real parametric EQ (todo.md — replaces the old fixed 3-band low/mid/high
 * crossover+gain hack, which had no frequency or Q control at all). An
 * arbitrary set of bell/shelf bands applied IN SERIES, each backed by
 * Elementary's native second-order state-variable peak/shelf filter
 * (`el.peak`/`el.lowshelf`/`el.highshelf`, filters.ts — real biquad-family
 * DSP, not an approximation) — both channels share the same control-rate
 * freq/gain/Q per band so the stereo image doesn't shift.
 *
 * Keyed by `b.id` (shared/types.ts's `EqBand.id`), NOT array index — a band
 * deleted from the middle of the array would otherwise shift every later
 * band's `ctrl()` smoothing state onto a DIFFERENT band for one render,
 * a real (if minor) audible glitch the LFO `FunctionPoint`/mod-cluster work
 * earlier this session already had to learn the same lesson from.
 */
function applyEqSlot(outL, outR, eq) {
  const enabled = eq.enabled ?? true;
  const mix = eq.mix ?? 1;

  // PRE-EQ scope tap (mono sum before filtering)
  const inMono = el.mul(0.5, el.add(outL, outR));
  const preScope = el.scope({ name: 'eq_pre', size: EQ_SCOPE_SIZE, channels: 1 }, inMono);

  let wetL = outL;
  let wetR = outR;
  if (enabled && mix > 1e-4) {
    const bands = Array.isArray(eq.bands) ? eq.bands.slice(0, 8) : [];
    for (const b of bands) {
      if (!b || !b.id) continue;
      const freq = ctrl(`fx:eq:${b.id}:freq`, clamp(b.freq ?? 1000, 20, 20000));
      const gain = ctrl(`fx:eq:${b.id}:gain`, clamp(b.gain ?? 0, -18, 18));
      const q = ctrl(`fx:eq:${b.id}:q`, clamp(b.q ?? 0.7, 0.1, 18));
      if (b.type === 'lowpass') {
        wetL = el.lowpass(freq, q, wetL);
        wetR = el.lowpass(freq, q, wetR);
      } else if (b.type === 'highpass') {
        wetL = el.highpass(freq, q, wetL);
        wetR = el.highpass(freq, q, wetR);
      } else if (b.type === 'notch') {
        wetL = el.notch(freq, q, wetL);
        wetR = el.notch(freq, q, wetR);
      } else if (b.type === 'lowshelf') {
        wetL = el.lowshelf(freq, q, gain, wetL);
        wetR = el.lowshelf(freq, q, gain, wetR);
      } else if (b.type === 'highshelf') {
        wetL = el.highshelf(freq, q, gain, wetL);
        wetR = el.highshelf(freq, q, gain, wetR);
      } else {
        wetL = el.peak(freq, q, gain, wetL);
        wetR = el.peak(freq, q, gain, wetR);
      }
    }
  }
  const m = enabled ? ctrl('fx:eq:mix', clamp(mix, 0, 1)) : 0;
  const resL = el.add(el.mul(outL, el.sub(1, m)), el.mul(wetL, m));
  const resR = el.add(el.mul(outR, el.sub(1, m)), el.mul(wetR, m));

  // POST-EQ scope tap (mono sum after filtering & mix)
  const outMono = el.mul(0.5, el.add(resL, resR));
  const postScope = el.scope({ name: 'eq_post', size: EQ_SCOPE_SIZE, channels: 1 }, outMono);

  const scopeSinks = el.add(el.mul(preScope, 0), el.mul(postScope, 0));
  return [el.add(resL, scopeSinks), el.add(resR, scopeSinks)];
}

/** Reorderable master-bus FX chain (todo.md §113 — was a hardcoded
 *  delay-then-reverb series). `fx.chain` is an ordered list of slot types
 *  ('off' | 'delay' | 'reverb', more types land later); each real slot
 *  applies that effect's OWN settings object (`fx.delay` / `fx.reverb`) in
 *  the chain's position, not a fixed one. Two slots naming the same type
 *  would apply the identical settings twice in series — harmless, and not
 *  guarded against, since only one instance of each type exists today.
 *  Returns `[L, R]`. Exported for the offline test harness (feeds it a
 *  synthetic burst directly — the offline `el.adsr` collapses to its
 *  sustain level almost instantly, so a synth note can't produce a clean
 *  "sound then silence" tail to measure). */
export function masterFx(outL, outR, fx) {
  const chain = (fx && Array.isArray(fx.chain) && fx.chain.length) ? fx.chain : DEFAULT_FX_CHAIN;
  for (const slot of chain) {
    if (slot === 'delay') [outL, outR] = applyDelaySlot(outL, outR, (fx && fx.delay) || {});
    else if (slot === 'reverb') [outL, outR] = applyReverbSlot(outL, outR, (fx && fx.reverb) || {});
    else if (slot === 'distortion') [outL, outR] = applyDistortionSlot(outL, outR, (fx && fx.distortion) || {});
    else if (slot === 'chorus') [outL, outR] = applyChorusSlot(outL, outR, (fx && fx.chorus) || {});
    else if (slot === 'flanger') [outL, outR] = applyFlangerSlot(outL, outR, (fx && fx.flanger) || {});
    else if (slot === 'compressor') [outL, outR] = applyCompressorSlot(outL, outR, (fx && fx.compressor) || {});
    else if (slot === 'phaser') [outL, outR] = applyPhaserSlot(outL, outR, (fx && fx.phaser) || {});
    else if (slot === 'eq') [outL, outR] = applyEqSlot(outL, outR, (fx && fx.eq) || {});
  }
  return [outL, outR];
}

/**
 * @param {object} state
 * @param {number} state.master / octave / semitone / fineCents
 * @param {{attackSec,decaySec,sustainLevel,releaseSec}} state.env
 * @param {Array<{wave,level,pan,semis, filterMix?, mods?:{[srcIndex]:{pm,fm}}}>} state.operators  length 4
 * @param {{type,cutoff,resonance,slope}} state.filterA / state.filterB
 * @param {{attackSec,decaySec,sustainLevel,releaseSec}} [state.modEnv] / [state.modEnv3]  ENV 2 / ENV 3
 * @param {{rateHz,wave,sync,perNote}} [state.lfo1] / [state.lfo2] / [state.lfo3]  per-voice LFOs
 * @param {number} [state.bpm]  host tempo, for LFO sync
 * @param {Array<{src:number, dst:number, amt:number}>} [state.mod]  mod-matrix slots (P5)
 * @param {Array<{gate:0|1, freq:number, vel?:number}>} state.voices
 * @returns {[NodeRepr_t, NodeRepr_t]}
 */
export function renderSynth(state) {
  afCache = new Map();
  const transpose = Math.pow(
    2,
    state.octave + state.semitone / 12 + state.fineCents / 1200,
  );
  state.filterA = state.filterA || DEFAULT_FILTER;
  state.filterB = state.filterB || DEFAULT_FILTER;

  // Each voice builds its own operator graph, per-voice filter params (with
  // modulation folded in) and amp envelope. `transpose` is the numeric
  // octave/semitone/fine multiplier; `v` is the `{gate, freq}` voice slot.
  const voiceOuts = state.voices.map((v, vi) => voiceSignal(vi, state, v, transpose));

  // Headroom is pinned to a 6-voice reference: raising the pool size must not
  // make every patch quieter (6 -> 12 voices would otherwise cost 3 dB).
  const headroom = 1 / Math.sqrt(Math.min(state.voices.length, HEADROOM_VOICES) * NUM_OPERATORS);
  const master = ctrl('master', Math.max(0, Math.min(1, state.master)));

  let outL = el.mul(el.add(...voiceOuts.map((o) => o.lr[0])), headroom, master);
  let outR = el.mul(el.add(...voiceOuts.map((o) => o.lr[1])), headroom, master);

  // Native arp/seq modulation: always emit all 6 ctlout nodes (a 0 const when
  // unrouted, so a removed route resets the bank slot instead of leaving it stale).
  // Zero-gain sinks keep them alive in the graph.
  if (nativeVoiceCtl()) {
    const seqMods = voiceOuts[0] && voiceOuts[0].seq;
    const sinks = SEQ_TARGETS.map(([name, span], i) => {
      const m = seqMods && seqMods[i];
      const sig = m ? el.mul(m, span) : el.const({ key: `ctlout${i}:z`, value: 0 });
      return el.mul(createNode('ctlout', { key: `ctlout${i}`, slot: i }, [sig]), 0);
    });
    outL = el.add(outL, ...sinks);
  }

  // Master-bus FX chain (delay → reverb). No-op unless a unit's mix > 0.
  [outL, outR] = masterFx(outL, outR, state.fx);

  // Master-out tap for Audio Followers set to OUT (read back with one block of
  // delay via el.tapIn). Zero-gain sink so it stays in the graph.
  if (Object.entries(state.extra || {}).some(([id, c]) => c && id.startsWith('audiofollower') && (c.source | 0) === 1)) {
    outL = el.add(outL, el.mul(el.tapOut({ name: 'faze:master' }, el.mul(0.5, el.add(outL, outR))), 0));
  }

  // ---- Visualizer taps (todo.md §73 P7c) -------------------------------------
  // `el.scope` passes its input straight through and emits Float32Array frames
  // through the runtime's event queue; the C++ side drains them on a timer and
  // forwards to the webview. `main` sits transparently on the output; the four
  // per-operator monitor buses are summed at zero gain so they stay live in
  // the graph without colouring the sound. Guarded on `state.scopes` so the
  // offline regression harness (no scope drain) isn't affected.
  if (state.scopes !== false) {
    outL = el.scope({ name: 'main', size: MAIN_SCOPE_SIZE, channels: 1 }, outL);
    const opSinks = [];
    for (let k = 0; k < NUM_OPERATORS; k++) {
      const cs = voiceOuts.map((o) => o.ops[k]).filter(Boolean);
      const bus = cs.length ? el.add(...cs) : el.const({ key: `opbus${k}z`, value: 0 });
      opSinks.push(el.mul(el.scope({ name: `op${k}`, size: SCOPE_SIZE, channels: 1 }, bus), 0));
    }
    // Audio Follower level meter (card UI): a zero-gain tap of the follower's
    // 0..1 output so the card can show what the sidechain is doing.
    for (const [id, cfg] of Object.entries(state.extra || {})) {
      if (cfg && id.startsWith('audiofollower')) {
        opSinks.push(el.mul(el.scope({ name: `af_${id}`, size: 512, channels: 1 }, afNode(id, cfg)), 0));
      }
    }
    outL = el.add(outL, ...opSinks);
  }

  return [outL, outR];
}

/** Default operator slots — mirrors `defaultOscillatorSlots()` in types.ts. */
export function defaultOperators() {
  return [
    { wave: 2, level: 1.0, pan: 0.0, semis: 0, filterMix: 0, mods: {} },
    { wave: 0, level: 0.0, pan: -0.4, semis: 0, filterMix: 0, mods: {} },
    { wave: 0, level: 0.0, pan: 0.4, semis: 0, filterMix: 0, mods: {} },
    { wave: 0, level: 0.0, pan: 0.0, semis: 0, filterMix: 0, mods: {} },
  ];
}

export function defaultFilter() {
  return { type: 0, cutoff: 20000, resonance: 0.7, slope: 12 };
}
