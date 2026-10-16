// ---------------------------------------------------------------------------
// Wavetable Engine & 28/30 Warp Modes for Elemental Audio
// Supports multi-frame wavetables, phase-domain warping, and preprocessed
// spectral-domain transformations (FFT/Harmonic synthesis).
// ---------------------------------------------------------------------------

export const FRAME_SIZE = 2048; // samples per single-cycle frame
export const NUM_FRAMES = 8; // frames per built-in table

export const WARP_MODES = [
  { id: 0, name: 'None', domain: 'none' },
  { id: 1, name: 'Bend +', domain: 'phase', param2Name: 'Center' },
  { id: 2, name: 'Bend -', domain: 'phase', param2Name: 'Center' },
  { id: 3, name: 'Asymmetry', domain: 'phase', param2Name: 'Skew' },
  { id: 4, name: 'Sync', domain: 'phase', param2Name: 'Cycles' },
  { id: 5, name: 'Mirror', domain: 'phase', param2Name: 'Center' },
  { id: 6, name: 'Reflect', domain: 'phase', param2Name: 'Segments' },
  { id: 7, name: 'PWM', domain: 'phase', param2Name: 'Width' },
  { id: 8, name: 'Quantize', domain: 'phase', param2Name: 'Steps' },
  { id: 9, name: 'Squeeze / Expand', domain: 'phase', param2Name: 'Curve' },
  { id: 10, name: 'FM-Like', domain: 'phase', param2Name: 'Ratio' },
  { id: 11, name: 'Wavefold', domain: 'phase', param2Name: 'Drive' },
  { id: 12, name: 'Shear', domain: 'phase', param2Name: 'Offset' },
  { id: 13, name: 'Formant', domain: 'spectral', param2Name: 'Center' },
  { id: 14, name: 'Bitcrush', domain: 'phase', param2Name: 'Bits' },
  { id: 15, name: 'Wave Rectify', domain: 'phase', param2Name: 'Mode' },
  { id: 16, name: 'Harmonic Stretch', domain: 'spectral', param2Name: 'Factor' },
  { id: 17, name: 'Comb / Ripple', domain: 'spectral', param2Name: 'Freq' },
  { id: 18, name: 'Inharmonic Stretch', domain: 'spectral', param2Name: 'Shift' },
  { id: 19, name: 'Smear', domain: 'spectral', param2Name: 'Radius' },
  { id: 20, name: 'Phase Disperse', domain: 'spectral', param2Name: 'Curve' },
  { id: 21, name: 'Spectral Freeze', domain: 'spectral', param2Name: 'Hold' },
  { id: 22, name: 'Odd / Even', domain: 'spectral', param2Name: 'Balance' },
  { id: 23, name: 'Harmonic Shift', domain: 'spectral', param2Name: 'Shift' },
  { id: 24, name: 'Spectral Fold', domain: 'spectral', param2Name: 'Cutoff' },
  { id: 25, name: 'Harmonic Random', domain: 'spectral', param2Name: 'Seed' },
  { id: 26, name: 'Phase Randomize', domain: 'spectral', param2Name: 'Seed' },
  { id: 27, name: 'Harmonic Rotate', domain: 'spectral', param2Name: 'Speed' },
  { id: 28, name: 'Spectral Warp', domain: 'spectral', param2Name: 'Curve' },
  { id: 29, name: 'Spectral Morph', domain: 'spectral', param2Name: 'Frame B' },
];

export function removeDC(frame) {
  let mean = 0;
  for (let i = 0; i < frame.length; i++) mean += frame[i];
  mean /= frame.length;
  for (let i = 0; i < frame.length; i++) frame[i] -= mean;
  return frame;
}

export function normalize(frame) {
  let peak = 0;
  for (let i = 0; i < frame.length; i++) peak = Math.max(peak, Math.abs(frame[i]));
  const g = peak > 1e-6 ? 0.92 / peak : 1;
  for (let i = 0; i < frame.length; i++) frame[i] *= g;
  return frame;
}

/** Phase remapping helper for real-time phase domain warps. */
export function warpPhase(ph, mode, amount, param2 = 0.5) {
  if (!mode || !amount) return ph;
  const p = Math.max(0, Math.min(0.999999, ph - Math.floor(ph)));
  const a = Math.max(-0.99, Math.min(0.99, amount));

  switch (mode) {
    case 1: { // Bend+
      const center = Math.max(0.1, Math.min(0.9, param2));
      if (p < center) return (p / center) * (0.5 * (1 + a));
      return 0.5 * (1 + a) + ((p - center) / (1 - center)) * (1 - 0.5 * (1 + a));
    }
    case 2: { // Bend-
      const center = Math.max(0.1, Math.min(0.9, param2));
      const invA = -a;
      if (p < center) return (p / center) * (0.5 * (1 + invA));
      return 0.5 * (1 + invA) + ((p - center) / (1 - center)) * (1 - 0.5 * (1 + invA));
    }
    case 3: { // Asymmetry
      const k = a * 0.99;
      return k >= 0 ? p * (1 - k) + p * p * k : p * (1 + k) - p * p * k;
    }
    case 4: { // Sync
      const cycles = 1 + a * (1 + param2 * 15);
      return (p * cycles) % 1;
    }
    case 5: { // Mirror
      const thresh = Math.max(0.05, Math.min(0.95, param2));
      if (p < thresh) return (p / thresh) * 0.5;
      return 0.5 + ((1 - (p - thresh) / (1 - thresh)) * 0.5);
    }
    case 6: { // Reflect
      const segs = 1 + Math.floor(a * 7);
      const x = p * segs;
      const seg = Math.floor(x);
      const local = x - seg;
      return (seg % 2 === 1 ? 1 - local : local);
    }
    case 7: { // PWM
      const width = Math.max(0.05, Math.min(0.95, param2));
      const skew = 0.5 + a * 0.45;
      if (p < width) return (p / width) * skew;
      return skew + ((p - width) / (1 - width)) * (1 - skew);
    }
    case 8: { // Quantize
      const steps = Math.max(2, Math.floor(2 + a * 30));
      return Math.floor(p * steps) / steps;
    }
    case 9: { // Squeeze/Expand
      const exp = Math.pow(2, (a - 0.5) * 4);
      return Math.pow(p, exp);
    }
    case 10: { // FM-Like
      const ratio = 1 + Math.floor(param2 * 8);
      const mod = Math.sin(2 * Math.PI * p * ratio) * a * 0.5;
      return (p + mod + 1) % 1;
    }
    case 12: { // Shear
      const offset = (p - 0.5) * a;
      return (p + offset + 1) % 1;
    }
    default:
      return p;
  }
}

/** Analyze Float32Array single-cycle frame into magnitudes and phases (up to 128 harmonics). */
export function analyzeFrame(frame, numHarmonics = 128) {
  const mag = new Float32Array(numHarmonics + 1);
  const phase = new Float32Array(numHarmonics + 1);
  const N = frame.length;

  for (let h = 1; h <= numHarmonics; h++) {
    let re = 0;
    let im = 0;
    const factor = (2 * Math.PI * h) / N;
    for (let n = 0; n < N; n++) {
      const theta = factor * n;
      re += frame[n] * Math.cos(theta);
      im -= frame[n] * Math.sin(theta);
    }
    re /= (N / 2);
    im /= (N / 2);
    mag[h] = Math.hypot(re, im);
    phase[h] = Math.atan2(im, re);
  }
  return { mag, phase };
}

/** Synthesize single-cycle Float32Array frame from magnitudes and phases. */
export function synthesizeFrame({ mag, phase }, frameSize = FRAME_SIZE) {
  const frame = new Float32Array(frameSize);
  const numHarmonics = mag.length - 1;
  for (let n = 0; n < frameSize; n++) {
    let s = 0;
    const thetaBase = (2 * Math.PI * n) / frameSize;
    for (let h = 1; h <= numHarmonics; h++) {
      if (mag[h] > 1e-5) {
        s += mag[h] * Math.sin(thetaBase * h + phase[h]);
      }
    }
    frame[n] = s;
  }
  return normalize(removeDC(frame));
}

/** Deterministic random float 0..1 from integer seed */
function pseudoRandom(seed) {
  let x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}

/** Apply Spectral Warp transformation to harmonic magnitudes & phases. */
export function applySpectralWarp(frame, mode, amount, param2 = 0.5, allFrames = null, currentFrameIdx = 0) {
  if (!mode || amount === 0) return new Float32Array(frame);

  const numHarmonics = 128;
  const { mag, phase } = analyzeFrame(frame, numHarmonics);
  const newMag = new Float32Array(numHarmonics + 1);
  const newPhase = new Float32Array(numHarmonics + 1);

  for (let h = 1; h <= numHarmonics; h++) {
    newMag[h] = mag[h];
    newPhase[h] = phase[h];
  }

  const a = Math.max(0, Math.min(1, amount));

  switch (mode) {
    case 13: { // Formant
      const center = 2 + param2 * 30;
      const sigma = 1 + (1 - a) * 8;
      for (let h = 1; h <= numHarmonics; h++) {
        const gain = Math.exp(-((h - center) ** 2) / (2 * sigma * sigma));
        newMag[h] *= (1 - a) + a * gain * 3;
      }
      break;
    }
    case 16: { // Harmonic Stretch
      const factor = 0.2 + a * 3.5;
      for (let h = 1; h <= numHarmonics; h++) {
        const srcBin = h / factor;
        const iBin = Math.floor(srcBin);
        const frac = srcBin - iBin;
        if (iBin >= 1 && iBin < numHarmonics) {
          newMag[h] = mag[iBin] + (mag[iBin + 1] - mag[iBin]) * frac;
        } else {
          newMag[h] = 0;
        }
      }
      break;
    }
    case 17: { // Comb / Ripple
      const freq = 0.1 + param2 * 1.5;
      for (let h = 1; h <= numHarmonics; h++) {
        const ripple = 1 + a * Math.sin(h * freq * Math.PI);
        newMag[h] *= Math.max(0, ripple);
      }
      break;
    }
    case 18: { // Inharmonic Stretch
      const shift = 0.1 + a * 1.2;
      for (let h = 1; h <= numHarmonics; h++) {
        const srcBin = Math.pow(h, 1 / shift);
        const iBin = Math.floor(srcBin);
        if (iBin >= 1 && iBin < numHarmonics) {
          newMag[h] = mag[iBin];
        } else {
          newMag[h] = 0;
        }
      }
      break;
    }
    case 19: { // Smear
      const radius = Math.floor(1 + a * 12);
      for (let h = 1; h <= numHarmonics; h++) {
        let sum = 0;
        let wSum = 0;
        for (let k = -radius; k <= radius; k++) {
          const bin = h + k;
          if (bin >= 1 && bin <= numHarmonics) {
            const w = Math.exp(-(k * k) / (2 * (radius / 2) ** 2));
            sum += mag[bin] * w;
            wSum += w;
          }
        }
        newMag[h] = wSum > 0 ? sum / wSum : mag[h];
      }
      break;
    }
    case 20: { // Phase Disperse
      for (let h = 1; h <= numHarmonics; h++) {
        newPhase[h] += a * Math.sin(h * param2 * Math.PI * 2);
      }
      break;
    }
    case 21: { // Spectral Freeze
      if (allFrames && allFrames[0]) {
        const firstSpec = analyzeFrame(allFrames[0], numHarmonics);
        for (let h = 1; h <= numHarmonics; h++) {
          newMag[h] = firstSpec.mag[h] * a + mag[h] * (1 - a);
        }
      }
      break;
    }
    case 22: { // Odd / Even
      const balance = (param2 - 0.5) * 2; // -1 (odd) .. +1 (even)
      for (let h = 1; h <= numHarmonics; h++) {
        if (h % 2 === 1) { // odd
          newMag[h] *= Math.max(0, 1 - a * balance);
        } else { // even
          newMag[h] *= Math.max(0, 1 + a * balance);
        }
      }
      break;
    }
    case 23: { // Harmonic Shift
      const shift = Math.floor((param2 - 0.5) * 40 * a);
      for (let h = 1; h <= numHarmonics; h++) {
        const src = h - shift;
        newMag[h] = (src >= 1 && src <= numHarmonics) ? mag[src] : 0;
      }
      break;
    }
    case 24: { // Spectral Fold
      const cutoff = Math.max(4, Math.floor((1 - a) * numHarmonics));
      for (let h = 1; h <= numHarmonics; h++) {
        if (h > cutoff) {
          const foldBin = cutoff - (h - cutoff);
          if (foldBin >= 1 && foldBin <= numHarmonics) {
            newMag[foldBin] += mag[h] * 0.8;
          }
          newMag[h] = 0;
        }
      }
      break;
    }
    case 25: { // Harmonic Random
      let seed = Math.floor(param2 * 10000);
      for (let h = 1; h <= numHarmonics; h++) {
        const r = pseudoRandom(seed + h);
        newMag[h] *= (1 - a) + a * r * 2;
      }
      break;
    }
    case 26: { // Phase Randomize
      let seed = Math.floor(param2 * 10000);
      for (let h = 1; h <= numHarmonics; h++) {
        const r = (pseudoRandom(seed + h * 3) - 0.5) * Math.PI * 2;
        newPhase[h] += a * r;
      }
      break;
    }
    case 27: { // Harmonic Rotate
      const rot = Math.floor(a * numHarmonics * param2);
      for (let h = 1; h <= numHarmonics; h++) {
        const src = ((h - 1 + rot) % numHarmonics) + 1;
        newMag[h] = mag[src];
      }
      break;
    }
    case 28: { // Spectral Warp
      const p = Math.pow(2, (param2 - 0.5) * 4);
      for (let h = 1; h <= numHarmonics; h++) {
        const norm = h / numHarmonics;
        const warpedNorm = Math.pow(norm, p);
        const srcBin = Math.max(1, Math.min(numHarmonics, warpedNorm * numHarmonics));
        const iBin = Math.floor(srcBin);
        newMag[h] = mag[iBin];
      }
      break;
    }
    case 29: { // Spectral Morph
      if (allFrames && allFrames.length > 1) {
        const nextIdx = Math.min(allFrames.length - 1, currentFrameIdx + 1);
        const nextSpec = analyzeFrame(allFrames[nextIdx], numHarmonics);
        for (let h = 1; h <= numHarmonics; h++) {
          newMag[h] = mag[h] * (1 - a) + nextSpec.mag[h] * a;
          newPhase[h] = phase[h] * (1 - a) + nextSpec.phase[h] * a;
        }
      }
      break;
    }
  }

  return synthesizeFrame({ mag: newMag, phase: newPhase }, frame.length);
}

/** Apply Wave/Sample domain warps to Float32Array frame (Wavefold, Bitcrush, Wave Rectify). */
export function applyWaveWarp(frame, mode, amount, param2 = 0.5) {
  if (!mode || amount === 0) return new Float32Array(frame);

  const out = new Float32Array(frame.length);
  const a = Math.max(0, Math.min(1, amount));

  for (let i = 0; i < frame.length; i++) {
    let x = frame[i];

    if (mode === 11) { // Wavefold
      const drive = 1 + a * 7;
      x = Math.sin(x * drive * (Math.PI / 2));
    } else if (mode === 14) { // Bitcrush
      const bits = Math.max(2, Math.floor(2 + (1 - a) * 14));
      const levels = Math.pow(2, bits);
      x = Math.round(x * levels) / levels;
    } else if (mode === 15) { // Wave Rectify
      if (param2 > 0.5) { // full-wave
        x = Math.abs(x) * 2 - 1;
      } else { // half-wave
        x = x > 0 ? x : 0;
      }
    }

    out[i] = x;
  }

  return normalize(removeDC(out));
}

function harmonicFrame(count) {
  const frame = new Float32Array(FRAME_SIZE);
  for (let n = 0; n < FRAME_SIZE; n++) {
    let s = 0;
    const theta = (2 * Math.PI * n) / FRAME_SIZE;
    for (let h = 1; h <= count; h++) s += Math.sin(theta * h) / h;
    frame[n] = s;
  }
  return normalize(frame);
}

function formantFrame(center, sigma) {
  const frame = new Float32Array(FRAME_SIZE);
  const HARMONICS = 32;
  for (let n = 0; n < FRAME_SIZE; n++) {
    let s = 0;
    const theta = (2 * Math.PI * n) / FRAME_SIZE;
    for (let h = 1; h <= HARMONICS; h++) {
      const w = Math.exp(-((h - center) ** 2) / (2 * sigma * sigma));
      s += (w / h) * Math.sin(theta * h);
    }
    frame[n] = s;
  }
  return normalize(frame);
}

// `with`, not `assert` -- Node 22+ removed the old import-assertion syntax
// and throws `SyntaxError: Unexpected identifier 'assert'` at parse time,
// which made `node test/engine.test.mjs` unrunnable (todo.md SS148).
import eswTables from './esw-tables.json' with { type: 'json' };
// Low-res preview of every ESW table (scripts/build-esw-preview.mjs). Used ONLY
// where the wavs can't be read (the plugin webview, for the WT graphic); the
// plugin's audio comes from native C++, which decodes the real files.
import eswPreview from './esw-preview.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// ESW (Echo Sound Works) wavetable loading.
//
// 379 of the 381 entries in WAVETABLES are ESW .wav files that ship *inside
// this repo* (tracked, "Echo Sound Works Core Tables/<Category>/<name>.wav").
// Two independent faults made loadEswWavetableFrames() return null for every
// one of them, so getBaseWavetableFrames() silently served the harmonicFrame
// fallback and all 379 tables were bit-identical (todo.md SS149 item 7;
// measured before this fix: 379/379 ESW frame 0 === the id-0 fallback):
//
//   1. ESW_BASE_DIR was hard-coded to 'Z:/GITHUB/FM/Echo Sound Works Core
//      Tables', a path that stopped existing when this repo moved to
//      'Z:/github/AUDIO . FAZE-RECORDER'.
//   2. The Node branch called `require('fs')`. There is no `require` in an
//      ES module, and this file IS one (package.json "type": "module"; the
//      test harness imports it directly), so it threw a ReferenceError that
//      the surrounding try/catch swallowed. It could only ever have worked in
//      a bundle converted to CJS.
//
// The directory is now resolved on first use — env override, then this
// module's own location, then the working directory, then the legacy path —
// and the built-ins are reached with process.getBuiltinModule(), which works
// from both CJS and ESM.
//
// STILL BLOCKED (SS149 item 7, the [!] line in the checklist index): neither
// fault is what makes the *plugin* sound wrong. There is no `process` in the
// QuickJS/WebView context at all, so nothing here can read a file there; and
// natively PluginProcessor.cpp's registerBuiltinWavetables() registers table
// ids 0 and 1 only, so every other id hits wtGenerateFrame()'s "unknown id"
// branch and returns the same harmonic frame. Making the ESW tables audible
// in the plugin is the open decision — precompute them to a binary at build
// time and ship (~1-2 GB), or cut the dropdown to the built-ins.
// ---------------------------------------------------------------------------
const ESW_DIR_NAME = 'Echo Sound Works Core Tables';

/** Env override, so a build step (or a checkout in a new place) can point at
 *  the tables without editing this file. */
const ESW_DIR_ENV = 'FAZE_ESW_TABLES';

let eswBaseDir;        // undefined = unresolved, null = resolved-but-missing
let eswWarned = false; // one diagnostic per process, not one per table
const eswFrameCache = new Map();

/**
 * Reach a Node built-in from either module system.
 * `process.getBuiltinModule` (Node 20.16+/22+) is the only synchronous way to
 * do this from ESM; a plain `require` is kept as the CJS fallback.
 */
function builtin(name) {
  try {
    if (typeof process !== 'undefined' && process
        && typeof process.getBuiltinModule === 'function') {
      return process.getBuiltinModule(name);
    }
    if (typeof require === 'function') return require(name);
  } catch (err) { /* this host has no fs/path */ }
  return null;
}

function eswCandidateDirs(fs, path) {
  const dirs = [];
  const env = typeof process !== 'undefined' && process.env ? process.env[ESW_DIR_ENV] : null;
  if (env) dirs.push(env);

  // Relative to this module: dsp/ -> spike/elementary -> spike -> repo root.
  try {
    const url = typeof import.meta !== 'undefined' && import.meta ? import.meta.url : null;
    const urlMod = url && String(url).startsWith('file:') ? builtin('url') : null;
    if (urlMod) {
      dirs.push(path.resolve(path.dirname(urlMod.fileURLToPath(url)), '..', '..', '..', ESW_DIR_NAME));
    }
  } catch (err) { /* not an ESM host, or a bundler replaced import.meta */ }

  // Relative to the working directory (test suite run from spike/elementary,
  // or from the repo root).
  const cwd = typeof process !== 'undefined' && process.cwd ? process.cwd() : null;
  if (cwd) {
    dirs.push(path.join(cwd, ESW_DIR_NAME));
    dirs.push(path.resolve(cwd, '..', ESW_DIR_NAME));
    dirs.push(path.resolve(cwd, '..', '..', ESW_DIR_NAME));
  }

  // Legacy location, last: a checkout that still has it keeps working.
  dirs.push('Z:/GITHUB/FM/' + ESW_DIR_NAME);
  return dirs;
}

function resolveEswBaseDir() {
  if (eswBaseDir !== undefined) return eswBaseDir;
  const fs = builtin('fs');
  const path = builtin('path');
  if (!fs || !path) { eswBaseDir = null; return null; } // browser / plugin webview
  for (const dir of eswCandidateDirs(fs, path)) {
    try {
      if (dir && fs.existsSync(dir)) { eswBaseDir = dir; return dir; }
    } catch (err) { /* try the next candidate */ }
  }
  eswBaseDir = null;
  return null;
}

// Vocal "01" suffix dropped where the table has no sibling (user request).
const DROP_01_VOCAL = new Set(['Talking 01', 'Throaty 01', 'Vocoder 01']);
function displayName(t) {
  const n = t.name.replace(/^ESW\s+/i, '');
  return t.category === 'Vocal' && DROP_01_VOCAL.has(n) ? n.replace(/\s+01$/, '') : n;
}

export const WAVETABLES = [
  { id: 0, category: 'Built-in', name: 'Harmonic Sweep' },
  { id: 1, category: 'Built-in', name: 'Formant Sweep' },
  ...eswTables.map((t) => ({
    id: t.id + 2,
    category: t.category,
    // Display name: drop the vendor "ESW " prefix some tables carry (the wav
    // path in `path` is untouched).
    name: displayName(t),
    path: t.path,
  })),
];

// Tables the user asked to remove (2026-10-09): hidden from every dropdown and
// shipped as a single frame in wavetables.bin. The ids stay RESERVED (a saved
// preset / host automation `op{k}_wtid` is positional), so nothing shifts.
// Keyed by "Category/Name" because "Pulse Acid" exists in Basics AND Digital.
const REMOVED_WAVETABLE_NAMES = new Set([
  ...['303 Saw', "80's PWM", 'ARP Pulse', 'ARP Saw', 'Arp Sine', 'Circle PWM', 'JP800 Square',
    'Juno 60 Sine 01', 'Jupiter 8 Saw', 'Jupiter 8 Triang', 'Korg Pro Saw', 'MS20 Square',
    'Mini Moog Pulse', 'Moog Saw 01', 'Moog Saw 02', 'Moog Saw 03', 'Moog Sine 02',
    'Moog Triangle', 'PWM Drift', 'Pluse Waves', 'Prophet Saw', 'Prophet Triangle', 'Russians',
    'SH101 Square 1', 'SH101 Square 2', 'Sys8', 'Ultra Saw', 'VMS Saw'].map((n) => `Analog/${n}`),
  ...['Deep High', 'MB Saw', 'PWM Pulse 01', 'PWM Saw 01', 'Pulse Acid', 'Saw Dual 01',
    'Saw Dual 02'].map((n) => `Basics/${n}`),
  ...['Serum Voice 01', 'Serum Voice 02', 'Serum Voice 03', 'Serum Voice 04', 'Serum Voice 05',
    'Serum Voice 06'].map((n) => `Vocal/${n}`),
  ...['Acoustic Guitar', 'BR French Horn 01', 'BR Trombone 01', 'BR Trombone Clean',
    'BR Trumpeter 02', 'BR Trumpeter 03', 'BS Elect', 'BS Upright', 'Bell Thin Metal',
    'Big Brass 01', 'Big Brass 02', 'Brass Brass Stab', 'Brass Shorts', 'Brassy Bell', 'Cello',
    'Electric Guitar', 'GT Acoustic 01', 'Gibson Acoustic', 'Glass Marimba', 'Guitar Acou Harm 01',
    'Guitar Palm Pluck', 'Guitar Petit Acoustic', 'Harp', 'Horn 01', 'KY Rhodes Classic',
    'Key Piano Like', 'Keys Digital', 'Mallet Senza', 'Mallet Toy Bell', 'Mallet Vibra', 'Marimba',
    'Nylon Guitar', 'Organ 01', 'Organ 02', 'Pan Flue', 'Pizzo String', 'Rhodes Hybrid',
    'Rhodes Wurli', 'ST Cello Solo', 'ST Violin Stac', 'Saxaphone', 'Simple Brass',
    'String Electric Stac', 'String Quartet', 'String Violins', 'String World Vio', 'Trumpeter 01',
    'Vibraphone', 'Violin', 'WW Chill Sax', 'WW Flutey', 'World Digidoo', 'World Japanese Guitar',
    'World Mibira', 'World Tambura'].map((n) => `Instruments/${n}`),
  ...['Zipper', 'Bell 01', 'Bell 02', 'Bell 03', 'Bell 04', 'Bell 05', 'Chime 01', 'Fuzzy Bells',
    'Ogran Bell', 'Ring Tone', 'Vocal Bell', 'Waves'].map((n) => `Metallic/${n}`),
  ...['BS Basix', 'BS Deep House', 'BS Elephant', 'BS Grimey', 'BS Party', 'BS Silver', 'BS Snappy',
    'BS Strep Throat', 'BS Talking Digits', 'BS Throaty', 'BS Yai', 'LD Brass Poly', 'LD Brassy',
    'LD Busy', 'LD Clouds', 'LD Tropics'].map((n) => `Synth One Shots/${n}`),
  ...['SSW 01', 'SSW 02', 'SSW 03', 'SSW 04', 'Sweep 01'].map((n) => `Digital/${n}`),
  ...['Saw Dual 03', 'Saw Dual 04', 'Saw Dual 05', 'Saw Fifth 01', 'Saw Fifth 02', 'Saw Fifth 03', 'Saw Mellow',
    'Saw Morph 01', 'Saw Morph 02', 'Saw Morph 03', 'Saw Phaser', 'Saw Reece', 'Saw Squeeze', 'Saw Thin',
    'Sine 03', 'Sine 909', 'Sine Dwmsmple', 'Sine PWM', 'Sine Pulse', 'Sine Saw Reveal', 'Sine Soft',
    'Sine to Saw', 'Sine to Square', 'Square Morph 01', 'Square Pushy', 'Square Saw 01', 'Square Saw',
    'Square Sine', 'Sub Sine 01', 'Sub Sine 02', 'Sub Sine 03', 'Triangle Saw'].map((n) => `Basics/${n}`),
  ...['Sine Fingers', 'Sqaure Saw Bits', 'Square Bendz', 'Square Cutoff', 'Square Harmonics', 'Super Dirt',
    'Sync House', 'Sync Ring', 'Synth Brass', 'Synth Bug', 'Saw Formant', 'Saw Harmonics'].map((n) => `Digital/${n}`),
  ...['Flute Vox', 'Formant Bot 01', 'Formant Bot 02', 'Formant Bot 03', 'Formant Bot 04', 'Formant Bot 05',
    'Fuzzy Vox'].map((n) => `Vocal/${n}`),
  // Vocal: AhWoYeYo is deliberately KEPT.
  ...["80's 01", 'Ah 02', 'Ahhh 01', 'Ahhh 02', 'Digital Choir 01', 'Digital Choir 02', 'Digital Choir 03'].map((n) => `Vocal/${n}`),
]);
/** wtIds hidden from the UI (populated below, once WAVETABLES exists). */
export const REMOVED_WAVETABLE_IDS = new Set(
  WAVETABLES.filter((w) => REMOVED_WAVETABLE_NAMES.has(`${w.category}/${w.name}`)).map((w) => w.id),
);

function parseWavBuffer(buf) {
  if (!buf || buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;

  let pos = 12;
  let audioFormat = 1, numChannels = 1, sampleRate = 44100, bitsPerSample = 16, dataPos = 0, dataLen = 0;

  while (pos < buf.length - 8) {
    const subId = buf.toString('ascii', pos, pos + 4);
    const subLen = buf.readUInt32LE(pos + 4);
    if (subId === 'fmt ') {
      audioFormat = buf.readUInt16LE(pos + 8);
      numChannels = buf.readUInt16LE(pos + 10);
      sampleRate = buf.readUInt32LE(pos + 12);
      bitsPerSample = buf.readUInt16LE(pos + 22);
    } else if (subId === 'data') {
      dataPos = pos + 8;
      dataLen = subLen;
      break;
    }
    pos += 8 + subLen;
  }

  if (!dataPos || !dataLen) return null;

  const bytesPerSample = bitsPerSample / 8;
  const frameSamples = 2048;
  const totalSamples = Math.floor(dataLen / (bytesPerSample * numChannels));
  const numFrames = Math.max(1, Math.floor(totalSamples / frameSamples));

  const frames = [];
  for (let f = 0; f < numFrames; f++) {
    const frameData = new Float32Array(frameSamples);
    const startSample = f * frameSamples;
    for (let s = 0; s < frameSamples; s++) {
      const idx = (startSample + s) * numChannels;
      const byteOffset = dataPos + idx * bytesPerSample;
      if (byteOffset >= buf.length) break;

      let val = 0;
      if (audioFormat === 3 && bitsPerSample === 32) {
        val = buf.readFloatLE(byteOffset);
      } else if (bitsPerSample === 16) {
        val = buf.readInt16LE(byteOffset) / 32768.0;
      } else if (bitsPerSample === 24) {
        const b0 = buf[byteOffset];
        const b1 = buf[byteOffset + 1];
        const b2 = buf[byteOffset + 2];
        let intVal = (b0 | (b1 << 8) | (b2 << 16));
        if (intVal & 0x800000) intVal |= 0xFF000000;
        val = intVal / 8388608.0;
      }
      frameData[s] = val;
    }
    frames.push(normalize(removeDC(frameData)));
  }
  return frames;
}

function loadEswWavetableFrames(relPath) {
  if (eswFrameCache.has(relPath)) return eswFrameCache.get(relPath);
  try {
    const base = resolveEswBaseDir();
    if (base) {
      const fs = builtin('fs');
      const path = builtin('path');
      const fullPath = path.join(base, relPath);
      if (fs.existsSync(fullPath)) {
        const frames = parseWavBuffer(fs.readFileSync(fullPath));
        if (frames && frames.length > 0) {
          eswFrameCache.set(relPath, frames);
          return frames;
        }
      } else if (!eswWarned) {
        eswWarned = true;
        console.warn(`[wavetables] ESW table not found: ${fullPath} (base dir: ${base})`);
      }
    } else if (!eswWarned) {
      // No filesystem in this host (browser, or the plugin's WebView/QuickJS
      // context). Say so once, loudly, instead of silently handing back the
      // harmonic frame for all 379 tables.
      eswWarned = true;
      console.warn(
        `[wavetables] ESW tables unavailable — this host has no filesystem ` +
        `access. Set ${ESW_DIR_ENV} to the "${ESW_DIR_NAME}" directory to ` +
        `override. Falling back to the harmonic frame, so every ESW table ` +
        `will sound identical.`
      );
    }
  } catch (err) {
    if (!eswWarned) {
      eswWarned = true;
      console.warn('[wavetables] ESW load failed:', err && err.message ? err.message : err);
    }
  }
  return null;
}

const previewCache = new Map();
/** Upsample the shipped 256-point preview frames to FRAME_SIZE (linear). */
function previewFrames(id) {
  if (previewCache.has(id)) return previewCache.get(id);
  let frames = null;
  try {
    const b64 = eswPreview.tables[id];
    if (b64 && typeof atob === 'function') {
      const bin = atob(b64);
      const { frames: nF, points: nP } = eswPreview;
      frames = [];
      for (let f = 0; f < nF; f++) {
        const fr = new Float32Array(FRAME_SIZE);
        const at = (i) => { const c = bin.charCodeAt(f * nP + (i % nP)); return (c > 127 ? c - 256 : c) / 127; };
        for (let n = 0; n < FRAME_SIZE; n++) {
          const x = n * nP / FRAME_SIZE, i = Math.floor(x), t = x - i;
          fr[n] = at(i) * (1 - t) + at(i + 1) * t;
        }
        frames.push(fr);
      }
    }
  } catch (e) { frames = null; }
  previewCache.set(id, frames);
  return frames;
}

export function getBaseWavetableFrames(id) {
  if (id === 1) {
    return Array.from({ length: NUM_FRAMES }, (_, i) => formantFrame(2 + i * 3.5, 1.6));
  }
  if (id === 0) {
    return Array.from({ length: NUM_FRAMES }, (_, i) => harmonicFrame(1 + i * 4));
  }

  const wt = WAVETABLES[id];
  if (wt && wt.path) {
    const loaded = loadEswWavetableFrames(wt.path);
    if (loaded && loaded.length > 0) return loaded;
    const prev = previewFrames(id);
    if (prev) return prev;
  }

  return Array.from({ length: NUM_FRAMES }, (_, i) => harmonicFrame(1 + i * 4));
}

export function generateWavetableFrames(
  id,
  warpMode = 0, warpAmount = 0, warpParam2 = 0.5,
  warpMode2 = 0, warpAmount2 = 0, warpParam2_2 = 0.5
) {
  const baseFrames = getBaseWavetableFrames(id);

  if ((!warpMode || warpAmount === 0) && (!warpMode2 || warpAmount2 === 0)) {
    return baseFrames;
  }

  // Apply Warp 1
  let frames = baseFrames.map((frame, i) => {
    if (warpMode >= 1 && warpMode <= 12) {
      const resampled = new Float32Array(FRAME_SIZE);
      for (let s = 0; s < FRAME_SIZE; s++) {
        const ph = s / FRAME_SIZE;
        const warpedPh = warpPhase(ph, warpMode, warpAmount, warpParam2);
        const idx = Math.max(0, Math.min(FRAME_SIZE - 1, Math.floor(warpedPh * FRAME_SIZE)));
        resampled[s] = frame[idx];
      }
      return resampled;
    }
    if (warpMode === 14 || warpMode === 15) {
      return applyWaveWarp(frame, warpMode, warpAmount, warpParam2);
    }
    if (warpMode >= 13) {
      return applySpectralWarp(frame, warpMode, warpAmount, warpParam2, baseFrames, i);
    }
    return frame;
  });

  // Apply Warp 2
  if (warpMode2 > 0 && warpAmount2 > 0) {
    const step1Frames = frames;
    frames = frames.map((frame, i) => {
      if (warpMode2 >= 1 && warpMode2 <= 12) {
        const resampled = new Float32Array(FRAME_SIZE);
        for (let s = 0; s < FRAME_SIZE; s++) {
          const ph = s / FRAME_SIZE;
          const warpedPh = warpPhase(ph, warpMode2, warpAmount2, warpParam2_2);
          const idx = Math.max(0, Math.min(FRAME_SIZE - 1, Math.floor(warpedPh * FRAME_SIZE)));
          resampled[s] = frame[idx];
        }
        return resampled;
      }
      if (warpMode2 === 14 || warpMode2 === 15) {
        return applyWaveWarp(frame, warpMode2, warpAmount2, warpParam2_2);
      }
      if (warpMode2 >= 13) {
        return applySpectralWarp(frame, warpMode2, warpAmount2, warpParam2_2, step1Frames, i);
      }
      return frame;
    });
  }

  return frames;
}

const frameCache = new Map();

export function wavetableResourceKey(
  id, frameIndex,
  warpMode = 0, warpAmount = 0, warpParam2 = 0.5,
  warpMode2 = 0, warpAmount2 = 0, warpParam2_2 = 0.5
) {
  if ((!warpMode || warpAmount === 0) && (!warpMode2 || warpAmount2 === 0)) {
    return `wavetable:${id}:${frameIndex}`;
  }
  const amtQ = Math.round(warpAmount * 100);
  const p2Q = Math.round(warpParam2 * 100);
  const amtQ2 = Math.round(warpAmount2 * 100);
  const p2Q2 = Math.round(warpParam2_2 * 100);
  return `wavetable:${id}:${frameIndex}:w${warpMode}:${amtQ}:${p2Q}:w2_${warpMode2}:${amtQ2}:${p2Q2}`;
}

export function getWavetableFrame(
  id, frameIndex,
  warpMode = 0, warpAmount = 0, warpParam2 = 0.5,
  warpMode2 = 0, warpAmount2 = 0, warpParam2_2 = 0.5
) {
  const key = wavetableResourceKey(id, frameIndex, warpMode, warpAmount, warpParam2, warpMode2, warpAmount2, warpParam2_2);
  if (frameCache.has(key)) return frameCache.get(key);

  const frames = generateWavetableFrames(id, warpMode, warpAmount, warpParam2, warpMode2, warpAmount2, warpParam2_2);
  frames.forEach((f, i) => {
    const k = wavetableResourceKey(id, i, warpMode, warpAmount, warpParam2, warpMode2, warpAmount2, warpParam2_2);
    frameCache.set(k, f);
  });

  return frameCache.get(key) || frames[frameIndex] || new Float32Array(FRAME_SIZE);
}

export function allBuiltinWavetableResources() {
  const out = {};
  for (let id = 0; id < Math.min(6, WAVETABLES.length); id++) {
    generateWavetableFrames(id).forEach((frame, i) => {
      out[wavetableResourceKey(id, i)] = frame;
    });
  }
  for (const [k, v] of frameCache.entries()) {
    out[k] = v;
  }
  return out;
}
