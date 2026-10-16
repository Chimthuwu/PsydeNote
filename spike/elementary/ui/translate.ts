// SynthSettings <-> flat plugin-param translation (todo.md §73, P7a).
//
// The React UI thinks in the rich `SynthSettings` shape from
// src/shared/types.ts. The plugin exposes a flat map of host params (see
// plugin/manifest.json) and the Elementary DSP (dsp/synth.js) consumes a
// subset of the full engine. This layer is deliberately LOSSY where the two
// disagree — every such spot is commented `// LOSSY`.
import type {
  SynthSettings,
  OscillatorSlotSettings,
  LfoSettings,
  LfoWave,
  FilterType,
  ModMap,
  ModSourceId,
  ModTargetId,
  FxChainSlotType,
  ModuleSet,
} from '../../../src/shared/types';
import {
  defaultFunctionShape,
  functionShapeForLegacyWave,
  normalizeSynthSettings,
  WAVE_MORPH_SHAPES,
  waveShapeForPosition,
  NUM_FX_SLOTS,
  DEFAULT_AUDIO_FOLLOWER,
  DEFAULT_MODULE_ENV,
  defaultModuleLfo,
  AF_MODULE_IDS,
  EXTRA_ENV_IDS,
  EXTRA_LFO_IDS,
  arpModeToPos,
  arpPosToMode,
} from '../../../src/shared/types';
import { MOD_TARGETS } from '../../../src/renderer/lib/mod-sources';

// Master FX chain (todo.md §113) — index order matches manifest.json's
// fxslot{n}_type comment and dsp/synth.js's own chain-type strings. APPEND
// new effect types here as they're built, never reorder.
const FX_CHAIN_TYPES: FxChainSlotType[] = ['off', 'delay', 'reverb', 'distortion', 'chorus', 'flanger', 'compressor', 'phaser', 'eq'];
const fxChainTypeIndex = (t: FxChainSlotType) => Math.max(0, FX_CHAIN_TYPES.indexOf(t));
const fxChainTypeFromIndex = (i: number): FxChainSlotType => FX_CHAIN_TYPES[Math.round(i)] ?? 'off';

export type FlatParams = Record<string, number>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// --------------------------------------------------------------------------
// Mod matrix — the app's Pigments per-knob `ModMap` <-> the DSP's flat
// 8-slot `mod{n}_{src,dst,amt}` params (todo.md §75 P7b).
//
// src index order matches dsp/synth.js `MOD_SOURCES` exactly.
// dst index order matches dsp/synth.js `MOD_TARGETS` — index 0 is 'off'.
// --------------------------------------------------------------------------
const MOD_SRC_IDS: ModSourceId[] = [
  'env1', 'env2', 'env3', 'lfo1', 'lfo2', 'lfo3', 'velocity', 'keytrack',
  // 8 Macro knobs (todo.md §111) — APPENDED, index-aligned with dsp/synth.js's
  // MOD_SOURCES tail and manifest.json's macro0..macro7 params.
  'macro1', 'macro2', 'macro3', 'macro4', 'macro5', 'macro6', 'macro7', 'macro8',
  // Optional "+" modulators (src 16..20) — APPENDED, never reorder.
  'audiofollower', 'env4', 'env5', 'lfo4', 'lfo5', 'lfo6',
  'env6', 'env7', 'env8', 'lfo7', 'lfo8',
  'audiofollower2', 'audiofollower3', 'audiofollower4',
  'env9', 'env10', 'env11', 'lfo9', 'lfo10',
  'audiofollower5', 'audiofollower6', 'audiofollower7', 'audiofollower8', 'audiofollower9', 'audiofollower10',
];
/** DSP dst index → app ModTargetId (index 0 'off' omitted). MUST stay
 *  index-aligned with `MOD_TARGETS` in dsp/synth.js. */
const MOD_DST_IDS: (ModTargetId | null)[] = [
  null, 'pitch',
  'osc1Level', 'osc2Level', 'osc3Level', 'osc4Level',
  'osc1Pitch', 'osc2Pitch', 'osc3Pitch', 'osc4Pitch',
  'osc1Pan', 'osc2Pan', 'osc3Pan', 'osc4Pan',
  'osc1ModAmount', 'osc2ModAmount', 'osc3ModAmount', 'osc4ModAmount',
  'osc1Wave', 'osc2Wave', 'osc3Wave', 'osc4Wave',
  'osc1FilterMix', 'osc2FilterMix', 'osc3FilterMix', 'osc4FilterMix',
  'filterACutoff', 'filterAResonance', 'filterBCutoff', 'filterBResonance',
  'lfo1Rate', 'lfo2Rate',
  // Per-source PM/FM depth knobs (todo.md §95) — APPENDED, index-aligned
  // with the 24 entries appended to `MOD_TARGETS` in dsp/synth.js. No
  // self-mod entries (osc*Pm*osc SAME id) — see that file's comment.
  'osc1Pmosc2', 'osc1Fmosc2', 'osc1Pmosc3', 'osc1Fmosc3', 'osc1Pmosc4', 'osc1Fmosc4',
  'osc2Pmosc1', 'osc2Fmosc1', 'osc2Pmosc3', 'osc2Fmosc3', 'osc2Pmosc4', 'osc2Fmosc4',
  'osc3Pmosc1', 'osc3Fmosc1', 'osc3Pmosc2', 'osc3Fmosc2', 'osc3Pmosc4', 'osc3Fmosc4',
  'osc4Pmosc1', 'osc4Fmosc1', 'osc4Pmosc2', 'osc4Fmosc2', 'osc4Pmosc3', 'osc4Fmosc3',
  // Self PM/FM (indexes 56..63) — index-aligned with the "Self PM & Self FM"
  // block in dsp/synth.js's MOD_TARGETS, which sits BEFORE WtPos. (This list
  // used to skip it, so WtPos landed on 56 = self-PM and could never work.)
  'osc1Pmosc1', 'osc1Fmosc1', 'osc2Pmosc2', 'osc2Fmosc2',
  'osc3Pmosc3', 'osc3Fmosc3', 'osc4Pmosc4', 'osc4Fmosc4',
  // Wavetable scan position (64..67).
  'osc1WtPos', 'osc2WtPos', 'osc3WtPos', 'osc4WtPos',
  // WarpAmt 68..71, WarpAmt2 72..75: DSP targets with no UI id yet. Kept as
  // null placeholders so indexes stay aligned (manifest mod*_dst max = 81).
  null, null, null, null, null, null, null, null,
  // Native arp/seq targets 76..84 (ctlout slots 0..8) — index-aligned with the tail of MOD_TARGETS.
  'seqRate', 'seqSwing', 'seqGate', 'seqTranspose', 'seqVelocity', 'seqRandom',
  'seqOctaves', 'seqPattern', 'seqChaos',
];
const MOD_DST_INDEX: Partial<Record<ModTargetId, number>> = Object.fromEntries(
  MOD_DST_IDS.map((id, i) => [id, i]).filter(([id]) => id),
) as Partial<Record<ModTargetId, number>>;
const NUM_MOD_SLOTS = 24; // todo.md §108 — was 8, silently dropped routes past the 8th

/**
 * Targets the spike DSP actually consumes audibly (todo.md §85 widened this;
 * §95 added the per-source PM/FM depth knobs below). Still NOT here:
 * `lfo*Shape`/`lfo*Rate` (listed in the DSP matrix but never wired into
 * `lfoSignal`). A cable dropped on any of these would store a silent route,
 * so `PluginApp` refuses it.
 */
export const DSP_MOD_TARGETS: ReadonlySet<string> = new Set([
  'pitch',
  'osc1Level', 'osc2Level', 'osc3Level', 'osc4Level',
  'osc1Pitch', 'osc2Pitch', 'osc3Pitch', 'osc4Pitch',
  'osc1Pan', 'osc2Pan', 'osc3Pan', 'osc4Pan',
  'osc1ModAmount', 'osc2ModAmount', 'osc3ModAmount', 'osc4ModAmount',
  'osc1Wave', 'osc2Wave', 'osc3Wave', 'osc4Wave',
  'osc1FilterMix', 'osc2FilterMix', 'osc3FilterMix', 'osc4FilterMix',
  'filterACutoff', 'filterAResonance', 'filterBCutoff', 'filterBResonance',
  'osc1Pmosc2', 'osc1Fmosc2', 'osc1Pmosc3', 'osc1Fmosc3', 'osc1Pmosc4', 'osc1Fmosc4',
  'osc2Pmosc1', 'osc2Fmosc1', 'osc2Pmosc3', 'osc2Fmosc3', 'osc2Pmosc4', 'osc2Fmosc4',
  'osc3Pmosc1', 'osc3Fmosc1', 'osc3Pmosc2', 'osc3Fmosc2', 'osc3Pmosc4', 'osc3Fmosc4',
  'osc4Pmosc1', 'osc4Fmosc1', 'osc4Pmosc2', 'osc4Fmosc2', 'osc4Pmosc3', 'osc4Fmosc3',
  // Wavetable scan position (Task 4) — genuinely wired/audible in
  // dsp/synth.js's wave===5 branch, unlike lfo*Rate/Shape above.
  'osc1WtPos', 'osc2WtPos', 'osc3WtPos', 'osc4WtPos',
  // Native arp/seq (realised through ctlout nodes -> ArpEngine mod inputs).
  'seqRate', 'seqSwing', 'seqGate', 'seqTranspose', 'seqVelocity', 'seqRandom',
  'seqOctaves', 'seqPattern', 'seqChaos',
]);

/**
 * SELF-mod pairs (`osc1Pmosc1`, ..., e.g. an operator modulating itself) —
 * todo.md §106. The audio-rate PM/FM loop in dsp/synth.js skips s===k, so
 * these have NO audible effect yet and are deliberately excluded from
 * `DSP_MOD_TARGETS` above (silent routes there get refused by `PluginApp`).
 * They used to get silently REMAPPED onto the shared `osc*ModAmount`
 * target in `useCableDrag.ts` so the drop "did something" — but that made
 * the self knob look wired to its sibling self knob (PM self and FM self
 * both showing/glowing the SAME route), which repeated user reports read
 * as "these knobs are secretly connected." Now the self pair gets its OWN
 * independent (inert) target instead: still a valid cable-drop target (see
 * `isValidDropTarget` in useCableDrag.ts), still has its own glow/popover,
 * just does nothing audibly until self-PM/FM is implemented in the DSP.
 */
export const UI_ONLY_MOD_TARGETS: ReadonlySet<string> = new Set([
  'osc1Pmosc1', 'osc1Fmosc1',
  'osc2Pmosc2', 'osc2Fmosc2',
  'osc3Pmosc3', 'osc3Fmosc3',
  'osc4Pmosc4', 'osc4Fmosc4',
]);

/**
 * The DSP `mod{n}_amt` param is bipolar -1..1 and each target reads it in its
 * own DSP-native unit:
 *   - pitch / osc{n}Pitch — a fraction of the popover's full ±2400ct (±24
 *     semitone) range, applied as `2^(amt·2)` (semitones = amt·24, ratio =
 *     2^(semitones/12)). Was hardcoded to a ±100ct/±1-semitone DSP span
 *     regardless of the dialed-in amount (todo.md — bug: the popover
 *     advertised up to ±2400ct but anything past 100ct did literally
 *     nothing, since dsp{amt} was already clamped to ±1 there — a user
 *     cranking the knob for a bigger effect would reasonably call this
 *     "totally inaudible", which is exactly what got reported).
 *   - filter cutoff — OCTAVES (`fc·2^amt`) → ±1 octave at full scale.
 *   - filter reso — `q + amt·12` → ±12 Q at full scale.
 *   - level — additive 0..1 (`level + amt·src`).
 * Every target (pitch included, now) carries the app's native amount as a
 * fraction of that target's popover range (`meta.max`), so the popover keeps
 * showing real units that actually correspond to what's audible.
 */
const dspSpan = (t: ModTargetId) => (MOD_TARGETS[t]?.max ?? 1) || 1;
const amtToDsp = (target: ModTargetId, amount: number): number =>
  clamp(amount / dspSpan(target), -1, 1);
const amtFromDsp = (target: ModTargetId, dsp: number): number => dsp * dspSpan(target);

interface ModSlot { src: number; dst: number; amt: number; }

/** Flatten a `ModMap` into up to `NUM_MOD_SLOTS` DSP slots. LOSSY: unsupported
 *  targets are dropped; routes past the last slot are dropped (todo.md §108 —
 *  raised from 8, which silent-dropped real patches; watch this ceiling as
 *  the mod system grows, e.g. macro sources). */
function modToSlots(mod: ModMap | undefined): ModSlot[] {
  const slots: ModSlot[] = [];
  for (const [target, routes] of Object.entries(mod ?? {}) as [ModTargetId, ModMap[ModTargetId]][]) {
    const dst = MOD_DST_INDEX[target];
    if (!dst || !routes) continue;
    for (const r of routes) {
      if (r.enabled === false) continue; // muted — kept in the patch, silent
      if (slots.length >= NUM_MOD_SLOTS) return slots;
      const src = MOD_SRC_IDS.indexOf(r.source);
      if (src < 0) continue;
      slots.push({ src, dst, amt: amtToDsp(target, r.amount) });
    }
  }
  return slots;
}

/** Rebuild a `ModMap` from the 8 DSP slots (host automation / preset recall). */
function slotsToMod(f: FlatParams): ModMap {
  const mod: ModMap = {};
  for (let n = 0; n < NUM_MOD_SLOTS; n += 1) {
    const dst = Math.round(f[`mod${n}_dst`] ?? 0);
    const target = MOD_DST_IDS[dst];
    if (!target) continue;
    const source = MOD_SRC_IDS[Math.round(f[`mod${n}_src`] ?? 0)];
    if (!source) continue;
    const amt = f[`mod${n}_amt`] ?? 0;
    if (Math.abs(amt) < 1e-4) continue;
    (mod[target] ??= []).push({ source, amount: amtFromDsp(target, amt) });
  }
  return mod;
}

const LFO_WAVES: LfoWave[] = ['sine', 'triangle', 'sawtooth', 'square', 'sample-hold', 'function'];
const FILTER_TYPES: FilterType[] = ['lowpass', 'highpass', 'bandpass'];

const lfoWaveIndex = (w: LfoWave) => Math.max(0, LFO_WAVES.indexOf(w));

const LEGACY_LFO_WAVES: LfoWave[] = ['sine', 'triangle', 'sawtooth', 'square'];

/** Rebuild one LFO from its flat params (`lfoN_*`), keeping `shapePosition`
 *  from `base` (not carried in the flat map). Every LFO is a Function now
 *  (shared/types.ts's `normalizeLfo` — no more discrete sine/triangle/
 *  sawtooth/square pick), but the DSP's numeric wave index still has room
 *  for those 4 legacy values (host automation on an old project could still
 *  send one) — coerce them to 'function' with a matching shape rather than
 *  resurrecting a UI mode that no longer exists. */
/** Host-param prefix for an Audio Follower instance ('af', 'af2', ...). */
const afPrefix = (id: (typeof AF_MODULE_IDS)[number]) => (id === 'audioFollower' ? 'af' : `af${id.slice('audioFollower'.length)}`);

/** The optional "+" modulator pool -> flat params. Absent modules still emit
 *  their defaults (flag 0) so every manifest param is always written. */
function modulesToFlat(m: ModuleSet | undefined): FlatParams {
  const mods = m ?? {};
  const out: FlatParams = {
    mod_on_env2: mods.env2 ? 1 : 0,
    mod_on_env3: mods.env3 ? 1 : 0,
    mod_on_lfo1: mods.lfo1 ? 1 : 0,
    mod_on_lfo2: mods.lfo2 ? 1 : 0,
    mod_on_lfo3: mods.lfo3 ? 1 : 0,
  };
  for (const id of AF_MODULE_IDS) {
    const pre = afPrefix(id);
    const a = mods[id] ?? DEFAULT_AUDIO_FOLLOWER;
    out[`mod_on_${pre}`] = mods[id] ? 1 : 0;
    out[`${pre}_lo`] = a.loHz; out[`${pre}_hi`] = a.hiHz;
    out[`${pre}_atk`] = a.attackMs; out[`${pre}_rel`] = a.releaseMs; out[`${pre}_gain`] = a.gainDb;
    out[`${pre}_src`] = a.source;
  }
  for (const id of EXTRA_ENV_IDS) {
    const e = mods[id] ?? DEFAULT_MODULE_ENV;
    out[`mod_on_${id}`] = mods[id] ? 1 : 0;
    out[`${id}_a`] = e.attackSec; out[`${id}_d`] = e.decaySec; out[`${id}_s`] = e.sustainLevel; out[`${id}_r`] = e.releaseSec;
  }
  for (const id of EXTRA_LFO_IDS) {
    const l = mods[id] ?? defaultModuleLfo(id);
    out[`mod_on_${id}`] = mods[id] ? 1 : 0;
    out[`${id}_rate`] = l.rateHz; out[`${id}_wave`] = lfoWaveIndex(l.wave);
    out[`${id}_sync`] = l.sync ? 1 : 0; out[`${id}_pernote`] = l.perNote ? 1 : 0;
  }
  return out;
}

function modulesFromFlat(f: FlatParams, base: ModuleSet | undefined): ModuleSet {
  const b = base ?? {};
  const n = (k: string, d: number) => (typeof f[k] === 'number' ? (f[k] as number) : d);
  const on = (k: string, d: boolean) => (typeof f[k] === 'number' ? (f[k] as number) > 0.5 : d);
  const out: Record<string, unknown> = {};
  for (const id of AF_MODULE_IDS) {
    const pre = afPrefix(id);
    if (!on(`mod_on_${pre}`, !!b[id])) continue;
    const a = b[id] ?? DEFAULT_AUDIO_FOLLOWER;
    out[id] = { loHz: n(`${pre}_lo`, a.loHz), hiHz: n(`${pre}_hi`, a.hiHz), attackMs: n(`${pre}_atk`, a.attackMs), releaseMs: n(`${pre}_rel`, a.releaseMs), gainDb: n(`${pre}_gain`, a.gainDb), source: Math.round(n(`${pre}_src`, a.source)) };
  }
  for (const id of EXTRA_ENV_IDS) {
    if (!on(`mod_on_${id}`, !!b[id])) continue;
    const e = b[id] ?? DEFAULT_MODULE_ENV;
    out[id] = { ...e, attackSec: n(`${id}_a`, e.attackSec), decaySec: n(`${id}_d`, e.decaySec), sustainLevel: n(`${id}_s`, e.sustainLevel), releaseSec: n(`${id}_r`, e.releaseSec) };
  }
  for (const id of EXTRA_LFO_IDS) {
    if (on(`mod_on_${id}`, !!b[id])) out[id] = lfoFromFlat(f, b[id] ?? defaultModuleLfo(id), id);
  }
  for (const k of ['env2', 'env3', 'lfo1', 'lfo2', 'lfo3'] as const) if (on(`mod_on_${k}`, !!b[k])) out[k] = true;
  return out as ModuleSet;
}

function lfoFromFlat(f: FlatParams, base: LfoSettings, p: string): LfoSettings {
  const n = (k: string, d: number) => (typeof f[k] === 'number' ? (f[k] as number) : d);
  const rawWave = lfoWaveFromIndex(n(`${p}_wave`, lfoWaveIndex(base.wave)));
  const isLegacy = LEGACY_LFO_WAVES.includes(rawWave);
  return {
    ...base,
    rateHz: n(`${p}_rate`, base.rateHz),
    wave: rawWave === 'sample-hold' ? 'sample-hold' : 'function',
    sync: (f[`${p}_sync`] ?? (base.sync ? 1 : 0)) > 0.5,
    perNote: (f[`${p}_pernote`] ?? (base.perNote ? 1 : 0)) > 0.5,
    functionShape: isLegacy ? functionShapeForLegacyWave(rawWave as 'sine' | 'triangle' | 'sawtooth' | 'square') : (base.functionShape ?? defaultFunctionShape()),
  };
}
const lfoWaveFromIndex = (i: number): LfoWave => LFO_WAVES[Math.round(i)] ?? 'sine';
const filterTypeIndex = (t: FilterType) => Math.max(0, FILTER_TYPES.indexOf(t));
const filterTypeFromIndex = (i: number): FilterType => FILTER_TYPES[Math.round(i)] ?? 'lowpass';

// LOSSY: the DSP oscillator is a discrete 4-shape pick (op{k}_wave 0..3); the
// UI drives a continuous wavetablePosition. Snap to the nearest breakpoint.
const wavePosToIndex = (pos: number) =>
  WAVE_MORPH_SHAPES.indexOf(waveShapeForPosition(pos));
const waveIndexToPos = (i: number) =>
  Math.round(i) / (WAVE_MORPH_SHAPES.length - 1);

/** The 4 operator ids, index-aligned with `SynthSettings.oscillators`. */
const OP_IDS = ['osc1', 'osc2', 'osc3', 'osc4'] as const;

/** Default flat params = defaults of the full settings, translated down. */
export const FLAT_DEFAULTS: FlatParams = synthToFlat(normalizeSynthSettings({}));

export function defaultSynthSettings(): SynthSettings {
  return normalizeSynthSettings({});
}

// --------------------------------------------------------------------------
// SynthSettings -> flat params
// --------------------------------------------------------------------------
export function synthToFlat(s: SynthSettings): FlatParams {
  const f: FlatParams = {
    master: s.masterLevel, // LOSSY: voiceLevel is folded away (no separate DSP trim)
    octave: s.octave,
    semitone: s.semitone,
    fineCents: s.fineTuneCents,
    voice_mode: s.voiceMode,
    glide: s.glideSec,

    env_a: s.ampEnv.attackSec,
    env_d: s.ampEnv.decaySec,
    env_s: s.ampEnv.sustainLevel,
    env_r: s.ampEnv.releaseSec,
    // LOSSY: ampEnv.{attack,decay,release}Curve dropped (DSP ADSR is exp-only)

    env2_a: s.modEnv.attackSec,
    env2_d: s.modEnv.decaySec,
    env2_s: s.modEnv.sustainLevel,
    env2_r: s.modEnv.releaseSec,
    env3_a: s.modEnv3.attackSec,
    env3_d: s.modEnv3.decaySec,
    env3_s: s.modEnv3.sustainLevel,
    env3_r: s.modEnv3.releaseSec,

    lfo1_rate: s.lfo1.rateHz,
    lfo1_wave: lfoWaveIndex(s.lfo1.wave), // LOSSY: shapePosition dropped
    lfo1_sync: s.lfo1.sync ? 1 : 0,
    lfo1_pernote: s.lfo1.perNote ? 1 : 0,
    lfo2_rate: s.lfo2.rateHz,
    lfo2_wave: lfoWaveIndex(s.lfo2.wave),
    lfo2_sync: s.lfo2.sync ? 1 : 0,
    lfo2_pernote: s.lfo2.perNote ? 1 : 0,
    lfo3_rate: s.lfo3.rateHz,
    lfo3_wave: lfoWaveIndex(s.lfo3.wave),
    lfo3_sync: s.lfo3.sync ? 1 : 0,
    lfo3_pernote: s.lfo3.perNote ? 1 : 0,
    vel_curve: s.velCurve,
    key_curve: s.keyCurve,

    ...modulesToFlat(s.modules),

    macro0: s.macros[0] ?? 0,
    macro1: s.macros[1] ?? 0,
    macro2: s.macros[2] ?? 0,
    macro3: s.macros[3] ?? 0,
    macro4: s.macros[4] ?? 0,
    macro5: s.macros[5] ?? 0,
    macro6: s.macros[6] ?? 0,
    macro7: s.macros[7] ?? 0,

    filterA_type: filterTypeIndex(s.filterA.type),
    filterA_cutoff: s.filterA.cutoffHz,
    filterA_q: s.filterA.resonance,
    filterA_slope: Number(s.filterA.slope),
    filterB_type: filterTypeIndex(s.filterB.type),
    filterB_cutoff: s.filterB.cutoffHz,
    filterB_q: s.filterB.resonance,
    filterB_slope: Number(s.filterB.slope),

    fx_delay_on: s.fx.delay.enabled ? 1 : 0,
    fx_delay_time: s.fx.delay.timeMs,
    fx_delay_fb: s.fx.delay.feedback,
    fx_delay_tone: s.fx.delay.tone,
    fx_delay_locut: s.fx.delay.locut,
    fx_delay_mod: s.fx.delay.mod,
    fx_delay_rate: s.fx.delay.rate,
    fx_delay_width: s.fx.delay.width,
    fx_delay_diff: s.fx.delay.diffusion,
    fx_delay_mix: s.fx.delay.mix,
    fx_reverb_on: s.fx.reverb.enabled ? 1 : 0,
    fx_reverb_size: s.fx.reverb.size,
    fx_reverb_decay: s.fx.reverb.decay,
    fx_reverb_damp: s.fx.reverb.damp,
    fx_reverb_locut: s.fx.reverb.locut,
    fx_reverb_mod: s.fx.reverb.mod,
    fx_reverb_rate: s.fx.reverb.rate,
    fx_reverb_width: s.fx.reverb.width,
    fx_reverb_diff: s.fx.reverb.diffusion,
    fx_reverb_mix: s.fx.reverb.mix,
    fx_dist_on: s.fx.distortion.enabled ? 1 : 0,
    fx_dist_drive: s.fx.distortion.drive,
    fx_dist_tone: s.fx.distortion.tone,
    fx_dist_mix: s.fx.distortion.mix,
    fx_chorus_on: s.fx.chorus.enabled ? 1 : 0,
    fx_chorus_rate: s.fx.chorus.rate,
    fx_chorus_depth: s.fx.chorus.depth,
    fx_chorus_width: s.fx.chorus.width,
    fx_chorus_mix: s.fx.chorus.mix,
    fx_flanger_on: s.fx.flanger.enabled ? 1 : 0,
    fx_flanger_rate: s.fx.flanger.rate,
    fx_flanger_depth: s.fx.flanger.depth,
    fx_flanger_fb: s.fx.flanger.feedback,
    fx_flanger_width: s.fx.flanger.width,
    fx_flanger_mix: s.fx.flanger.mix,
    fx_comp_on: s.fx.compressor.enabled ? 1 : 0,
    fx_comp_lowfreq: s.fx.compressor.lowFreq,
    fx_comp_highfreq: s.fx.compressor.highFreq,
    fx_comp_low_floor: s.fx.compressor.lowFloorDb,
    fx_comp_low_ceil: s.fx.compressor.lowCeilingDb,
    fx_comp_low_amt: s.fx.compressor.lowAmount,
    fx_comp_low_atk: s.fx.compressor.lowAttackMs,
    fx_comp_low_rel: s.fx.compressor.lowReleaseMs,
    fx_comp_mid_floor: s.fx.compressor.midFloorDb,
    fx_comp_mid_ceil: s.fx.compressor.midCeilingDb,
    fx_comp_mid_amt: s.fx.compressor.midAmount,
    fx_comp_mid_atk: s.fx.compressor.midAttackMs,
    fx_comp_mid_rel: s.fx.compressor.midReleaseMs,
    fx_comp_high_floor: s.fx.compressor.highFloorDb,
    fx_comp_high_ceil: s.fx.compressor.highCeilingDb,
    fx_comp_high_amt: s.fx.compressor.highAmount,
    fx_comp_high_atk: s.fx.compressor.highAttackMs,
    fx_comp_high_rel: s.fx.compressor.highReleaseMs,
    fx_comp_drive: s.fx.compressor.drive,
    fx_comp_crush: s.fx.compressor.crush,
    fx_comp_gain: s.fx.compressor.gain,
    fx_comp_mix: s.fx.compressor.mix,
    fx_phaser_on: s.fx.phaser.enabled ? 1 : 0,
    fx_phaser_rate: s.fx.phaser.rate,
    fx_phaser_depth: s.fx.phaser.depth,
    fx_phaser_fb: s.fx.phaser.feedback,
    fx_phaser_stages: s.fx.phaser.stages,
    fx_phaser_mix: s.fx.phaser.mix,
    fx_eq_on: s.fx.eq.enabled ? 1 : 0,
    fx_eq_mix: s.fx.eq.mix,
    // LOSSY: `fx_eq_low/mid/high` (manifest.json) are dead flat params now —
    // the EQ is a real variable-band parametric design (todo.md), and band
    // data (freq/gain/Q per band, arbitrary count) doesn't fit a fixed
    // scalar param the way a 3-knob EQ did. `bands` travels over the same
    // custom bridge channel `lfoN_functionShape` uses (`setEqBands`,
    // useBridgeSynth.ts) instead of the flat param map. Left the 3 old
    // native params declared-but-unread rather than renumbering everything
    // downstream of them in manifest.json/PluginProcessor for a pre-release
    // spike with no presets to preserve compatibility for.
  };

  // Master FX chain order (todo.md §113) — NUM_FX_SLOTS flat slot-type params.
  for (let n = 0; n < NUM_FX_SLOTS; n += 1) {
    f[`fxslot${n}_type`] = fxChainTypeIndex(s.fx.chain[n] ?? 'off');
  }

  s.oscillators.forEach((op, k) => {
    // Sample mode (todo.md §114) is index 4, real wavetable synthesis
    // (Task 4, multi-agent work order) is index 5 — both discrete jumps off
    // the 0..3 wavetable-morph snap, same precedent as lfo{n}_wave's own
    // 4=sample-hold.
    f[`op${k}_wave`] = op.wave === 'sample' ? 4
      : op.wave === 'wavetable' ? 5
      : wavePosToIndex(op.wavetablePosition); // LOSSY (snap)
    f[`op${k}_roothz`] = op.rootHz;
    f[`op${k}_wtid`] = op.wtId ?? 0;
    f[`op${k}_wtpos`] = op.wtPos ?? 0;
    f[`op${k}_warpmode`] = op.warpMode ?? 0;
    f[`op${k}_warpamount`] = op.warpAmount ?? 0;
    f[`op${k}_warpparam2`] = op.warpParam2 ?? 0.5;
    f[`op${k}_warpmode2`] = op.warpMode2 ?? 0;
    f[`op${k}_warpamount2`] = op.warpAmount2 ?? 0;
    f[`op${k}_warpparam2_2`] = op.warpParam2_2 ?? 0.5;
    f[`op${k}_loop`] = op.sampleLoop ? 1 : 0;
    f[`op${k}_start`] = op.sampleStart ?? 0;
    f[`op${k}_end`] = op.sampleEnd ?? 1;
    f[`op${k}_reverse`] = op.sampleReverse ? 1 : 0;
    f[`op${k}_level`] = op.enabled ? op.level : 0; // LOSSY: disabled -> silent
    f[`op${k}_pan`] = op.pan;
    f[`op${k}_semis`] = op.pitch;
    f[`op${k}_fmix`] = op.filterMix;
    OP_IDS.forEach((srcId, srcK) => {
      if (srcK === k) return;
      const entry = op.mods?.[srcId];
      f[`op${k}_pm${srcK}`] = entry?.pm ?? 0;
      f[`op${k}_fm${srcK}`] = entry?.fm ?? 0;
    });
  });

  // Arp pattern + Chaos are the only two arp values that are HOST PARAMS; the
  // rest of the arp config travels as JSON through setArpConfig. The pattern is
  // carried as a 0..1 selector position (ArpEngine derives the mode index from
  // it), which is what makes the slider, the pattern grid and automation one
  // value instead of three that can drift apart.
  f.arp_pattern = arpModeToPos(s.arp.mode);
  f.arp_chaos = s.arp.generation.chaosAmount;

  // mod matrix (mod{n}_src/dst/amt) — the Pigments per-knob ModMap flattened
  // into the DSP's 8 fixed slots (todo.md §75).
  const slots = modToSlots(s.mod);
  for (let n = 0; n < NUM_MOD_SLOTS; n += 1) {
    const sl = slots[n];
    f[`mod${n}_src`] = sl ? sl.src : 0;
    f[`mod${n}_dst`] = sl ? sl.dst : 0;
    f[`mod${n}_amt`] = sl ? sl.amt : 0;
  }

  return f;
}

// --------------------------------------------------------------------------
// flat params -> SynthSettings  (host automation / preset recall reflection)
// `base` supplies everything the flat map doesn't carry losslessly.
// --------------------------------------------------------------------------
export function flatToSynth(
  f: FlatParams,
  base: SynthSettings,
  // Rebuild `mod` from the 8 DSP slots? Only when the incoming flat map
  // actually carries a *changed* matrix param (preset recall, mod automation)
  // — see the caller. On a plain knob echo this stays false so UI-only routes
  // (targets the DSP can't express: per-source PM/FM depth, lfo*Shape…) aren't
  // silently wiped every time you nudge an unrelated knob.
  mergeMod = true,
): SynthSettings {
  const num = (k: string, fallback: number) => (typeof f[k] === 'number' ? f[k] : fallback);

  const oscillators: OscillatorSlotSettings[] = base.oscillators.map((op, k) => {
    const wi = num(`op${k}_wave`, op.wave === 'sample' ? 4 : op.wave === 'wavetable' ? 5 : wavePosToIndex(op.wavetablePosition));
    const wiR = Math.round(wi);
    // Sample mode (todo.md §114) is index 4, real wavetable synthesis
    // (Task 4) is index 5 — both discrete jumps, not part of the 0..3
    // wavetable-morph range. `WAVE_MORPH_SHAPES[4/5]` is out of bounds
    // (undefined) by design; keep `wavetablePosition` at whatever it last
    // was rather than storing a meaningless `waveIndexToPos(4/5)` (>1) —
    // the interface's own doc comment says the field is unused there anyway.
    const isSample = wiR === 4;
    const isWavetable = wiR === 5;
    const mods = { ...op.mods };
    OP_IDS.forEach((srcId, srcK) => {
      if (srcK === k) return;
      const pm = num(`op${k}_pm${srcK}`, mods[srcId]?.pm ?? 0);
      const fm = num(`op${k}_fm${srcK}`, mods[srcId]?.fm ?? 0);
      if (pm > 0 || fm > 0) mods[srcId] = { pm, fm };
      else delete mods[srcId];
    });
    return {
      ...op,
      wave: isSample ? 'sample' : isWavetable ? 'wavetable' : (WAVE_MORPH_SHAPES[wiR] ?? op.wave),
      wavetablePosition: (isSample || isWavetable) ? op.wavetablePosition : waveIndexToPos(wi),
      wtId: num(`op${k}_wtid`, op.wtId ?? 0),
      wtPos: num(`op${k}_wtpos`, op.wtPos ?? 0),
      warpMode: Math.round(num(`op${k}_warpmode`, op.warpMode ?? 0)),
      warpAmount: num(`op${k}_warpamount`, op.warpAmount ?? 0),
      warpParam2: num(`op${k}_warpparam2`, op.warpParam2 ?? 0.5),
      warpMode2: Math.round(num(`op${k}_warpmode2`, op.warpMode2 ?? 0)),
      warpAmount2: num(`op${k}_warpamount2`, op.warpAmount2 ?? 0),
      warpParam2_2: num(`op${k}_warpparam2_2`, op.warpParam2_2 ?? 0.5),
      sampleLoop: num(`op${k}_loop`, op.sampleLoop ? 1 : 0) > 0.5,
      sampleStart: num(`op${k}_start`, op.sampleStart ?? 0),
      sampleEnd: num(`op${k}_end`, op.sampleEnd ?? 1),
      sampleReverse: num(`op${k}_reverse`, op.sampleReverse ? 1 : 0) > 0.5,
      rootHz: num(`op${k}_roothz`, op.rootHz),
      level: num(`op${k}_level`, op.level),
      pan: num(`op${k}_pan`, op.pan),
      pitch: num(`op${k}_semis`, op.pitch),
      filterMix: num(`op${k}_fmix`, op.filterMix),
      mods,
    };
  });

  return {
    ...base,
    octave: num('octave', base.octave),
    semitone: num('semitone', base.semitone),
    fineTuneCents: num('fineCents', base.fineTuneCents),
    voiceMode: Math.round(num('voice_mode', base.voiceMode)),
    glideSec: num('glide', base.glideSec),
    masterLevel: num('master', base.masterLevel),
    ampEnv: {
      ...base.ampEnv,
      attackSec: num('env_a', base.ampEnv.attackSec),
      decaySec: num('env_d', base.ampEnv.decaySec),
      sustainLevel: num('env_s', base.ampEnv.sustainLevel),
      releaseSec: num('env_r', base.ampEnv.releaseSec),
    },
    modEnv: {
      ...base.modEnv,
      attackSec: num('env2_a', base.modEnv.attackSec),
      decaySec: num('env2_d', base.modEnv.decaySec),
      sustainLevel: num('env2_s', base.modEnv.sustainLevel),
      releaseSec: num('env2_r', base.modEnv.releaseSec),
    },
    modEnv3: {
      ...base.modEnv3,
      attackSec: num('env3_a', base.modEnv3.attackSec),
      decaySec: num('env3_d', base.modEnv3.decaySec),
      sustainLevel: num('env3_s', base.modEnv3.sustainLevel),
      releaseSec: num('env3_r', base.modEnv3.releaseSec),
    },
    lfo1: lfoFromFlat(f, base.lfo1, 'lfo1'),
    lfo2: lfoFromFlat(f, base.lfo2, 'lfo2'),
    lfo3: lfoFromFlat(f, base.lfo3, 'lfo3'),
    velCurve: num('vel_curve', base.velCurve),
    keyCurve: num('key_curve', base.keyCurve),
    macros: Array.from({ length: 8 }, (_, i) => num(`macro${i}`, base.macros[i] ?? 0)),
    modules: modulesFromFlat(f, base.modules),
    filterA: {
      ...base.filterA,
      type: filterTypeFromIndex(num('filterA_type', filterTypeIndex(base.filterA.type))),
      cutoffHz: num('filterA_cutoff', base.filterA.cutoffHz),
      resonance: num('filterA_q', base.filterA.resonance),
      slope: (String(Math.round(num('filterA_slope', Number(base.filterA.slope)))) as '12' | '24'),
    },
    filterB: {
      ...base.filterB,
      type: filterTypeFromIndex(num('filterB_type', filterTypeIndex(base.filterB.type))),
      cutoffHz: num('filterB_cutoff', base.filterB.cutoffHz),
      resonance: num('filterB_q', base.filterB.resonance),
      slope: (String(Math.round(num('filterB_slope', Number(base.filterB.slope)))) as '12' | '24'),
    },
    fx: {
      chain: Array.from({ length: NUM_FX_SLOTS }, (_, n) =>
        fxChainTypeFromIndex(num(`fxslot${n}_type`, fxChainTypeIndex(base.fx.chain[n] ?? 'off')))),
      delay: {
        enabled: num('fx_delay_on', base.fx.delay.enabled ? 1 : 0) > 0.5,
        timeMs: num('fx_delay_time', base.fx.delay.timeMs),
        feedback: num('fx_delay_fb', base.fx.delay.feedback),
        tone: num('fx_delay_tone', base.fx.delay.tone),
        locut: num('fx_delay_locut', base.fx.delay.locut),
        mod: num('fx_delay_mod', base.fx.delay.mod),
        rate: num('fx_delay_rate', base.fx.delay.rate),
        width: num('fx_delay_width', base.fx.delay.width),
        diffusion: num('fx_delay_diff', base.fx.delay.diffusion),
        mix: num('fx_delay_mix', base.fx.delay.mix),
      },
      reverb: {
        enabled: num('fx_reverb_on', base.fx.reverb.enabled ? 1 : 0) > 0.5,
        size: num('fx_reverb_size', base.fx.reverb.size),
        decay: num('fx_reverb_decay', base.fx.reverb.decay),
        damp: num('fx_reverb_damp', base.fx.reverb.damp),
        locut: num('fx_reverb_locut', base.fx.reverb.locut),
        mod: num('fx_reverb_mod', base.fx.reverb.mod),
        rate: num('fx_reverb_rate', base.fx.reverb.rate),
        width: num('fx_reverb_width', base.fx.reverb.width),
        diffusion: num('fx_reverb_diff', base.fx.reverb.diffusion),
        mix: num('fx_reverb_mix', base.fx.reverb.mix),
      },
      distortion: {
        enabled: num('fx_dist_on', base.fx.distortion.enabled ? 1 : 0) > 0.5,
        drive: num('fx_dist_drive', base.fx.distortion.drive),
        tone: num('fx_dist_tone', base.fx.distortion.tone),
        mix: num('fx_dist_mix', base.fx.distortion.mix),
      },
      chorus: {
        enabled: num('fx_chorus_on', base.fx.chorus.enabled ? 1 : 0) > 0.5,
        rate: num('fx_chorus_rate', base.fx.chorus.rate),
        depth: num('fx_chorus_depth', base.fx.chorus.depth),
        width: num('fx_chorus_width', base.fx.chorus.width),
        mix: num('fx_chorus_mix', base.fx.chorus.mix),
      },
      flanger: {
        enabled: num('fx_flanger_on', base.fx.flanger.enabled ? 1 : 0) > 0.5,
        rate: num('fx_flanger_rate', base.fx.flanger.rate),
        depth: num('fx_flanger_depth', base.fx.flanger.depth),
        feedback: num('fx_flanger_fb', base.fx.flanger.feedback),
        width: num('fx_flanger_width', base.fx.flanger.width),
        mix: num('fx_flanger_mix', base.fx.flanger.mix),
      },
      compressor: {
        enabled: num('fx_comp_on', base.fx.compressor.enabled ? 1 : 0) > 0.5,
        lowFreq: num('fx_comp_lowfreq', base.fx.compressor.lowFreq),
        highFreq: num('fx_comp_highfreq', base.fx.compressor.highFreq),

        lowFloorDb: num('fx_comp_low_floor', base.fx.compressor.lowFloorDb),
        lowCeilingDb: num('fx_comp_low_ceil', base.fx.compressor.lowCeilingDb),
        lowAmount: num('fx_comp_low_amt', base.fx.compressor.lowAmount),
        lowAttackMs: num('fx_comp_low_atk', base.fx.compressor.lowAttackMs),
        lowReleaseMs: num('fx_comp_low_rel', base.fx.compressor.lowReleaseMs),

        midFloorDb: num('fx_comp_mid_floor', base.fx.compressor.midFloorDb),
        midCeilingDb: num('fx_comp_mid_ceil', base.fx.compressor.midCeilingDb),
        midAmount: num('fx_comp_mid_amt', base.fx.compressor.midAmount),
        midAttackMs: num('fx_comp_mid_atk', base.fx.compressor.midAttackMs),
        midReleaseMs: num('fx_comp_mid_rel', base.fx.compressor.midReleaseMs),

        highFloorDb: num('fx_comp_high_floor', base.fx.compressor.highFloorDb),
        highCeilingDb: num('fx_comp_high_ceil', base.fx.compressor.highCeilingDb),
        highAmount: num('fx_comp_high_amt', base.fx.compressor.highAmount),
        highAttackMs: num('fx_comp_high_atk', base.fx.compressor.highAttackMs),
        highReleaseMs: num('fx_comp_high_rel', base.fx.compressor.highReleaseMs),

        drive: num('fx_comp_drive', base.fx.compressor.drive),
        crush: num('fx_comp_crush', base.fx.compressor.crush),
        gain: num('fx_comp_gain', base.fx.compressor.gain),
        mix: num('fx_comp_mix', base.fx.compressor.mix),
      },
      phaser: {
        enabled: num('fx_phaser_on', base.fx.phaser.enabled ? 1 : 0) > 0.5,
        rate: num('fx_phaser_rate', base.fx.phaser.rate),
        depth: num('fx_phaser_depth', base.fx.phaser.depth),
        feedback: num('fx_phaser_fb', base.fx.phaser.feedback),
        stages: num('fx_phaser_stages', base.fx.phaser.stages),
        mix: num('fx_phaser_mix', base.fx.phaser.mix),
      },
      eq: {
        enabled: num('fx_eq_on', base.fx.eq.enabled ? 1 : 0) > 0.5,
        mix: num('fx_eq_mix', base.fx.eq.mix),
        // `bands` isn't a flat param (see the LOSSY note in synthToFlat) —
        // carried through from `base`, same pattern `lfoFromFlat` uses for
        // `functionShape`.
        bands: base.fx.eq.bands,
      },
    },
    mod: (mergeMod && 'mod0_dst' in f) ? slotsToMod(f) : base.mod,
    // Reflect the two arp HOST PARAMS back into the settings, so host automation
    // of the pattern selector or Chaos moves the UI. Everything else about the
    // arp is carried through from `base` — it travels as JSON, not flat params.
    arp: {
      ...base.arp,
      mode: 'arp_pattern' in f ? arpPosToMode(num('arp_pattern', arpModeToPos(base.arp.mode))) : base.arp.mode,
      generation: {
        ...base.arp.generation,
        chaosAmount: num('arp_chaos', base.arp.generation.chaosAmount),
      },
    },
    oscillators,
  };
}

/** Diff two flat maps — the keys whose value changed (for minimal param writes). */
export function changedKeys(a: FlatParams, b: FlatParams): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) if (a[k] !== b[k]) out.push(k);
  return out;
}
