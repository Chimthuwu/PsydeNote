import { useEffect, useRef, useState } from 'react';
import { AnalyserLike, drawVisualizer } from '../lib/visualizer';
import { Theme, VisualizerMode } from '../../shared/types';

import { PeakBuffer } from '../lib/peak-buffer';

interface Props {
  analyser: AnalyserLike | null;
  mode: VisualizerMode;
  theme: Theme;
  className?: string;
  /** Placeholder text shown when nothing is bound. */
  idleText?: string;
  peakBuffer?: PeakBuffer | null;
  isPopout?: boolean;
  onSelectionChange?: (sel: [number, number] | null) => void;
  onDragExport?: (sel: [number, number]) => void;
  /** Sampler-only: the captured sample's [min, max] peak pairs, drawn when
   *  this board is in history mode. */
  samplePeaks?: Float32Array | null;
}

export function VisualizerBoard({ analyser, mode, theme, className, idleText, peakBuffer, isPopout = false, onSelectionChange, onDragExport, samplePeaks = null }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  
  const [selection, setSelection] = useState<[number, number] | null>(null);

  const handleDragStart = (e: React.DragEvent) => {
    e.preventDefault(); // crucial for electron drag
    window.api.startDragExportPrepared();
  };

  const dragState = useRef<{
    type: 'new' | 'left' | 'right';
    startX: number;
    initialSelection: [number, number];
  } | null>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode !== 'history') return;
    const target = e.target as HTMLElement;
    // Ignore down events on the selection background itself so native drag works
    if (target.classList.contains('history-selection') || target.classList.contains('history-selection-border') || target.classList.contains('history-duration')) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;

    let type: 'new' | 'left' | 'right' = 'new';
    
    if (target.classList.contains('left')) type = 'left';
    else if (target.classList.contains('right')) type = 'right';

    dragState.current = {
      type,
      startX: x,
      initialSelection: selection || [x, x],
    };

    if (type === 'new') {
      setSelection([x, x]);
    }
    
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current || mode !== 'history') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const { type, initialSelection } = dragState.current;

    if (type === 'new') {
      setSelection([Math.min(initialSelection[0], x), Math.max(initialSelection[0], x)]);
    } else if (type === 'left') {
      setSelection([Math.min(x, initialSelection[1]), Math.max(x, initialSelection[1])]);
    } else if (type === 'right') {
      setSelection([Math.min(initialSelection[0], x), Math.max(initialSelection[0], x)]);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragState.current = null;
    
    setSelection(currentSel => {
      if (currentSel && currentSel[1] - currentSel[0] < 0.001) {
        onSelectionChange?.(null);
        return null;
      }
      onSelectionChange?.(currentSel);
      return currentSel;
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!selection) return;
    const nudge = 0.005; // 0.5%
    if (e.key === 'ArrowLeft') {
      const shift = e.shiftKey ? nudge * 5 : nudge;
      const newLeft = Math.max(0, selection[0] - shift);
      const diff = selection[0] - newLeft;
      const newSel: [number, number] = [newLeft, selection[1] - diff];
      setSelection(newSel);
      onSelectionChange?.(newSel);
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      const shift = e.shiftKey ? nudge * 5 : nudge;
      const newRight = Math.min(1, selection[1] + shift);
      const diff = newRight - selection[1];
      const newSel: [number, number] = [selection[0] + diff, newRight];
      setSelection(newSel);
      onSelectionChange?.(newSel);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      setSelection(null);
      onSelectionChange?.(null);
      e.preventDefault();
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;

    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    };
    fit();
    // The canvas box changes for reasons other than a window resize — the
    // footer chip row wrapping, the HUD gaining/losing the error line, a
    // breakpoint firing — so observe the element itself, not just `window`.
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);
    window.addEventListener('resize', fit);

    const draw = () => {
      if (analyser || mode === 'history') {
        drawVisualizer(
          {
            ctx: ctx as unknown as CanvasRenderingContext2D,
            width: canvas.width,
            height: canvas.height,
            theme,
            mode,
            rms: 0,
            peakBuffer,
            isPopout,
            samplePeaks,
          },
          analyser || ({} as AnalyserLike),
        );
      } else {
        // Idle screen: pulsing placeholder.
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let grad: CanvasGradient;
        grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
        grad.addColorStop(0, '#0c1133');
        grad.addColorStop(1, '#070a1c');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(120,150,255,0.15)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Drop to the terse message once the long one can't fit, and cap the
        // font size off the width too so it never runs past the canvas edges.
        const long = idleText ?? 'Pick a source and press Start';
        const msg = canvas.width < 260 ? 'no source' : long;
        const size = Math.max(
          8,
          Math.floor(Math.min(canvas.height / 14, (canvas.width * 0.82) / (msg.length * 0.6))),
        );
        ctx.font = `${size}px ui-monospace, Consolas, monospace`;
        ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [analyser, mode, theme, idleText, peakBuffer, samplePeaks]);

  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      {mode === 'history' && peakBuffer && (
        <div
          className="history-interaction-layer"
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
        >
          {selection && (
            <div
              className="history-selection"
              draggable={true}
              onDragStart={handleDragStart}
              style={{
                left: `${selection[0] * 100}%`,
                width: `${(selection[1] - selection[0]) * 100}%`,
              }}
            >
              <div className="history-selection-border" style={{ width: '100%' }} />
              <div className="history-duration">
                {((selection[1] - selection[0]) * peakBuffer.getCount() * 0.02).toFixed(2)}s
              </div>
              <div className="history-handle left" />
              <div className="history-handle right" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
