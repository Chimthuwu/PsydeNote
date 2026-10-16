// Type declarations for `dsp/wavetables.js`.
//
// The wavetable DSP module is plain ESM JavaScript: it is bundled by esbuild
// for the plugin (dist/dsp.main.js) and by vite for the browser spike, and
// `allowJs` is off everywhere, so TypeScript could not see it at all. Two
// reused components import it by path —
// `src/renderer/components/OscillatorPanel.tsx` (WAVETABLES, for the
// WT-select `<option>` list) and `.../WavetableGraphic.tsx`
// (getWavetableFrame) — which made the whole import implicitly `any`
// (TS7016) and every callback parameter over it implicitly `any` (TS7006)
// (todo.md SS149 item 6).
//
// This file is a hand-maintained mirror of the module's exports: keep it in
// sync when `wavetables.js` gains or changes an export. It deliberately types
// frames as `Float32Array` because that is what the DSP code allocates, and
// the parameter lists as required-first / optional-defaulted so a caller
// cannot silently drop a warp argument.

export const FRAME_SIZE: number;
export const NUM_FRAMES: number;

export interface WarpMode {
  id: number;
  name: string;
  domain: 'none' | 'phase' | 'spectral';
  param2Name?: string;
}

export const WARP_MODES: WarpMode[];

export interface WavetableEntry {
  id: number;
  category: string;
  name: string;
  /** Repo-relative path of the source wav, ESW tables only. */
  path?: string;
}

export const WAVETABLES: WavetableEntry[];

export interface FrameSpectrum {
  mag: Float32Array;
  phase: Float32Array;
}

export function removeDC(frame: Float32Array): Float32Array;
export function normalize(frame: Float32Array): Float32Array;

export function warpPhase(ph: number, mode: number, amount: number, param2?: number): number;

export function analyzeFrame(frame: Float32Array, numHarmonics?: number): FrameSpectrum;
export function synthesizeFrame(spectrum: FrameSpectrum, frameSize?: number): Float32Array;

export function applySpectralWarp(
  frame: Float32Array,
  mode: number,
  amount: number,
  param2?: number,
  allFrames?: Float32Array[] | null,
  currentFrameIdx?: number,
): Float32Array;

export function applyWaveWarp(
  frame: Float32Array,
  mode: number,
  amount: number,
  param2?: number,
): Float32Array;

export function getBaseWavetableFrames(id: number): Float32Array[];

export function generateWavetableFrames(
  id: number,
  warpMode?: number,
  warpAmount?: number,
  warpParam2?: number,
  warpMode2?: number,
  warpAmount2?: number,
  warpParam2_2?: number,
): Float32Array[];

export function wavetableResourceKey(
  id: number,
  frameIndex: number,
  warpMode?: number,
  warpAmount?: number,
  warpParam2?: number,
  warpMode2?: number,
  warpAmount2?: number,
  warpParam2_2?: number,
): string;

export function getWavetableFrame(
  id: number,
  frameIndex: number,
  warpMode?: number,
  warpAmount?: number,
  warpParam2?: number,
  warpMode2?: number,
  warpAmount2?: number,
  warpParam2_2?: number,
): Float32Array;

export function allBuiltinWavetableResources(): Record<string, Float32Array>;

/** wtIds hidden from the UI (removed tables keep their reserved slot). */
export const REMOVED_WAVETABLE_IDS: Set<number>;
