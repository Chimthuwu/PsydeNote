import type { ModMap, ModRoute, ModSourceId, ModTargetId, ModuleId, ModuleSet } from '../../shared/types';
import { OPERATOR_IDS } from '../../shared/types';
import { OPERATOR_LABELS } from './operator-colors';

/**
 * Metadata for the Pigments-style modulation system.
 *
 * Source colours are FIXED identity colours (like Bitwig Phase-4 / Arturia
 * Pigments source lanes) — they are deliberately NOT theme tokens. They
 * exist so a modulated knob's dot, its popover row and its envelope graph
 * all share one colour you can learn once. Everything else in the synth UI
 * stays token-driven.
 *
 * New sources (LFOs, velocity, random…) add an entry here and to the
 * `ModSourceId` union in shared/types.ts. New modulatable targets add an
 * entry to `MOD_TARGETS` below, plus `SynthEngine.resolveTargetParam` and
 * `MOD_ROUTE_RANGES` in lib/synth.ts.
 */
export const MOD_SOURCES: Record<
  ModSourceId,
  { short: string; label: string; color: string }
> = {
  // Source identity colours — user's scheme (todo.md §87, "subject to change").
  // ENV n = white/yellow family, LFO n = neon lime, S&H = neon pink,
  // Velocity = orange, Keyboard = blue.
  env1: { short: 'ENV 1', label: 'Envelope 1 · Amp', color: '#ffffff' },
  env2: { short: 'ENV 2', label: 'Envelope 2 · Mod', color: '#facc15' },
  env3: { short: 'ENV 3', label: 'Envelope 3 · Mod', color: '#facc15' },
  lfo1: { short: 'LFO 1', label: 'LFO 1', color: '#a3e635' },
  lfo2: { short: 'LFO 2', label: 'LFO 2', color: '#a3e635' },
  lfo3: { short: 'LFO 3', label: 'LFO 3', color: '#a3e635' },
  velocity: { short: 'Velo', label: 'Velocity', color: '#fb923c' },
  // Was blue (#3b82f6) — changed per user's mockup: this magenta/fuchsia is
  // the colour the future macro section will use too (todo.md §98/§99).
  keytrack: { short: 'Key', label: 'Keyboard', color: '#d946ef' },
  // Macros (todo.md §111) — violet/fuchsia family per the note above, one
  // shade per knob so all 8 stay individually distinguishable as cable-drag
  // sources (unlike env2/env3 or the 3 LFOs, which deliberately share one
  // family colour).
  macro1: { short: 'M1', label: 'Macro 1', color: '#c4b5fd' },
  macro2: { short: 'M2', label: 'Macro 2', color: '#a78bfa' },
  macro3: { short: 'M3', label: 'Macro 3', color: '#8b5cf6' },
  macro4: { short: 'M4', label: 'Macro 4', color: '#7c3aed' },
  macro5: { short: 'M5', label: 'Macro 5', color: '#d8b4fe' },
  macro6: { short: 'M6', label: 'Macro 6', color: '#c084fc' },
  macro7: { short: 'M7', label: 'Macro 7', color: '#e879f9' },
  macro8: { short: 'M8', label: 'Macro 8', color: '#f0abfc' },
  // Optional modulators added with the "+" tile (mockup: purple Audio
  // Follower, yellow ENV 4/5, lime LFO 4/5).
  audiofollower: { short: 'AF', label: 'Audio Follower', color: '#a855f7' },
  env4: { short: 'ENV 4', label: 'Envelope 4 · Mod', color: '#facc15' },
  env5: { short: 'ENV 5', label: 'Envelope 5 · Mod', color: '#facc15' },
  lfo4: { short: 'LFO 4', label: 'LFO 4', color: '#a3e635' },
  lfo5: { short: 'LFO 5', label: 'LFO 5', color: '#a3e635' },
  lfo6: { short: 'LFO 6', label: 'LFO 6', color: '#a3e635' },
  env6: { short: 'ENV 6', label: 'Envelope 6 · Mod', color: '#facc15' },
  env7: { short: 'ENV 7', label: 'Envelope 7 · Mod', color: '#facc15' },
  env8: { short: 'ENV 8', label: 'Envelope 8 · Mod', color: '#facc15' },
  lfo7: { short: 'LFO 7', label: 'LFO 7', color: '#a3e635' },
  lfo8: { short: 'LFO 8', label: 'LFO 8', color: '#a3e635' },
  audiofollower2: { short: 'AF 2', label: 'Audio Follower 2', color: '#c084fc' },
  audiofollower3: { short: 'AF 3', label: 'Audio Follower 3', color: '#d8b4fe' },
  audiofollower4: { short: 'AF 4', label: 'Audio Follower 4', color: '#e9d5ff' },
  env9: { short: 'ENV 9', label: 'Envelope 9 · Mod', color: '#facc15' },
  env10: { short: 'ENV 10', label: 'Envelope 10 · Mod', color: '#facc15' },
  env11: { short: 'ENV 11', label: 'Envelope 11 · Mod', color: '#facc15' },
  lfo9: { short: 'LFO 9', label: 'LFO 9', color: '#a3e635' },
  lfo10: { short: 'LFO 10', label: 'LFO 10', color: '#a3e635' },
  audiofollower5: { short: 'AF 5', label: 'Audio Follower 5', color: '#a855f7' },
  audiofollower6: { short: 'AF 6', label: 'Audio Follower 6', color: '#c084fc' },
  audiofollower7: { short: 'AF 7', label: 'Audio Follower 7', color: '#d8b4fe' },
  audiofollower8: { short: 'AF 8', label: 'Audio Follower 8', color: '#e9d5ff' },
  audiofollower9: { short: 'AF 9', label: 'Audio Follower 9', color: '#b57bee' },
  audiofollower10: { short: 'AF 10', label: 'Audio Follower 10', color: '#9333ea' },
};

/** The sources that only exist while their module has been added ("+" tile). */
export const MODULE_SOURCE_IDS: ModSourceId[] = [
  'env2', 'env3', 'lfo1', 'lfo2', 'lfo3',
  'audiofollower', 'audiofollower2', 'audiofollower3', 'audiofollower4', 'audiofollower5',
  'audiofollower6', 'audiofollower7', 'audiofollower8', 'audiofollower9', 'audiofollower10',
  'env4', 'env5', 'env6', 'env7', 'env8', 'env9', 'env10', 'env11',
  'lfo4', 'lfo5', 'lfo6', 'lfo7', 'lfo8', 'lfo9', 'lfo10',
];

// Which optional modules the current patch has added. Module-level (one synth
// per plugin UI) so every popover/cable menu can hide sources whose module is
// absent without threading a prop through ~10 call sites.
let activeModules = new Set<ModSourceId>();
export function setActiveModules(ids: Iterable<ModSourceId>) { activeModules = new Set(ids); }
/** The mod source a module id feeds ('audioFollower' is the only renamed one). */
export const moduleSourceId = (id: ModuleId): ModSourceId => id.replace('audioFollower', 'audiofollower') as ModSourceId;
/** Every source that has at least one non-zero route. */
export function routedSources(mod: ModMap | undefined): Set<ModSourceId> {
  const out = new Set<ModSourceId>();
  for (const routes of Object.values(mod ?? {})) for (const r of routes ?? []) if (r.amount !== 0) out.add(r.source);
  return out;
}
/** The optional sources present in a patch: added modules + anything routed. */
export function presentSources(modules: ModuleSet | undefined, mod: ModMap | undefined): ModSourceId[] {
  const routed = routedSources(mod);
  const ids = (Object.keys(modules ?? {}) as ModuleId[]).map(moduleSourceId);
  return MODULE_SOURCE_IDS.filter((id) => ids.includes(id) || routed.has(id));
}
/** Built-in sources are always available; optional ones only while added. */
export const isSourceAvailable = (id: ModSourceId) => !MODULE_SOURCE_IDS.includes(id) || activeModules.has(id);

/** Every source (used by most targets). `ALL_SOURCES` includes ENV 1; some
 *  targets (level) exclude it because ENV 1 is already the amp contour. Also
 *  the canonical draw order for the mod-source overview row (todo.md §91/92
 *  Pigments overhaul). */
export const MACRO_IDS: ModSourceId[] = ['macro1', 'macro2', 'macro3', 'macro4', 'macro5', 'macro6', 'macro7', 'macro8'];
/** The original 8 sources, no macros — the header's compact overview-row
 *  dots (todo.md §111: macros get their own knobs instead, further right). */
export const OVERVIEW_SOURCES: ModSourceId[] = ['env1', 'env2', 'env3', 'lfo1', 'lfo2', 'lfo3', 'velocity', 'keytrack'];
export const ALL_SOURCES: ModSourceId[] = [...new Set<ModSourceId>([...OVERVIEW_SOURCES, ...MACRO_IDS, ...MODULE_SOURCE_IDS])];
const NON_AMP_SOURCES: ModSourceId[] = [...new Set<ModSourceId>(['env2', 'env3', 'lfo1', 'lfo2', 'lfo3', 'velocity', 'keytrack', ...MACRO_IDS, ...MODULE_SOURCE_IDS])];

export interface ModTargetMeta {
  /** Human name shown in the popover header. */
  label: string;
  /** Amount range in the target's native unit (cents, 0..1 scale…). */
  min: number;
  max: number;
  /** Amount change per vertical pixel of drag. */
  sensitivity: number;
  /** Amount added when a source row is clicked without dragging. */
  defaultAmount: number;
  format: (v: number) => string;
  /**
   * Sources offered for this target. env1 is excluded from oscLevel — it
   * IS the amp envelope (pre-wired to level), so routing it again would
   * double the contour.
   */
  sources: ModSourceId[];
}

/**
 * Every modulation AMOUNT reads as a percentage of the target's own range,
 * regardless of native unit (todo.md — user: "I think it's best to have
 * modulation values as percentages rather than having different values
 * based on whatever is being modulated... a hundred percent modulation
 * would be the parameter's max value"). This is the mod-POPOVER's amount
 * display only — a knob's own plain VALUE (Pan's L/R readout, Filter
 * cutoff's Hz readout, etc.) is a completely separate formatter elsewhere
 * and is unaffected. `min`/`max`/`sensitivity` (the actual DSP-space
 * amount and drag physics) don't change at all, just this label.
 */
const pct = (max: number) => (v: number) => `${v >= 0 ? '+' : ''}${Math.round((v / max) * 100)}%`;
/** Pitch is the one target kept in its native unit (todo.md — user's own
 *  follow-up: cents/semitones are more musically meaningful here than a
 *  percentage — "100ct 200ct 300ct", not "+4%"). Paired with quantized
 *  stepping in `stepModAmount` below. */
const centsFormat = (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v)} ct`;

/** Pitch-family targets: default modulation is in the target's native unit
 *  with amount SNAPPED to a musically-meaningful grid, rather than the
 *  generic fraction-of-range step every other target uses (todo.md — user:
 *  "I would appreciate if it was just going up by the semitone, meaning
 *  100ct 200ct 300ct... hold shift [for] twelve [semitones]... holding
 *  ctrl... in between cts... ctrl+alt... even more finite"). Default step
 *  100ct (1 semitone); Shift = 1200ct (1 octave); Ctrl = 10ct; Ctrl+Alt =
 *  1ct. Every other target keeps the old fraction-of-range/sensitivity
 *  scroll step. */
const PITCH_MOD_TARGETS = new Set<string>(['pitch', 'osc1Pitch', 'osc2Pitch', 'osc3Pitch', 'osc4Pitch']);
export function isPitchModTarget(targetId: ModTargetId): boolean {
  return PITCH_MOD_TARGETS.has(targetId);
}
/**
 * One shared scroll-step formula for every "scroll to adjust a mod amount"
 * call site (useCableDrag's audition mode, useModHoverEdit's plain hover,
 * ModPopover's rows, SourceRoutesPopover's rows) — previously duplicated
 * (and drifting) in all four. `deltaY` is the raw wheel event's deltaY;
 * negative = scrolled up (increase).
 */
export function stepModAmount(
  targetId: ModTargetId,
  current: number,
  deltaY: number,
  mods: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean },
): number {
  const meta = MOD_TARGETS[targetId];
  const dir = deltaY < 0 ? 1 : -1;
  if (isPitchModTarget(targetId)) {
    const step = mods.ctrlKey && mods.altKey ? 1 : mods.ctrlKey ? 10 : mods.shiftKey ? 1200 : 100;
    // Snap to the step's own grid (not just "current + step") so scrolling
    // always lands on a clean multiple, regardless of where `current`
    // started (e.g. a value left over from a finer-grained adjustment).
    const grid = dir > 0 ? Math.floor(current / step) * step + step : Math.ceil(current / step) * step - step;
    return Math.max(meta.min, Math.min(meta.max, grid));
  }
  const unit = mods.shiftKey ? meta.sensitivity * 3 : (meta.max - meta.min) / 40;
  return Math.max(meta.min, Math.min(meta.max, current + dir * unit));
}

/**
 * Modulatable-target metadata, built for every target id in `ModTargetId`:
 * the two global targets (pitch / oscLevel) plus a per-operator level / pan /
 * FM-PM-depth trio. This is the single source the ModPopover and the
 * cable-drop both read, so a new target is one entry here + one in
 * `SynthEngine.resolveTargetParam`/`MOD_ROUTE_RANGES`.
 */
export const MOD_TARGETS: Record<ModTargetId, ModTargetMeta> = (() => {
  const out: Record<string, ModTargetMeta> = {
    pitch: {
      label: 'Pitch',
      min: -2400,
      max: 2400,
      sensitivity: 4,
      defaultAmount: 100,
      format: centsFormat,
      sources: ALL_SOURCES,
    },
    oscLevel: {
      label: 'Level',
      min: -1,
      max: 1,
      sensitivity: 0.004,
      defaultAmount: 0.25,
      format: pct(1),
      sources: NON_AMP_SOURCES,
    },
    // Dual filters (todo.md §60, was Phase 4's single filter). No dedicated
    // "filter envelope" exists; ENV 2 (the free mod envelope) IS the filter
    // envelope once you route it here, same as it's the pitch/level
    // envelope elsewhere. `keytrack` is offered too — that's each filter's
    // "keytrack knob", no bespoke control needed (todo.md §22.4-style reuse).
    // Octaves, not Hz (todo.md — bug: this used to advertise "+10000 Hz" but
    // dsp/synth.js's filterParams() has always applied it as `fc·2^amt` — a
    // multiplicative OCTAVE shift, not an additive Hz offset. Since dspSpan
    // (translate.ts) normalizes against this target's own `max`, the label
    // was lying about the unit but the actual depth was also capped at
    // whatever `max` implied in DSP terms (±1 octave when max was 10000) —
    // reported as "seems to only modulate up to 10khz" (a wide-open 20kHz
    // default cutoff, dropped by exactly 1 octave at full negative amount,
    // lands at exactly 10000 Hz). Now honestly labeled in octaves, and
    // widened to ±4 (a full, useful sweep) since the old ±1-octave ceiling
    // was itself an accident of the mislabeled range, not a deliberate
    // depth choice.
    filterACutoff: {
      label: 'Filter A cutoff',
      // SS162: OCTAVES. Widened from ±4 to ±10. The cutoff knob spans
      // 20 Hz..20000 Hz (~10 octaves), so ±4 could only cover ~40% of the
      // knob's range from the default 20000 Hz base — -4 octaves lands at
      // 1250 Hz and the sweep stops far above the floor, so the user could not
      // "modulate the whole way using an LFO" however hard they dialled.
      // ±10 covers the knob end-to-end from ANY base (20 Hz +10 -> 20 kHz,
      // 20 kHz -10 -> 20 Hz). The DSP clamps the result to 20..20000 so the
      // value can never leave the knob's own range (dsp/synth.js filterParams).
      min: -10,
      max: 10,
      sensitivity: 0.016,
      defaultAmount: 0.8,
            // SS164: `pct(4)` rendered the amount as v/4*100, but SS162 widened the
      // range to +/-10 -- so the knob topped out reading "+250%" while actually
      // being AT its maximum. The user read that as the range stopping there
      // and asked for 500% ("Maybe if we turn that 250% value to like 500%
      // maybe it will be close but it goes about half way"), which would have
      // meant ~20 octaves, nearly double the cutoff knob's own ~10-octave span.
      // Dividing by the real max restores 100% = full deflection.
      format: pct(10),
      sources: ALL_SOURCES,
    },
    filterAResonance: {
      label: 'Filter A resonance',
      min: -20,
      max: 20,
      sensitivity: 0.08,
      defaultAmount: 4,
      format: pct(20),
      sources: ALL_SOURCES,
    },
    filterBCutoff: {
      label: 'Filter B cutoff',
      // SS162: same ±10 octaves as Filter A cutoff above.
      min: -10,
      max: 10,
      sensitivity: 0.016,
      defaultAmount: 0.8,
            // SS164: `pct(4)` rendered the amount as v/4*100, but SS162 widened the
      // range to +/-10 -- so the knob topped out reading "+250%" while actually
      // being AT its maximum. The user read that as the range stopping there
      // and asked for 500% ("Maybe if we turn that 250% value to like 500%
      // maybe it will be close but it goes about half way"), which would have
      // meant ~20 octaves, nearly double the cutoff knob's own ~10-octave span.
      // Dividing by the real max restores 100% = full deflection.
      format: pct(10),
      sources: ALL_SOURCES,
    },
    filterBResonance: {
      label: 'Filter B resonance',
      min: -20,
      max: 20,
      sensitivity: 0.08,
      defaultAmount: 4,
      format: pct(20),
      sources: ALL_SOURCES,
    },
    // LFO 1/2 rate + shape are modulatable (todo.md §66). Rate is additive
    // Hz into the LFO node's frequency; shape is an additive 0..1 morph
    // position resolved at control-rate. An LFO can drive the OTHER LFO's
    // rate/shape but not its own (that's filtered in the UI).
    lfo1Rate: {
      label: 'LFO 1 rate',
      min: -30, max: 30, sensitivity: 0.12, defaultAmount: 4,
      format: pct(30),
      sources: ALL_SOURCES,
    },
    lfo1Shape: {
      label: 'LFO 1 shape',
      min: -1, max: 1, sensitivity: 0.004, defaultAmount: 0.5,
      format: pct(1),
      sources: ALL_SOURCES,
    },
    lfo2Rate: {
      label: 'LFO 2 rate',
      min: -30, max: 30, sensitivity: 0.12, defaultAmount: 4,
      format: pct(30),
      sources: ALL_SOURCES,
    },
    lfo2Shape: {
      label: 'LFO 2 shape',
      min: -1, max: 1, sensitivity: 0.004, defaultAmount: 0.5,
      format: pct(1),
      sources: ALL_SOURCES,
    },
    lfo3Rate: {
      label: 'LFO 3 rate',
      min: -30, max: 30, sensitivity: 0.12, defaultAmount: 4,
      format: pct(30),
      sources: ALL_SOURCES,
    },
    lfo3Shape: {
      label: 'LFO 3 shape',
      min: -1, max: 1, sensitivity: 0.004, defaultAmount: 0.5,
      format: pct(1),
      sources: ALL_SOURCES,
    },
  };
  for (const op of OPERATOR_IDS) {
    const label = OPERATOR_LABELS[op];
    out[`${op}Level`] = {
      label: `${label} level`,
      min: -1,
      max: 1,
      sensitivity: 0.004,
      defaultAmount: 0.25,
      format: pct(1),
      sources: NON_AMP_SOURCES,
    };
    out[`${op}Pan`] = {
      label: `${label} pan`,
      min: -1,
      max: 1,
      sensitivity: 0.004,
      defaultAmount: 0.5,
      format: pct(1),
      sources: NON_AMP_SOURCES,
    };
    out[`${op}Wave`] = {
      label: `${label} wave`,
      min: -3,
      max: 3,
      sensitivity: 0.012,
      defaultAmount: 1,
      format: pct(3),
      sources: ALL_SOURCES,
    };
    out[`${op}FilterMix`] = {
      label: `${label} filter A/B`,
      min: -1,
      max: 1,
      sensitivity: 0.004,
      defaultAmount: 0.4,
      format: pct(1),
      sources: ALL_SOURCES,
    };
    out[`${op}ModAmount`] = {
      label: `${label} PM depth`,
      min: -1,
      max: 1,
      sensitivity: 0.004,
      defaultAmount: 0.5,
      format: pct(1),
      sources: NON_AMP_SOURCES,
    };
    // Per-operator pitch — bends ONLY this operator's detune (the global
    // 'pitch' target bends the whole voice). Same cents range, all sources.
    out[`${op}Pitch`] = {
      label: `${label} pitch`,
      min: -2400,
      max: 2400,
      sensitivity: 4,
      defaultAmount: 100,
      format: centsFormat,
      sources: ALL_SOURCES,
    };
    // Per-SOURCE PM/FM depth knobs (`${op}Pm${src}` / `${op}Fm${src}`) — an
    // ENV/LFO can now modulate the depth of ONE modulation knob, not just
    // the whole operator's PM. Amount is 0..1 × the knob's depth.
    for (const src of OPERATOR_IDS) {
      const srcLabel = OPERATOR_LABELS[src];
      out[`${op}Pm${src}`] = {
        label: `${label} PM · ${srcLabel}`,
        min: -1,
        max: 1,
        sensitivity: 0.004,
        defaultAmount: 0.5,
        format: pct(1),
        sources: NON_AMP_SOURCES,
      };
      out[`${op}Fm${src}`] = {
        label: `${label} FM · ${srcLabel}`,
        min: -1,
        max: 1,
        sensitivity: 0.004,
        defaultAmount: 0.5,
        format: pct(1),
        sources: NON_AMP_SOURCES,
      };
    }
    // Wavetable scan position (Task 4, multi-agent work order) — additive
    // into the 0..1 `wtPos` knob, same bipolar-amount convention as
    // oscLevel/FilterMix above. Appended last, mirroring dsp/synth.js's own
    // MOD_TARGETS order (after every Pm/Fm entry).
    out[`${op}WtPos`] = {
      label: `${label} wavetable pos`,
      min: -1,
      max: 1,
      sensitivity: 0.004,
      defaultAmount: 0.5,
      format: pct(1),
      sources: ALL_SOURCES,
    };
    out[`${op}WarpAmt`] = {
      label: `${label} warp 1 amount`,
      min: -1,
      max: 1,
      sensitivity: 0.004,
      defaultAmount: 0.5,
      format: pct(1),
      sources: ALL_SOURCES,
    };
    out[`${op}WarpAmt2`] = {
      label: `${label} warp 2 amount`,
      min: -1,
      max: 1,
      sensitivity: 0.004,
      defaultAmount: 0.5,
      format: pct(1),
      sources: ALL_SOURCES,
    };
  }
  // Native arp/seq targets (APPENDED, mirrors dsp/synth.js MOD_TARGETS tail). `max` is the
  // full-scale span translate.ts divides by: Rate +-2 octaves, Swing +-25 pts, Gate +-100 %,
  // Transpose +-24 st, Velocity +-100 %, Random +-100 %. The arp runs natively, so the graph
  // only supplies the summed modulation (from voice 0's sources).
  const fmtOct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} oct`;
  const fmtPts = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} pts`;
  const fmtSt = (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v)} st`;
  out.seqRate = { label: 'Seq rate', min: -2, max: 2, sensitivity: 0.008, defaultAmount: 0.5, format: fmtOct, sources: ALL_SOURCES };
  out.seqSwing = { label: 'Seq swing', min: -25, max: 25, sensitivity: 0.1, defaultAmount: 8, format: fmtPts, sources: ALL_SOURCES };
  out.seqGate = { label: 'Seq gate', min: -1, max: 1, sensitivity: 0.004, defaultAmount: 0.3, format: pct(1), sources: ALL_SOURCES };
  out.seqTranspose = { label: 'Seq transpose', min: -24, max: 24, sensitivity: 0.1, defaultAmount: 7, format: fmtSt, sources: ALL_SOURCES };
  out.seqVelocity = { label: 'Seq velocity', min: -1, max: 1, sensitivity: 0.004, defaultAmount: 0.3, format: pct(1), sources: ALL_SOURCES };
  out.seqRandom = { label: 'Seq random', min: -1, max: 1, sensitivity: 0.004, defaultAmount: 0.3, format: pct(1), sources: ALL_SOURCES };
  // Ranges here MUST equal the spans in dsp/synth.js's SEQ_TARGETS — the wire
  // carries amount/span clamped to +-1 and the DSP multiplies the span back in.
  out.seqOctaves = { label: 'Seq octaves', min: -3, max: 3, sensitivity: 0.02, defaultAmount: 1, format: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} oct`, sources: ALL_SOURCES };
  out.seqPattern = { label: 'Seq pattern', min: -1, max: 1, sensitivity: 0.004, defaultAmount: 0.3, format: pct(1), sources: ALL_SOURCES };
  out.seqChaos = { label: 'Seq chaos', min: -1, max: 1, sensitivity: 0.004, defaultAmount: 0.5, format: pct(1), sources: ALL_SOURCES };
  return out as Record<ModTargetId, ModTargetMeta>;
})();

/**
 * Assign `source` to `target` with the target's default amount, Pigments
 * cable-drop style: dragging an ENV dot onto a knob adds a route without
 * clobbering whatever else is already routed there. Returns the same map
 * (unchanged) if the source isn't offered for that target, or if it's
 * already routed.
 */
export function addModRoute(
  mod: ModMap | undefined,
  source: ModSourceId,
  target: ModTargetId,
): ModMap {
  const meta = MOD_TARGETS[target];
  if (!meta.sources.includes(source)) return mod ?? {};
  const existing = (mod ?? {})[target] ?? [];
  if (existing.some((r) => r.source === source)) return mod ?? {};
  return {
    ...(mod ?? {}),
    [target]: [...existing, { source, amount: meta.defaultAmount }],
  };
}

/**
 * The dominant active route for a knob, for the "glow" affordance: which
 * source is modulating it, and how strongly (0..1, so the knob's glow can
 * scale with the amount). The strongest |amount| relative to the target's
 * range wins; a square-root curve keeps small amounts visible while still
 * reading "more amount = brighter glow".
 *
 * Returns null when the target has no routes (knob shows no mod glow).
 */
export function modGlowFor(
  targetId: ModTargetId,
  routes: ModRoute[] | undefined,
): { color: string; amount: number } | null {
  const meta = MOD_TARGETS[targetId];
  if (!meta) return null;
  let best: { color: string; score: number } | null = null;
  for (const r of routes ?? []) {
    if (!r || r.amount === 0) continue;
    const src = MOD_SOURCES[r.source];
    if (!src) continue;
    const score = Math.abs(r.amount) / Math.max(1e-6, meta.max);
    if (!best || score > best.score) best = { color: src.color, score };
  }
  if (!best) return null;
  // Floor at 0.4 — the point of the ring is "this knob IS modulated", which
  // should read clearly even for a tiny amount (todo.md §87). Magnitude
  // still scales it up from there.
  return { color: best.color, amount: Math.max(0.4, Math.min(1, Math.sqrt(best.score) * 1.4)) };
}

/**
 * Reverse lookup: every target `source` currently drives, most-recently-
 * defined target order (`MOD_TARGETS` insertion order — stable across
 * renders). Feeds the "right-click a modulator → its active routes" panel
 * (todo.md §91/92 Pigments overhaul) — the mirror image of a knob's own
 * `ModPopover`, which lists sources for ONE target; this lists targets for
 * ONE source. Muted routes (amount 0, or `enabled: false`) are included so
 * the panel can still show + unmute them, same as the per-knob editor does.
 */
export function routesForSource(
  mod: ModMap | undefined,
  source: ModSourceId,
): { target: ModTargetId; route: ModRoute }[] {
  const out: { target: ModTargetId; route: ModRoute }[] = [];
  for (const target of Object.keys(MOD_TARGETS) as ModTargetId[]) {
    for (const route of mod?.[target] ?? []) {
      if (route.source === source) out.push({ target, route });
    }
  }
  return out;
}

/**
 * Set `source` → `target` to an exact amount (clamped to the target's
 * range), removing the route when the amount is zero — used by the cable
 * drag's amount phase so a downward drag can drive the amount through zero
 * and disconnect the route. No-ops (returns the map unchanged) if the
 * source isn't offered for the target.
 */
export function setModRouteAmount(
  mod: ModMap | undefined,
  source: ModSourceId,
  target: ModTargetId,
  amount: number,
): ModMap {
  const meta = MOD_TARGETS[target];
  if (!meta.sources.includes(source)) return mod ?? {};
  const clamped = Math.max(meta.min, Math.min(meta.max, amount));
  const rest = ((mod ?? {})[target] ?? []).filter((r) => r.source !== source);
  const next = clamped !== 0 ? [...rest, { source, amount: clamped }] : rest;
  return { ...(mod ?? {}), [target]: next };
}