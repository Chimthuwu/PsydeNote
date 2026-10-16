// ---------------------------------------------------------------------------
// Native DSP entry point — the plugin's equivalent of web/main.js.
//
// Adapted from elemaudio/srvb's dsp/main.js (MIT). It marshals Elementary
// instruction batches to the native elem::Runtime via __postNativeMessage__,
// and re-renders whenever the C++ processor dispatches new state.
//
// The graph itself is dsp/synth.js — IMPORTED VERBATIM, byte-for-byte the
// same file the browser preview runs. That is the whole point of the spike:
// the DSP is portable, only the host harness differs.
// ---------------------------------------------------------------------------
import { Renderer } from '@elemaudio/core';
import { renderSynth, NUM_OPERATORS, PM_INDEX, FM_DEPTH_HZ } from '../dsp/synth.js';
import { fastValueUpdates, applyConstValues } from '../dsp/fastpath.js';

// Gate/freq/vel come from the native `voicectl` node (audio thread), not from
// the state snapshot — see voiceCtl() in dsp/synth.js. Must be set BEFORE the
// first renderSynth.
globalThis.__FAZE_NATIVE_VOICECTL__ = true;

/**
 * Fold a multi-point envelope shape onto an ADSR object.
 *
 * `<id>_envShape` is written into `state` by PluginProcessor::setEnvShape (the
 * `setEnvShape` bridge verb) and carries `{mode, durationSec, points, bipolar}`
 * in one blob, because point data is not a bounded host float — the same
 * treatment `lfo*_functionShape` gets. Anything missing or not in 'multi' mode
 * leaves the ADSR untouched, so every existing preset behaves exactly as before.
 */
function withEnvShape(s, id, adsr) {
  const blob = s[`${id}_envShape`];
  if (!blob || typeof blob !== 'object') return adsr;
  if (blob.mode !== 'multi') return adsr;
  if (!Array.isArray(blob.points) || blob.points.length < 2) return adsr;
  return {
    ...adsr,
    mode: 'multi',
    durationSec: typeof blob.durationSec === 'number' ? blob.durationSec : 1,
    shape: { points: blob.points, bipolar: blob.bipolar !== false },
  };
}

const NUM_VOICES = 12; // MUST match kNumVoices in PluginProcessor.h (todo.md §73)

const core = new Renderer((batch) => {
  __postNativeMessage__(JSON.stringify(batch));
});

let prev = null;

// The C++ side (PluginProcessor::dispatchStateChange) sends a flat object of
// all plugin params + the per-voice note state:
//   { sampleRate, master, octave, semitone, fineCents, env_a, env_d, env_s, env_r,
//     op0_wave, op0_level, op0_pan, op0_semis, op1_wave, ...  (4 operators)
//     env2_a..r, lfo1_rate/wave, lfo2_rate/wave, sh_rate,
//     mod0_src/dst/amt .. mod23_src/dst/amt,   (24-slot mod matrix — todo.md §108)
//     v0_gate, v0_freq, v0_vel, v1_gate, ... }
// All values are numbers (DAW params).
const NUM_MOD_SLOTS = 24;
const OP_DEFAULTS = [
  { wave: 2, level: 1.0, pan: 0.0, semis: 0 },
  { wave: 0, level: 0.0, pan: -0.4, semis: 0 },
  { wave: 0, level: 0.0, pan: 0.4, semis: 0 },
  { wave: 0, level: 0.0, pan: 0.0, semis: 0 },
];

// The "+" modulator pool: any number of ENV (4-8), LFO (4-8) and Audio Follower
// (1-4) instances, each present only while its mod_on_* flag is set. Keys are
// the mod SOURCE ids dsp/synth.js reads (env4.., lfo4.., audiofollower[2-4]).
function buildExtraModules(s) {
  const extra = {};
  const on = (k) => (s[k] ?? 0) > 0.5;
  for (let n = 4; n <= 11; n++) {
    if (n <= 11 && on(`mod_on_env${n}`)) {
      extra[`env${n}`] = withEnvShape(s, `env${n}`, {
        attackSec: s[`env${n}_a`] ?? 0.01, decaySec: s[`env${n}_d`] ?? 0.3,
        sustainLevel: s[`env${n}_s`] ?? 0.4, releaseSec: s[`env${n}_r`] ?? 0.6,
      });
    }
    if (n <= 10 && on(`mod_on_lfo${n}`)) {
      extra[`lfo${n}`] = {
        rateHz: s[`lfo${n}_rate`] ?? 1, wave: Math.round(s[`lfo${n}_wave`] ?? 5),
        sync: (s[`lfo${n}_sync`] ?? 0) > 0.5, perNote: (s[`lfo${n}_pernote`] ?? 0) > 0.5,
        functionShape: s[`lfo${n}_functionShape`],
      };
    }
  }
  for (let n = 1; n <= 10; n++) {
    const pre = n === 1 ? 'af' : `af${n}`;
    if (on(`mod_on_${pre}`)) {
      extra[n === 1 ? 'audiofollower' : `audiofollower${n}`] = {
        loHz: s[`${pre}_lo`] ?? 20, hiHz: s[`${pre}_hi`] ?? 20000,
        attackMs: s[`${pre}_atk`] ?? 5, releaseMs: s[`${pre}_rel`] ?? 120, gainDb: s[`${pre}_gain`] ?? 12,
        source: Math.round(s[`${pre}_src`] ?? 0),
      };
    }
  }
  return extra;
}

function toSynthState(s) {
  return {
    master: s.master ?? 0.7,
    octave: s.octave ?? 0,
    semitone: s.semitone ?? 0,
    fineCents: s.fineCents ?? 0,
    glide: s.glide ?? 0,
    env: withEnvShape(s, 'env1', {
      attackSec: s.env_a ?? 0.005,
      decaySec: s.env_d ?? 0.2,
      sustainLevel: s.env_s ?? 0.7,
      releaseSec: s.env_r ?? 0.4,
    }),
    operators: Array.from({ length: NUM_OPERATORS }, (_, k) => {
      const mods = {};
      for (let src = 0; src < NUM_OPERATORS; src++) {
        if (src === k) continue;
        const pm = s[`op${k}_pm${src}`] ?? 0;
        const fm = s[`op${k}_fm${src}`] ?? 0;
        if (pm || fm) mods[src] = { pm, fm };
      }
      return {
        wave: Math.round(s[`op${k}_wave`] ?? OP_DEFAULTS[k].wave),
        level: s[`op${k}_level`] ?? OP_DEFAULTS[k].level,
        pan: s[`op${k}_pan`] ?? OP_DEFAULTS[k].pan,
        semis: s[`op${k}_semis`] ?? OP_DEFAULTS[k].semis,
        filterMix: s[`op${k}_fmix`] ?? 0,
        // Sampler (todo.md §114) — wave===4. rootHz is the fundamental the
        // loaded file was recorded at; sampleVersion picks which versioned
        // SharedResourceMap entry to play (PluginProcessor::loadSampleFile
        // registers a fresh "sample:opK:V" on every (re)load, never reusing
        // V — SharedResourceMap only allows insertion, never an update).
        rootHz: s[`op${k}_roothz`] ?? 440,
        sampleVersion: Math.round(s[`op${k}_sampleversion`] ?? 0),
        // Sampler upgrade (Task 6) — sampleFrames is the resampled buffer's
        // exact length (PluginProcessor::loadSampleFile, non-manifest state
        // field, same treatment as sampleversion/sampleduration); loop/
        // start/end/reverse are real manifest params.
        sampleFrames: Math.round(s[`op${k}_sampleframes`] ?? 0),
        sampleLoop: (s[`op${k}_loop`] ?? 0) > 0.5,
        sampleStart: s[`op${k}_start`] ?? 0,
        sampleEnd: s[`op${k}_end`] ?? 1,
        sampleReverse: (s[`op${k}_reverse`] ?? 0) > 0.5,
        // Real wavetable synthesis (Task 4) — wave===5. wtId picks a
        // built-in table (dsp/wavetables.js, registered once at startup by
        // PluginProcessor::registerBuiltinWavetables); wtPos (0..1, also a
        // mod-matrix target) scans continuously across its frames.
        wtId: Math.round(s[`op${k}_wtid`] ?? 0),
        wtPos: s[`op${k}_wtpos`] ?? 0,
        warpMode: Math.round(s[`op${k}_warpmode`] ?? 0),
        warpAmount: s[`op${k}_warpamount`] ?? 0,
        warpParam2: s[`op${k}_warpparam2`] ?? 0.5,
        warpMode2: Math.round(s[`op${k}_warpmode2`] ?? 0),
        warpAmount2: s[`op${k}_warpamount2`] ?? 0,
        warpParam2_2: s[`op${k}_warpparam2_2`] ?? 0.5,
        mods,
      };
    }),
    filterA: {
      type: Math.round(s.filterA_type ?? 0),
      cutoff: s.filterA_cutoff ?? 20000,
      resonance: s.filterA_q ?? 0.7,
      slope: Math.round(s.filterA_slope ?? 12),
    },
    filterB: {
      type: Math.round(s.filterB_type ?? 0),
      cutoff: s.filterB_cutoff ?? 20000,
      resonance: s.filterB_q ?? 0.7,
      slope: Math.round(s.filterB_slope ?? 12),
    },
    // Modulators (§88.A): ENV 2/3, LFO 1/2/3, the mod matrix. bpm for LFO
    // sync (from the C++ playhead; 120 fallback).
    bpm: s.bpm ?? 120,
    // 8 Macro knobs (todo.md §111) — plain global 0..1 values, index 0 =
    // Macro 1. Consumed by dsp/synth.js's buildSources() as extra mod
    // sources ('macro1'..'macro8'), same as velocity/keytrack.
    macros: Array.from({ length: 8 }, (_, i) => s[`macro${i}`] ?? 0),
    velCurve: s.vel_curve ?? 0, // §88.E — Velocity / Keyboard transfer curves
    keyCurve: s.key_curve ?? 0,
    modEnv: withEnvShape(s, 'env2', {
      attackSec: s.env2_a ?? 0.005, decaySec: s.env2_d ?? 0.2,
      sustainLevel: s.env2_s ?? 0.7, releaseSec: s.env2_r ?? 0.4,
    }),
    modEnv3: withEnvShape(s, 'env3', {
      attackSec: s.env3_a ?? 0.01, decaySec: s.env3_d ?? 0.3,
      sustainLevel: s.env3_s ?? 0.4, releaseSec: s.env3_r ?? 0.6,
    }),
    // Function point data is not a bounded host float, so it remains in the
    // UI-side patch for the native spike; the DSP still accepts it when the
    // browser renderer supplies a rich state object.
    lfo1: { rateHz: s.lfo1_rate ?? 4, wave: Math.round(s.lfo1_wave ?? 0), sync: (s.lfo1_sync ?? 0) > 0.5, perNote: (s.lfo1_pernote ?? 0) > 0.5, functionShape: s.lfo1_functionShape },
    lfo2: { rateHz: s.lfo2_rate ?? 0.5, wave: Math.round(s.lfo2_wave ?? 1), sync: (s.lfo2_sync ?? 0) > 0.5, perNote: (s.lfo2_pernote ?? 0) > 0.5, functionShape: s.lfo2_functionShape },
    lfo3: { rateHz: s.lfo3_rate ?? 2, wave: Math.round(s.lfo3_wave ?? 2), sync: (s.lfo3_sync ?? 0) > 0.5, perNote: (s.lfo3_pernote ?? 0) > 0.5, functionShape: s.lfo3_functionShape },
    // Optional "+" modulators (todo.md P2): each exists in the graph only
    // while its mod_on_* flag is set, so an un-added module costs nothing.
    // Which original modulators are switched on (a fresh patch has none; a
    // routed source is always built regardless — see buildSources).
    modOn: {
      env2: (s.mod_on_env2 ?? 0) > 0.5, env3: (s.mod_on_env3 ?? 0) > 0.5,
      lfo1: (s.mod_on_lfo1 ?? 0) > 0.5, lfo2: (s.mod_on_lfo2 ?? 0) > 0.5, lfo3: (s.mod_on_lfo3 ?? 0) > 0.5,
    },
    extra: buildExtraModules(s),
    // Master-bus FX (todo.md §79/§113). mix 0 = bypassed (renderSynth skips
    // it); `chain` is the reorderable slot-type list (0=off/1=delay/2=reverb/3=distortion).
    fx: {
      chain: Array.from({ length: 8 }, (_, n) => ['off', 'delay', 'reverb', 'distortion', 'chorus', 'flanger', 'compressor', 'phaser', 'eq'][Math.round(s[`fxslot${n}_type`] ?? 0)] || 'off'),
      delay: {
        enabled: (s.fx_delay_on ?? 0) > 0.5,
        timeMs: s.fx_delay_time ?? 300,
        feedback: s.fx_delay_fb ?? 0.3,
        tone: s.fx_delay_tone ?? 0.7,
        locut: s.fx_delay_locut ?? 0.05,
        mod: s.fx_delay_mod ?? 0,
        rate: s.fx_delay_rate ?? 0.6,
        width: s.fx_delay_width ?? 0.3,
        diffusion: s.fx_delay_diff ?? 0.2,
        mix: s.fx_delay_mix ?? 0,
      },
      reverb: {
        enabled: (s.fx_reverb_on ?? 0) > 0.5,
        size: s.fx_reverb_size ?? 0.5,
        decay: s.fx_reverb_decay ?? 0.5,
        damp: s.fx_reverb_damp ?? 0.5,
        locut: s.fx_reverb_locut ?? 0.05,
        mod: s.fx_reverb_mod ?? 0.15,
        rate: s.fx_reverb_rate ?? 0.5,
        width: s.fx_reverb_width ?? 0.5,
        diffusion: s.fx_reverb_diff ?? 0.4,
        mix: s.fx_reverb_mix ?? 0,
      },
      distortion: {
        enabled: (s.fx_dist_on ?? 0) > 0.5,
        drive: s.fx_dist_drive ?? 0.35,
        tone: s.fx_dist_tone ?? 0.7,
        mix: s.fx_dist_mix ?? 0,
      },
      chorus: {
        enabled: (s.fx_chorus_on ?? 0) > 0.5,
        rate: s.fx_chorus_rate ?? 0.35,
        depth: s.fx_chorus_depth ?? 0.45,
        width: s.fx_chorus_width ?? 0.65,
        mix: s.fx_chorus_mix ?? 0,
      },
      flanger: {
        enabled: (s.fx_flanger_on ?? 0) > 0.5,
        rate: s.fx_flanger_rate ?? 0.25,
        depth: s.fx_flanger_depth ?? 0.55,
        feedback: s.fx_flanger_fb ?? 0.45,
        width: s.fx_flanger_width ?? 0.7,
        mix: s.fx_flanger_mix ?? 0,
      },
      compressor: {
        enabled: (s.fx_comp_on ?? 0) > 0.5,
        lowFreq: s.fx_comp_lowfreq ?? 250,
        highFreq: s.fx_comp_highfreq ?? 2500,
        // Per-band DOOM parameters (todo.md §165 item 1 / P0-C). These 17
        // keys used to be dropped natively because they were never declared
        // in manifest.json, so every user ran the defaults and could not turn
        // the compressor down with its own controls. The legacy
        // threshold/ratio/attackMs/releaseMs fields are gone — the DSP
        // (dsp/synth.js applyCompressorSlot) never read them.
        lowFloorDb: s.fx_comp_low_floor ?? -55,
        lowCeilingDb: s.fx_comp_low_ceil ?? 0,
        lowAmount: s.fx_comp_low_amt ?? 0.5,
        lowAttackMs: s.fx_comp_low_atk ?? 0,
        lowReleaseMs: s.fx_comp_low_rel ?? 120,
        midFloorDb: s.fx_comp_mid_floor ?? -55,
        midCeilingDb: s.fx_comp_mid_ceil ?? 0,
        midAmount: s.fx_comp_mid_amt ?? 0.5,
        midAttackMs: s.fx_comp_mid_atk ?? 0,
        midReleaseMs: s.fx_comp_mid_rel ?? 120,
        highFloorDb: s.fx_comp_high_floor ?? -55,
        highCeilingDb: s.fx_comp_high_ceil ?? 0,
        highAmount: s.fx_comp_high_amt ?? 0.5,
        highAttackMs: s.fx_comp_high_atk ?? 0,
        highReleaseMs: s.fx_comp_high_rel ?? 120,
        drive: s.fx_comp_drive ?? 0,
        crush: s.fx_comp_crush ?? 0,
        gain: s.fx_comp_gain ?? 1.0,
        mix: s.fx_comp_mix ?? 0,
      },
      phaser: {
        enabled: (s.fx_phaser_on ?? 0) > 0.5,
        rate: s.fx_phaser_rate ?? 0.35,
        depth: s.fx_phaser_depth ?? 0.65,
        feedback: s.fx_phaser_fb ?? 0.35,
        stages: s.fx_phaser_stages ?? 4,
        mix: s.fx_phaser_mix ?? 0,
      },
      eq: {
        enabled: (s.fx_eq_on ?? 1) > 0.5,
        mix: s.fx_eq_mix ?? 1,
        // Real parametric EQ (todo.md) — `fx_eq_bands` travels as JSON
        // point data (PluginProcessor::setEqBands), same non-flat-param
        // precedent as `lfoN_functionShape` two blocks up; passed straight
        // through, applyEqSlot (dsp/synth.js) does its own clamping.
        bands: Array.isArray(s.fx_eq_bands) ? s.fx_eq_bands : [],
      },
    },
    mod: Array.from({ length: NUM_MOD_SLOTS }, (_, i) => ({
      src: Math.round(s[`mod${i}_src`] ?? 0),
      dst: Math.round(s[`mod${i}_dst`] ?? 0),
      amt: s[`mod${i}_amt`] ?? 0,
    })).filter((m) => m.dst > 0 && Math.abs(m.amt) > 1e-4),
    voices: Array.from({ length: NUM_VOICES }, (_, i) => ({
      gate: s[`v${i}_gate`] ?? 0,
      freq: s[`v${i}_freq`] ?? 440,
      vel: s[`v${i}_vel`] ?? 1,
    })),
  };
}

let lastSerialized = null;
globalThis.__receiveStateChange__ = (serialized) => {
  // Identical state -> identical graph. A rebuild costs ~50ms in QuickJS (the
  // plugin's message thread), and native re-dispatches on every param echo,
  // UI-note poke and debounce tick, many of which change nothing.
  // Note state no longer feeds the graph (native voicectl), so a snapshot that
  // differs only in v{i}_gate/freq/vel needs no ~50 ms reconcile.
  const graphKey = serialized.replace(/"v\d+_(?:gate|freq|vel)":[^,}]*,?/g, '');
  if (graphKey === lastSerialized) return;
  lastSerialized = graphKey;
  const s = JSON.parse(serialized);

  // FAST PATH: a value-only change to a PM / FM amount (that stays on the same side of zero) is pushed straight to
  // the mounted const nodes. No renderSynth, no graph rebuild: this is what made PM/FM knobs take ~1 s to act.
  if (prev !== null) {
    const updates = fastValueUpdates(prev, s, { numVoices: s.voices ? s.voices.length : 8, pmIndex: PM_INDEX, fmDepthHz: FM_DEPTH_HZ });
    if (updates && updates.length > 0 && applyConstValues(core, updates)) {
      prev = s;
      return;
    }
  }

  // Anything else (structure, pitch, filter, FX, a PM/FM crossing zero, a sample-rate change) takes the full render.
  // Only then is renderSynth re-run; the el.const refs inside it make the common cases prop updates.
  const needsFullRender = prev === null || prev.sampleRate !== s.sampleRate;
  const stats = core.render(...renderSynth(toSynthState(s)));
  if (needsFullRender) console.log('full render', stats);

  prev = s;
};

globalThis.__receiveError__ = (err) => {
  console.log(`[dsp error: ${err.name}] ${err.message}`);
};

// Hydration hook — lets native reinitialize the JS engine and re-inject the
// running graph state. Copied from srvb; "highly experimental" there too.
globalThis.__receiveHydrationData__ = (data) => {
  const payload = JSON.parse(data);
  const nodeMap = core._delegate.nodeMap;
  for (const [k, v] of Object.entries(payload)) {
    nodeMap.set(parseInt(k, 16), {
      symbol: '__ELEM_NODE__',
      kind: '__HYDRATED__',
      hash: parseInt(k, 16),
      props: v,
      generation: { current: 0 },
    });
  }
};
