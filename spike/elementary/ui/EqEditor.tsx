// Graphic parametric EQ editor (todo.md) — FabFilter Pro-Q / Bitwig EQ+-style: NO knobs,
// every band is a point on a log-frequency/gain canvas. Double-click empty
// space to add a band, double-click a point to remove it, drag a point to
// move its freq/gain, scroll while hovering a point to change its Q.
//
// Enhanced with Bitwig EQ+ features:
// - Rainbow frequency spectrum response curve gradient.
// - Cursor hover symbols for Low Shelf, High Shelf, and High Pass / Low Cut at spectrum edges.
// - Right-click context dropdown menu to change band types (Bell ↔ Notch, Low Shelf ↔ High Pass, High Shelf ↔ Low Pass).
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useThemeVersion } from '../../../src/renderer/lib/useThemeVersion';
import type { EqBand, EqBandType } from '../../../src/shared/types';
import { EQ_FREQ_MIN, EQ_FREQ_MAX, EQ_GAIN_MIN, EQ_GAIN_MAX, EQ_Q_MIN, EQ_Q_MAX, MAX_EQ_BANDS, newEqBandId } from '../../../src/shared/types';

const BAND_COLORS = ['#7df9ff', '#ff8df0', '#ffcc66', '#7fffaf', '#ff5d6c', '#b48bff', '#4fd1c5', '#f59e0b'];
const bandColor = (i: number) => BAND_COLORS[i % BAND_COLORS.length];

const freqToX = (freq: number, w: number) =>
  (w * Math.log(freq / EQ_FREQ_MIN)) / Math.log(EQ_FREQ_MAX / EQ_FREQ_MIN);
const xToFreq = (x: number, w: number) =>
  EQ_FREQ_MIN * Math.pow(EQ_FREQ_MAX / EQ_FREQ_MIN, Math.max(0, Math.min(1, x / w)));
const gainToY = (gain: number, h: number) =>
  ((EQ_GAIN_MAX - gain) / (EQ_GAIN_MAX - EQ_GAIN_MIN)) * h;
const yToGain = (y: number, h: number) =>
  EQ_GAIN_MAX - (Math.max(0, Math.min(1, y / h)) * (EQ_GAIN_MAX - EQ_GAIN_MIN));

/** Simplified per-band contribution at `freq`, in dB. */
function bandDb(b: EqBand, freq: number): number {
  const oct = Math.log2(freq / b.freq);
  if (b.type === 'highpass') {
    if (oct >= 0) return 0;
    const slope = 14 + Math.max(0, b.q - 0.7) * 12;
    return Math.max(-36, oct * slope);
  }
  if (b.type === 'lowpass') {
    if (oct <= 0) return 0;
    const slope = 14 + Math.max(0, b.q - 0.7) * 12;
    return Math.max(-36, -oct * slope);
  }
  if (b.type === 'notch') {
    const sigma = Math.max(0.02, 0.15 / Math.max(0.1, b.q));
    return -32 * Math.exp(-(oct * oct) / (2 * sigma * sigma));
  }
  if (b.type === 'bell') {
    const sigma = Math.max(0.06, 1 / (b.q * 2));
    return b.gain * Math.exp(-(oct * oct) / (2 * sigma * sigma));
  }
  const k = 2 + b.q * 2;
  const rise = 1 / (1 + Math.exp(-k * oct));
  return b.type === 'highshelf' ? b.gain * rise : b.gain * (1 - rise);
}

function drawLowShelfSymbol(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y);

  // Outer glow
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-14, 6);
  ctx.bezierCurveTo(-5, 6, -2, -6, 6, -6);
  ctx.lineTo(14, -6);
  ctx.stroke();

  // White line
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-14, 6);
  ctx.bezierCurveTo(-5, 6, -2, -6, 6, -6);
  ctx.lineTo(14, -6);
  ctx.stroke();

  // Fork handle dot
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(6, -6, 2.5, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
}

function drawHighShelfSymbol(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y);

  // Outer glow
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-14, -6);
  ctx.lineTo(-6, -6);
  ctx.bezierCurveTo(2, -6, 5, 6, 14, 6);
  ctx.stroke();

  // White line
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-14, -6);
  ctx.lineTo(-6, -6);
  ctx.bezierCurveTo(2, -6, 5, 6, 14, 6);
  ctx.stroke();

  // Fork handle dot
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(-6, -6, 2.5, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
}

function drawHighPassSymbol(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y);

  // Outer glow
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-10, 14);
  ctx.bezierCurveTo(-7, 2, -2, -4, 8, -4);
  ctx.lineTo(14, -4);
  ctx.stroke();

  // White line
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-10, 14);
  ctx.bezierCurveTo(-7, 2, -2, -4, 8, -4);
  ctx.lineTo(14, -4);
  ctx.stroke();

  // Handle dot
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(8, -4, 2.5, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
}

/** Tiny in-place radix-2 FFT (magnitude only). `re`/`im` are mutated. */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

import { getScope, getScopeVersion } from './scopeStore';
import { bridge } from './bridge';

// Native only ships the two EQ scopes while at least one EQ canvas is mounted.
let eqMounted = 0;

interface EqCanvasProps {
  bands: EqBand[];
  onChange: (bands: EqBand[]) => void;
  color: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  bandId: string;
}

/** Compute spectrum points (Y positions for x = 0..w) with log freq mapping & decay. */
function computeSpectrumPoints(
  buf: Float32Array | null,
  w: number,
  h: number,
  prevY: Float32Array | null
): Float32Array {
  const out = new Float32Array(w);
  const defaultY = gainToY(EQ_GAIN_MIN - 6, h);

  if (!buf || buf.length < 4) {
    for (let x = 0; x < w; x += 1) {
      const p = prevY ? prevY[x] : defaultY;
      out[x] = p + (defaultY - p) * 0.15;
    }
    return out;
  }

  const n = 1 << Math.floor(Math.log2(Math.min(buf.length, 512)));
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    re[i] = (buf[i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  }
  fft(re, im);
  const bins = n / 2;

  for (let x = 0; x < w; x += 1) {
    const freq = xToFreq(x, w);
    const binFloat = Math.max(0, Math.min(bins - 1, (freq / 22050) * bins));
    const b0 = Math.floor(binFloat);
    const b1 = Math.min(bins - 1, b0 + 1);
    const frac = binFloat - b0;

    const mag0 = Math.hypot(re[b0], im[b0]) / n;
    const mag1 = Math.hypot(re[b1], im[b1]) / n;
    const mag = mag0 + (mag1 - mag0) * frac;

    const db = mag > 1e-5 ? 20 * Math.log10(mag * 7) : -60;
    const clampedDb = Math.max(EQ_GAIN_MIN - 12, Math.min(EQ_GAIN_MAX + 12, db));
    const targetY = gainToY(clampedDb, h);

    if (prevY && prevY.length === w) {
      const py = prevY[x];
      // Faster attack when rising (smaller Y value = higher on screen), smooth decay
      out[x] = targetY < py ? py + (targetY - py) * 0.45 : py + (targetY - py) * 0.12;
    } else {
      out[x] = targetY;
    }
  }

  return out;
}

/** The interactive canvas itself — sized by its container (CSS), reused
 *  unchanged for both the compact inline stage and the popout. */
function EqCanvas({ bands, onChange, color }: EqCanvasProps) {
  const themeVersion = useThemeVersion();
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const drag = useRef<string | null>(null);

  const bandsRef = useRef(bands);
  bandsRef.current = bands;
  const hoverIdRef = useRef(hoverId);
  hoverIdRef.current = hoverId;
  const mousePosRef = useRef(mousePos);
  mousePosRef.current = mousePos;

  const prevPreYRef = useRef<Float32Array | null>(null);
  const prevPostYRef = useRef<Float32Array | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let running = true;
    if (eqMounted++ === 0) bridge.setEqScopes(true);

    const renderFrame = () => {
      if (!running) return;

      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));

      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cs = getComputedStyle(document.body);
      ctx.fillStyle = cs.getPropertyValue('--bg-surface-elevated').trim() || '#0c1133';
      ctx.fillRect(0, 0, w, h);

      // -----------------------------------------------------------------------
      // High-density Frequency & Gain Grid (Bitwig EQ+ / FabFilter style)
      // -----------------------------------------------------------------------
      // 1. Sub-decade minor vertical lines
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      const minorFreqs = [
        30, 40, 60, 70, 80, 90,
        300, 400, 600, 700, 800, 900,
        3000, 4000, 6000, 7000, 8000, 9000, 15000,
      ];
      for (const f of minorFreqs) {
        const gx = freqToX(f, w);
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
      }

      // 2. Major vertical frequency lines & top labels
      const majorFreqs: { f: number; label: string }[] = [
        { f: 20, label: '20' },
        { f: 50, label: '50' },
        { f: 100, label: '100' },
        { f: 200, label: '200' },
        { f: 500, label: '500' },
        { f: 1000, label: '1k' },
        { f: 2000, label: '2k' },
        { f: 5000, label: '5k' },
        { f: 10000, label: '10k' },
        { f: 20000, label: '20k' },
      ];

      ctx.font = '8px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      for (const { f, label } of majorFreqs) {
        const gx = freqToX(f, w);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();

        ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.fillText(label, gx, 3);
      }

      // 3. Horizontal gain lines & right dB labels
      const gains = [-30, -24, -18, -12, -6, 0, 6, 12, 18, 24, 30];
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';

      for (const g of gains) {
        const gy = gainToY(g, h);
        const isCenter = g === 0;

        ctx.strokeStyle = isCenter ? 'rgba(255, 255, 255, 0.35)' : 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = isCenter ? 1.5 : 1;
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();

        // dB label on right edge
        ctx.fillStyle = isCenter ? 'rgba(255, 255, 255, 0.75)' : 'rgba(255, 255, 255, 0.4)';
        const label = g > 0 ? `+${g}` : `${g}`;
        ctx.fillText(label, w - 4, gy);
      }

      // -----------------------------------------------------------------------
      // REAL-TIME PRE AND POST SPECTRUM ANALYZER (ZLEqualizer-style)
      // -----------------------------------------------------------------------
      const preBuf = getScope('eq_pre');
      const postBuf = getScope('eq_post');

      const preY = computeSpectrumPoints(preBuf, w, h, prevPreYRef.current);
      const postY = computeSpectrumPoints(postBuf, w, h, prevPostYRef.current);
      prevPreYRef.current = preY;
      prevPostYRef.current = postY;

      // 1. PRE-EQ Spectrum (Drawn first, behind POST)
      ctx.save();
      ctx.fillStyle = 'rgba(70, 130, 220, 0.12)';
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x < w; x += 1) ctx.lineTo(x, preY[x]);
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = 'rgba(110, 170, 255, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (let x = 0; x < w; x += 1) {
        if (x === 0) ctx.moveTo(x, preY[x]);
        else ctx.lineTo(x, preY[x]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // 2. POST-EQ Spectrum (Drawn second, in front of PRE, more prominent)
      ctx.save();
      const postGrad = ctx.createLinearGradient(0, 0, 0, h);
      postGrad.addColorStop(0, 'rgba(0, 245, 212, 0.22)');
      postGrad.addColorStop(1, 'rgba(0, 245, 212, 0.02)');
      ctx.fillStyle = postGrad;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x < w; x += 1) ctx.lineTo(x, postY[x]);
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = '#00f5d4';
      ctx.lineWidth = 2.2;
      ctx.shadowColor = '#00f5d4';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      for (let x = 0; x < w; x += 1) {
        if (x === 0) ctx.moveTo(x, postY[x]);
        else ctx.lineTo(x, postY[x]);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.restore();

      // -----------------------------------------------------------------------
      // Rainbow response curve (Bitwig EQ+ style frequency spectrum gradient)
      // -----------------------------------------------------------------------
      const currentBands = bandsRef.current;
      if (currentBands.length > 0) {
        const points: { x: number; y: number }[] = [];
        for (let i = 0; i <= 180; i += 1) {
          const x = (i / 180) * w;
          const freq = xToFreq(x, w);
          let db = 0;
          for (const b of currentBands) db += bandDb(b, freq);
          const y = gainToY(Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, db)), h);
          points.push({ x, y });
        }

        ctx.beginPath();
        for (let i = 0; i < points.length; i += 1) {
          if (i === 0) ctx.moveTo(points[i].x, points[i].y);
          else ctx.lineTo(points[i].x, points[i].y);
        }

        const grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0.0, '#ff3b30');  // Red (Sub/Low)
        grad.addColorStop(0.18, '#ff9500'); // Orange
        grad.addColorStop(0.38, '#ffcc00'); // Yellow
        grad.addColorStop(0.58, '#34c759'); // Green (Mids)
        grad.addColorStop(0.78, '#5ac8fa'); // Cyan (High Mids)
        grad.addColorStop(0.90, '#007aff'); // Blue (Highs)
        grad.addColorStop(1.0, '#af52de');  // Purple (Air)

        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = 'rgba(255, 255, 255, 0.35)';
        ctx.shadowBlur = 6;
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = cs.getPropertyValue('--text-muted').trim() || '#8e9cc8';
        ctx.font = '11px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('double-click to add a band', w / 2, h / 2);
      }

      // -----------------------------------------------------------------------
      // Nodes (numbered badges FabFilter/Bitwig style)
      // -----------------------------------------------------------------------
      const currentHoverId = hoverIdRef.current;
      const currentMousePos = mousePosRef.current;
      const currentDrag = drag.current;

      currentBands.forEach((b, i) => {
        const x = freqToX(b.freq, w);
        const y = gainToY(b.gain, h);
        const bc = bandColor(i);
        const isHovered = b.id === currentHoverId;
        const isDragged = b.id === currentDrag;
        const r = isHovered || isDragged ? 8 : 6.5;

        if (isHovered || isDragged) {
          ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2);
          ctx.fillStyle = `color-mix(in srgb, ${bc} 35%, transparent)`; ctx.fill();
        }

        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = bc; ctx.fill();
        ctx.strokeStyle = isHovered || isDragged ? '#ffffff' : 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1.5; ctx.stroke();

        // Band index number
        ctx.fillStyle = '#080c16';
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${i + 1}`, x, y + 0.5);
      });

      // Cursor hover indicators for edge zones (Low Shelf, High Shelf, High Pass)
      if (!currentHoverId && currentMousePos && !currentDrag) {
        const mx = currentMousePos.x;
        const my = currentMousePos.y;
        const hoverFreq = xToFreq(mx, w);

        if (mx < 30 || hoverFreq < 32) {
          drawHighPassSymbol(ctx, Math.max(16, mx), Math.max(20, Math.min(h - 20, my)));
        } else if (mx < 110 || hoverFreq < 160) {
          drawLowShelfSymbol(ctx, mx, Math.max(20, Math.min(h - 20, my)));
        } else if (mx > w - 110 || hoverFreq > 8000) {
          drawHighShelfSymbol(ctx, mx, Math.max(20, Math.min(h - 20, my)));
        }
      }

      if (running) {
        rafId = requestAnimationFrame(renderFrame);
      }
    };

    rafId = requestAnimationFrame(renderFrame);

    return () => {
      running = false;
      cancelAnimationFrame(rafId);
      if (--eqMounted === 0) bridge.setEqScopes(false);
    };
  }, [color, themeVersion]);

  const bandAt = (e: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>): EqBand | null => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    let best: EqBand | null = null;
    let bestDist = 14;
    for (const b of bands) {
      const dx = freqToX(b.freq, r.width) - px;
      const dy = gainToY(b.gain, r.height) - py;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) { bestDist = d; best = b; }
    }
    return best;
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 2) return; // Right-click handled by onContextMenu
    const hit = bandAt(e);
    if (!hit) return;
    drag.current = hit.id;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    setMousePos({ x: px, y: py });

    if (drag.current) {
      const target = bands.find((b) => b.id === drag.current);
      const freq = Math.max(EQ_FREQ_MIN, Math.min(EQ_FREQ_MAX, xToFreq(px, r.width)));
      const isNoGain = target?.type === 'highpass' || target?.type === 'lowpass' || target?.type === 'notch';
      const gain = isNoGain ? 0 : Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, yToGain(py, r.height)));
      onChange(bands.map((b) => (b.id === drag.current ? { ...b, freq, gain } : b)));
      return;
    }
    setHoverId(bandAt(e)?.id ?? null);
  };

  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drag.current) { try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ } drag.current = null; }
  };

  const onLeave = () => {
    setHoverId(null);
    setMousePos(null);
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const hit = bandAt(e);
    if (!hit) {
      setMenu(null);
      return;
    }
    const menuWidth = 220;
    const menuHeight = 250;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
    setMenu({ x, y, bandId: hit.id });
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = bandAt(e);
    if (hit) { onChange(bands.filter((b) => b.id !== hit.id)); return; }
    if (bands.length >= MAX_EQ_BANDS) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const freq = Math.max(EQ_FREQ_MIN, Math.min(EQ_FREQ_MAX, xToFreq(px, r.width)));
    const gain = Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, yToGain(py, r.height)));

    let type: EqBandType = 'bell';
    if (px < 30 || freq < 32) type = 'highpass';
    else if (px < 110 || freq < 160) type = 'lowshelf';
    else if (px > r.width - 110 || freq > 8000) type = 'highshelf';

    // Only 'highpass' is ever assigned above (lowpass/notch have no placement
    // heuristic here) — TS narrowing is right, so compare against that alone.
    const initialGain = type === 'highpass' ? 0 : gain;

    onChange([...bands, { id: newEqBandId(), freq, gain: initialGain, q: 0.7, type }]);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!hoverId) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    onChange(bands.map((b) => (b.id === hoverId ? { ...b, q: Math.max(EQ_Q_MIN, Math.min(EQ_Q_MAX, b.q * factor)) } : b)));
  };

  const getCursor = () => {
    if (hoverId) return drag.current ? 'grabbing' : 'grab';
    if (mousePos) {
      if (mousePos.x < 30 || mousePos.x < 110 || mousePos.x > 350) return 'pointer';
    }
    return 'crosshair';
  };

  return (
    <>
      <canvas
        ref={ref}
        className="eq-editor-canvas"
        data-allow-2d=""
        style={{ cursor: getCursor() }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={onLeave}
        onContextMenu={onContextMenu}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
      />
      {menu && (() => {
        const targetBand = bands.find((b) => b.id === menu.bandId);
        const bandIndex = bands.findIndex((b) => b.id === menu.bandId);
        if (!targetBand || bandIndex < 0) return null;

        const setType = (t: EqBandType) => {
          const isNoGain = t === 'highpass' || t === 'lowpass' || t === 'notch';
          onChange(
            bands.map((b) =>
              b.id === menu.bandId
                ? { ...b, type: t, gain: isNoGain ? 0 : (b.gain === 0 ? 3 : b.gain) }
                : b
            )
          );
          setMenu(null);
        };

        const removeBand = () => {
          onChange(bands.filter((b) => b.id !== menu.bandId));
          setMenu(null);
        };

        const menuOptions: { type: EqBandType; label: string; desc: string; icon: string }[] = [
          { type: 'highpass', label: 'Low-cut (High-pass)', desc: '12dB/oct slope', icon: '⤻' },
          { type: 'lowshelf', label: 'Low-shelf', desc: 'Gain-variable shelf', icon: '⤿' },
          { type: 'bell', label: 'Bell', desc: 'Gain-variable peak', icon: '∿' },
          { type: 'highshelf', label: 'High-shelf', desc: 'Gain-variable shelf', icon: '⤾' },
          { type: 'lowpass', label: 'High-cut (Low-pass)', desc: '12dB/oct slope', icon: '⤺' },
          { type: 'notch', label: 'Notch', desc: 'Steep cut at freq', icon: 'V' },
        ];

        return createPortal(
          <>
            <div
              className="eq-menu-scrim"
              onClick={() => setMenu(null)}
              onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
            />
            <ul className="eq-context-menu" style={{ left: menu.x, top: menu.y }}>
              <li className="eq-context-menu-head">BAND {bandIndex + 1} TYPE</li>
              {menuOptions.map((opt) => (
                <li key={opt.type}>
                  <button
                    type="button"
                    className={targetBand.type === opt.type ? 'is-active' : ''}
                    onClick={() => setType(opt.type)}
                  >
                    <span className="eq-context-menu-icon">{opt.icon}</span>
                    <span>{opt.label}</span>
                    <span className="eq-context-menu-sub">{opt.desc}</span>
                  </button>
                </li>
              ))}
              <li style={{ borderTop: '1px solid var(--border-soft, rgba(255,255,255,0.1))', marginTop: 4, paddingTop: 4 }}>
                <button type="button" onClick={removeBand} style={{ color: '#ff5d6c' }}>
                  <span className="eq-context-menu-icon">×</span>
                  <span>Delete Band</span>
                </button>
              </li>
            </ul>
          </>,
          document.body
        );
      })()}
    </>
  );
}

/** Popout — same backdrop/portal idiom as the LFO `FunctionEditor`
 *  (EnvelopePanel.tsx), independent CSS classes. */
export function EqEditorPopout({ bands, onChange, onClose, color }: EqCanvasProps & { onClose: () => void }) {
  return createPortal(
    <div
      className="eq-editor-backdrop"
      role="dialog"
      aria-label="EQ editor"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <div className="eq-editor-modal">
        <header><strong>EQ</strong><button type="button" onClick={onClose} aria-label="Close EQ editor">×</button></header>
        <div className="eq-editor-modal-canvas"><EqCanvas bands={bands} onChange={onChange} color={color} /></div>
        <span className="eq-editor-help">
          double-click add/remove a band · right-click a node for band type menu · drag moves freq/gain · scroll over point changes Q · {bands.length}/{MAX_EQ_BANDS} bands
        </span>
      </div>
    </div>,
    document.body,
  );
}

export function EqEditorStage({ bands, onChange, color }: EqCanvasProps) {
  return (
    <div className="eq-editor-stage">
      <EqCanvas bands={bands} onChange={onChange} color={color} />
    </div>
  );
}
