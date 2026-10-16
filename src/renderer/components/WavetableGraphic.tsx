import { useMemo } from 'react';
import { generateWavetableFrames } from '../../../spike/elementary/dsp/wavetables.js';
import type { OperatorId, OscillatorSlotSettings, SynthSettings } from '../../shared/types';

interface WavetableGraphicProps {
  id: OperatorId;
  slot: OscillatorSlotSettings;
  settings: SynthSettings;
  width?: number;
  height?: number;
}

export const WavetableGraphic: React.FC<WavetableGraphicProps> = ({
  id,
  slot,
  settings,
  width = 200,
  height = 80
}) => {
  // Frames depend on table + warp only; the scan position just picks one, so
  // dragging WT Pos doesn't regenerate (or re-warp) the whole table.
  const frames = useMemo(() => {
    try {
      return generateWavetableFrames(
        slot.wtId ?? 0,
        slot.warpMode ?? 0, slot.warpAmount ?? 0, slot.warpParam2 ?? 0.5,
        slot.warpMode2 ?? 0, slot.warpAmount2 ?? 0, slot.warpParam2_2 ?? 0.5
      );
    } catch (error) {
      console.error('Error generating wavetable frames:', error);
      return [] as Float32Array[];
    }
  }, [slot.wtId, slot.warpMode, slot.warpAmount, slot.warpParam2,
      slot.warpMode2, slot.warpAmount2, slot.warpParam2_2]);

  const waveformPath = useMemo(() => {
    if (frames.length === 0) return `M 0 ${height / 2} L ${width} ${height / 2}`;
    const pos = Math.max(0, Math.min(1, slot.wtPos ?? 0));
    const frame = frames[Math.round(pos * (frames.length - 1))];
    const pts = Array.from(frame, (val, i) => {
      const v = Math.max(-1, Math.min(1, val));
      return `${(i / (frame.length - 1)) * width},${v * -0.4 * height + height / 2}`;
    }).join(' L ');
    return `M ${pts}`;
  }, [frames, slot.wtPos, width, height]);

  return (
    <div className="op-wavetable-graphic" style={{ width: `${width}px`, height: `${height}px` }}>
      <svg 
        width={width} 
        height={height} 
        className="wavetable-waveform"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <path 
          d={waveformPath} 
          stroke="var(--op-color)" 
          strokeWidth="2"
          fill="none"
        />
      </svg>
    </div>
  );
};
