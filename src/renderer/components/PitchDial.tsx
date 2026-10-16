import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ModTargetId } from '../../shared/types';

interface Props {
  /** Combined pitch offset in semitones (continuous — fractional = cents). */
  value: number;
  onChange: (semitones: number) => void;
  color: string;
  min?: number;
  max?: number;
  label?: string;
  /** Cable-drop target id — makes the whole dial a mod-drop target (todo.md BUG3). */
  modTarget?: ModTargetId;
  /** Dominant mod source tint for the persistent glow: colour + 0..1 strength. */
  modGlow?: { color: string; amount: number } | null;
  /** Mod-indicator dots beside the label (per-operator pitch modulation). */
  modBadge?: ReactNode;
  /** Right-click the dial → open the modulation assign menu (todo.md §88.C). */
  onModContext?: (anchor: HTMLElement) => void;
}

const SWEEP_DEG = 270; // -135deg .. +135deg, matches a classic synth knob
const BASE_SENSITIVITY = 0.25; // semitones per px of vertical drag (no modifier)

/**
 * Fine-tuning is folded into the dial via modifier keys, matching the same
 * scheme `stepModAmount` (mod-sources.ts) uses for pitch mod-amount
 * scrolling — one consistent set of modifiers for "how coarse/fine is this
 * pitch adjustment" everywhere in the app, so there's no separate Fine
 * slider:
 *   - no modifier  → whole semitones (0.25 st/px)
 *   - Shift        → jump by the octave (12 semitones)
 *   - Ctrl         → 0.1 semitone steps (10 cents)
 *   - Ctrl+Alt     → 0.01 semitone steps (1 cent)
 * Was Shift = 0.1 semitone / Ctrl = 0.01 / Shift+Ctrl = 0.001 (todo.md §31)
 * — replaced because Shift dragging the knob directly used to do the
 * OPPOSITE of what Shift does when scrolling a routed mod amount onto this
 * same dial (jump a whole octave there, fine-tune here), which read as
 * broken rather than just different (todo.md, user: "it should work even
 * when im adjusting it without the cable... hold shift and change the
 * value by multiples of 12").
 */
function dragPrecision(shift: boolean, ctrl: boolean, alt: boolean) {
  if (ctrl && alt) return { sensitivity: BASE_SENSITIVITY * 0.01, step: 0.01 };
  if (ctrl) return { sensitivity: BASE_SENSITIVITY * 0.1, step: 0.1 };
  if (shift) return { sensitivity: BASE_SENSITIVITY * 12, step: 12 };
  return { sensitivity: BASE_SENSITIVITY, step: 1 };
}

/** Round to the nearest multiple of `step` (not just decimal places — needed
 *  so Shift's 12-semitone jump actually lands on exact octave multiples
 *  regardless of drag drift, not just "0 decimal places"). */
function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

function modKey(shift: boolean, ctrl: boolean, alt: boolean): string {
  return `${shift ? 1 : 0}:${ctrl ? 1 : 0}:${alt ? 1 : 0}`;
}

function formatSemitones(v: number): string {
  const r = roundTo(v, 0.001);
  if (r === 0) return '0';
  return `${r > 0 ? '+' : '-'}${Math.abs(r)}`;
}

/**
 * Bitwig Phase-4-style pitch dial — click-and-drag (vertical) to sweep the
 * value, with Shift/Ctrl/Ctrl+Alt for coarser/finer drag precision, and
 * Ctrl+double-click to type a semitone value directly.
 */
export function PitchDial({ value, onChange, color, min = -48, max = 48, label = 'Pitch', modTarget, modGlow, modBadge, onModContext }: Props) {
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const drag = useRef<{ startY: number; startValue: number; current: number; moved: boolean; mk: string } | null>(null);

  const clamp = (n: number) => Math.max(min, Math.min(max, n));

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (editing) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { startY: e.clientY, startValue: value, current: value, moved: false, mk: modKey(e.shiftKey, e.ctrlKey, e.altKey) };
    },
    [editing, value],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      // Re-anchor when a modifier changes mid-drag so the value doesn't jump.
      const mk = modKey(e.shiftKey, e.ctrlKey, e.altKey);
      if (mk !== d.mk) {
        d.mk = mk;
        d.startY = e.clientY;
        d.startValue = d.current;
      }
      const p = dragPrecision(e.shiftKey, e.ctrlKey, e.altKey);
      const dy = d.startY - e.clientY;
      if (Math.abs(dy) > 2) d.moved = true;
      if (d.moved) {
        const v = clamp(roundTo(d.startValue + dy * p.sensitivity, p.step));
        d.current = v;
        onChange(v);
      }
    },
    [onChange, min, max],
  );
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (drag.current) (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    drag.current = null;
  }, []);

  const openEditor = useCallback(() => {
    setDraftText(String(value));
    setEditing(true);
  }, [value]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = useCallback(() => {
    const n = Number(draftText);
    if (Number.isFinite(n)) onChange(clamp(roundTo(n, 0.001)));
    setEditing(false);
  }, [draftText, onChange, min, max]);

  const frac = (clamp(value) - min) / (max - min);
  const angle = -135 + frac * SWEEP_DEG;
  const display = formatSemitones(value);
  // Semitone dial is bipolar — the arc grows out from 12 o'clock.
  const arcFrom = Math.min(0.5, frac) * SWEEP_DEG;
  const arcTo = Math.max(0.5, frac) * SWEEP_DEG;

  return (
    <div
      className={`pitch-dial ${modGlow ? 'is-modded' : ''}`}
      data-mod-target={modTarget ?? undefined}
      onContextMenu={
        modTarget && onModContext
          ? (e) => { e.preventDefault(); e.stopPropagation(); onModContext(e.currentTarget as HTMLElement); }
          : undefined
      }
      style={
        {
          '--knob-color': color,
          '--op-color': color,
          '--ang': `${angle}deg`,
          '--arc-from': `${arcFrom}deg`,
          '--arc-to': `${arcTo}deg`,
          '--mod-glow': modGlow?.color ?? 'transparent',
          '--mod-glow-amt': modGlow?.amount ?? 0,
        } as React.CSSProperties
      }
    >
      <span className="pitch-dial-label">
        {label}
        {modBadge}
      </span>
      {/* Reuses the .knob-* visual language (Knob.tsx) so every rotary in the
          synth reads the same; the drag/precision logic stays bespoke. */}
      <div
        className="knob-ring pitch-dial-knob"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${display} semitones`}
        title="Drag = semitones · Shift = jump an octave · Ctrl = 0.1 · Ctrl+Alt = 0.01 · Ctrl+double-click to type"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => { if (e.ctrlKey) openEditor(); }}
        onKeyDown={(e) => {
          const p = dragPrecision(e.shiftKey, e.ctrlKey, e.altKey);
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') onChange(clamp(roundTo(value + p.step, p.step)));
          else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') onChange(clamp(roundTo(value - p.step, p.step)));
          else if (e.key === 'Enter') openEditor();
        }}
      >
        <span className="knob-arc" aria-hidden="true" />
        <span className="knob-ticks" aria-hidden="true" />
        <span className="knob-face" aria-hidden="true">
          <span className="knob-indicator" />
        </span>
        <span className="knob-detent" aria-hidden="true" />
        <span className="knob-cap" aria-hidden="true" />
        {/* Same discoverable assign entry point as Knob.tsx (todo.md §91/92) —
            and the same "hide once modded" guard, for the same reason
            (overlaps the mod-glow ring; found in review). */}
        {modTarget && onModContext && !modGlow && (
          <button
            type="button"
            className="knob-mod-plus"
            tabIndex={-1}
            title="Add a modulation source"
            aria-label={`Add modulation to ${label}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onModContext(e.currentTarget.closest('.pitch-dial') as HTMLElement);
            }}
          >
            +
          </button>
        )}
        {!editing && <span className="knob-value">{display}</span>}
        {editing && (
          <input
            ref={inputRef}
            className="knob-input"
            type="number"
            step="any"
            value={draftText}
            min={min}
            max={max}
            onChange={(e) => setDraftText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        )}
      </div>
      <span className="pitch-dial-unit">st</span>
    </div>
  );
}
