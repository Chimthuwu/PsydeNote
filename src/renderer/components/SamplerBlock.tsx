import { useMemo, useRef } from 'react';
import type { OperatorId, OscillatorSlotSettings } from '../../shared/types';
import type { OperatorCaptureContext } from './OscillatorPanel';

/**
 * Sampler face of an OSC card (todo.md §167 S0) — takes the footprint the
 * wavetable graphic + picker + WT Pos slider occupy, so flipping a card
 * between WT and SMP never changes its height.
 *
 * Waveform with a RECORDR-style highlight: drag across it to select the part
 * that plays (writes `sampleStart`/`sampleEnd`, 0..1 of the file); drag near
 * either edge of an existing selection to trim just that edge; double-click
 * to select the whole sample again. Load…/loop/reverse/clear + a root-note
 * picker sit underneath.
 */
const PEAK_POINTS = 160;
const EDGE_PX = 7;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const hzToMidi = (hz: number) => Math.round(69 + 12 * Math.log2(Math.max(1, hz) / 440));
const ROOT_NOTES = Array.from({ length: 61 }, (_, i) => 24 + i); // C1..C6
const noteLabel = (m: number) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

interface Props {
  id: OperatorId;
  slot: OscillatorSlotSettings;
  capture: OperatorCaptureContext;
  onChange: (patch: Partial<OscillatorSlotSettings>) => void;
}

export function SamplerBlock({ id, slot, capture, onChange }: Props) {
  const duration = capture.sampleDuration(id);
  const hasSample = duration > 0;
  const start = Math.max(0, Math.min(1, slot.sampleStart ?? 0));
  const end = Math.max(start, Math.min(1, slot.sampleEnd ?? 1));
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ kind: 'new' | 'start' | 'end'; anchor: number } | null>(null);

  const peaks = useMemo(
    () => capture.samplePeaks(id, PEAK_POINTS),
    // sampleVersion bumps on every load/clear
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [capture.sampleVersion, id],
  );

  const fracAt = (clientX: number) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  const onDown = (e: React.PointerEvent) => {
    if (!hasSample) return;
    const r = wrapRef.current!.getBoundingClientRect();
    const f = fracAt(e.clientX);
    const nearStart = Math.abs(f - start) * r.width <= EDGE_PX;
    const nearEnd = Math.abs(f - end) * r.width <= EDGE_PX;
    if (nearStart && (!nearEnd || Math.abs(f - start) <= Math.abs(f - end))) dragRef.current = { kind: 'start', anchor: end };
    else if (nearEnd) dragRef.current = { kind: 'end', anchor: start };
    else dragRef.current = { kind: 'new', anchor: f };
    e.preventDefault(); // POLICY: no text selection starts during a drag (see ui-selection test)
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const f = fracAt(e.clientX);
    if (d.kind === 'start') onChange({ sampleStart: Math.min(f, d.anchor), sampleEnd: d.anchor });
    else if (d.kind === 'end') onChange({ sampleStart: d.anchor, sampleEnd: Math.max(f, d.anchor) });
    else onChange({ sampleStart: Math.min(f, d.anchor), sampleEnd: Math.max(f, d.anchor) });
  };
  const onUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    // A bare click (selection collapsed to ~nothing) clears the trim instead
    // of leaving a zero-length region that plays silence.
    if (d && (slot.sampleEnd ?? 1) - (slot.sampleStart ?? 0) < 0.005) onChange({ sampleStart: 0, sampleEnd: 1 });
  };

  const selDur = (end - start) * duration;
  const rootMidi = hzToMidi(slot.rootHz || 440);

  return (
    <div className="op-sampler">
      <div
        ref={wrapRef}
        className={`op-sampler-wave ${hasSample ? 'has-sample' : ''}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => onChange({ sampleStart: 0, sampleEnd: 1 })}
        title={hasSample ? 'Drag to highlight the part that plays · drag an edge to trim · double-click for all' : 'Load a sample'}
      >
        {hasSample ? (
          <>
            <svg viewBox={`0 0 ${PEAK_POINTS} 40`} preserveAspectRatio="none" aria-hidden="true">
              {Array.from(peaks, (p, i) => {
                const h = Math.max(0.6, Math.abs(p) * 19);
                return <rect key={i} x={i} y={20 - h} width={0.78} height={h * 2} />;
              })}
            </svg>
            <div className="op-sampler-dim" style={{ left: 0, width: `${start * 100}%` }} />
            <div className="op-sampler-dim" style={{ left: `${end * 100}%`, right: 0 }} />
            <div className="op-sampler-sel" style={{ left: `${start * 100}%`, width: `${(end - start) * 100}%` }}>
              <i className="op-sampler-handle is-start" />
              <i className="op-sampler-handle is-end" />
            </div>
          </>
        ) : (
          <button type="button" className="op-sampler-empty" onClick={() => capture.onToggleRecord(id)}>
            Drop in a sample — Load…
          </button>
        )}
      </div>

      <div className="op-sampler-row">
        <button type="button" className="op-sampler-btn" onClick={() => capture.onToggleRecord(id)}
          title="Load a sample from disk">
          {hasSample ? 'Load…' : '📁 Load…'}
        </button>
        {capture.onResample && capture.onRecSource && (
          <select className="op-sampler-root op-sampler-src" value={capture.recSource ?? 0}
            disabled={(capture.resampleOp ?? -1) >= 0}
            onChange={(e) => capture.onRecSource!(e.target.value === '1' ? 1 : 0)}
            title="What the Rec button records: the synth's own output (resample) or your audio input">
            <option value={0}>Resample</option>
            <option value={1}>Input</option>
          </select>
        )}
        {capture.onResample && capture.recSource === 1 && capture.onAudioSettings && (
          <button type="button" className="op-sampler-btn" onClick={capture.onAudioSettings}
            title="Choose the audio input device and un-mute the input (the standalone mutes it by default)">
            ⚙ Input…
          </button>
        )}
        {capture.onResample && (() => {
          const idx = id === 'osc1' ? 0 : id === 'osc2' ? 1 : id === 'osc3' ? 2 : 3;
          const rec = capture.resampleOp === idx;
          return (
            <button type="button" className={`op-sampler-btn ${rec ? 'is-on' : ''}`}
              disabled={!rec && (capture.resampleOp ?? -1) >= 0}
              aria-pressed={rec} onClick={() => capture.onResample!(id, !rec)}
              title={rec ? 'Stop and load the recording as this sample' : (capture.recSource === 1 ? 'Record the audio input (max 30 s) into this sampler' : 'Resample: record the synth\'s own output (max 30 s) into this sampler')}>
              {rec ? `■ ${(capture.resampleSec ?? 0).toFixed(1)}s` : '● Rec'}
            </button>
          );
        })()}
        <span className="op-sampler-dur" title="Selected length / total length">
          {hasSample ? `${selDur.toFixed(2)}s / ${duration.toFixed(2)}s` : 'empty'}
        </span>
        <select
          className="op-sampler-root"
          value={rootMidi}
          onChange={(e) => onChange({ rootHz: midiToHz(parseInt(e.target.value, 10)) })}
          title="Root note — the key at which the sample plays at its original pitch"
        >
          {ROOT_NOTES.map((m) => <option key={m} value={m}>{noteLabel(m)}</option>)}
        </select>
        <button type="button" className={`op-sampler-btn ${slot.sampleLoop ? 'is-on' : ''}`}
          aria-pressed={!!slot.sampleLoop} onClick={() => onChange({ sampleLoop: !slot.sampleLoop })}
          title={slot.sampleLoop ? 'Loop: on (sustains while held)' : 'Loop: off (plays once)'}>∞</button>
        <button type="button" className={`op-sampler-btn ${slot.sampleReverse ? 'is-on' : ''}`}
          aria-pressed={!!slot.sampleReverse} onClick={() => onChange({ sampleReverse: !slot.sampleReverse })}
          title={slot.sampleReverse ? 'Reverse: on' : 'Reverse: off'}>◄</button>
        <button type="button" className="op-sampler-btn" disabled={!hasSample}
          onClick={() => capture.clearSampleBuffer(id)} title="Clear sample">✕</button>
      </div>
    </div>
  );
}
