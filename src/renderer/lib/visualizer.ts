import type { Theme, VisualizerMode } from '../../shared/types';
import { PeakBuffer } from './peak-buffer';

/**
 * Audio visualizer rendering routines. Adapted from the reference HTML
 * (Audio Oscilloscope & Spectrum Analyzer) and extended with a scrolling
 * spectrogram and an 'aurora-ice' neon theme.
 *
 * Drawing can run at any FPS — we use requestAnimationFrame in the consumer.
 */

export interface VisualizerState {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  theme: Theme;
  mode: VisualizerMode;
  rms: number;
  peakBuffer?: PeakBuffer | null;
  isPopout?: boolean;
  /** Sampler-only: raw [min, max] pairs of the captured sample. When
   *  present, history mode draws this envelope instead of the recorder's
   *  rolling peak track. */
  samplePeaks?: Float32Array | null;
}

/**
 * Everything the draw routines actually need from an analyser.
 *
 * The main window supplies a real `AudioAnalyser` wrapping an AnalyserNode;
 * the pop-out window has no audio graph of its own and supplies a
 * `RemoteAnalyser` fed by IPC frames instead. Both satisfy this.
 */
export interface AnalyserLike {
  readonly timeData: Float32Array;
  readonly freqData: Float32Array;
  readonly analyser: {
    minDecibels: number;
    maxDecibels: number;
    /** Present on a real AnalyserNode; absent on the pop-out's RemoteAnalyser. */
    smoothingTimeConstant?: number;
  };
  sample(): { rms: number };
}

/**
 * Temporal smoothing per mode.
 *
 * The spectrum bars want a lot of it or they strobe. The spectrogram is a
 * *time-history* view, so the same smoothing paints every transient across
 * dozens of columns — which is what made it look like a smeared watercolour.
 * `App.tsx` applies this to the live AnalyserNode whenever the mode changes.
 */
export const SMOOTHING_FOR_MODE: Record<VisualizerMode, number> = {
  oscilloscope: 0.82,
  spectrum: 0.82,
  spectrogram: 0.2,
  history: 0.82,
};

export class AudioAnalyser implements AnalyserLike {
  readonly analyser: AnalyserNode;
  readonly timeData: Float32Array<ArrayBuffer>;
  readonly freqData: Float32Array<ArrayBuffer>;

  constructor(ctx: AudioContext, source: AudioNode) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.82;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -10;
    source.connect(this.analyser);
    this.timeData = new Float32Array(this.analyser.fftSize) as Float32Array<ArrayBuffer>;
    this.freqData = new Float32Array(this.analyser.frequencyBinCount) as Float32Array<ArrayBuffer>;
  }

  sample(): { rms: number } {
    this.analyser.getFloatTimeDomainData(this.timeData);
    this.analyser.getFloatFrequencyData(this.freqData);
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i++) sum += this.timeData[i] ** 2;
    return { rms: Math.sqrt(sum / this.timeData.length) };
  }
}

/**
 * An `AnalyserLike` with no audio graph behind it — the pop-out window fills
 * it from `viz:frame` IPC messages produced by the main window's real
 * analyser. `sample()` is a no-op because the data is already current.
 */
export class RemoteAnalyser implements AnalyserLike {
  timeData: Float32Array = new Float32Array(2048);
  freqData: Float32Array = new Float32Array(1024);
  analyser = { minDecibels: -90, maxDecibels: -10 };
  private lastRms = 0;

  update(frame: {
    time: Float32Array;
    freq: Float32Array;
    minDecibels: number;
    maxDecibels: number;
  }) {
    this.timeData = frame.time;
    this.freqData = frame.freq;
    this.analyser.minDecibels = frame.minDecibels;
    this.analyser.maxDecibels = frame.maxDecibels;
    let sum = 0;
    for (let i = 0; i < frame.time.length; i++) sum += frame.time[i] ** 2;
    this.lastRms = Math.sqrt(sum / Math.max(1, frame.time.length));
  }

  sample(): { rms: number } {
    return { rms: this.lastRms };
  }
}

export function drawVisualizer(state: VisualizerState, analyser: AnalyserLike) {
  const { ctx, width, height, theme, mode, peakBuffer } = state;
  // The spectrogram keeps its own scroll buffer, so it repaints in full every
  // frame like the other two modes — no "don't clear" special case.
  ctx.clearRect(0, 0, width, height);
  drawBackground(ctx, width, height, theme);
  analyser.sample();

  if (mode === 'history') {
    if (state.samplePeaks && state.samplePeaks.length > 0) {
      drawSampleHistory(ctx, state.samplePeaks, width, height, theme);
    } else {
      drawHistory(ctx, peakBuffer, width, height, theme, !!state.isPopout);
    }
  }
  else if (mode === 'oscilloscope') drawOscilloscope(ctx, analyser.timeData, width, height, theme);
  else if (mode === 'spectrum') drawSpectrum(ctx, analyser.freqData, analyser.analyser, width, height, theme);
  else drawSpectrogram(ctx, analyser.freqData, analyser.analyser, width, height, theme);
}

function palette(theme: Theme) {
  switch (theme) {
    case 'black-ice':
      return {
        bg: '#000000',
        grid: 'rgba(168,240,255,0.04)',
        gridStrong: 'rgba(168,240,255,0.1)',
        wave: '#c4f4fc',
        bar: '#7fe3f5',
        spike: '#c4f4fc',
        accent: '#a8f0d8',
      };
    case 'graphite':
      return {
        bg: '#0b0c0e',
        grid: 'rgba(205,213,222,0.045)',
        gridStrong: 'rgba(205,213,222,0.11)',
        wave: '#e4e9ef',
        bar: '#d8dee6',
        spike: '#9aa3ad',
        accent: '#7fd99a',
      };
    case 'aurora-ice':
    default:
      return {
        bg: '#02030a',
        grid: 'rgba(130,200,255,0.05)',
        gridStrong: 'rgba(130,200,255,0.12)',
        wave: '#8ff3ff',
        bar: '#6df0ff',
        spike: '#a58bff',
        accent: '#6dffd0',
      };
  }
}

/** Both Aurora themes share the neon treatment (glow, vertical gradients);
 *  Black ice is the flat one. Aurora ember is Aurora ice off blue, so anything
 *  that asked `theme === 'aurora-ice'` has to ask this instead or the new theme
 *  silently falls back to the flat look. */
function isAurora(theme: Theme): boolean {
  return theme === 'aurora-ice';
}

function drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number, theme: Theme) {
  if (isAurora(theme)) {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#080d1c');
    grad.addColorStop(1, '#02030a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, theme: Theme) {
  const p = palette(theme);
  ctx.strokeStyle = p.grid;
  ctx.lineWidth = 1;
  for (let x = 0; x <= w; x += w / 10) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += h / 8) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.strokeStyle = p.gridStrong;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

function drawOscilloscope(
  ctx: CanvasRenderingContext2D,
  data: Float32Array,
  w: number,
  h: number,
  theme: Theme,
) {
  drawGrid(ctx, w, h, theme);
  const p = palette(theme);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = p.wave;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = p.wave;
  ctx.shadowBlur = isAurora(theme) ? 12 : 0;
  ctx.beginPath();
  const slice = w / data.length;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const y = h / 2 + v * (h / 2) * 0.9;
    const x = i * slice;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawSpectrum(
  ctx: CanvasRenderingContext2D,
  data: Float32Array,
  analyser: { minDecibels: number; maxDecibels: number },
  w: number,
  h: number,
  theme: Theme,
) {
  drawGrid(ctx, w, h, theme);
  const p = palette(theme);
  const range = analyser.maxDecibels - analyser.minDecibels;
  const barWidth = w / data.length;
  for (let i = 0; i < data.length; i++) {
    const db = data[i];
    const norm = Math.max(0, Math.min(1, (db - analyser.minDecibels) / range));
    const barHeight = norm * (h - 8);
    let grad: string | CanvasGradient = p.bar;
    if (isAurora(theme)) {
      const g = ctx.createLinearGradient(0, h, 0, 0);
      g.addColorStop(0, '#6df0ff');
      g.addColorStop(0.6, '#a58bff');
      g.addColorStop(1, '#c9fbff');
      grad = g;
    }
    ctx.fillStyle = grad;
    ctx.fillRect(i * barWidth, h - barHeight, Math.max(1, barWidth - 1), barHeight);
  }
}

/**
 * Scrolling spectrogram.
 *
 * History lives in an offscreen buffer rather than on the visible canvas. The
 * old implementation scrolled the live canvas with getImageData/putImageData
 * every frame — a GPU→CPU readback per frame that stalled the render loop, and
 * it was wiped by anything that repainted the canvas (a resize, a theme swap,
 * a mode round-trip), which is why the spectrogram usually showed nothing.
 *
 * The buffer is keyed off the destination context, so each canvas (main window
 * and pop-out) keeps its own independent history.
 */
interface SpectroBuffer {
  canvas: HTMLCanvasElement;
  bctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  theme: Theme;
  bins: number;
  /** Per-row bin mapping — see buildRowMap(). */
  lo: Int32Array;
  hi: Int32Array;
  frac: Float32Array;
}
const spectroBuffers = new WeakMap<CanvasRenderingContext2D, SpectroBuffer>();

/**
 * Precompute, for every output row, which FFT bins it represents.
 *
 * A naive `round(exp(...))` lookup per row is wrong at *both* ends of a log
 * axis and that is what made the old spectrogram look broken:
 *
 *   - **Low end.** With a 1024-bin FFT the bottom ~30% of the image spans bins
 *     1–8. Dozens of consecutive rows resolved to the same bin and painted the
 *     same flat colour, producing the thick horizontal banding across the
 *     bottom of the picture.
 *   - **High end.** Near the top each row advances by 40+ bins, so a single
 *     sampled bin stood in for all of them. Any peak that fell between two
 *     sampled bins vanished, and which bins got sampled shifted frame to frame
 *     — the source of the flickering vertical streaks.
 *
 * So: rows narrower than one bin interpolate between neighbours (`hi === lo`,
 * blend by `frac`), and rows wider than one bin take the max over their range
 * (`hi > lo`) so nothing is dropped.
 */
function buildRowMap(h: number, bins: number) {
  const lo = new Int32Array(h);
  const hi = new Int32Array(h);
  const frac = new Float32Array(h);
  const maxBin = bins - 1;
  const logMin = Math.log(1);
  const logMax = Math.log(maxBin);
  // Bin position for a row centre expressed as a fraction up the canvas.
  const posAt = (t: number) => Math.exp(logMin + Math.min(1, Math.max(0, t)) * (logMax - logMin));

  for (let y = 0; y < h; y++) {
    // y = 0 is the top of the canvas, i.e. the highest frequency.
    const tMid = 1 - y / Math.max(1, h - 1);
    const half = 0.5 / Math.max(1, h - 1);
    const pLow = posAt(tMid - half);
    const pHigh = posAt(tMid + half);
    const a = Math.floor(pLow);
    const b = Math.ceil(pHigh) - 1;
    if (b > a) {
      lo[y] = Math.max(1, Math.min(maxBin, a));
      hi[y] = Math.max(1, Math.min(maxBin, b));
      frac[y] = 0;
    } else {
      const p = Math.min(maxBin - 1, Math.max(1, posAt(tMid)));
      lo[y] = Math.floor(p);
      hi[y] = Math.floor(p);
      frac[y] = p - Math.floor(p);
    }
  }
  return { lo, hi, frac };
}

function getSpectroBuffer(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  theme: Theme,
  bins: number,
): SpectroBuffer | null {
  let buf = spectroBuffers.get(ctx);
  // Any size or theme change invalidates the history — the old pixels were
  // painted with a different palette at a different scale.
  if (!buf || buf.w !== w || buf.h !== h || buf.theme !== theme || buf.bins !== bins) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const bctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!bctx) return null;
    // The scroll step below draws this canvas onto itself. With smoothing left
    // on, every frame resamples the whole history and it turns to mush after a
    // few seconds — the soft, out-of-focus look the old version had.
    bctx.imageSmoothingEnabled = false;
    drawBackground(bctx, w, h, theme);
    const map = buildRowMap(h, bins);
    buf = { canvas, bctx, w, h, theme, bins, ...map };
    spectroBuffers.set(ctx, buf);
  }
  return buf;
}

function drawSpectrogram(
  ctx: CanvasRenderingContext2D,
  data: Float32Array,
  analyser: { minDecibels: number; maxDecibels: number },
  w: number,
  h: number,
  theme: Theme,
) {
  if (w < 2 || h < 2) return;
  const bins = data.length;
  if (bins < 4) return;
  const buf = getSpectroBuffer(ctx, w, h, theme, bins);
  if (!buf) return;

  const { bctx, lo, hi, frac } = buf;
  const min = analyser.minDecibels;
  const range = analyser.maxDecibels - min || 1;
  // One or two device pixels per frame. The old `w / 480` gave 4px columns on a
  // wide window, which both coarsened the time axis and scrolled the whole
  // history off screen in about eight seconds.
  const col = Math.max(1, Math.round(w / 900));

  // Shift left. 'copy' means the vacated column comes back transparent instead
  // of ghosting the previous frame under the new one.
  bctx.globalCompositeOperation = 'copy';
  bctx.drawImage(buf.canvas, -col, 0);
  bctx.globalCompositeOperation = 'source-over';

  // Paint the newest slice into the freed column.
  const slice = bctx.createImageData(col, h);
  const px = slice.data;
  for (let y = 0; y < h; y++) {
    const a = lo[y];
    const b = hi[y];
    let db: number;
    if (b > a) {
      // Wide row: max over the bins it covers, so nothing is skipped.
      let m = -Infinity;
      for (let i = a; i <= b; i++) {
        const v = data[i];
        if (v > m) m = v;
      }
      db = m;
    } else {
      // Narrow row: interpolate, so the low end is a gradient not a stack of
      // flat bands.
      const f = frac[y];
      const v0 = data[a];
      const v1 = data[a + 1] ?? v0;
      db = v0 + (v1 - v0) * f;
    }

    let norm = Number.isFinite(db) ? (db - min) / range : 0;
    norm = norm < 0 ? 0 : norm > 1 ? 1 : norm;
    // Contrast curve. Typical music sits at -60…-30 dB, i.e. right in the
    // middle of the -90…-10 window, so a linear map rendered almost the entire
    // picture in one mid-tone — the flat cyan wash. This pushes the noise floor
    // down to the background and keeps the headroom for actual peaks.
    norm = norm * norm;

    const [r, g, bb] = magColor(norm, theme);
    for (let x = 0; x < col; x++) {
      const off = (y * col + x) * 4;
      px[off] = r;
      px[off + 1] = g;
      px[off + 2] = bb;
      px[off + 3] = 255;
    }
  }
  bctx.putImageData(slice, w - col, 0);

  ctx.drawImage(buf.canvas, 0, 0);
}

/**
 * Spectrogram colour ramps, as `[stop, r, g, b]` rows in ascending stop order.
 *
 * Every ramp starts *at that theme's canvas background* so silence disappears
 * into the panel instead of tinting the whole picture, then climbs through two
 * or three hues to a near-white peak. The old ramps began at a mid-brightness
 * colour (modern's floor was rgb(20,40,80)), which is why a quiet track still
 * filled the board edge to edge.
 */
type Ramp = readonly (readonly [number, number, number, number])[];

const RAMPS: Record<Theme, Ramp> = {
  // Graphite's ramp is the same brightness curve in pure greys.
  'graphite': [
    [0.0, 6, 7, 8],
    [0.25, 34, 37, 41],
    [0.5, 92, 98, 105],
    [0.72, 150, 158, 167],
    [0.88, 208, 215, 223],
    [1.0, 250, 252, 255],
  ],
  'aurora-ice': [
    [0.0, 0, 0, 4],
    [0.25, 22, 14, 70],
    [0.5, 70, 70, 210],
    [0.72, 90, 190, 255],
    [0.88, 140, 255, 235],
    [1.0, 245, 255, 255],
  ],
  'black-ice': [
    [0.0, 0, 0, 0],
    [0.35, 10, 40, 50],
    [0.6, 50, 140, 160],
    [0.8, 127, 227, 245],
    [0.92, 196, 244, 252],
    [1.0, 240, 255, 255],
  ],
};

function magColor(norm: number, theme: Theme): [number, number, number] {
  const ramp = RAMPS[theme] ?? RAMPS['aurora-ice'];
  if (norm <= ramp[0][0]) return [ramp[0][1], ramp[0][2], ramp[0][3]];
  for (let i = 1; i < ramp.length; i++) {
    const [stop, r, g, b] = ramp[i];
    if (norm <= stop) {
      const [prevStop, pr, pg, pb] = ramp[i - 1];
      const t = (norm - prevStop) / (stop - prevStop || 1);
      return [
        (pr + (r - pr) * t) | 0,
        (pg + (g - pg) * t) | 0,
        (pb + (b - pb) * t) | 0,
      ];
    }
  }
  const last = ramp[ramp.length - 1];
  return [last[1], last[2], last[3]];
}

function drawHistory(
  ctx: CanvasRenderingContext2D,
  peakBuffer: PeakBuffer | null | undefined,
  width: number,
  height: number,
  theme: Theme,
  isPopout?: boolean,
) {
  if (!peakBuffer) {
    const p = palette(theme);
    ctx.fillStyle = p.gridStrong;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '12px ui-monospace, Consolas, monospace';
    if (isPopout) {
      ctx.fillText('History not available in pop-out', width / 2, height / 2);
    } else {
      ctx.fillText('Waiting for recording to start...', width / 2, height / 2);
    }
    return;
  }

  const arr = peakBuffer.getFloat32Array();
  const numPairs = arr.length / 2;
  if (numPairs === 0) return;

  const p = palette(theme);
  const midY = height / 2;

  ctx.beginPath();
  // Top envelope (maxes)
  for (let i = 0; i < numPairs; i++) {
    const x = (i / numPairs) * width;
    const max = arr[i * 2 + 1];
    ctx.lineTo(x, midY - (max * midY * 0.9)); // 0.9 padding
  }
  // Bottom envelope (mins)
  for (let i = numPairs - 1; i >= 0; i--) {
    const x = (i / numPairs) * width;
    const min = arr[i * 2];
    ctx.lineTo(x, midY - (min * midY * 0.9));
  }
  ctx.closePath();

  ctx.fillStyle = p.wave;
  ctx.globalAlpha = 0.5;
  ctx.fill();
  
  ctx.strokeStyle = p.wave;
  ctx.globalAlpha = 0.8;
  ctx.stroke();

  ctx.globalAlpha = 1.0;


}

/**
 * Sampler-only history view: draw the captured sample's peak envelope.
 * `peaks` is a Float32Array of [min, max] pairs in chronological order
 * (the same shape `SynthEngine.samplePeaks` returns). When the sampler has
 * no buffer the caller never reaches here — `drawHistory`'s empty-state
 * "Waiting for recording to start..." handles that.
 */
function drawSampleHistory(
  ctx: CanvasRenderingContext2D,
  peaks: Float32Array,
  width: number,
  height: number,
  theme: Theme,
) {
  const numPairs = peaks.length / 2;
  if (numPairs === 0) return;

  const p = palette(theme);
  const midY = height / 2;

  ctx.beginPath();
  for (let i = 0; i < numPairs; i++) {
    const x = (i / numPairs) * width;
    const max = peaks[i * 2 + 1];
    ctx.lineTo(x, midY - (max * midY * 0.9));
  }
  for (let i = numPairs - 1; i >= 0; i--) {
    const x = (i / numPairs) * width;
    const min = peaks[i * 2];
    ctx.lineTo(x, midY - (min * midY * 0.9));
  }
  ctx.closePath();

  ctx.fillStyle = p.wave;
  ctx.globalAlpha = 0.5;
  ctx.fill();

  ctx.strokeStyle = p.wave;
  ctx.globalAlpha = 0.8;
  ctx.stroke();

  ctx.globalAlpha = 1.0;
}
