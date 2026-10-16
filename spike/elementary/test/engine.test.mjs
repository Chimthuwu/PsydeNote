// Headless regression checks for dsp/synth.js — renders the graph offline
// (no browser) and asserts on RMS / spectral centroid. Run: `npm test`.
import OfflineRenderer from '@elemaudio/offline-renderer';
import { el } from '@elemaudio/core';
import {
  renderSynth, masterFx, defaultOperators, defaultFilter, midiToFreq, MOD_TARGETS, MOD_SOURCES,
} from '../dsp/synth.js';
import { allBuiltinWavetableResources, getBaseWavetableFrames, generateWavetableFrames, WAVETABLES, wavetableResourceKey } from '../dsp/wavetables.js';

const SR = 48000;

async function render(mutate, { note = 57, ms = 400 } = {}) {
  const core = new OfflineRenderer();
  await core.initialize({ numInputChannels: 0, numOutputChannels: 2, sampleRate: SR, blockSize: 512 });
  const st = {
    master: 0.9, octave: 0, semitone: 0, fineCents: 0,
    env: { attackSec: 0.001, decaySec: 0.5, sustainLevel: 1, releaseSec: 0.2 },
    operators: defaultOperators(),
    filterA: defaultFilter(), filterB: defaultFilter(),
    voices: Array.from({ length: 8 }, (_, i) => ({ gate: i === 0 ? 1 : 0, freq: midiToFreq(note) })),
  };
  mutate(st);
  core.render(...renderSynth(st));
  const n = Math.round((ms / 1000) * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  core.process([], [L, R]);
  return { L, R, st };
}

function rms(a, from = 0, to = a.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / (to - from));
}

// Rough spectral centroid (naive DFT on a mid slice) — a brightness proxy.
function centroid(a) {
  const s = a.subarray(Math.min(4000, a.length >> 1), Math.min(8096, a.length));
  const K = 512;
  let num = 0, den = 0;
  for (let k = 1; k < K; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < s.length; n += 4) {
      const w = (-2 * Math.PI * k * n) / s.length;
      re += s[n] * Math.cos(w);
      im += s[n] * Math.sin(w);
    }
    const m = Math.hypot(re, im);
    num += k * m; den += m;
  }
  return den > 0 ? num / den : 0;
}

let failed = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   (${detail})` : ''}`);
  if (!ok) failed++;
}

// --- P1/P2: sound, envelope, per-op level -------------------------------
{
  const { L } = await render(() => {});
  check('default patch makes sound', rms(L) > 0.01, `rms=${rms(L).toFixed(4)}`);
}
{
  const { L } = await render((st) => st.operators.forEach((o) => (o.level = 0)));
  check('all operator levels 0 -> silence', rms(L) < 1e-4, `rms=${rms(L).toExponential(1)}`);
}
{
  const { L } = await render((st) => { st.env.releaseSec = 0.05; st.voices[0].gate = 0; }, { ms: 500 });
  check('gate 0 -> release tail decays to silence', rms(L, 20000, 24000) < 1e-3);
}
// --- P2: per-op pan ---------------------------------------------------
{
  const { L, R } = await render((st) => { st.operators[0].pan = -1; });
  check('OSC 1 panned hard left -> L >> R', rms(L) > rms(R) * 2, `L=${rms(L).toFixed(3)} R=${rms(R).toFixed(3)}`);
}
// --- P3: FM/PM ------------------------------------------------------
{
  const dry = centroid((await render((st) => { st.operators[0].wave = 0; })).L);
  const wet = centroid((await render((st) => {
    st.operators[0].wave = 0; st.operators[1].semis = 12;
    st.operators[0].mods = { 1: { pm: 0.9, fm: 0 } };
  })).L);
  check('PM depth 0.9 makes a sine carrier much brighter', wet > dry * 3, `dry=${dry.toFixed(0)} wet=${wet.toFixed(0)}`);
}
{
  const { L } = await render((st) => {
    st.operators[0].wave = 0; st.operators[1].semis = 7;
    st.operators[0].mods = { 1: { pm: 0.8, fm: 0 } };
    st.operators[1].mods = { 0: { pm: 0.5, fm: 0 } }; // cycle
  });
  check('cyclic PM (op0<->op1) stays finite + audible', Number.isFinite(rms(L)) && rms(L) > 0.01 && rms(L) < 2);
}
// --- P4: dual filter ----------------------------------------------
{
  const open = centroid((await render((st) => { st.operators[0].wave = 2; })).L);
  const lp = centroid((await render((st) => {
    st.operators[0].wave = 2;
    st.filterA = { type: 0, cutoff: 400, resonance: 2, slope: 24 };
  })).L);
  check('Filter A LP 400 Hz darkens a sawtooth', lp < open * 0.8, `open=${open.toFixed(0)} lp=${lp.toFixed(0)}`);
}
{
  const lo = rms((await render((st) => {
    st.operators[0].wave = 2;
    st.filterA = { type: 1, cutoff: 3000, resonance: 1, slope: 24 }; // HP kills a 220Hz saw's lows
  })).L);
  const open = rms((await render((st) => { st.operators[0].wave = 2; })).L);
  check('Filter A HP 3 kHz removes most of a low sawtooth', lo < open * 0.5, `open=${open.toFixed(3)} hp=${lo.toFixed(3)}`);
}
{
  const noB = centroid((await render((st) => { st.operators[0].wave = 2; })).L);
  const toB = centroid((await render((st) => {
    st.operators[0].wave = 2; st.operators[0].filterMix = 1;
    st.filterB = { type: 0, cutoff: 300, resonance: 3, slope: 24 };
  })).L);
  check('per-op crossfade routes OSC 1 into Filter B', toB < noB * 0.6, `A=${noB.toFixed(0)} B=${toB.toFixed(0)}`);
}

// --- P5: mod matrix (ENV2 / LFO / S&H / random / velocity / keytrack) ---
// Target/source indices mirror MOD_TARGETS / MOD_SOURCES in dsp/synth.js.
const MT = { pitch: 1, op1Level: 2, filterACutoff: 26, lfo1Rate: 30 };
// §88.A roster: env1=0 env2=1 env3=2 lfo1=3 lfo2=4 lfo3=5 velocity=6 keytrack=7
// §111: 8 Macros appended at 8..15 (macro1=8 .. macro8=15).
const MS = { env2: 1, env3: 2, lfo1: 3, lfo2: 4, lfo3: 5, velocity: 6, keytrack: 7, macro1: 8 };
{
  // Every source, routed one at a time, must stay finite and audible.
  const routes = [
    ['env2 -> op1Level', { src: MS.env2, dst: MT.op1Level, amt: 0.5 }],
    ['env3 -> op1Level', { src: MS.env3, dst: MT.op1Level, amt: 0.5 }],
    ['lfo1 -> pitch', { src: MS.lfo1, dst: MT.pitch, amt: 0.3 }],
    ['lfo2 -> filterACutoff', { src: MS.lfo2, dst: MT.filterACutoff, amt: 0.5 }],
    ['lfo3 -> op1Level', { src: MS.lfo3, dst: MT.op1Level, amt: 0.4 }],
    ['keytrack -> filterACutoff', { src: MS.keytrack, dst: MT.filterACutoff, amt: 0.5 }],
    ['lfo1Rate is itself a target', { src: MS.env2, dst: MT.lfo1Rate, amt: 0.5 }],
  ];
  for (const [name, slot] of routes) {
    const { L } = await render((st) => { st.mod = [slot]; });
    const r = rms(L);
    check(`P5 ${name}`, Number.isFinite(r) && r > 0.005 && r < 3, `rms=${r.toFixed(4)}`);
  }
}
{
  // SS164 REWRITE. The spectral-centroid metric is the WRONG instrument for a
  // swept filter and is what let this bug survive several rounds: a centroid is
  // a time-average, so a correct full sweep and a filter that barely moves can
  // both report a similar number. This test also pinned `type: 1` (highpass)
  // rather than the default lowpass the user actually has, and asserted
  // UPWARD movement from the top of the range — only possible because SS156
  // let the clamp run past 20 kHz, which the user then explicitly ruled out
  // ("I dont want it to go past 20Khz").
  //
  // What must hold, measured as the MINIMUM of the short-window RMS envelope
  // over a 2 s render: at -10 octaves from the 20000 Hz default the sweep
  // bottoms out on 20000 * 2^-10 = 19.5 Hz, i.e. the 20 Hz floor, so the
  // quietest moment of the sweep must match a filter parked at 20 Hz. That
  // distinguishes a full sweep from a half sweep; a centroid cannot.
  const envMin = async (mutate) => {
    const { L } = await render(mutate, { ms: 2000 });
    const H = 256;
    const vals = [];
    for (let h = 0; h + H < L.length; h += H) {
      let s = 0;
      for (let i = h; i < h + H; i += 1) s += L[i] * L[i];
      vals.push(Math.sqrt(s / H));
    }
    // Ignore the attack — the first 40% covers the amp envelope's rise.
    return Math.min(...vals.slice(Math.floor(vals.length * 0.4)));
  };
  const LP = (cutoff) => (st) => { st.filterA = { type: 0, cutoff, resonance: 0.7, slope: 12 }; };
  const swept = (amt) => (st) => {
    st.filterA = { type: 0, cutoff: 20000, resonance: 0.7, slope: 12 };
    st.mod = [{ src: MS.lfo2, dst: MT.filterACutoff, amt }];
  };

  const PARKED = await envMin(LP(20));
  const FULL = await envMin(swept(-1));
  check('LFO -> filter cutoff reaches the 20 Hz floor from the 20000 Hz default',
    Math.abs(FULL - PARKED) < 0.2 * PARKED,
    `sweepMin=${FULL.toExponential(3)} parkedMin=${PARKED.toExponential(3)}`);

  // The half-way regression itself: -4 octaves from 20000 Hz is 1250 Hz, which
  // must NOT reach the floor. Guards the specific bug where functionSignal's
  // unipolar remap discarded half the LFO's swing.
  const OLD = await envMin(swept(-0.4));
  check('a -4 octave amount does NOT reach the floor (half-swing regression)',
    OLD > 4 * PARKED,
    `minus4Min=${OLD.toExponential(3)} parkedMin=${PARKED.toExponential(3)} ratio=${(OLD / PARKED).toFixed(1)}x`);
}
{
  // SS161 regression: at the DEFAULT filter (type 0, fc 20000) the LFO must
  // still reach the filter. It previously could not, because `filterIsBypassed`
  // gated the whole filter out of the graph on the static cutoff alone, so the
  // route was dropped and the render was bit-identical with and without it.
  // Asserts DOWNWARD movement at the default, which is the direction that has
  // room: upward from 20000 Hz clamps at the 24000 Hz ceiling (20000*2^4 =
  // 320000), so an upward-only assertion here would be asserting the clamp.
  const cDefault = async (amt) => {
    const { L } = await render((st) => {
      st.filterA = { type: 0, cutoff: 20000, resonance: 0.7, slope: 12 };
      if (amt !== 0) st.mod = [{ src: MS.lfo1, dst: MT.filterACutoff, amt }];
    });
    return centroid(L);
  };
  const d0 = await cDefault(0);
  const dDown = await cDefault(-0.4);
  check('LFO reaches the filter at the DEFAULT 20000 Hz cutoff (was silently dropped)',
    Number.isFinite(d0) && Number.isFinite(dDown) && Math.abs(d0 - dDown) > 25,
    `centroid(amt 0)=${d0.toFixed(1)} centroid(amt -4)=${dDown.toFixed(1)} spread=${Math.abs(d0 - dDown).toFixed(1)}`);
}
{
  // Negative velocity->level route: louder note is quieter than a soft one.
  const hard = rms((await render((st) => {
    st.mod = [{ src: MS.velocity, dst: MT.op1Level, amt: -0.6 }];
    st.voices[0].vel = 1;
  })).L);
  const soft = rms((await render((st) => {
    st.mod = [{ src: MS.velocity, dst: MT.op1Level, amt: -0.6 }];
    st.voices[0].vel = 0.1;
  })).L);
  check('P5 velocity -> op1Level (negative amount)', hard < soft * 0.85, `hard=${hard.toFixed(4)} soft=${soft.toFixed(4)}`);
}
{
  // §111 — Macro 1 is a plain global held value, not per-voice/per-note like
  // every other source above. A higher macro position should scale the
  // route more, same shape as the velocity test.
  const lo = rms((await render((st) => {
    st.mod = [{ src: MS.macro1, dst: MT.op1Level, amt: 0.6 }];
    st.macros = [0.1, 0, 0, 0, 0, 0, 0, 0];
  })).L);
  const hi = rms((await render((st) => {
    st.mod = [{ src: MS.macro1, dst: MT.op1Level, amt: 0.6 }];
    st.macros = [1, 0, 0, 0, 0, 0, 0, 0];
  })).L);
  check('§111 macro1 -> op1Level scales with the macro\'s held value', hi > lo * 1.3, `lo=${lo.toFixed(4)} hi=${hi.toFixed(4)}`);
}
{
  // All eight sources firing at once must not blow up or go silent.
  const { L } = await render((st) => {
    st.mod = Object.values(MS).concat([0]).map((si, i) => ({ src: si, dst: (i % 3) + 1, amt: 0.12 }));
  });
  const r = rms(L);
  check('P5 all sources routed at once stays finite', Number.isFinite(r) && r > 0.005 && r < 3, `rms=${r.toFixed(4)}`);
}

// ---- Master-bus FX (todo.md §79) -----------------------------------------
// Feed masterFx a synthetic burst directly: a 40 ms noise blip at the top of
// the render, then silence. Any energy in a late window came from the FX tail.
// (Can't drive this from a synth note — the offline `el.adsr` snaps to its
// sustain level near-instantly, so decay-to-silence doesn't render.)
async function renderFx(fx, ms = 1600, srcFreq = 0, amp = 0.6) {
  const core = new OfflineRenderer();
  await core.initialize({ numInputChannels: 0, numOutputChannels: 2, sampleRate: SR, blockSize: 512 });
  const n40 = Math.round(0.04 * SR);
  const blip = srcFreq
    ? el.mul(el.le(el.time(), n40), el.cycle(srcFreq), amp)
    : el.mul(el.le(el.time(), n40), el.noise(), amp);
  core.render(...masterFx(blip, blip, fx));
  const n = Math.round((ms / 1000) * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  core.process([], [L, R]);
  return { L, R };
}
function lrCorr(L, R, from, to) {
  let sl = 0, sr = 0, slr = 0;
  for (let i = from; i < to; i++) { sl += L[i] * L[i]; sr += R[i] * R[i]; slr += L[i] * R[i]; }
  return slr / (Math.sqrt(sl * sr) + 1e-12);
}
const FX_LATE = [Math.round(0.9 * SR), Math.round(1.5 * SR)];
{
  const dry = rms((await renderFx({ delay: { timeMs: 150, feedback: 0, tone: 1, mix: 0 }, reverb: { size: 0.5, decay: 0.5, damp: 0.5, mix: 0 } })).L, ...FX_LATE);
  const wet = rms((await renderFx({ delay: { timeMs: 150, feedback: 0.75, tone: 1, mix: 0.9 }, reverb: { size: 0.5, decay: 0.5, damp: 0.5, mix: 0 } })).L, ...FX_LATE);
  check('FX delay rings on past the input', wet > 1e-3 && wet < 1 && wet > dry * 50, `dry=${dry.toExponential(1)} wet=${wet.toExponential(1)}`);
}
{
  const dry = rms((await renderFx({ delay: { timeMs: 150, feedback: 0.3, tone: 0.7, mix: 0 }, reverb: { size: 0.7, decay: 0.85, damp: 0.4, mix: 0 } })).L, ...FX_LATE);
  const wet = rms((await renderFx({ delay: { timeMs: 150, feedback: 0.3, tone: 0.7, mix: 0 }, reverb: { size: 0.7, decay: 0.85, damp: 0.4, mix: 0.9 } })).L, ...FX_LATE);
  check('FX reverb tail decays but sustains past the input', wet > 1e-3 && wet < 1 && wet > dry * 50, `dry=${dry.toExponential(1)} wet=${wet.toExponential(1)}`);
}
{
  const [wL, wR] = await (async () => { const r = await renderFx({ delay: { timeMs: 150, feedback: 0.6, tone: 1, mix: 0.9 }, reverb: { size: 0.5, decay: 0.5, damp: 0.5, mix: 0 } }); return [r.L, r.R]; })();
  check('FX delay decorrelates L/R (stereo width)', rms(wL, ...FX_LATE) > 0 && Math.abs(rms(wL, ...FX_LATE) - rms(wR, ...FX_LATE)) / rms(wL, ...FX_LATE) > 0.02,
    `L=${rms(wL, ...FX_LATE).toExponential(2)} R=${rms(wR, ...FX_LATE).toExponential(2)}`);
}
{
  // mix 0 on both units must be bit-for-bit the no-fx path (the skip guard).
  const noFx = rms((await render(() => {})).L);
  const zeroFx = rms((await render((st) => {
    st.fx = { delay: { timeMs: 300, feedback: 0.5, tone: 0.5, mix: 0 }, reverb: { size: 0.5, decay: 0.5, damp: 0.5, mix: 0 } };
  })).L);
  check('FX mix 0 is a true bypass', Math.abs(noFx - zeroFx) < 1e-6, `noFx=${noFx.toFixed(5)} zeroFx=${zeroFx.toFixed(5)}`);
}
{
  // §86 new FX params — LoCut kills a 100 Hz tone in the delay tail.
  const dly = (locut) => ({ delay: { timeMs: 150, feedback: 0.7, tone: 1, locut, mod: 0, rate: 0.6, width: 0, diffusion: 0, mix: 0.9 }, reverb: { mix: 0 } });
  const full = rms((await renderFx(dly(0), 1600, 100)).L, ...FX_LATE);
  const cut  = rms((await renderFx(dly(1), 1600, 100)).L, ...FX_LATE);
  check('FX delay LoCut kills the low end', cut < full * 0.25 && Number.isFinite(cut), `full=${full.toExponential(1)} cut=${cut.toExponential(1)}`);
}
{
  // Width: L/R correlation of the reverb tail drops toward -1 as width rises.
  const corr = async (width) => {
    const { L, R } = await renderFx({ delay: { mix: 0 }, reverb: { size: 0.7, decay: 0.8, damp: 0.4, locut: 0, mod: 0.1, rate: 0.5, width, diffusion: 0.4, mix: 0.9 } });
    return lrCorr(L, R, ...FX_LATE);
  };
  const narrow = await corr(0);
  const wide   = await corr(1);
  check('FX reverb Width decorrelates L/R', wide < narrow - 0.2 && Number.isFinite(wide), `narrow=${narrow.toFixed(2)} wide=${wide.toFixed(2)}`);
}
{
  // The full 9-param patch on both units stays finite + audible.
  const { L } = await renderFx({
    delay:  { timeMs: 250, feedback: 0.5, tone: 0.6, locut: 0.3, mod: 0.4, rate: 1.2, width: 0.7, diffusion: 0.6, mix: 0.5 },
    reverb: { size: 0.8, decay: 0.7, damp: 0.5, locut: 0.2, mod: 0.5, rate: 0.4, width: 0.9, diffusion: 0.7, mix: 0.5 },
  });
  const r = rms(L, ...FX_LATE);
  check('FX full 9-param patch stays finite + audible', r > 1e-3 && r < 1 && Number.isFinite(r), `rms=${r.toExponential(2)}`);
}
{
  // §113 — the chain is genuinely reorderable, not just accepted-and-ignored:
  // delay->reverb and reverb->delay are two non-commuting LTI systems, so
  // swapping the order with IDENTICAL per-effect settings must change the
  // output. Also covers the `renderFx` call sites above having no `chain`
  // field at all (masterFx's DEFAULT_FX_CHAIN fallback) still working.
  const settings = {
    delay: { timeMs: 200, feedback: 0.5, tone: 0.8, locut: 0.05, mod: 0, rate: 0.6, width: 0.3, diffusion: 0.2, mix: 0.8 },
    reverb: { size: 0.6, decay: 0.6, damp: 0.5, locut: 0.05, mod: 0.1, rate: 0.5, width: 0.4, diffusion: 0.4, mix: 0.8 },
  };
  const a = (await renderFx({ ...settings, chain: ['delay', 'reverb'] })).L;
  const b = (await renderFx({ ...settings, chain: ['reverb', 'delay'] })).L;
  let diff = 0;
  for (let i = FX_LATE[0]; i < FX_LATE[1]; i++) diff += Math.abs(a[i] - b[i]);
  check('§113 FX chain order changes the output (delay→reverb ≠ reverb→delay)',
    Number.isFinite(diff) && diff > 1e-3, `sumAbsDiff=${diff.toExponential(2)}`);
}
{
  // §117 — distortion is a real master-bus processor, not just a chain label:
  // the driven tanh path must measurably differ from the dry signal while
  // remaining bounded and finite.
  const dry = (await renderFx({
    chain: ['distortion'],
    distortion: { drive: 0, tone: 0.7, mix: 0 },
  }, 400, 440)).L;
  const driven = (await renderFx({
    chain: ['distortion'],
    distortion: { drive: 1, tone: 0.8, mix: 1 },
  }, 400, 440)).L;
  let diff = 0;
  let peak = 0;
  for (let i = 0; i < dry.length; i++) {
    diff += Math.abs(dry[i] - driven[i]);
    peak = Math.max(peak, Math.abs(driven[i]));
  }
  check('§117 distortion drive changes and bounds the signal', diff > 1 && peak < 1.1
    && Number.isFinite(diff) && Number.isFinite(peak),
  `sumAbsDiff=${diff.toExponential(2)} peak=${peak.toFixed(3)}`);
}
{
  // §118 — bypass preserves the configured effect but removes it from the
  // signal path, distinct from setting Mix to zero and losing the wet amount.
  const fx = {
    chain: ['distortion'],
    distortion: { enabled: true, drive: 1, tone: 0.8, mix: 1 },
  };
  const active = (await renderFx(fx, 400, 440)).L;
  const bypassed = (await renderFx({ ...fx, distortion: { ...fx.distortion, enabled: false } }, 400, 440)).L;
  let diff = 0;
  for (let i = 0; i < active.length; i++) diff += Math.abs(active[i] - bypassed[i]);
  check('§118 FX bypass removes a slot without changing its settings', diff > 1 && Number.isFinite(diff),
    `sumAbsDiff=${diff.toExponential(2)}`);
}
{
  // §120 — chorus creates a real modulated short-delay signal and remains
  // bounded on both stereo channels.
  const dry = (await renderFx({ chain: ['chorus'], chorus: { enabled: true, rate: 0.35, depth: 0, width: 0.65, mix: 0 } }, 500, 440));
  const wet = (await renderFx({ chain: ['chorus'], chorus: { enabled: true, rate: 0.8, depth: 1, width: 1, mix: 1 } }, 500, 440));
  let diff = 0;
  let peak = 0;
  for (let i = 0; i < dry.L.length; i++) {
    diff += Math.abs(dry.L[i] - wet.L[i]);
    peak = Math.max(peak, Math.abs(wet.L[i]), Math.abs(wet.R[i]));
  }
  check('§120 chorus modulates the signal and stays bounded', diff > 1 && peak < 1.1
    && Number.isFinite(diff) && Number.isFinite(peak),
  `sumAbsDiff=${diff.toExponential(2)} peak=${peak.toFixed(3)}`);
}
{
  // §121 — flanger feedback creates a bounded comb-filtered signal distinct
  // from the dry input.
  const dry = (await renderFx({ chain: ['flanger'], flanger: { enabled: true, rate: 0.25, depth: 0, feedback: 0, width: 0.7, mix: 0 } }, 500, 440));
  const wet = (await renderFx({ chain: ['flanger'], flanger: { enabled: true, rate: 0.7, depth: 1, feedback: 0.75, width: 1, mix: 1 } }, 500, 440));
  let diff = 0;
  let peak = 0;
  for (let i = 0; i < dry.L.length; i++) {
    diff += Math.abs(dry.L[i] - wet.L[i]);
    peak = Math.max(peak, Math.abs(wet.L[i]), Math.abs(wet.R[i]));
  }
  check('§121 flanger feedback modulates the signal and stays bounded', diff > 1 && peak < 2
    && Number.isFinite(diff) && Number.isFinite(peak),
  `sumAbsDiff=${diff.toExponential(2)} peak=${peak.toFixed(3)}`);
}
{
  // §122 — multi-stage phaser produces a distinct, bounded stereo signal.
  const dry = (await renderFx({ chain: ['phaser'], phaser: { enabled: true, rate: 0.35, depth: 0, feedback: 0, stages: 4, mix: 0 } }, 500, 440));
  const wet = (await renderFx({ chain: ['phaser'], phaser: { enabled: true, rate: 0.8, depth: 1, feedback: 0.7, stages: 8, mix: 1 } }, 500, 440));
  let diff = 0;
  let peak = 0;
  for (let i = 0; i < dry.L.length; i++) {
    diff += Math.abs(dry.L[i] - wet.L[i]);
    peak = Math.max(peak, Math.abs(wet.L[i]), Math.abs(wet.R[i]));
  }
  check('§122 phaser stages modulate the signal and stay bounded', diff > 1 && peak < 2
    && Number.isFinite(diff) && Number.isFinite(peak),
  `sumAbsDiff=${diff.toExponential(2)} peak=${peak.toFixed(3)}`);
}
{
  // §123 — multiband compressor processes dynamics and remains bounded.
  const dry = (await renderFx({ chain: ['compressor'], compressor: { enabled: true, lowFreq: 250, highFreq: 2500, threshold: 0.5, ratio: 0.4, attackMs: 10, releaseMs: 100, gain: 1, mix: 0 } }, 500, 440));
  const wet = (await renderFx({ chain: ['compressor'], compressor: { enabled: true, lowFreq: 250, highFreq: 2500, threshold: 0.1, ratio: 0.9, attackMs: 2, releaseMs: 50, gain: 1.2, mix: 1 } }, 500, 440));
  let diff = 0;
  let peak = 0;
  for (let i = 0; i < dry.L.length; i++) {
    diff += Math.abs(dry.L[i] - wet.L[i]);
    peak = Math.max(peak, Math.abs(wet.L[i]), Math.abs(wet.R[i]));
  }
  check('§123 multiband compressor alters dynamics and stays bounded', diff > 1 && peak < 3
    && Number.isFinite(diff) && Number.isFinite(peak),
  `sumAbsDiff=${diff.toExponential(2)} peak=${peak.toFixed(3)}`);
}
{
  // Mix is a real volume control again (the loudness cap was removed on purpose;
  // the UI warns with a white->red container instead): a quiet note is boosted
  // well above dry at mix 100%, but never past the -1 dBFS output ceiling.
  const quietDry = (await renderFx({ chain: ['compressor'], compressor: { enabled: true, lowFreq: 250, highFreq: 2500, lowAmount: 1, midAmount: 1, highAmount: 1, attackMs: 2, releaseMs: 50, gain: 1, mix: 0 } }, 500, 440, 0.03));
  const quietUp  = (await renderFx({ chain: ['compressor'], compressor: { enabled: true, lowFreq: 250, highFreq: 2500, lowAmount: 1, midAmount: 1, highAmount: 1, attackMs: 2, releaseMs: 50, gain: 1, mix: 1 } }, 500, 440, 0.03));
  const rmsDry = rms(quietDry.L, 500, 1800);
  const rmsUp = rms(quietUp.L, 500, 1800);
  let pk = 0; for (let i = 500; i < 1800; i++) pk = Math.max(pk, Math.abs(quietUp.L[i]));
  check('compressor mix 100% boosts a quiet note (no loudness cap) but stays under the -1 dBFS ceiling',
    rmsUp > rmsDry * 3 && pk <= Math.pow(10, -1 / 20) + 1e-3 && Number.isFinite(rmsUp),
    `rmsDry=${rmsDry.toFixed(4)} rmsUp=${rmsUp.toFixed(4)} peak=${pk.toFixed(3)}`);
}
{
  // §124 -> rewritten (todo.md) for the real parametric EQ: `bands` (an
  // array of {freq,gain,q,type}) replaces the old fixed low/mid/high gain
  // knobs entirely. Zero bands must be transparent; a shelf cut + bell
  // boost + shelf boost must audibly reshape the signal and stay bounded.
  const flat = (await renderFx({ chain: ['eq'], eq: { enabled: true, mix: 1, bands: [] } }, 500, 440));
  const shaped = (await renderFx({
    chain: ['eq'],
    eq: {
      enabled: true,
      mix: 1,
      bands: [
        { id: 'b1', freq: 150, gain: -8, q: 0.7, type: 'lowshelf' },
        { id: 'b2', freq: 1000, gain: 6, q: 1.2, type: 'bell' },
        { id: 'b3', freq: 6000, gain: 8, q: 0.7, type: 'highshelf' },
      ],
    },
  }, 500, 440));
  let diff = 0;
  let peak = 0;
  for (let i = 0; i < flat.L.length; i++) {
    diff += Math.abs(flat.L[i] - shaped.L[i]);
    peak = Math.max(peak, Math.abs(shaped.L[i]), Math.abs(shaped.R[i]));
  }
  check('§124 EQ bands reshape the signal and stay bounded', diff > 1 && peak < 2
    && Number.isFinite(diff) && Number.isFinite(peak),
  `sumAbsDiff=${diff.toExponential(2)} peak=${peak.toFixed(3)}`);
}
{
  // A lone bell band's TYPE actually changes its shape — bell vs. lowshelf
  // at the same freq/gain/Q must sound different (a shelf keeps boosting
  // everything below `freq`, a bell returns to flat away from it), proving
  // `applyEqSlot` is really dispatching to different `el.*` filters per
  // band and not, say, always falling through to one type.
  const bell = (await renderFx({ chain: ['eq'], eq: { enabled: true, mix: 1, bands: [
    { id: 'y1', freq: 300, gain: 10, q: 0.7, type: 'bell' },
  ] } }, 500, 60));
  const shelf = (await renderFx({ chain: ['eq'], eq: { enabled: true, mix: 1, bands: [
    { id: 'y1', freq: 300, gain: 10, q: 0.7, type: 'lowshelf' },
  ] } }, 500, 60));
  let typeDiff = 0;
  for (let i = 0; i < bell.L.length; i++) typeDiff += Math.abs(bell.L[i] - shelf.L[i]);
  check('bell vs. lowshelf at the same freq/gain/Q produce audibly different shapes',
    typeDiff > 0.5 && Number.isFinite(typeDiff),
    `typeDiff=${typeDiff.toExponential(2)}`);
}

// ---- P5b — pan + ModAmount mod targets (todo.md §85) ---------------------
{
  // env1 sits at sustain 1 (a near-constant offset). Routed to op1Pan with
  // +amt it pushes the centred operator hard right; with -amt, hard left.
  const bal = async (amt) => {
    const { L, R } = await render((st) => {
      st.env = { attackSec: 0.002, decaySec: 0.02, sustainLevel: 1, releaseSec: 0.1 };
      st.operators[0].pan = 0;
      st.mod = [{ src: 0, dst: 10, amt }]; // env1 -> op1Pan
    }, { ms: 300 });
    return rms(R, 6000, 13000) / (rms(L, 6000, 13000) + 1e-9);
  };
  const right = await bal(0.9);
  const left  = await bal(-0.9);
  check('P5 env1 -> op1Pan moves the image L↔R', right > 3 && left < 0.33 && Number.isFinite(right),
    `+amt R/L=${right.toFixed(2)}  -amt R/L=${left.toFixed(2)}`);
}
{
  // env2 → op1ModAmount: scales OSC 1's PM depth (OSC 2 modulating OSC 1).
  // With the scale the timbre should be brighter (more sidebands) than without.
  const patch = (amt) => (st) => {
    st.operators[0].level = 1; st.operators[1].level = 0;
    st.operators[0].mods = { 1: { pm: 0.35, fm: 0 } }; // OSC1 PM < OSC2
    if (amt) st.mod = [{ src: MS.env2, dst: 14, amt }]; // op1ModAmount
  };
  const plain  = centroid((await render(patch(0))).L);
  const scaled = centroid((await render(patch(0.9))).L);
  check('P5 env2 -> op1ModAmount changes PM depth (brightness)',
    Math.abs(scaled - plain) > plain * 0.05 && Number.isFinite(scaled),
    `plain=${plain.toFixed(1)} scaled=${scaled.toFixed(1)}`);
}
{
  // §95 — a per-knob depth mod (env2 -> op1Pm2, index 32: appended after
  // lfo2Rate) must scale ONLY that (target,source) pair's contribution, NOT
  // the whole operator like op1ModAmount (index 14) does. OSC1 is PM'd by
  // BOTH OSC2 and OSC3 here, so op1ModAmount scales both contributions at
  // once while op1Pm2 scales only the OSC2->OSC1 half — two simultaneous PM
  // sources interact non-additively (sidebands can partially cancel), so
  // don't assert a direction/magnitude relationship between the two, only
  // that both are audible AND that they're clearly NOT the same effect
  // (which is what "isolated" actually means here).
  const patch = (dst) => (st) => {
    st.operators[0].level = 1; st.operators[1].level = 0; st.operators[2].level = 0;
    st.operators[0].mods = { 1: { pm: 0.35, fm: 0 }, 2: { pm: 0.35, fm: 0 } }; // OSC2 + OSC3 both PM OSC1
    if (dst != null) st.mod = [{ src: MS.env2, dst, amt: 0.9 }];
  };
  const plain = centroid((await render(patch(null))).L);
  const perKnob = centroid((await render(patch(32))).L); // op1Pm2 only
  const shared = centroid((await render(patch(14))).L); // op1ModAmount (both pairs)
  check('§95 per-knob PM depth mod (op1Pm2) is isolated from the whole-operator ModAmount',
    Math.abs(perKnob - plain) > plain * 0.02
    && Math.abs(shared - plain) > plain * 0.02
    && Math.abs(perKnob - shared) > plain * 0.02
    && Number.isFinite(perKnob) && Number.isFinite(shared),
    `plain=${plain.toFixed(1)} perKnob=${perKnob.toFixed(1)} shared=${shared.toFixed(1)}`);
}
{
  // Bug: user reported "PM/FM knobs at 0%, add LFO at 100% non-bipolar,
  // should modulate from lowest to highest — but it does nothing." Root
  // cause: op1Pm2/op1Fm2 mod used to be MULTIPLICATIVE (`1+m` scaling the
  // static `pm`/`fm` knob value) — with the knob at 0, 0 * anything is
  // still 0, so no mod route could ever inject depth from a bare base. Fixed
  // to be ADDITIVE. Static PM knob at 0, a strong (0.9) env2 route on
  // op1Pm2 (dst 32) must now produce real PM sidebands.
  const patch = (routed) => (st) => {
    st.operators[0].level = 1; st.operators[1].level = 0;
    st.operators[0].mods = { 1: { pm: 0, fm: 0 } }; // PM knob at 0%
    if (routed) st.mod = [{ src: MS.env2, dst: 32, amt: 0.9 }]; // env2 -> op1Pm2
  };
  const silent = centroid((await render(patch(false))).L);
  const summoned = centroid((await render(patch(true))).L);
  check('bugfix: LFO/env can summon PM depth from a 0% base knob (op1Pm2)',
    Math.abs(summoned - silent) > silent * 0.1 && Number.isFinite(summoned),
    `silent=${silent.toFixed(1)} summoned=${summoned.toFixed(1)}`);
}

// ---- P5c — wave-morph + filter A/B crossfade mod targets (todo.md §87) ---
{
  // env1 (sustain 1) → op1Wave shifts OSC 1 from sine toward brighter shapes.
  const bright = (amt) => (st) => {
    st.env = { attackSec: 0.002, decaySec: 0.02, sustainLevel: 1, releaseSec: 0.1 };
    st.operators[0].wave = 0; // sine
    st.operators[0].level = 1;
    if (amt) st.mod = [{ src: 0, dst: 18, amt }]; // env1 -> op1Wave
  };
  const sine = centroid((await render(bright(0))).L);
  const morphed = centroid((await render(bright(3))).L); // env1 (→1) shifts sine → square
  check('P5 env1 -> op1Wave brightens the tone', morphed > sine * 1.3 && Number.isFinite(morphed),
    `sine=${sine.toFixed(1)} square=${morphed.toFixed(1)}`);
}
{
  // env1 → op1FilterMix pushes OSC 1 from Filter A (open) toward Filter B (LP).
  const patch = (amt) => (st) => {
    st.env = { attackSec: 0.002, decaySec: 0.02, sustainLevel: 1, releaseSec: 0.1 };
    st.operators[0].wave = 2; st.operators[0].level = 1; st.operators[0].filterMix = 0;
    st.filterB = { type: 0, cutoff: 400, resonance: 0.7, slope: 12 }; // dark B
    if (amt) st.mod = [{ src: 0, dst: 22, amt }]; // env1 -> op1FilterMix
  };
  const toA = centroid((await render(patch(0))).L);
  const toB = centroid((await render(patch(1))).L);
  check('P5 env1 -> op1FilterMix routes into Filter B', toB < toA * 0.75 && Number.isFinite(toB),
    `A=${toA.toFixed(1)} B=${toB.toFixed(1)}`);
}

// ---- §88.A — LFO perNote + sync -----------------------------------------
// The offline harness holds `gate` constant (no note-on edge), so
// `el.latch(gate, noise)` samples a fixed artefact value rather than a fresh
// per-note random — same limitation as the ADSR decay tests. So we test the
// ROUTE is wired: +amt and -amt push op1Level opposite ways.
{
  const lvl = async (amt) => rms((await render((st) => {
    st.env = { attackSec: 0.002, decaySec: 0.02, sustainLevel: 1, releaseSec: 0.1 };
    st.operators[0].level = 0.5;
    st.lfo1 = { rateHz: 2, sync: false, perNote: true, wave: 0, shapePosition: 0 };
    st.mod = [{ src: 3, dst: 2, amt }]; // lfo1(perNote) -> op1Level
  })).L);
  const a = await lvl(0.5);
  const b = await lvl(-0.5);
  check('§88.A lfo1 perNote routes to op1Level', Math.abs(a - b) > 0.01 && Number.isFinite(a) && Number.isFinite(b),
    `+amt=${a.toFixed(4)} -amt=${b.toFixed(4)}`);
}
{
  // Function mode uses the same breakpoint schema as the UI editor. A
  // deliberately asymmetric shape should produce a different modulation
  // result from the legacy sine path, proving the points reach the DSP.
  const fn = async (shape) => rms((await render((st) => {
    st.env = { attackSec: 0.002, decaySec: 0.02, sustainLevel: 1, releaseSec: 0.1 };
    st.operators[0].level = 0.25;
    st.lfo1 = { rateHz: 3, sync: false, perNote: false, wave: 5, shapePosition: 0,
      functionShape: shape };
    st.mod = [{ src: 3, dst: 2, amt: 0.8 }]; // function LFO -> op1Level
  })).L);
  const shapeA = { points: [{ time: 0, level: -1, curve: 0 }, { time: 0.2, level: 1, curve: 0 }, { time: 1, level: -1, curve: 0 }], bipolar: true };
  const shapeB = { points: [{ time: 0, level: 0, curve: 0 }, { time: 1, level: 0, curve: 0 }], bipolar: true };
  const a = await fn(shapeA);
  const b = await fn(shapeB);
  check('Pigments Function LFO evaluates breakpoint points', Math.abs(a - b) > 0.005 && Number.isFinite(a) && Number.isFinite(b),
    `shaped=${a.toFixed(4)} flat=${b.toFixed(4)}`);
}
{
  // A tempo-synced LFO stays finite + audible; the actual rate scaling
  // (bpm/120) can't be measured cleanly offline.
  const { L } = await render((st) => {
    st.env = { attackSec: 0.002, decaySec: 0.02, sustainLevel: 1, releaseSec: 0.2 };
    st.operators[0].level = 0.5;
    st.bpm = 240;
    st.lfo1 = { rateHz: 4, sync: true, perNote: false, wave: 0, shapePosition: 0 };
    st.mod = [{ src: 3, dst: 2, amt: 0.4 }];
  });
  const r = rms(L);
  check('§88.A lfo1 sync stays finite + audible', r > 0.01 && r < 3 && Number.isFinite(r), `rms=${r.toFixed(4)}`);
}

// ---- §88.E — Velocity / Keyboard transfer curves ----------------------
{
  // velCurve bends the velocity source: exp curve (+1) makes a mid velocity
  // route weaker than log (-1). Route velocity -> op1Level, mid velocity.
  const at = async (velCurve) => rms((await render((st) => {
    st.env = { attackSec: 0.002, decaySec: 0.02, sustainLevel: 1, releaseSec: 0.1 };
    st.operators[0].level = 0.15;
    st.velCurve = velCurve;
    st.voices[0].vel = 0.5;
    st.mod = [{ src: 6, dst: 2, amt: 0.8 }]; // velocity -> op1Level
  })).L);
  const exp = await at(1);
  const log = await at(-1);
  check('§88.E velCurve reshapes the velocity source', log > exp * 1.3 && Number.isFinite(exp),
    `exp(+1)=${exp.toFixed(4)} log(-1)=${log.toFixed(4)}`);
}

// ---- §114 — Sampler (wave index 4) --------------------------------------
// A real file load can't be exercised headless (that's JUCE's FileChooser +
// AudioFormatManager, native-only) — but the ACTUAL playback path (wave===4
// -> el.sample against "sample:opK:V") is pure dsp/synth.js and IS testable
// via the offline renderer's virtualFileSystem, which stands in for
// PluginProcessor::loadSampleFile registering a SharedResourceMap entry.
{
  const sampleData = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.8);
  const core = new OfflineRenderer();
  await core.initialize({
    numInputChannels: 0, numOutputChannels: 2, sampleRate: SR, blockSize: 512,
    virtualFileSystem: { 'sample:op0:1': sampleData },
  });
  const ops = defaultOperators();
  ops[0] = { wave: 4, level: 1, pan: 0, semis: 0, rootHz: 440, sampleVersion: 1, filterMix: 0, mods: {} };
  const st = {
    master: 0.9, octave: 0, semitone: 0, fineCents: 0,
    env: { attackSec: 0.001, decaySec: 0.5, sustainLevel: 1, releaseSec: 0.2 },
    operators: ops,
    filterA: defaultFilter(), filterB: defaultFilter(),
    // A4 = 440 Hz = the sample's own rootHz -> playback rate ~1.
    voices: Array.from({ length: 8 }, (_, i) => ({ gate: i === 0 ? 1 : 0, freq: midiToFreq(69) })),
  };
  core.render(...renderSynth(st));
  const n = Math.round(0.08 * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  core.process([], [L, R]);
  const r = rms(L);
  check('§114 sampler (wave=4) plays the registered buffer', Number.isFinite(r) && r > 0.01, `rms=${r.toFixed(4)}`);
}
{
  // sampleVersion 0 -> "sample:op0:0", a key loadSampleFile never registers
  // (it always pre-increments before adding) — must render silence, not
  // throw or produce garbage, exactly like Sample.h's own "no active
  // buffer" guard promises.
  //
  // Found while adding the Task 4 wavetable tests below: `path:
  // "sample:op0:0"` is genuinely unregistered, so the WASM-side property
  // set on el.sample's underlying node rejects ("Invalid value for the
  // given node property") — a real async rejection this test was silently
  // dropping (unawaited `core.render()`, no 'error' listener). It never
  // surfaced before because nothing later in the file did enough async work
  // to flush it before `process.exit()`; the wavetable tests' own awaits
  // were what finally exposed it. Silencing it here (not asserting on it —
  // the RMS check below is still the real assertion) documents that this
  // rejection is EXPECTED for this deliberately-invalid path, same as
  // Table.h's/Sample.h's own "no active buffer" guard is expected to noop.
  const core = new OfflineRenderer();
  core.on('error', () => {}); // expected: "sample:op0:0" is never registered
  await core.initialize({ numInputChannels: 0, numOutputChannels: 2, sampleRate: SR, blockSize: 512 });
  const ops = defaultOperators();
  ops[0] = { wave: 4, level: 1, pan: 0, semis: 0, rootHz: 440, sampleVersion: 0, filterMix: 0, mods: {} };
  const st = {
    master: 0.9, octave: 0, semitone: 0, fineCents: 0,
    env: { attackSec: 0.001, decaySec: 0.5, sustainLevel: 1, releaseSec: 0.2 },
    operators: ops,
    filterA: defaultFilter(), filterB: defaultFilter(),
    voices: Array.from({ length: 8 }, (_, i) => ({ gate: i === 0 ? 1 : 0, freq: midiToFreq(69) })),
  };
  await core.render(...renderSynth(st)).catch(() => {});
  const n = Math.round(0.08 * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  core.process([], [L, R]);
  const r = rms(L);
  check('§114 sampler with no loaded file is silent, not a crash', Number.isFinite(r) && r < 1e-6, `rms=${r.toExponential(2)}`);
}

// ---- Task 4 — real wavetable synthesis (wave index 5) ---------------------
// Registers the actual built-in tables (dsp/wavetables.js) via the offline
// renderer's virtualFileSystem — the identical mechanism PluginProcessor's
// native `registerBuiltinWavetables()` stands in for on the plugin side.
// Proves the DSP engine's frame-crossfade actually morphs (not a static
// no-op): table 0 sweeps from a pure sine (frame 0) to a harmonically rich
// buzz (last frame), so scanning wtPos 0 -> 1 must raise the spectral
// centroid meaningfully. ONE shared `core`/registration for every case
// below — SharedResourceMap only allows insertion, never an update (same
// constraint §114's sampler runs into), so re-registering the identical
// "wavetable:0:N" keys on a second OfflineRenderer.initialize() call is not
// safe to rely on; share the instance instead, like a real plugin session
// (built-ins are registered exactly once, at startup) would.
{
  const core = new OfflineRenderer();
  await core.initialize({
    numInputChannels: 0, numOutputChannels: 2, sampleRate: SR, blockSize: 512,
    virtualFileSystem: allBuiltinWavetableResources(),
  });
  const renderAt = (wtPos, extra = {}) => {
    const ops = defaultOperators();
    ops[0] = { wave: 5, level: 1, pan: 0, semis: 0, wtId: 0, wtPos, filterMix: 0, mods: {}, ...extra.op };
    const st = {
      master: 0.9, octave: 0, semitone: 0, fineCents: 0,
      env: { attackSec: 0.001, decaySec: 0.5, sustainLevel: 1, releaseSec: 0.2 },
      operators: ops,
      filterA: defaultFilter(), filterB: defaultFilter(),
      voices: Array.from({ length: 8 }, (_, i) => ({ gate: i === 0 ? 1 : 0, freq: midiToFreq(48) })),
      ...extra.state,
    };
    core.render(...renderSynth(st));
    const n = Math.round(0.3 * SR);
    const L = new Float32Array(n), R = new Float32Array(n);
    core.process([], [L, R]);
    return L;
  };
  const lo = renderAt(0);
  const hi = renderAt(1);
  const rLo = rms(lo);
  const rHi = rms(hi);
  const cLo = centroid(lo);
  const cHi = centroid(hi);
  check('Task 4 wavetable (wave=5) produces sound at frame 0', Number.isFinite(rLo) && rLo > 0.01, `rms=${rLo.toFixed(4)}`);
  check('Task 4 wavetable (wave=5) produces sound at frame N-1', Number.isFinite(rHi) && rHi > 0.01, `rms=${rHi.toFixed(4)}`);
  check('Task 4 wavetable position genuinely morphs timbre (centroid rises)', cHi > cLo * 1.5,
    `centroid(pos=0)=${cLo.toFixed(1)} centroid(pos=1)=${cHi.toFixed(1)}`);

  // The new op1WtPos mod target (appended to MOD_TARGETS) must route
  // through the same modSignal() plumbing every other target uses — a
  // basic wiring smoke test: with env1 -> op1WtPos at full depth and env1
  // near its sustain level offline, the operator must still render sound
  // (not throw, not go silent from an index/lookup mistake).
  const dst = MOD_TARGETS.indexOf('op1WtPos');
  check('Task 4 op1WtPos target resolved (found in MOD_TARGETS)', dst > 0, `index=${dst}`);
  const modded = renderAt(0, {
    state: { env: { attackSec: 0.001, decaySec: 0.01, sustainLevel: 1, releaseSec: 0.2 }, mod: [{ src: 0, dst, amt: 1 }] },
  });
  const rMod = rms(modded);
  check('Task 4 op1WtPos mod route renders sound, not silence/crash', Number.isFinite(rMod) && rMod > 0.01, `rms=${rMod.toFixed(4)}`);

  // Bug fix (todo.md — user: "When in Wavetable mode the PM and FM
  // modulation literally does not work at all") — the wave===5 branch used
  // to build its phasor straight off the bare carrier frequency, ignoring
  // FM/PM inputs entirely, and never tapped out for other operators to read
  // it as a source. Mirrors the "PM depth 0.9 makes a sine carrier much
  // brighter" test near the top of this file, but with the wavetable
  // operator as PM target, then as PM source. wtPos=0 on table 0 is a pure
  // sine (per this block's own header comment), so brightness comparisons
  // read the same way the sine-oscillator PM test's do.
  const renderTwoOps = (op0Extra, op1Extra) => {
    const ops = defaultOperators();
    ops[0] = { wave: 5, level: 1, pan: 0, semis: 0, wtId: 0, wtPos: 0, filterMix: 0, mods: {}, ...op0Extra };
    ops[1] = { wave: 0, level: 0, pan: 0, semis: 12, filterMix: 0, mods: {}, ...op1Extra };
    const st = {
      master: 0.9, octave: 0, semitone: 0, fineCents: 0,
      env: { attackSec: 0.001, decaySec: 0.5, sustainLevel: 1, releaseSec: 0.2 },
      operators: ops,
      filterA: defaultFilter(), filterB: defaultFilter(),
      voices: Array.from({ length: 8 }, (_, i) => ({ gate: i === 0 ? 1 : 0, freq: midiToFreq(48) })),
    };
    core.render(...renderSynth(st));
    const n = Math.round(0.3 * SR);
    const L = new Float32Array(n), R = new Float32Array(n);
    core.process([], [L, R]);
    return L;
  };
  const dryTarget = centroid(renderTwoOps({}, {}));
  const wetTarget = centroid(renderTwoOps({ mods: { 1: { pm: 0.9, fm: 0 } } }, {}));
  check('Task 4 wavetable (wave=5) responds to incoming PM (was a no-op bug)', wetTarget > dryTarget * 1.3,
    `dry=${dryTarget.toFixed(1)} wet=${wetTarget.toFixed(1)}`);

  // Smaller threshold than the target-side check above: the wavetable's raw
  // frame-0 amplitude (whatever wavetables.js actually normalizes it to)
  // isn't guaranteed to match a plain oscillator's, so the brightening a
  // wavetable SOURCE produces is real but more modest — this just needs to
  // confirm the tap wiring exists at all (was fully silent/no-op before).
  const drySource = centroid(renderTwoOps({ level: 0 }, { level: 1 }));
  const wetSource = centroid(renderTwoOps({ level: 0 }, { level: 1, mods: { 0: { pm: 0.9, fm: 0 } } }));
  check('Task 4 wavetable (wave=5) works as a PM SOURCE for another operator (was a no-op bug)', Math.abs(wetSource - drySource) > drySource * 0.03, // same-block PM changes the spectrum (direction depends on phase alignment)
   
    `dry=${drySource.toFixed(1)} wet=${wetSource.toFixed(1)}`);
}

// ---- Task 6 — sampler upgrade: loop, start/end trim, reverse ------------
// All three properties (mode/startOffset/stopOffset) already exist natively
// in Sample.h — this only proves dsp/synth.js actually drives them from the
// new per-op fields (sampleLoop/sampleStart/sampleEnd/sampleReverse/
// sampleFrames), not that the native node itself works (that's elemaudio's).
{
  const FRAMES = 4800; // 0.1s @ 48kHz
  const sampleData = Float32Array.from({ length: FRAMES }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.8);
  const core = new OfflineRenderer();
  await core.initialize({
    numInputChannels: 0, numOutputChannels: 2, sampleRate: SR, blockSize: 512,
    virtualFileSystem: { 'sample:op0:1': sampleData },
  });
  const renderSampler = (extra, ms = 0.3) => {
    const ops = defaultOperators();
    ops[0] = { wave: 4, level: 1, pan: 0, semis: 0, rootHz: 440, sampleVersion: 1, sampleFrames: FRAMES, filterMix: 0, mods: {}, ...extra };
    const st = {
      master: 0.9, octave: 0, semitone: 0, fineCents: 0,
      env: { attackSec: 0.001, decaySec: 0.5, sustainLevel: 1, releaseSec: 0.2 },
      operators: ops,
      filterA: defaultFilter(), filterB: defaultFilter(),
      voices: Array.from({ length: 8 }, (_, i) => ({ gate: i === 0 ? 1 : 0, freq: midiToFreq(69) })),
    };
    core.render(...renderSynth(st));
    const n = Math.round(ms * SR);
    const L = new Float32Array(n), R = new Float32Array(n);
    core.process([], [L, R]);
    return L;
  };
  const oneShot = renderSampler({});
  const looped = renderSampler({ sampleLoop: true });
  const tailFrom = FRAMES * 2; // well past the file's one-shot end
  const tailTo = tailFrom + FRAMES;
  check('Task 6 sampler one-shot (no loop) goes silent after the file ends',
    rms(oneShot, tailFrom, tailTo) < 1e-3, `rms=${rms(oneShot, tailFrom, tailTo).toExponential(2)}`);
  // Relative, not absolute: the voice's 1/sqrt(voices*operators) headroom
  // scaling means the actual achievable RMS here is well under the raw
  // 0.8-amplitude source (~0.09 in this 8-voice/4-op patch, not ~0.57) —
  // compare against the already-passing one-shot's near-silent tail instead
  // of guessing an absolute number.
  check('Task 6 sampleLoop:true keeps sounding well past the file\'s natural length',
    rms(looped, tailFrom, tailTo) > Math.max(1e-3, rms(oneShot, tailFrom, tailTo) * 20),
    `looped=${rms(looped, tailFrom, tailTo).toFixed(4)} oneShot=${rms(oneShot, tailFrom, tailTo).toExponential(2)}`);
}
{
  // Start/end trim: first half of the file is silence, second half a tone.
  const FRAMES = 9600;
  const half = FRAMES / 2;
  const sampleData = Float32Array.from({ length: FRAMES }, (_, i) =>
    i < half ? 0 : Math.sin((2 * Math.PI * 440 * (i - half)) / SR) * 0.8);
  const core = new OfflineRenderer();
  await core.initialize({
    numInputChannels: 0, numOutputChannels: 2, sampleRate: SR, blockSize: 512,
    virtualFileSystem: { 'sample:op0:1': sampleData },
  });
  const renderFrom = (sampleStart) => {
    const ops = defaultOperators();
    ops[0] = { wave: 4, level: 1, pan: 0, semis: 0, rootHz: 440, sampleVersion: 1, sampleFrames: FRAMES, sampleStart, filterMix: 0, mods: {} };
    const st = {
      master: 0.9, octave: 0, semitone: 0, fineCents: 0,
      env: { attackSec: 0.001, decaySec: 0.5, sustainLevel: 1, releaseSec: 0.2 },
      operators: ops,
      filterA: defaultFilter(), filterB: defaultFilter(),
      voices: Array.from({ length: 8 }, (_, i) => ({ gate: i === 0 ? 1 : 0, freq: midiToFreq(69) })),
    };
    core.render(...renderSynth(st));
    const n = half;
    const L = new Float32Array(n), R = new Float32Array(n);
    core.process([], [L, R]);
    return L;
  };
  const fromStart = renderFrom(0);
  const fromHalf = renderFrom(0.5);
  check('Task 6 sampleStart:0 plays the file\'s silent front half first',
    rms(fromStart) < 1e-3, `rms=${rms(fromStart).toExponential(2)}`);
  // Same headroom caveat as the loop test above — ~0.09 is the realistic
  // ceiling here, further diluted by the pitch-smoothing ramp at note-on
  // dominating this short (0.1s) window. 0.02 comfortably separates "has
  // sound" from fromStart's near-zero without assuming full-scale amplitude.
  check('Task 6 sampleStart:0.5 skips straight to the tone',
    rms(fromHalf) > 0.02, `rms=${rms(fromHalf).toFixed(4)}`);
}
{
  // Reverse: a rising linear ramp should come out falling.
  const FRAMES = 4800;
  const sampleData = Float32Array.from({ length: FRAMES }, (_, i) => 0.9 * (i / FRAMES));
  const core = new OfflineRenderer();
  await core.initialize({
    numInputChannels: 0, numOutputChannels: 2, sampleRate: SR, blockSize: 512,
    virtualFileSystem: { 'sample:op0:1': sampleData },
  });
  const renderDir = (sampleReverse) => {
    const ops = defaultOperators();
    ops[0] = { wave: 4, level: 1, pan: 0, semis: 0, rootHz: 440, sampleVersion: 1, sampleFrames: FRAMES, sampleReverse, filterMix: 0, mods: {} };
    const st = {
      master: 0.9, octave: 0, semitone: 0, fineCents: 0,
      env: { attackSec: 0.001, decaySec: 0.5, sustainLevel: 1, releaseSec: 0.2 },
      operators: ops,
      filterA: defaultFilter(), filterB: defaultFilter(),
      voices: Array.from({ length: 8 }, (_, i) => ({ gate: i === 0 ? 1 : 0, freq: midiToFreq(69) })),
    };
    core.render(...renderSynth(st));
    const n = FRAMES;
    const L = new Float32Array(n), R = new Float32Array(n);
    core.process([], [L, R]);
    return L;
  };
  const mean = (a, from, to) => { let s = 0; for (let i = from; i < to; i++) s += a[i]; return s / (to - from); };
  const fwd = renderDir(false);
  const rev = renderDir(true);
  const edge = 400; // skip the amp envelope's attack ramp right at note-on
  check('Task 6 forward playback rises (ramp early < ramp late)',
    mean(fwd, edge, edge + 400) < mean(fwd, FRAMES - 400, FRAMES) * 0.5,
    `early=${mean(fwd, edge, edge + 400).toFixed(3)} late=${mean(fwd, FRAMES - 400, FRAMES).toFixed(3)}`);
  check('Task 6 sampleReverse:true falls (ramp early > ramp late) — time-reversed',
    mean(rev, edge, edge + 400) > mean(rev, FRAMES - 400, FRAMES) * 2,
    `early=${mean(rev, edge, edge + 400).toFixed(3)} late=${mean(rev, FRAMES - 400, FRAMES).toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// SS162 — the ESW loader must actually FIND the 379 wav tables that ship in
// this repo. It could not before: ESW_BASE_DIR pointed at a path that stopped
// existing when the repo moved, and the Node branch called `require`, which
// does not exist in an ES module. Both faults were swallowed by a try/catch,
// so every ESW table quietly served the id-0 harmonic fallback and all 379
// were bit-identical (measured: 379/379). Asserted on the DEFAULT table list,
// not a convenient hand-picked one.
{
  const sameFrame = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const sig = (f) => { let s = 0; for (let i = 0; i < f.length; i++) s += Math.abs(f[i]); return s; };

  const fallback = getBaseWavetableFrames(0)[0];
  // A spread across the categories rather than the first few entries.
  const sampleIds = [2, 3, 40, 120, 200, 280, 340, 380];
  const sampleFrames = sampleIds.map((id) => getBaseWavetableFrames(id)[0]);

  check('SS162 ESW tables load real data, not the harmonic fallback',
    !sameFrame(sampleFrames[0], fallback),
    `esw(id=2) sum=${sig(sampleFrames[0]).toFixed(2)} fallback sum=${sig(fallback).toFixed(2)}`);

  let pairwiseDistinct = true;
  for (let i = 0; i < sampleFrames.length && pairwiseDistinct; i++) {
    for (let j = i + 1; j < sampleFrames.length; j++) {
      if (sameFrame(sampleFrames[i], sampleFrames[j])) { pairwiseDistinct = false; break; }
    }
  }
  check('SS162 sampled ESW tables are distinct from each other (379 were identical)',
    pairwiseDistinct,
    `ids=${sampleIds.join(',')} of ${WAVETABLES.length} entries`);

  check('SS162 ESW tables carry their own frame counts (wav length, not the 8-frame built-ins)',
    getBaseWavetableFrames(2).length !== getBaseWavetableFrames(0).length,
    `frames(id=2)=${getBaseWavetableFrames(2).length} frames(id=0)=${getBaseWavetableFrames(0).length}`);
}

// --- native voicectl (arp/seq timing): note state must not change the graph ---
{
  globalThis.__FAZE_NATIVE_VOICECTL__ = true;
  const mk = (gate, note) => {
    const st = {
      master: 0.9, octave: 0, semitone: 0, fineCents: 0,
      env: { attackSec: 0.001, decaySec: 0.5, sustainLevel: 1, releaseSec: 0.2 },
      operators: defaultOperators(),
      filterA: defaultFilter(), filterB: defaultFilter(),
      voices: Array.from({ length: 8 }, (_, i) => ({ gate: i === 0 ? gate : 0, freq: midiToFreq(note), vel: 0.5 })),
    };
    return JSON.stringify(renderSynth(st));
  };
  const a = mk(1, 57), b = mk(0, 72);
  delete globalThis.__FAZE_NATIVE_VOICECTL__;
  check('voicectl: graph is identical for different note state (no reconcile per note)', a === b);
  check('voicectl: graph uses the native voicectl node', a.includes('voicectl'));
  check('voicectl: browser path (flag off) still bakes note state into the graph', mk(1, 57) !== mk(0, 72));
}


// Portamento: state.glide is the time constant of the note-frequency smoother.
{
  const crossings = (a, from, to) => { let c = 0; for (let i = from + 1; i < to; i++) if (a[i - 1] < 0 && a[i] >= 0) c++; return c; };
  async function pitchJump(glide) {
    const core = new OfflineRenderer();
    await core.initialize({ numInputChannels: 0, numOutputChannels: 2, sampleRate: SR, blockSize: 512 });
    const mk = (note) => ({
      master: 0.9, octave: 0, semitone: 0, fineCents: 0, glide,
      env: { attackSec: 0.001, decaySec: 0.5, sustainLevel: 1, releaseSec: 0.2 },
      operators: defaultOperators(),
      filterA: defaultFilter(), filterB: defaultFilter(),
      voices: Array.from({ length: 8 }, (_, i) => ({ gate: i === 0 ? 1 : 0, freq: midiToFreq(note) })),
    });
    core.render(...renderSynth(mk(45)));
    core.process([], [new Float32Array(SR / 5), new Float32Array(SR / 5)]);
    core.render(...renderSynth(mk(69)));          // two octaves up
    const L = new Float32Array(SR / 5), R = new Float32Array(SR / 5);
    core.process([], [L, R]);
    const w0 = Math.round(0.02 * SR), w1 = w0 + Math.round(0.04 * SR);
    return crossings(L, w0, w1) / 0.04;
  }
  const hard = await pitchJump(0), slow = await pitchJump(0.5);
  check('glide: off -> pitch reaches the new note within ~20 ms', hard > 330, `${hard.toFixed(0)} Hz (target 440)`);
  check('glide: 0.5 s -> still gliding 20-60 ms after the jump', slow < hard * 0.6, `${slow.toFixed(0)} Hz`);
}


// Audio Follower: global 0..1 source following the sidechain INPUT.
{
  const OP1_LEVEL = MOD_TARGETS.indexOf('op1Level');
  const AF_SRC = MOD_SOURCES.indexOf('audiofollower');
  async function afRender(inputFn, af, { ms = 600 } = {}) {
    const core = new OfflineRenderer();
    await core.initialize({ numInputChannels: 2, numOutputChannels: 2, sampleRate: SR, blockSize: 512 });
    const ops = defaultOperators();
    ops[0].level = 0;            // silent unless the follower opens it
    const st = {
      master: 0.9, octave: 0, semitone: 0, fineCents: 0, scopes: false,
      env: { attackSec: 0.001, decaySec: 0.5, sustainLevel: 1, releaseSec: 0.2 },
      operators: ops, filterA: defaultFilter(), filterB: defaultFilter(),
      mod: [{ src: AF_SRC, dst: OP1_LEVEL, amt: 1 }],
      extra: { audiofollower: af },
      voices: Array.from({ length: 8 }, (_, i) => ({ gate: i === 0 ? 1 : 0, freq: midiToFreq(57) })),
    };
    core.render(...renderSynth(st));
    const n = Math.round((ms / 1000) * SR);
    const inL = new Float32Array(n), inR = new Float32Array(n);
    inputFn(inL, inR);
    const L = new Float32Array(n), R = new Float32Array(n);
    core.process([inL, inR], [L, R]);
    return L;
  }
  const sine = (hz, amp) => (a, b) => { for (let i = 0; i < a.length; i++) a[i] = b[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR); };
  const af = { loHz: 20, hiHz: 20000, attackMs: 2, releaseMs: 50, gainDb: 12 };
  const silent = await afRender(() => {}, af);
  const loud = await afRender(sine(200, 0.5), af);
  const n = silent.length;
  check('audio follower: silent input -> silent output', rms(silent, n >> 1, n) < 1e-4, `rms ${rms(silent, n >> 1, n).toExponential(1)}`);
  check('audio follower: loud input opens the modulated level', rms(loud, n >> 1, n) > 0.01, `rms ${rms(loud, n >> 1, n).toFixed(3)}`);
  const inBand = await afRender(sine(200, 0.5), { ...af, loHz: 100, hiHz: 500 });
  const outBand = await afRender(sine(5000, 0.5), { ...af, loHz: 100, hiHz: 500 });
  check('audio follower: band-pass ignores out-of-band input', rms(outBand, n >> 1, n) < rms(inBand, n >> 1, n) * 0.25,
    `in ${rms(inBand, n >> 1, n).toFixed(3)} vs out ${rms(outBand, n >> 1, n).toFixed(3)}`);
  // release: input stops half-way; the follower must decay (not stay open, not drop instantly with a long release)
  const burst = (a, b) => { for (let i = 0; i < a.length >> 1; i++) a[i] = b[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / SR); };
  const slow = await afRender(burst, { ...af, releaseMs: 400 });
  const fast = await afRender(burst, { ...af, releaseMs: 10 });
  const q = Math.round(0.15 * SR), at = (n >> 1) + q;
  check('audio follower: release time shapes the tail', rms(slow, at, at + 2000) > rms(fast, at, at + 2000) * 3,
    `slow ${rms(slow, at, at + 2000).toFixed(3)} fast ${rms(fast, at, at + 2000).toFixed(3)}`);

  // Two Audio Followers at once, different bands, routed to different targets.
  {
    const AF3 = MOD_SOURCES.indexOf('audiofollower3');
    const core = new OfflineRenderer();
    await core.initialize({ numInputChannels: 2, numOutputChannels: 2, sampleRate: SR, blockSize: 512 });
    const ops = defaultOperators(); ops[0].level = 0;
    const st = {
      master: 0.9, octave: 0, semitone: 0, fineCents: 0, scopes: false,
      env: { attackSec: 0.001, decaySec: 0.5, sustainLevel: 1, releaseSec: 0.2 },
      operators: ops, filterA: defaultFilter(), filterB: defaultFilter(),
      mod: [{ src: AF3, dst: OP1_LEVEL, amt: 1 }],
      extra: { audiofollower: { ...af, loHz: 20, hiHz: 100 }, audiofollower3: { ...af, loHz: 3000, hiHz: 8000 } },
      voices: Array.from({ length: 8 }, (_, i) => ({ gate: i === 0 ? 1 : 0, freq: midiToFreq(57) })),
    };
    core.render(...renderSynth(st));
    const n2 = Math.round(0.6 * SR);
    const run = (hz) => { const a = new Float32Array(n2), b = new Float32Array(n2); sine(hz, 0.5)(a, b); const L = new Float32Array(n2), R2 = new Float32Array(n2); core.process([a, b], [L, R2]); return rms(L, n2 >> 1, n2); };
    const hi = run(5000);   // inside AF3's band
    const lo = run(60);     // inside AF1's band only
    check('audio follower 3 follows its own band (5 kHz opens it, 60 Hz does not)', hi > 0.01 && lo < hi * 0.3, `5k ${hi.toFixed(3)} / 60 ${lo.toFixed(3)}`);
  }

  // OUT mode: the follower listens to the synth's own output (no sidechain needed).
  {
    const AF1 = MOD_SOURCES.indexOf('audiofollower');
    const OP2_LEVEL = MOD_TARGETS.indexOf('op2Level');
    const run = async (source, routed) => {
      const core = new OfflineRenderer();
      await core.initialize({ numInputChannels: 2, numOutputChannels: 2, sampleRate: SR, blockSize: 512 });
      const ops = defaultOperators(); ops[1].level = 0;           // op1 plays; op2 only opens via the follower
      const st = {
        master: 0.9, octave: 0, semitone: 0, fineCents: 0, scopes: false,
        env: { attackSec: 0.001, decaySec: 0.5, sustainLevel: 1, releaseSec: 0.2 },
        operators: ops, filterA: defaultFilter(), filterB: defaultFilter(),
        mod: routed ? [{ src: AF1, dst: OP2_LEVEL, amt: 1 }] : [],
        extra: { audiofollower: { ...af, source } },
        voices: Array.from({ length: 8 }, (_, i) => ({ gate: i === 0 ? 1 : 0, freq: midiToFreq(57) })),
      };
      core.render(...renderSynth(st));
      const n3 = Math.round(0.6 * SR); const L = new Float32Array(n3), R3 = new Float32Array(n3);
      core.process([new Float32Array(n3), new Float32Array(n3)], [L, R3]);   // silent sidechain input
      return L;
    };
    const diff = (a, b) => { let d = 0; for (let i = a.length >> 1; i < a.length; i++) d += (a[i] - b[i]) ** 2; return Math.sqrt(d / (a.length >> 1)); };
    const plain = await run(1, false), outMode = await run(1, true), inMode = await run(0, true);
    check('audio follower OUT mode reacts to the synth itself (changes the sound)', diff(outMode, plain) > 0.01, `diff ${diff(outMode, plain).toFixed(3)}`);
    check('audio follower IN mode stays closed with a silent sidechain', diff(inMode, plain) < 1e-4, `diff ${diff(inMode, plain).toExponential(1)}`);
  }
  check('audio follower: no module state -> no source', (await (async () => {
    const st = { master: .9, octave: 0, semitone: 0, fineCents: 0, scopes: false, env: { attackSec: .001, decaySec: .5, sustainLevel: 1, releaseSec: .2 },
      operators: defaultOperators(), filterA: defaultFilter(), filterB: defaultFilter(), mod: [{ src: AF_SRC, dst: OP1_LEVEL, amt: 1 }],
      voices: Array.from({ length: 8 }, () => ({ gate: 0, freq: 440 })) };
    return JSON.stringify(renderSynth(st)).includes('af:');
  })()) === false);
}


// Optional "+" modulators: ENV 4/5 + LFO 4/5 only exist while their state object does.
{
  const OP1_LEVEL = MOD_TARGETS.indexOf('op1Level');
  const lvl = async (src, extra) => {
    const { L } = await render((st) => {
      st.operators[0].level = 0;                       // silent unless the source opens it
      st.mod = [{ src: MOD_SOURCES.indexOf(src), dst: OP1_LEVEL, amt: 1 }];
      Object.assign(st, extra);
    }, { ms: 500 });
    return rms(L, L.length >> 1, L.length);
  };
  const env = { attackSec: 0.001, decaySec: 0.5, sustainLevel: 1, releaseSec: 0.2, attackCurve: 0, decayCurve: 0, releaseCurve: 0 };
  check('env4: routed + present -> opens the level', (await lvl('env4', { extra: { env4: env } })) > 0.01);
  check('env4: routed but module absent -> silent', (await lvl('env4', {})) < 1e-4);
  check('env5: routed + present -> opens the level', (await lvl('env5', { extra: { env5: env } })) > 0.01);
  const lfo = { rateHz: 2, wave: 2, sync: false, perNote: false };   // saw
  check('lfo4: routed + present -> modulates the level', (await lvl('lfo4', { extra: { lfo4: lfo } })) > 0.003);
  check('lfo5: routed but module absent -> silent', (await lvl('lfo5', {})) < 1e-4);

  // Several instances of one type at once (the pool has no fixed per-type amounts).
  check('env11 (highest ENV instance) works', (await lvl('env11', { extra: { env11: env } })) > 0.01);
  check('lfo10 (highest LFO instance) works', (await lvl('lfo10', { extra: { lfo10: lfo } })) > 0.003);
  check('env8 (highest ENV instance) works', (await lvl('env8', { extra: { env8: env } })) > 0.01);
  check('lfo8 (highest LFO instance) works', (await lvl('lfo8', { extra: { lfo8: lfo } })) > 0.003);
  const two = await lvl('env6', { extra: { env6: env, env7: env } });   // two ENVs present, one routed
  check('two ENV instances coexist (only the routed one drives the level)', two > 0.01);
}


// Fresh patch = only ENV 1: ENV 2/3 + LFO 1-3 build only when switched on or routed.
{
  const OP1_LEVEL = MOD_TARGETS.indexOf('op1Level');
  const json = (extra, mod = []) => {
    const st = { master: .9, octave: 0, semitone: 0, fineCents: 0, scopes: false, env: { attackSec: .001, decaySec: .5, sustainLevel: 1, releaseSec: .2 },
      modEnv: { attackSec: .01, decaySec: .2, sustainLevel: .5, releaseSec: .3 }, lfo1: { rateHz: 2, wave: 2 },
      operators: defaultOperators(), filterA: defaultFilter(), filterB: defaultFilter(), mod,
      voices: Array.from({ length: 8 }, (_, i) => ({ gate: i === 0 ? 1 : 0, freq: 220 })), ...extra };
    return JSON.stringify(renderSynth(st));
  };
  const none = { env2: false, env3: false, lfo1: false, lfo2: false, lfo3: false };
  check('default: no modulators on -> no ENV2/LFO1 nodes', !json({ modOn: none }).includes('env2:') && !json({ modOn: none }).includes('lfo1:'));
  check('a route from lfo1 builds it even if the module flag is off', json({ modOn: none }, [{ src: MOD_SOURCES.indexOf('lfo1'), dst: OP1_LEVEL, amt: 1 }]).includes('lfo1:'));
  // (Unrouted sources never reach the emitted graph either way — Elementary only
  // emits nodes reachable from the output — so the flag only saves JS build work.)
}


// Regression: Elementary's `log` is BASE 10. The native-voicectl glide path smooths log2(freq) and
// converts back with 2^x; with the wrong divisor (LN2) A440 came out at 14 Hz ("all notes much lower").
{
  const core = new OfflineRenderer();
  await core.initialize({ numInputChannels: 0, numOutputChannels: 1, sampleRate: SR, blockSize: 512 });
  core.render(el.pow(2, el.div(el.log(el.const({ key: 'logchk', value: 440 })), Math.log10(2))));
  const o = new Float32Array(512 * 40); core.process([], [o]);
  check('el.log is base 10: 2^(log(440)/log10(2)) == 440', Math.abs(o[o.length - 1] - 440) < 0.5, `got ${o[o.length - 1].toFixed(2)}`);
}
// Multi-point envelope (`env.mode === 'multi'`): an arbitrary breakpoint shape
// played once from note-on, holding its last point, then released. The thing an
// ADSR provably CANNOT do is go down and then back up again while the note is
// held, so that is what this asserts.
{
  const SHAPE = { bipolar: false, points: [
    { time: 0, level: 0, curve: 0 },
    { time: 0.15, level: 1, curve: 0 },
    { time: 0.35, level: 0.05, curve: 0 },
    { time: 0.6, level: 0.9, curve: 0 },
    { time: 1, level: 0.6, curve: 0 },
  ] };
  const MULTI = { attackSec: 0.005, decaySec: 0.2, sustainLevel: 0.7, releaseSec: 0.3,
                  mode: 'multi', durationSec: 1.0, shape: SHAPE };
  // Peak amplitude per window = the envelope's contour.
  const windows = (buf, n) => {
    const w = Math.floor(buf.length / n), out = [];
    for (let i = 0; i < n; i++) { let p = 0; for (let j = i * w; j < (i + 1) * w; j++) p = Math.max(p, Math.abs(buf[j])); out.push(p); }
    return out;
  };
  const multi = windows((await render((st) => { st.env = MULTI; }, { ms: 1000 })).L, 8);
  const adsr = windows((await render((st) => { st.env = { ...MULTI, mode: 'adsr' }; }, { ms: 1000 })).L, 8);

  check('multi env: shape rises, DIPS, then rises again while held (an ADSR cannot)',
    multi[1] > multi[0] && multi[2] < multi[1] * 0.7 && multi[4] > multi[2] * 1.5,
    multi.map((v) => v.toFixed(3)).join(' '));
  check('multi env: the same envelope in adsr mode is flat at sustain instead',
    Math.abs(adsr[6] - adsr[3]) < 0.02, adsr.map((v) => v.toFixed(3)).join(' '));
  const degenerate = windows((await render((st) => {
    st.env = { ...MULTI, shape: { points: [{ time: 0, level: 1, curve: 0 }] } };
  }, { ms: 1000 })).L, 8);
  check('multi env: a shape with fewer than 2 points falls back to the ADSR',
    Math.abs(degenerate[6] - adsr[6]) < 1e-6, `${degenerate[6].toFixed(4)} vs ${adsr[6].toFixed(4)}`);

  // Two function shapes with the SAME point count used to collide on a global
  // `fn:last:<n>` el.const key and fight over its value (fixed: per-source prefix).
  const mk = (a, b) => ({ bipolar: false, points: [{ time: 0, level: a, curve: 0 }, { time: 1, level: b, curve: 0 }] });
  const two = await render((st) => {
    st.modOn = { lfo1: true, lfo2: true };
    st.lfo1 = { rateHz: 2, wave: 5, functionShape: mk(0, 1) };
    st.lfo2 = { rateHz: 2, wave: 5, functionShape: mk(1, 0.2) };
  }, { ms: 200 });
  check('two function shapes with equal point counts get distinct const keys',
    rms(two.L) > 0);
}

/**
 * Warp stage 2 (todo.md 2026-10-10 — "Warp 2 silences the synth").
 *
 * NOTE ON SCOPE: this harness is the JS engine, and the JS reference
 * (`generateWavetableFrames`) has always implemented stage 2 correctly — the
 * defect was NATIVE-only (PluginProcessor.cpp bailed before generating any
 * stage-2 resource, so the plugin asked for a key that was never registered,
 * `TableNode::setProperty` returned InvalidPropertyValue, that failed the whole
 * setState batch, and every operator went silent).
 *
 * So these cases pin the JS half of the contract the C++ fix now mirrors, and
 * `.warp2-probe.mjs` covers the native half (it asserts the C++ applies Warp 1
 * then Warp 2 over step 1, and no longer bails). Without this pair the fix
 * could regress on either side independently.
 */
{
  const WT_OP = (extra) => (st) => {
    st.operators[0] = { ...st.operators[0], wave: 2, wtid: 0, wtPos: 0.5, ...extra };
  };

  // The acceptance test named in the audit's task 1: a spectral stage 2 at
  // warpAmount2 = 0.5 must render audible output, not silence.
  const spectral = await render(WT_OP({ warpMode2: 16, warpAmount2: 0.5, warpParam2_2: 0.5 }), { ms: 400 });
  check('warp stage 2 (spectral) renders audible output, not silence',
    rms(spectral.L) > 1e-4, `rms=${rms(spectral.L).toExponential(2)}`);

  // Warp-2-ONLY (stage 1 off). This is the case the native side skipped even
  // BEFORE the `warpMode2 != 0` bail, because the upper gate tested Warp 1 only.
  const stage2Only = await render(WT_OP({ warpMode: 0, warpAmount: 0, warpMode2: 1, warpAmount2: 0.8 }), { ms: 400 });
  check('warp stage 2 works with stage 1 OFF (the case that drove the bail-out)',
    rms(stage2Only.L) > 1e-4, `rms=${rms(stage2Only.L).toExponential(2)}`);

  // Stage 1 + stage 2 composed — the two-stage case. Assert the frames actually
  // DIFFER, not merely that they are audible: three configurations above all
  // measure the same RMS (a resampled table has the same energy), so an
  // "audible" assertion would pass even if stage 2 were ignored entirely. The
  // spread between configurations is what proves the warp is applied — and
  // that stage 1+2 differs from either alone is what proves the composition is
  // ordered rather than either-or.
  const both = await render(WT_OP({ warpMode: 2, warpAmount: 0.5, warpParam2: 0.5, warpMode2: 2, warpAmount2: 0.5, warpParam2_2: 0.5 }), { ms: 400 });
  check('warp stage 1 + stage 2 composed renders audible output',
    rms(both.L) > 1e-4, `rms=${rms(both.L).toExponential(2)}`);

  const f0 = (frames) => frames[0];
  const maxDiff = (a, b) => {
    let m = 0;
    for (let i = 0; i < a.length; i += 1) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;
  };
  const baseF = f0(getBaseWavetableFrames(0));
  const stage1F = f0(generateWavetableFrames(0, 2, 0.5, 0.5, 0, 0, 0.5));
  const stage2F = f0(generateWavetableFrames(0, 0, 0, 0.5, 2, 0.5, 0.5));
  const bothF = f0(generateWavetableFrames(0, 2, 0.5, 0.5, 2, 0.5, 0.5));
  check('stage 2 changes the frames (not just the key)',
    maxDiff(baseF, stage2F) > 1e-3, `maxdiff=${maxDiff(baseF, stage2F).toExponential(2)}`);
  check('stage 1 + stage 2 is NOT the same as either stage alone (order matters)',
    maxDiff(stage1F, bothF) > 1e-3 && maxDiff(stage2F, bothF) > 1e-3,
    `vs stage1=${maxDiff(stage1F, bothF).toExponential(2)}, vs stage2=${maxDiff(stage2F, bothF).toExponential(2)}`);

  // Stage 2 selected but at amount 0 must key to the SAME resource as no warp
  // at all. This is the exact disagreement that made the plugin destructive:
  // the graph asked for a `:w2_` key the native side had decided not to bake.
  check('stage 2 at amount 0 keys identically to no warp',
    wavetableResourceKey(0, 0, 0, 0, 0.5, 5, 0, 0.5) === wavetableResourceKey(0, 0, 0, 0, 0.5, 0, 0, 0.5));
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
