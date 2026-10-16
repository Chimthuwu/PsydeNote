import { useEffect, useRef } from 'react';
import { useThemeVersion } from '../lib/useThemeVersion';
import type { Wave } from '../../shared/types';

interface Props {
  wave: Wave;
  /** Optional: highlight colour if you want to override the theme token. */
}

/**
 * Tiny instrument-panel display: one cycle of the current waveform.
 *
 * Not driven by the audio analyser — draws the *theoretical* shape so the
 * indicator is meaningful even before any note is played. The colour comes
 * from the theme's `--waveform` token; the surrounding chrome anchors it
 * back to the panel.
 */
export function WaveformThumb({ wave }: Props) {
  const themeVersion = useThemeVersion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = cvs.getBoundingClientRect();
    cvs.width = Math.max(1, Math.floor(rect.width * dpr));
    cvs.height = Math.max(1, Math.floor(rect.height * dpr));

    ctx.clearRect(0, 0, cvs.width, cvs.height);

    // Read theme tokens — the synth UI must avoid hard-coded colours.
    const cs = getComputedStyle(cvs);
    const streamColor = cs.getPropertyValue('--waveform').trim() || '#7df9ff';
    const grid = cs.getPropertyValue('--grid-minor').trim() || 'rgba(120,150,255,0.1)';
    const bg = cs.getPropertyValue('--bg-surface-elevated').trim() || '#0c1133';

    // Background
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cvs.width, cvs.height);

    // Centre line + half-amplitude marks
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1 * dpr;
    const mid = cvs.height / 2;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(cvs.width, mid);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, mid - cvs.height * 0.35);
    ctx.lineTo(cvs.width, mid - cvs.height * 0.35);
    ctx.moveTo(0, mid + cvs.height * 0.35);
    ctx.lineTo(cvs.width, mid + cvs.height * 0.35);
    ctx.stroke();

    // One cycle of the chosen shape.
    const N = 256;
    ctx.strokeStyle = streamColor;
    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = streamColor;
    ctx.shadowBlur = 6 * dpr;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const x = t * cvs.width;
      const y = mid + sample(t, wave) * cvs.height * 0.35;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }, [wave, themeVersion]);

  return (
    <div className="op-thumb" aria-label={`${wave} waveform`}>
      <canvas ref={canvasRef} />
    </div>
  );
}

/**
 * Sample one cycle at phase t ∈ [0, 1). Phase is normalised to *one* period
 * regardless of the fundamental — the indicator isn't telling you which
 * note you're on, only which waveform family you've picked.
 */
function sample(t: number, wave: Wave): number {
  switch (wave) {
    case 'sine':
      return Math.sin(t * Math.PI * 2);
    case 'triangle':
      return 1 - 4 * Math.abs(t - 0.5);
    case 'sawtooth':
      return 2 * (t < 0.5 ? t : t - 1); // ramp up, hard reset
    case 'square':
      return t < 0.5 ? 0.9 : -0.9;
    case 'sample':
      // Sample buffers aren't periodic in any useful sense for the thumb;
      // we render a small flat envelope so the user can see something other
      // than "no sample" while a buffer is loading. Real sample rendering
      // is SamplerPanel's job (it paints the captured buffer's actual peaks).
      return 0;
  }
}
