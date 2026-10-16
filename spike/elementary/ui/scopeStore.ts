// Module-level store for native el.scope frames (todo.md §73 P7c).
//
// C++ (`drainScopes`) forwards ~30Hz batches as
//   window.__receiveScopes__({ main: <base64 int8[512]>, op0: <int8[128]>, ... })
// `main` gets more points than the per-op scopes (todo.md §101/§102) since
// it renders far wider on screen — `decode()` below sizes itself off the
// actual payload length, no per-source special-casing needed here.
// We decode into Float32Array (-1..1) and bump a per-source version so the
// Scope components (which poll on their own rAF) only redraw on new data.

export type ScopeSource = 'main' | 'op0' | 'op1' | 'op2' | 'op3' | 'eq_pre' | 'eq_post' | 'af';

const buffers = new Map<string, Float32Array>();
const versions = new Map<string, number>();

function decode(b64: string): Float32Array {
  // int16 little-endian (todo.md SS168) — was int8, which put a ~-42 dB noise
  // floor under every spectrum.
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    out[i] = (v & 0x8000 ? v - 0x10000 : v) / 32767;
  }
  return out;
}

function install() {
  (window as unknown as { __receiveScopes__?: (m: Record<string, string>) => void })
    .__receiveScopes__ = (m) => {
    for (const key of Object.keys(m)) {
      try {
        const next = decode(m[key]);
        const prev = buffers.get(key);
        // Skip redundant "still silent" frames so idle operator scopes don't
        // burn redraws (user: "laggy").
        if (next.length === 0 && (!prev || prev.length === 0)) continue;
        buffers.set(key, next);
        versions.set(key, (versions.get(key) ?? 0) + 1);
      } catch {
        /* ignore a malformed frame */
      }
    }
  };
}
if (typeof window !== 'undefined') install();

export function getScope(source: string): Float32Array | null {
  return buffers.get(source) ?? null;
}
export function getScopeVersion(source: string): number {
  return versions.get(source) ?? 0;
}

// --------------------------------------------------------------------------
// Visualizer reactivity (todo.md §92, split per-group in §96 — user: "if I
// set one, it sets it to all of them" — was a single module-level number
// shared by every Scope instance). A draw-time amplitude multiplier — the
// scopes barely move on a quiet patch, and the main scope only looks alive
// with every operator stacked. Display only, never touches audio. Ported
// from Recordr's `vizGain`. Persisted per group; read live each frame.
//
// Two independent groups: the big relocated main visualizer gets its own
// setting; the 4 per-operator scopes share ONE setting between them (user:
// "we can have the OSC visualizers synced... but the big one has to be
// separate"), so adjusting one op scope's reactivity still applies to all
// 4 at once — only "main" is carved out on its own.
// --------------------------------------------------------------------------
// SS163 (user, with the top visualizer in a non-scope mode: "visualizer still
// hardly reactive and the graphic is kinda pixelatd or distoreted").
//
// 1. REACTIVITY: 6 was the TOP of the list, so "I set it to 6x and it barely
//    moves" was the user pinned against the end of the range with nothing left
//    to give. Measured at the worst realistic case -- all 4 OSC levels at 1.0,
//    one note held -- the master bus peaks at only 0.267, because renderSynth
//    divides by 1/sqrt(voices * NUM_OPERATORS) = 1/sqrt(24) = 0.204 for
//    headroom. 0.267 * 6 = 1.6 peak but only 0.92 RMS, so a quiet patch never
//    fills the canvas and there was no setting that could make it. Presets now
//    run to 16 and the stored-value clamp matches, so the range can actually
//    be dialled past the old ceiling.
export const VIZ_GAIN_PRESETS = [1, 1.5, 2, 3, 4, 6, 8, 12, 16] as const;
type VizGainGroup = 'main' | 'op';
const gainGroupFor = (source: string): VizGainGroup => (source === 'main' ? 'main' : 'op');

const vizGains: Record<VizGainGroup, number> = { main: 1, op: 1 };
try {
  (['main', 'op'] as VizGainGroup[]).forEach((group) => {
    const stored = Number(localStorage.getItem(`faze.viz.gain.${group}`));
    if (Number.isFinite(stored) && stored > 0) vizGains[group] = Math.min(32, Math.max(0.5, stored));
  });
} catch { /* private mode / no storage */ }

export function getVizGain(source: string): number {
  return vizGains[gainGroupFor(source)];
}
export function setVizGain(source: string, g: number): void {
  const group = gainGroupFor(source);
  vizGains[group] = Math.min(8, Math.max(0.5, g));
  try { localStorage.setItem(`faze.viz.gain.${group}`, String(vizGains[group])); } catch { /* ignore */ }
}

/** RMS of the latest frame for `source`, 0..~1. 0 when there's no data. */
export function getScopeRms(source: string): number {
  const b = buffers.get(source);
  if (!b || b.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < b.length; i += 1) s += b[i] * b[i];
  return Math.sqrt(s / b.length);
}
