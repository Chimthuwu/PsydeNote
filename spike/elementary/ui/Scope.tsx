// Faze visualizer (todo.md §73 P7c, reworked in §168). Draws a native
// `el.scope` frame (scopeStore) as an oscilloscope / spectrum / spectrogram.
// ONE rAF loop, throttled by shims.ts (~60fps), that only repaints on a new
// frame (spectrogram scrolls every tick). The canvas is sized by a
// ResizeObserver on its own box. Right-click cycles / picks the mode.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useThemeVersion } from '../../../src/renderer/lib/useThemeVersion';
import { getScope, getScopeVersion, getVizGain, setVizGain, VIZ_GAIN_PRESETS } from './scopeStore';

export type ScopeMode = 'scope' | 'spectrum' | 'spectrogram' | 'wave3d';
export const SCOPE_MODES: { id: ScopeMode; label: string; glyph: string }[] = [
  { id: 'scope', label: 'Oscilloscope', glyph: '∿' },
  { id: 'spectrum', label: 'Spectrum', glyph: '▥' },
  { id: 'spectrogram', label: 'Spectrogram', glyph: '▦' },
  // Oscillators only: PluginApp swaps the view for <Wave3D>. Right-click it to go back.
  { id: 'wave3d', label: '3D waveform', glyph: '◱' },
];

interface Props {
  source: string;
  mode: ScopeMode;
  onChangeMode: (m: ScopeMode) => void;
  color?: string;
  className?: string;
}

/** Cached per-size FFT tables (bit-reverse + twiddles + Hann window) and
 *  reusable work buffers. The old fft() recomputed cos/sin per stage per call
 *  and the draw loop allocated fresh Float32Arrays every frame. */
interface FftPlan {
  n: number; rev: Uint32Array; cos: Float32Array; sin: Float32Array; win: Float32Array;
  re: Float32Array; im: Float32Array; mag: Float32Array; smooth: Float32Array;
}
const plans = new Map<number, FftPlan>();
function planFor(n: number): FftPlan {
  let p = plans.get(n);
  if (p) return p;
  const rev = new Uint32Array(n);
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k += 1) {
    cos[k] = Math.cos((-2 * Math.PI * k) / n);
    sin[k] = Math.sin((-2 * Math.PI * k) / n);
  }
  const win = new Float32Array(n);
  for (let i = 0; i < n; i += 1) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  p = {
    n, rev, cos, sin, win,
    re: new Float32Array(n), im: new Float32Array(n),
    mag: new Float32Array(n / 2), smooth: new Float32Array(n / 2),
  };
  plans.set(n, p);
  return p;
}

/** In-place radix-2 FFT of the plan's re/im buffers. */
function fftPlan(p: FftPlan) {
  const { n, rev, cos, sin, re, im } = p;
  for (let i = 1; i < n; i += 1) {
    const j = rev[i];
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, t = 0; k < half; k += 1, t += step) {
        const cr = cos[t];
        const ci = sin[t];
        const a = i + k;
        const b = a + half;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
      }
    }
  }
}

/** dB floor for the spectrum views (ceiling is 0 dB = full-scale sine). */
const DB_FLOOR = -84;

/** Fill `p.mag` with 0..1 levels on a dB scale for the latest buffer.
 *  `decay` in [0,1): bins rise instantly but fall slowly, so the curve glides
 *  instead of flickering from frame to frame (0 = no smoothing). */
function analyse(p: FftPlan, buf: Float32Array, gain: number, decay: number) {
  const { n, re, im, win, mag, smooth } = p;
  const off = Math.max(0, buf.length - n);
  for (let i = 0; i < n; i += 1) {
    re[i] = (buf[off + i] ?? 0) * win[i];
    im[i] = 0;
  }
  fftPlan(p);
  const norm = 4 / n; // Hann coherent gain is 0.5 -> a full-scale sine reads ~1.0
  for (let b = 0; b < n / 2; b += 1) {
    const m = Math.hypot(re[b], im[b]) * norm * gain;
    const db = m > 1e-6 ? 20 * Math.log10(m) : DB_FLOOR;
    const lvl = Math.max(0, Math.min(1, (db - DB_FLOOR) / -DB_FLOOR));
    smooth[b] = lvl > smooth[b] ? lvl : smooth[b] * decay + lvl * (1 - decay);
    mag[b] = smooth[b];
  }
}

const SAMPLE_RATE = 48000;
/** Level at frequency `hz` (linear interpolation between bins). */
function levelAt(p: FftPlan, hz: number): number {
  const bins = p.n / 2;
  const bf = Math.max(0, Math.min(bins - 1.001, (hz / (SAMPLE_RATE / 2)) * bins));
  const b0 = Math.floor(bf);
  return p.mag[b0] + (p.mag[b0 + 1] - p.mag[b0]) * (bf - b0);
}
const F_LO = 30;
const F_HI = 20000;
const xToHz = (x: number, W: number) => F_LO * Math.pow(F_HI / F_LO, x / Math.max(1, W - 1));

export function Scope({ source, mode, onChangeMode, color = 'var(--accent)', className }: Props) {
  const themeVersion = useThemeVersion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [gain, setGain] = useState(getVizGain(source));
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Visual auto-level (todo.md §167 §1): when on, the draw gain tracks the
  // signal peak (fast attack, slow release) so quiet patches fill the canvas
  // without hand-tuning Reactivity. Display only. Persisted per source.
  const autoKey = `faze.vizAuto.${source}`;
  const [auto, setAuto] = useState(() => { try { return localStorage.getItem(autoKey) === '1'; } catch { return false; } });
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const autoGainRef = useRef(1);

  // Resolve the CSS colour token to a concrete rgb once (canvas needs a real colour).
  const resolvedColor = useMemo(() => color, [color]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    canvas.setAttribute('data-allow-2d', '');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // The big main canvas gets a DPR-aware backing store (the window runs
    // body-zoomed and at a non-1 devicePixelRatio, so a 1x bitmap was being
    // upscaled = soft/pixelated edges); the small op scopes stay 1x to keep
    // fill cost down. `px` is the bitmap-pixels-per-CSS-pixel factor.
    const isMain = source === 'main';
    let px = 1;
    const fit = () => {
      const r = wrap.getBoundingClientRect();
      const uiScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
      px = isMain ? Math.max(1, Math.min(2, (window.devicePixelRatio || 1) * uiScale)) : 1;
      const w = Math.max(1, Math.round(r.width * px));
      const h = Math.max(1, Math.round(r.height * px));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    };
    // Layout reads only on mount + whenever the box's OWN size actually
    // changes — never per frame (§73: per-frame getBoundingClientRect was
    // part of what froze the DAW). ResizeObserver fires on the first observe()
    // too, so this also replaces a manual fit() and fixes the cold-launch race
    // where the box was measured before its flex siblings had settled.
    const ro = new ResizeObserver(() => fit());
    ro.observe(wrap);

    // Read theme tokens off `document.body` (always carries `theme-${theme}`).
    const resolveColor = () => {
      if (!resolvedColor.startsWith('var(')) return resolvedColor || '#37e0d8';
      return getComputedStyle(document.body).getPropertyValue(resolvedColor.slice(4, -1).trim()).trim()
        || '#37e0d8';
    };
    const resolveBg = () => getComputedStyle(document.body).getPropertyValue('--bg-surface-elevated').trim() || '#05070f';
    let col = resolveColor();
    let bgCol = resolveBg();

    let raf = 0;
    let lastVersion = -1;
    let frameN = 0;
    let running = true;

    const draw = () => {
      if (!running) return;
      raf = requestAnimationFrame(draw);
      const m = modeRef.current;
      const version = getScopeVersion(source);
      const fresh = version !== lastVersion;
      if (!fresh && m !== 'spectrogram') return;
      const W = canvas.width;
      const H = canvas.height;
      if (W <= 1 || H <= 1) { fit(); return; } // box not laid out yet
      lastVersion = version;
      const buf = getScope(source);
      let g = getVizGain(source); // draw-time reactivity multiplier, per-group (todo.md §92/§96)
      if (autoRef.current && buf && buf.length) {
        let pk = 0;
        for (let i = 0; i < buf.length; i += 1) { const a = Math.abs(buf[i]); if (a > pk) pk = a; }
        const want = pk > 1e-4 ? Math.min(40, 0.9 / pk) : autoGainRef.current;
        // gain falling (loud peak) applies at once so peaks never clip; rising is slow
        autoGainRef.current = want < autoGainRef.current ? want : autoGainRef.current + (want - autoGainRef.current) * 0.03;
        g *= Math.max(1, autoGainRef.current);
      }
      if ((frameN++ & 127) === 0) { col = resolveColor(); bgCol = resolveBg(); } // catch theme changes
      const grid = 'rgba(120,150,255,0.10)';

      if (m === 'spectrogram') {
        // Scroll left with a canvas self-blit (stays on the GPU — the old
        // getImageData/putImageData round trip read the whole canvas back
        // every frame), then write the new column from ONE ImageData instead
        // of H separate fillRects with string colours.
        const COL = 2;
        ctx.drawImage(canvas, COL, 0, W - COL, H, 0, 0, W - COL, H);
        ctx.clearRect(W - COL, 0, COL, H);
        if (buf && buf.length && fresh) {
          const n = Math.min(1024, 1 << Math.floor(Math.log2(Math.max(64, buf.length))));
          const p = planFor(n);
          analyse(p, buf, g, 0);
          const colImg = ctx.createImageData(COL, H);
          const d = colImg.data;
          for (let y = 0; y < H; y += 1) {
            const lvl = levelAt(p, xToHz((1 - y / H) * (W - 1), W));
            const r = 80 + lvl * 175;
            const gg = 120 + lvl * 90;
            const bl = 255 - lvl * 40;
            const al = lvl * 255;
            for (let c = 0; c < COL; c += 1) {
              const o = (y * COL + c) * 4;
              d[o] = r; d[o + 1] = gg; d[o + 2] = bl; d[o + 3] = al;
            }
          }
          ctx.putImageData(colImg, W - COL, 0);
        }
        return;
      }

      ctx.fillStyle = bgCol;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = grid;
      ctx.lineWidth = px;
      ctx.beginPath();
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();

      if (!buf || !buf.length) return;

      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      // Two-pass glow instead of shadowBlur — a per-frame gaussian blur of the
      // whole path, on up to five canvases, was the most expensive thing in
      // the draw loop. A wide faint stroke under a crisp one reads the same.
      const strokeGlow = (trace: () => void) => {
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.16;
        ctx.lineWidth = 6 * px;
        ctx.beginPath(); trace(); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2 * px;
        ctx.beginPath(); trace(); ctx.stroke();
      };

      if (m === 'spectrum') {
        const n = Math.min(1024, 1 << Math.floor(Math.log2(Math.max(64, buf.length))));
        const p = planFor(n);
        analyse(p, buf, g, 0.82);

        // Log-frequency axis (where synths live), drawn as a smooth curve.
        const STEP = Math.max(2, Math.round(2 * px));
        const xs: number[] = [];
        const ys: number[] = [];
        for (let x = 0; x <= W + STEP; x += STEP) {
          xs.push(x);
          ys.push(H - levelAt(p, xToHz(Math.min(x, W), W)) * H * 0.96);
        }
        const trace = () => {
          ctx.moveTo(xs[0], ys[0]);
          for (let i = 1; i < xs.length - 1; i += 1) {
            ctx.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[i + 1]) / 2, (ys[i] + ys[i + 1]) / 2);
          }
          ctx.lineTo(xs[xs.length - 1], ys[ys.length - 1]);
        };
        const specGrad = ctx.createLinearGradient(0, 0, 0, H);
        specGrad.addColorStop(0, col);
        specGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = specGrad;
        ctx.beginPath();
        ctx.moveTo(0, H);
        ctx.lineTo(xs[0], ys[0]);
        trace();
        ctx.lineTo(W, H);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        strokeGlow(trace);
      } else {
        // Oscilloscope — trigger on a rising zero crossing so a held note
        // draws a STABLE trace instead of wandering (each native frame is an
        // arbitrary slice of the signal). Only where there is room to spare
        // (the 1024-sample main scope); the 128-point op scopes show it all.
        let start = 0;
        let n = buf.length;
        if (n >= 512) {
          n >>= 1;
          const lim = buf.length - n;
          for (let i = 1; i < lim; i += 1) {
            if (buf[i - 1] < 0 && buf[i] >= 0) { start = i; break; }
          }
        }
        const xs = new Float32Array(n);
        const ys = new Float32Array(n);
        for (let i = 0; i < n; i += 1) {
          xs[i] = (i / (n - 1)) * W;
          const v = Math.max(-1.15, Math.min(1.15, buf[start + i] * g));
          ys[i] = H / 2 - v * (H / 2) * 0.92;
        }
        const trace = () => {
          ctx.moveTo(xs[0], ys[0]);
          for (let i = 1; i < n - 1; i += 1) {
            ctx.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[i + 1]) / 2, (ys[i] + ys[i + 1]) / 2);
          }
          ctx.lineTo(xs[n - 1], ys[n - 1]);
        };
        ctx.save();
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(0, H / 2);
        ctx.lineTo(xs[0], ys[0]);
        trace();
        ctx.lineTo(W, H / 2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        strokeGlow(trace);
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [source, resolvedColor, themeVersion]);

  return (
    <div
      ref={wrapRef}
      className={`faze-scope ${className ?? ''}`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // Re-sync from the shared per-group store — another scope in the
        // same group (e.g. a different operator) may have changed it since
        // this one mounted, and the menu's highlighted preset would
        // otherwise show a stale value (todo.md §96).
        setGain(getVizGain(source));
        // Viewport coords — the menu is portaled to <body> (the scope strip
        // is only ~20px tall and `overflow:hidden`, so an in-box menu was
        // clipped, todo.md §88.6). Flip up/left near the edges.
        const w = 150;
        const h = SCOPE_MODES.length * 30 + 8;
        setMenu({
          x: Math.min(e.clientX, window.innerWidth - w - 6),
          y: Math.min(e.clientY, window.innerHeight - h - 6),
        });
      }}
    >
      <canvas ref={canvasRef} />
      {menu && createPortal(
        <>
          <div className="faze-scope-menu-scrim" onPointerDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <ul className="faze-menu faze-menu-fixed" style={{ left: menu.x, top: menu.y }}>
            {SCOPE_MODES.filter((mm) => mm.id !== 'wave3d' || source.startsWith('op')).map((mm) => (
              <li key={mm.id}>
                <button
                  type="button"
                  className={mm.id === mode ? 'is-on' : ''}
                  onClick={() => { onChangeMode(mm.id); setMenu(null); }}
                >
                  <span className="faze-menu-glyph">{mm.glyph}</span>
                  {mm.label}
                </button>
              </li>
            ))}
            <li className="faze-menu-sep" aria-hidden="true" />
            <li className="faze-menu-head">Reactivity</li>
            <li className="faze-menu-gains">
              <button
                type="button"
                className={auto ? 'is-on' : ''}
                onClick={() => {
                  const next = !auto;
                  setAuto(next);
                  try { localStorage.setItem(autoKey, next ? '1' : '0'); } catch { /* noop */ }
                }}
                title="Auto-level: scale the display to the signal peak"
              >
                Auto-level {auto ? 'on' : 'off'}
              </button>
            </li>
            <li className="faze-menu-gains">
              {VIZ_GAIN_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={Math.abs(gain - p) < 0.01 ? 'is-on' : ''}
                  onClick={() => { setVizGain(source, p); setGain(p); }}
                  title={`Visual amplitude ${p}×`}
                >
                  {p}×
                </button>
              ))}
            </li>
          </ul>
        </>,
        document.body,
      )}
    </div>
  );
}
