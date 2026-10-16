// Replaces src/renderer/hooks/useSynth — instead of owning a Web-Audio
// SynthEngine, it mirrors `SynthSettings` to/from the native plugin params
// through ui/bridge.ts (todo.md §73, P7a).
//
// The PLUGIN state is authoritative (it's what the host saves with the
// project / recalls from a preset). On mount the UI adopts whatever the
// plugin sends; after that, UI edits push out (coalesced) and external edits
// (host automation, preset recall) merge back in.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SynthSettings } from '../../../src/shared/types';
import { defaultFunctionShape, normalizeFunctionShape, normalizeEqBands, EXTRA_LFO_IDS } from '../../../src/shared/types';
import { bridge } from './bridge';
import { setVoiceReadout } from '../../../src/renderer/lib/voiceStore';
import {
  defaultSynthSettings,
  synthToFlat,
  flatToSynth,
  type FlatParams,
} from './translate';

/** Per-operator sampler metadata (todo.md §114) — NOT part of `SynthSettings`
 *  (it's plugin-only display data: a duration + waveform-preview peaks,
 *  never something the UI edits directly), so it can't flow through the
 *  normal synthToFlat/flatToSynth round trip. Tracked separately here,
 *  straight off every native state push. */
export interface SampleInfo {
  path: string;
  duration: number;
  /** base64 int8[256], same encoding drainScopes uses for scope frames. */
  peaksBase64: string;
  version: number;
}
const EMPTY_SAMPLE: SampleInfo = { path: '', duration: 0, peaksBase64: '', version: 0 };

export interface BridgeSynth {
  synth: SynthSettings;
  change: (patch: Partial<SynthSettings>) => void;
  noteOn: (midi: number, velocity?: number) => void;
  noteOff: (midi: number) => void;
  /** 4 entries, index-aligned with `synth.oscillators`. */
  samples: SampleInfo[];
}

const freqToMidi = (hz: number) => Math.round(69 + 12 * Math.log2(Math.max(1, hz) / 440));
const EPS = 1e-4; // float round-trip tolerance (convertTo0to1 <-> convertFrom0to1)

/** Key-order-independent JSON stringify — used ONLY as a change-detection
 *  key for `fnShapeRef`, never as the actual wire payload. A round trip
 *  through native reorders keys (its `state` map is a C++ `std::map`,
 *  alphabetical by key, regardless of the JS object's insertion order), so
 *  a plain `JSON.stringify` comparison saw every single echo as an
 *  "external change" — which fired a redundant `setFunctionShape` on every
 *  unrelated knob tweak. Each of those triggers an immediate native
 *  dispatch that could race ahead of an in-flight parameter correction
 *  (e.g. `lfo1_wave`), so the UI would see a stale echo, mistake it for an
 *  external edit, and revert that correction — the "knobs snap back and
 *  forth" / "LFOs don't do anything" regression. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function useBridgeSynth(): BridgeSynth {
  const [synth, setSynth] = useState<SynthSettings>(defaultSynthSettings);
  // Latest settings, updated synchronously with every commit. The bridge
  // sends below read from here instead of from a setState updater: updaters
  // are not allowed to have side effects (React may run them twice in dev,
  // and StrictMode did, doubling the messages).
  const synthRef = useRef<SynthSettings>(synth);
  const commitSynth = useCallback((next: SynthSettings) => {
    synthRef.current = next;
    setSynth(next);
  }, []);
  const [samples, setSamples] = useState<SampleInfo[]>(() => [EMPTY_SAMPLE, EMPTY_SAMPLE, EMPTY_SAMPLE, EMPTY_SAMPLE]);

  // Last flat map we believe the plugin holds. Lets an incoming push tell an
  // external edit from an echo of our own write.
  const flatRef = useRef<FlatParams>(synthToFlat(synth));
  const adoptedRef = useRef(false); // has the first plugin state been adopted?

  // Last function-shape JSON we believe the plugin holds, per LFO — mirrors
  // flatRef's echo-suppression above, but for point data, which isn't a
  // bounded host float and so can't ride the numeric flat-param diff below
  // (see bridge.setFunctionShape). Without this, every native echo of our
  // own edit would look like an "external" change and could clobber an
  // in-progress drag in <FunctionEditor>.
  const fnShapeRef = useRef<Record<'lfo1' | 'lfo2' | 'lfo3' | (typeof EXTRA_LFO_IDS)[number], string>>({
    lfo1: stableStringify(synth.lfo1.functionShape),
    lfo2: stableStringify(synth.lfo2.functionShape),
    lfo3: stableStringify(synth.lfo3.functionShape),
    lfo4: stableStringify(synth.modules.lfo4?.functionShape),
    lfo5: stableStringify(synth.modules.lfo5?.functionShape),
    lfo6: stableStringify(synth.modules.lfo6?.functionShape),
    lfo7: stableStringify(synth.modules.lfo7?.functionShape),
    lfo8: stableStringify(synth.modules.lfo8?.functionShape),
    lfo9: stableStringify(synth.modules.lfo9?.functionShape),
    lfo10: stableStringify(synth.modules.lfo10?.functionShape),
  });

  // Same echo-suppression as `fnShapeRef`, for the parametric EQ's band list
  // (todo.md) — also point/array data outside the numeric flat-param diff.
  const eqBandsRef = useRef<string>(stableStringify(synth.fx.eq.bands));

  const change = useCallback((patch: Partial<SynthSettings>) => {
    const next = { ...synthRef.current, ...patch };
    const before = flatRef.current;
    const after = synthToFlat(next);
    for (const k of Object.keys(after)) {
      if (Math.abs((after[k] ?? 0) - (before[k] ?? 0)) > EPS) bridge.setParam(k, after[k]);
    }
    flatRef.current = after;
    (['lfo1', 'lfo2', 'lfo3'] as const).forEach((key, i) => {
      // Never send `undefined` as literal "null" — that would parse on
      // the native side into a real null, and functionSignal's `shape?.
      // points` guard would then fall back to a flat-zero signal (the
      // LFO would just go silent/inert until something else happened to
      // touch it again).
      const shape = next[key].functionShape ?? defaultFunctionShape();
      const dedupeKey = stableStringify(shape);
      if (dedupeKey !== fnShapeRef.current[key]) {
        fnShapeRef.current[key] = dedupeKey;
        bridge.setFunctionShape((i + 1) as 1 | 2 | 3, JSON.stringify(shape));
      }
    });
    // LFO 4/5 only exist once added with the "+" tile; send their shape
    // (and again whenever it changes) exactly like LFO 1-3.
    EXTRA_LFO_IDS.forEach((key) => {
      const lfo = next.modules[key];
      if (!lfo) return;
      const shape = lfo.functionShape ?? defaultFunctionShape();
      const dedupeKey = stableStringify(shape);
      if (dedupeKey !== fnShapeRef.current[key]) {
        fnShapeRef.current[key] = dedupeKey;
        bridge.setFunctionShape(Number(key.slice(3)), JSON.stringify(shape));
      }
    });
    const bands = next.fx.eq.bands;
    const bandsKey = stableStringify(bands);
    if (bandsKey !== eqBandsRef.current) {
      eqBandsRef.current = bandsKey;
      bridge.setEqBands(JSON.stringify(bands));
    }
    commitSynth(next);
  }, [commitSynth]);

  useEffect(() => {
    const off = bridge.onState((flat) => {
      // --- voice readout (every push) ---
      let active = 0;
      const held = new Set<number>();
      for (let i = 0; i < 12; i += 1) { // kNumVoices
        if ((flat[`v${i}_gate`] ?? 0) > 0.5) {
          active += 1;
          held.add(freqToMidi(flat[`v${i}_freq`] ?? 440));
        }
      }
      // External store, not React state: a voice change must not re-render the app (see voiceStore.ts).
      setVoiceReadout(active, held);

      // --- sampler metadata (todo.md §114), every push, not gated by the
      // adopted/external-edit tracking below (that's SynthSettings-only). ---
      const raw = flat as unknown as Record<string, string | number>;
      setSamples((prev) => {
        let changed = false;
        const next = prev.map((cur, k) => {
          const version = Number(raw[`op${k}_sampleversion`] ?? 0);
          if (version === cur.version) return cur;
          changed = true;
          return {
            path: String(raw[`op${k}_samplepath`] ?? ''),
            duration: Number(raw[`op${k}_sampleduration`] ?? 0),
            peaksBase64: String(raw[`op${k}_samplepeaks`] ?? ''),
            version,
          };
        });
        return changed ? next : prev;
      });

      // --- LFO function shapes (todo.md — "all LFOs are functions"), every
      // push, not gated by adopted/external tracking below (point data isn't
      // part of the numeric flat map that tracking diffs). Skips a push that
      // just echoes what we last sent (bridge.setFunctionShape) so it can't
      // clobber an in-progress drag in <FunctionEditor> mid-gesture. ---
      const rawFn = flat as unknown as Record<string, unknown>;
      const prevSynth = synthRef.current;
      let changed = false;
      const nextSynth = { ...prevSynth };
      (['lfo1', 'lfo2', 'lfo3'] as const).forEach((key) => {
        const raw = rawFn[`${key}_functionShape`];
        if (raw == null) return;
        const dedupeKey = stableStringify(raw);
        if (dedupeKey === fnShapeRef.current[key]) return; // our own echo
        fnShapeRef.current[key] = dedupeKey;
        nextSynth[key] = {
          ...nextSynth[key],
          functionShape: normalizeFunctionShape(raw, prevSynth[key].functionShape ?? defaultFunctionShape()),
        };
        changed = true;
      });
      EXTRA_LFO_IDS.forEach((key) => {
        const cur = prevSynth.modules[key];
        const raw = rawFn[`${key}_functionShape`];
        if (!cur || raw == null) return;
        const dedupeKey = stableStringify(raw);
        if (dedupeKey === fnShapeRef.current[key]) return;
        fnShapeRef.current[key] = dedupeKey;
        nextSynth.modules = {
          ...nextSynth.modules,
          [key]: { ...cur, functionShape: normalizeFunctionShape(raw, cur.functionShape ?? defaultFunctionShape()) },
        };
        changed = true;
      });
      if (changed) commitSynth(nextSynth);

      // --- EQ bands (todo.md), every push, same echo-guard pattern as the
      // LFO function shapes just above — array data outside the numeric
      // flat-param diff, so it needs its own dedupe against our last send. ---
      const rawEq = (flat as unknown as Record<string, unknown>).fx_eq_bands;
      if (rawEq != null) {
        const dedupeKey = stableStringify(rawEq);
        if (dedupeKey !== eqBandsRef.current) {
          eqBandsRef.current = dedupeKey;
          const prevSynth = synthRef.current;
          commitSynth({
            ...prevSynth,
            fx: { ...prevSynth.fx, eq: { ...prevSynth.fx.eq, bands: normalizeEqBands(rawEq) } },
          });
        }
      }

      // --- param state ---
      if (!adoptedRef.current) {
        // First push: the plugin state is the truth. Adopt it wholesale.
        adoptedRef.current = true;
        const merged: FlatParams = { ...flatRef.current };
        for (const k of Object.keys(merged)) if (k in flat) merged[k] = flat[k];
        flatRef.current = merged;
        commitSynth(flatToSynth(merged, synthRef.current));
        return;
      }
      // Later pushes: only external edits (automation / preset recall).
      const before = flatRef.current;
      let anyExternal = false;
      let modChanged = false;
      const merged: FlatParams = { ...before };
      for (const k of Object.keys(before)) {
        if (k in flat && Math.abs((flat[k] ?? 0) - (before[k] ?? 0)) > EPS) {
          merged[k] = flat[k];
          anyExternal = true;
          if (/^mod\d_(src|dst|amt)$/.test(k)) modChanged = true;
        }
      }
      if (anyExternal) {
        flatRef.current = merged;
        commitSynth(flatToSynth(merged, synthRef.current, modChanged));
      }
    });
    bridge.ready();
    return off;
  }, [commitSynth]);

  const noteOn = useCallback((midi: number, velocity = 0.8) => {
    bridge.midiNote(midi, true, velocity);
  }, []);
  const noteOff = useCallback((midi: number) => {
    bridge.midiNote(midi, false);
  }, []);

  return { synth, change, noteOn, noteOff, samples };
}
