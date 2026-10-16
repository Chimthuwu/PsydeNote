import { useEffect, useRef } from 'react';
import { getScope, getScopeVersion } from './scopeStore';

/**
 * 3D waveform for an oscillator: the last SLICES waveform frames drawn as
 * receding ridges (newest in front, oldest at the back). Visual only.
 * Right-click returns to the 2D view the oscillator was showing.
 */

const SLICES = 48;
const POINTS = 160;
const BG = '#0a0c10';

/** A CSS colour (e.g. 'var(--accent)' or '#rrggbb') as a concrete rgb string for canvas. */
function resolveColor(el: HTMLElement, css: string): string {
  const probe = document.createElement('span');
  probe.style.color = css;
  el.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c || '#7cf';
}

interface Props {
  source: string;
  color?: string;
  onBack: () => void;
}

export function Wave3D({ source, color = 'var(--accent)', onBack }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(wrap.clientWidth * dpr));
      const h = Math.max(1, Math.floor(wrap.clientHeight * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    });
    ro.observe(wrap);

    const rgb = resolveColor(wrap, color);
    const slices: Float32Array[] = [];
    let lastVersion = -1;
    let raf = 0;
    let running = true;

    const draw = () => {
      if (!running) return;
      raf = requestAnimationFrame(draw);

      const version = getScopeVersion(source);
      if (version !== lastVersion) {
        lastVersion = version;
        const buf = getScope(source);
        if (buf && buf.length) {
          const s = new Float32Array(POINTS);
          const step = buf.length / POINTS;
          for (let i = 0; i < POINTS; i += 1) s[i] = buf[Math.min(buf.length - 1, Math.floor(i * step))];
          slices.push(s);
          if (slices.length > SLICES) slices.shift();
        }
      }

      const W = canvas.width;
      const H = canvas.height;
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);
      const n = slices.length;
      if (n === 0) return;

      // Back to front: the oldest slice is smallest and highest; the newest is widest and lowest.
      for (let k = 0; k < n; k += 1) {
        const depth = (k + 1) / n;               // 0..1, 1 = front
        const yBase = H * (0.18 + 0.74 * depth);
        const xScale = 0.5 + 0.5 * depth;
        const x0 = W * (1 - xScale) / 2;
        const amp = H * 0.14 * (0.45 + 0.55 * depth);
        const s = slices[k];

        ctx.beginPath();
        for (let i = 0; i < POINTS; i += 1) {
          const x = x0 + (i / (POINTS - 1)) * W * xScale;
          const y = yBase - s[i] * amp;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        // Fill under the ridge with the background so nearer ridges hide farther ones.
        ctx.lineTo(x0 + W * xScale, H);
        ctx.lineTo(x0, H);
        ctx.closePath();
        ctx.fillStyle = BG;
        ctx.fill();

        ctx.beginPath();
        for (let i = 0; i < POINTS; i += 1) {
          const x = x0 + (i / (POINTS - 1)) * W * xScale;
          const y = yBase - s[i] * amp;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.globalAlpha = 0.25 + 0.75 * depth;
        ctx.strokeStyle = rgb;
        ctx.lineWidth = Math.max(1, (W / 420) * (0.6 + 0.4 * depth));
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [source, color]);

  return (
    <div
      ref={wrapRef}
      className="faze-scope wave3d"
      title="3D waveform - right-click to go back to the 2D view"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onBackRef.current();
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
