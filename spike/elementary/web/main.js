// ---------------------------------------------------------------------------
// Browser preview host. Wires the portable DSP (../dsp) to a WebRenderer + the
// on-screen keyboard. The browser equivalent of the VST3 plugin harness: it
// owns the renderer + state and re-renders the Elementary graph on any change.
// ---------------------------------------------------------------------------
import WebRenderer from '@elemaudio/web-renderer';

import {
  renderSynth, defaultOperators, defaultFilter,
  WAVES, FILTER_TYPES, NUM_OPERATORS,
  MOD_SOURCES, MOD_TARGETS, NUM_MOD_SLOTS,
} from '../dsp/synth.js';
import { createAllocator } from '../dsp/allocator.js';
import { installKeyboard } from './keyboard.js';

const NUM_VOICES = 6; // MUST match kNumVoices in PluginProcessor.h (todo.md §73)
const alloc = createAllocator(NUM_VOICES);

const OP_COLORS = ['#37e0d8', '#e05fb0', '#f0a030', '#5fd06a']; // Phase-4 palette

const state = {
  master: 0.7,
  octave: 0,
  semitone: 0,
  fineCents: 0,
  env: { attackSec: 0.005, decaySec: 0.2, sustainLevel: 0.7, releaseSec: 0.4 },
  operators: defaultOperators(),
  filterA: defaultFilter(),
  filterB: defaultFilter(),
  // P5 — mod envelope, LFOs, sample-and-hold rate, 8-slot mod matrix.
  modEnv: { attackSec: 0.005, decaySec: 0.2, sustainLevel: 0.7, releaseSec: 0.4 },
  lfo1: { rateHz: 4, wave: 0 },
  lfo2: { rateHz: 0.5, wave: 1 },
  shRateHz: 8,
  mod: Array.from({ length: NUM_MOD_SLOTS }, () => ({ src: 0, dst: 0, amt: 0 })),
  voices: alloc.voices, // shared reference — allocator mutates in place
};

const LFO_WAVE_LABELS = ['sine', 'triangle', 'saw', 'square', 'S&H'];

let core = null;
let ready = false;

function pushToEngine() {
  if (!ready) return;
  core.render(...renderSynth(state));
  voicesEl.textContent = String(alloc.activeCount());
}

const $ = (id) => document.getElementById(id);
const voicesEl = $('voices');

// --- operator panels (built from state) ---------------------------------
const opsBox = $('operators');
state.operators.forEach((op, k) => {
  const color = OP_COLORS[k];
  const panel = document.createElement('div');
  panel.className = 'panel op';
  panel.style.borderLeft = `3px solid ${color}`;
  const modRows = state.operators
    .map((_, s) => (s === k ? '' : `
      <div class="row modrow">
        <label>from OSC ${s + 1}</label>
        <span class="ml">PM</span><input type="range" min="0" max="1" step="0.01" data-op="${k}" data-src="${s}" data-mod="pm">
        <span class="ml">FM</span><input type="range" min="0" max="1" step="0.01" data-op="${k}" data-src="${s}" data-mod="fm">
      </div>`))
    .join('');
  panel.innerHTML = `
    <h2 style="color:${color}">OSC ${k + 1}</h2>
    <div class="waves" data-op="${k}"></div>
    <div class="row"><label>Level</label><input type="range" min="0" max="1" step="0.01" data-op="${k}" data-field="level"><span class="val"></span></div>
    <div class="row"><label>Pan</label><input type="range" min="-1" max="1" step="0.01" data-op="${k}" data-field="pan"><span class="val"></span></div>
    <div class="row"><label>Pitch (st)</label><input type="range" min="-36" max="36" step="1" data-op="${k}" data-field="semis"><span class="val"></span></div>
    <div class="row"><label>Filter A◂▸B</label><input type="range" min="0" max="1" step="0.01" data-op="${k}" data-field="filterMix"><span class="val"></span></div>
    <div class="modmatrix">${modRows}</div>
  `;
  opsBox.appendChild(panel);

  // mod-matrix sliders for this op
  panel.querySelectorAll('.modrow input[type="range"]').forEach((inp) => {
    const src = Number(inp.dataset.src);
    const kind = inp.dataset.mod;
    inp.value = String((op.mods[src] && op.mods[src][kind]) || 0);
    inp.style.accentColor = OP_COLORS[src];
    inp.oninput = () => {
      op.mods[src] = op.mods[src] || { pm: 0, fm: 0 };
      op.mods[src][kind] = Number(inp.value);
      pushToEngine();
    };
  });

  // wave buttons for this op
  const wb = panel.querySelector(`.waves[data-op="${k}"]`);
  WAVES.forEach((w, wi) => {
    const b = document.createElement('button');
    b.textContent = w;
    b.setAttribute('aria-pressed', String(wi === op.wave));
    b.style.setProperty('--op', color);
    b.onclick = () => {
      op.wave = wi;
      [...wb.children].forEach((c, ci) => c.setAttribute('aria-pressed', String(ci === wi)));
      pushToEngine();
    };
    wb.appendChild(b);
  });

  // level / pan / pitch sliders for this op
  panel.querySelectorAll('input[data-field]').forEach((inp) => {
    const field = inp.dataset.field;
    const out = inp.nextElementSibling;
    const fmt = field === 'semis' ? (v) => `${v > 0 ? '+' : ''}${v}` : (v) => v.toFixed(2);
    inp.value = String(op[field]);
    out.textContent = fmt(op[field]);
    inp.style.accentColor = color;
    inp.oninput = () => {
      op[field] = Number(inp.value);
      out.textContent = fmt(op[field]);
      pushToEngine();
    };
  });
});

// --- dual filter panel ----------------------------------------------
const filtBox = $('filters');
[['filterA', 'Filter A'], ['filterB', 'Filter B']].forEach(([key, label]) => {
  const f = state[key];
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <h2>${label}</h2>
    <div class="waves" data-filt="${key}"></div>
    <div class="row"><label>Cutoff</label><input type="range" min="20" max="20000" step="1" data-filt="${key}" data-ff="cutoff"><span class="val"></span></div>
    <div class="row"><label>Reso</label><input type="range" min="0.3" max="24" step="0.1" data-filt="${key}" data-ff="resonance"><span class="val"></span></div>
    <div class="row"><label>Slope</label>
      <button class="slopebtn" data-filt="${key}" data-slope="12">12 dB</button>
      <button class="slopebtn" data-filt="${key}" data-slope="24">24 dB</button>
    </div>`;
  filtBox.appendChild(panel);

  const tb = panel.querySelector(`.waves[data-filt="${key}"]`);
  FILTER_TYPES.forEach((t, ti) => {
    const b = document.createElement('button');
    b.textContent = t;
    b.setAttribute('aria-pressed', String(ti === f.type));
    b.onclick = () => {
      f.type = ti;
      [...tb.children].forEach((c, ci) => c.setAttribute('aria-pressed', String(ci === ti)));
      pushToEngine();
    };
    tb.appendChild(b);
  });

  panel.querySelectorAll('input[data-ff]').forEach((inp) => {
    const ff = inp.dataset.ff;
    const out = inp.nextElementSibling;
    const fmt = ff === 'cutoff' ? (v) => `${v | 0} Hz` : (v) => v.toFixed(1);
    inp.value = String(f[ff]);
    out.textContent = fmt(f[ff]);
    inp.oninput = () => { f[ff] = Number(inp.value); out.textContent = fmt(f[ff]); pushToEngine(); };
  });

  panel.querySelectorAll('.slopebtn').forEach((b) => {
    const s = Number(b.dataset.slope);
    b.setAttribute('aria-pressed', String(s === f.slope));
    b.onclick = () => {
      f.slope = s;
      panel.querySelectorAll('.slopebtn').forEach((x) =>
        x.setAttribute('aria-pressed', String(Number(x.dataset.slope) === s)));
      pushToEngine();
    };
  });
});

// --- P5: LFO 1 / LFO 2 / S&H rate -------------------------------------
const lfoBox = $('lfopanel');
lfoBox.innerHTML = '<h2>LFO 1 / LFO 2 / S&amp;H</h2>';
[['lfo1', 'LFO 1'], ['lfo2', 'LFO 2']].forEach(([key, label]) => {
  const lfo = state[key];
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label>${label} rate</label>
    <input type="range" min="0.01" max="40" step="0.01" data-lfo="${key}">
    <span class="val"></span>`;
  const inp = row.querySelector('input');
  const out = row.querySelector('.val');
  inp.value = String(lfo.rateHz);
  out.textContent = `${lfo.rateHz.toFixed(2)} Hz`;
  inp.oninput = () => { lfo.rateHz = Number(inp.value); out.textContent = `${lfo.rateHz.toFixed(2)} Hz`; pushToEngine(); };
  lfoBox.appendChild(row);

  const waves = document.createElement('div');
  waves.className = 'waves';
  waves.style.marginBottom = '12px';
  LFO_WAVE_LABELS.forEach((w, wi) => {
    const b = document.createElement('button');
    b.textContent = w;
    b.setAttribute('aria-pressed', String(wi === lfo.wave));
    b.onclick = () => {
      lfo.wave = wi;
      [...waves.children].forEach((c, ci) => c.setAttribute('aria-pressed', String(ci === wi)));
      pushToEngine();
    };
    waves.appendChild(b);
  });
  lfoBox.appendChild(waves);
});
{
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label>S&amp;H rate</label>
    <input type="range" min="0.01" max="40" step="0.01"><span class="val"></span>`;
  const inp = row.querySelector('input');
  const out = row.querySelector('.val');
  inp.value = String(state.shRateHz);
  out.textContent = `${state.shRateHz.toFixed(2)} Hz`;
  inp.oninput = () => { state.shRateHz = Number(inp.value); out.textContent = `${state.shRateHz.toFixed(2)} Hz`; pushToEngine(); };
  lfoBox.appendChild(row);
}

// --- P5: modulation matrix ------------------------------------------
const modBox = $('modpanel');
modBox.innerHTML = '<h2>Mod matrix — source → target × amount</h2>';
state.mod.forEach((slot) => {
  const rowEl = document.createElement('div');
  rowEl.className = 'modslot';
  const srcOpts = MOD_SOURCES.map((s, si) => `<option value="${si}">${s}</option>`).join('');
  const dstOpts = MOD_TARGETS.map((t, ti) => `<option value="${ti}">${t}</option>`).join('');
  rowEl.innerHTML = `
    <select data-k="src">${srcOpts}</select>
    <select data-k="dst">${dstOpts}</select>
    <input type="range" min="-1" max="1" step="0.01" value="0">
    <span class="val">0.00</span>`;
  const [srcSel, dstSel] = rowEl.querySelectorAll('select');
  const amtInp = rowEl.querySelector('input');
  const amtOut = rowEl.querySelector('.val');
  srcSel.value = String(slot.src);
  dstSel.value = String(slot.dst);
  const refresh = () => {
    rowEl.classList.toggle('active', slot.dst > 0 && Math.abs(slot.amt) > 1e-4);
    amtOut.textContent = slot.amt.toFixed(2);
  };
  srcSel.onchange = () => { slot.src = Number(srcSel.value); refresh(); pushToEngine(); };
  dstSel.onchange = () => { slot.dst = Number(dstSel.value); refresh(); pushToEngine(); };
  amtInp.oninput = () => { slot.amt = Number(amtInp.value); refresh(); pushToEngine(); };
  refresh();
  modBox.appendChild(rowEl);
});

// --- ADSR + global sliders --------------------------------------------
function bindSlider(id, path, fmt = (v) => v.toFixed(2)) {
  const inp = $(id);
  const out = $(`${id}-v`);
  const get = () => path.split('.').reduce((o, k) => o[k], state);
  const set = (v) => {
    const keys = path.split('.');
    const last = keys.pop();
    keys.reduce((o, k) => o[k], state)[last] = v;
  };
  inp.value = String(get());
  out.textContent = fmt(get());
  inp.oninput = () => {
    const v = Number(inp.value);
    set(v);
    out.textContent = fmt(v);
    pushToEngine();
  };
}
bindSlider('attackSec', 'env.attackSec', (v) => `${(v * 1000) | 0} ms`);
bindSlider('decaySec', 'env.decaySec', (v) => `${(v * 1000) | 0} ms`);
bindSlider('sustainLevel', 'env.sustainLevel');
bindSlider('releaseSec', 'env.releaseSec', (v) => `${(v * 1000) | 0} ms`);
bindSlider('env2_a', 'modEnv.attackSec', (v) => `${(v * 1000) | 0} ms`);
bindSlider('env2_d', 'modEnv.decaySec', (v) => `${(v * 1000) | 0} ms`);
bindSlider('env2_s', 'modEnv.sustainLevel');
bindSlider('env2_r', 'modEnv.releaseSec', (v) => `${(v * 1000) | 0} ms`);
bindSlider('octave', 'octave', (v) => String(v));
bindSlider('semitone', 'semitone', (v) => String(v));
bindSlider('fineCents', 'fineCents', (v) => String(v));
bindSlider('master', 'master');

// --- keyboard --------------------------------------------------------
let baseMidi = 60;
installKeyboard($('keyboard'), {
  onNoteOn: (midi, vel) => { alloc.noteOn(midi, vel); pushToEngine(); },
  onNoteOff: (midi) => { alloc.noteOff(midi); pushToEngine(); },
  getBaseMidi: () => baseMidi,
  shiftOctave: (dir) => { baseMidi = Math.max(12, Math.min(108, baseMidi + dir * 12)); },
});

// --- start audio on user gesture ------------------------------------
$('start').onclick = async () => {
  if (ready) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  core = new WebRenderer();
  const node = await core.initialize(ctx, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  node.connect(ctx.destination);
  await ctx.resume();
  core.on('error', (e) => console.error('[elementary]', e));

  window.__spike = { core, ctx, state, alloc, pushToEngine, NUM_OPERATORS };

  ready = true;
  $('start').textContent = '● Audio running';
  $('start').disabled = true;
  $('app').classList.remove('gate');
  pushToEngine();
};
