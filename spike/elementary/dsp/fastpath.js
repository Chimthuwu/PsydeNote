// Fast path for value-only parameter changes (todo.md — FM/PM and FX lag, option 2).
//
// A full reconcile re-runs renderSynth in QuickJS, which costs ~0.5-1 s on the plugin's message thread. Most knob
// moves change nothing but the VALUE of a `const` node. Elementary identifies a keyed node by its key, not its
// value, so a changed value can be pushed straight to the mounted node with one SET_PROPERTY instruction and no
// graph rebuild. This module decides when that is safe and applies it.
//
// Safe = every changed state key is a PM or FM amount (`op{k}_pm{src}` / `op{k}_fm{src}`) and it stays on the same
// side of zero (renderSynth only builds those nodes when the amount is above zero, so crossing zero changes the
// structure and needs a full render). Anything else returns null and the caller does the full render.
import { el } from '@elemaudio/core';

const PM_FM_KEY = /^op(\d+)_(pm|fm)(\d+)$/;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Value updates for the const nodes behind the changed PM/FM amounts, or null if a full render is needed. */
export function fastValueUpdates(prev, next, { numVoices, pmIndex, fmDepthHz }) {
  if (!prev || !next || prev.sampleRate !== next.sampleRate) return null;
  const out = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    if (/^v\d+_/.test(k)) continue; // voice readouts never reach the graph
    const pv = prev[k];
    const nv = next[k];
    if (pv === nv) continue;
    const m = PM_FM_KEY.exec(k);
    if (!m) return null; // any other change (pitch, filter, FX, bpm, …) needs the full render
    const before = clamp01(pv ?? 0);
    const after = clamp01(nv ?? 0);
    if ((before > 0) !== (after > 0)) return null; // crossing zero adds or removes nodes
    const kind = m[2];
    const scale = kind === 'pm' ? pmIndex : fmDepthHz;
    for (let vi = 0; vi < numVoices; vi++) {
      out.push({ key: `v${vi}:op${m[1]}:${kind}:${m[3]}`, value: after * scale });
    }
  }
  return out;
}

/** Push the values to the already-mounted const nodes. Returns false (and sends nothing) if any node is missing. */
export function applyConstValues(core, updates) {
  const d = core._delegate;
  const targets = [];
  for (const u of updates) {
    const hash = el.const({ key: u.key, value: u.value }).hash;
    const copy = d.nodeMap.get(hash);
    if (!copy) return false; // this operator/voice is not in the graph: fall back to a full render
    targets.push({ hash, copy, value: u.value });
  }
  d.clear();
  for (const t of targets) {
    if (t.copy.props.value === t.value) continue;
    d.setProperty(t.hash, 'value', t.value);
    t.copy.props.value = t.value; // keep the mounted-node record in step with what was sent
  }
  d.commitUpdates();
  core._sendMessage(d.getPackedInstructions());
  return true;
}
