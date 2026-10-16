import { useEffect, useRef, useState } from 'react';
import type { ModTargetId } from '../../shared/types';

/**
 * Hardware-style rotary knob. Vertical drag to set (Shift = fine) from anywhere
 * on the knob incl. its label; mouse wheel nudges (Shift = fine);
 * Ctrl+double-click to type a value (todo.md — user: plain double-click was
 * triggering typing mode by accident); arrow keys nudge when focused.
 *
 * Visual language adapted from profmitchell/AudioUI's RotaryKnobDetailed —
 * a recessed housing, a rotating metallic face carrying a lit indicator line,
 * a thin value arc on the rim and a tick ring — but rebuilt on Faze's theme
 * tokens (`--knob-color` drives the indicator + arc + glow; everything else is
 * `--bg-* / --border`). All colour comes from `--knob-color`, so an FM/PM
 * depth knob tinted with its SOURCE operator's colour reads correctly, and the
 * six themes stay coherent.
 *
 * `modTarget` makes the whole knob a cable-drop target; `modGlow` tints it in
 * the strongest routed source's colour, brightness scaled by amount.
 */
interface KnobProps {
  label?: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  /** Parse a typed string back to a value (for double-click editing). Defaults to `parseFloat`. */
  parse?: (s: string) => number;
  color?: string;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  title?: string;
  /** Draw a notch at 12 o'clock + make the arc grow from centre (for bipolar params like pan). */
  centerDetent?: boolean;
  /** Cable-drop target id — makes this knob a drop target. */
  modTarget?: ModTargetId;
  /** Dominant mod source tint for the persistent glow: colour + 0..1 strength. */
  modGlow?: { color: string; amount: number } | null;
  /** Right-click the knob → open the modulation assign menu, anchored to the
   *  knob element (todo.md §88.C — replaces the always-visible ∿ badge). */
  onModContext?: (anchor: HTMLElement) => void;
}

const SWEEP = 270; // -135deg .. +135deg
const START = -135;

export function Knob({
  label,
  value,
  min,
  max,
  onChange,
  format,
  parse,
  color = 'var(--accent)',
  size = 'md',
  disabled = false,
  title,
  centerDetent = false,
  modTarget,
  modGlow,
  onModContext,
}: KnobProps) {
  const drag = useRef<{ startY: number; start: number; fine: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const range = max - min || 1;
  const frac = (clamp(value) - min) / range;
  const angle = START + frac * SWEEP;
  const display = format ? format(value) : String(Math.round(value * 100) / 100);

  // Value arc: for a centre-detent (bipolar) knob it grows out from 12 o'clock
  // in whichever direction; otherwise it fills from the -135deg start.
  const arcFrom = centerDetent ? Math.min(0.5, frac) : 0;
  const arcTo = centerDetent ? Math.max(0.5, frac) : frac;

  // POLICY (see ui-selection test): every pointer-drag control stops the
  // default on pointer/mouse down, or the browser starts a text selection
  // and highlights the value text mid-drag. Keyboard focus is taken by hand.
  const guardDown = (e: React.SyntheticEvent) => {
    if ((e.target as HTMLElement).closest('input')) return;
    e.preventDefault();
    (rootRef.current?.querySelector('.knob-ring') as HTMLElement | null)?.focus({ preventScroll: true });
  };
  const onDown = (e: React.PointerEvent) => {
    if (disabled || editing) return;
    guardDown(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, start: value, fine: e.shiftKey };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // Full travel in ~150px (was 200) so small header knobs (macros) don't
    // need a long drag; Shift = fine. Re-anchor when Shift toggles mid-drag so
    // the value doesn't jump.
    const fine = e.shiftKey;
    if (fine !== d.fine) { d.start = clamp(value); d.startY = e.clientY; d.fine = fine; }
    const speed = fine ? range / 800 : range / 150;
    onChange(clamp(d.start + (d.startY - e.clientY) * speed));
  };
  const onUp = (e: React.PointerEvent) => {
    if (drag.current) (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    drag.current = null;
  };

  // Wheel nudge. Native listener (React's onWheel is passive, so it could not
  // stop the panel scrolling). Leaves routed knobs alone: while one is hovered
  // or a cable is being dragged the wheel adjusts the mod depth instead
  // (useModHoverEdit / useCableDrag listen on window).
  const wheelRef = useRef({ value, min, max, range, onChange, disabled, editing, routed: !!(modTarget && modGlow) });
  wheelRef.current = { value, min, max, range, onChange, disabled, editing, routed: !!(modTarget && modGlow) };
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const w = wheelRef.current;
      if (w.disabled || w.editing || w.routed || e.ctrlKey) return;
      if (el.closest('.is-mod-dragging')) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const wholeSteps = w.range >= 4 && w.range <= 48 && Number.isInteger(w.value);
      const step = wholeSteps ? 1 : Math.max(w.range / (e.shiftKey ? 250 : 50), 0);
      w.onChange(Math.max(w.min, Math.min(w.max, w.value + dir * step)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const openEditor = () => {
    if (disabled) return;
    setDraft(String(Math.round(value * 1000) / 1000));
    setEditing(true);
  };
  const commit = () => {
    const n = (parse ?? Number)(draft);
    if (Number.isFinite(n)) onChange(clamp(n));
    setEditing(false);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    const step = (e.shiftKey ? range / 100 : range / 40);
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); onChange(clamp(value + step)); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); onChange(clamp(value - step)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(); }
  };

  return (
    <div
      ref={rootRef}
      className={`knob knob-${size} ${disabled ? 'is-disabled' : ''} ${modGlow ? 'is-modded' : ''}`}
      data-mod-target={modTarget ?? undefined}
      onPointerDown={onDown}
      onMouseDown={(e) => { if (!disabled && !editing) guardDown(e); }}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onContextMenu={
        modTarget && onModContext
          ? (e) => { e.preventDefault(); e.stopPropagation(); onModContext(e.currentTarget as HTMLElement); }
          : undefined
      }
      style={
        {
          '--knob-color': color,
          '--ang': `${angle}deg`,
          '--arc-from': `${arcFrom * SWEEP}deg`,
          '--arc-to': `${arcTo * SWEEP}deg`,
          '--mod-glow': modGlow?.color ?? 'transparent',
          '--mod-glow-amt': modGlow?.amount ?? 0,
        } as React.CSSProperties
      }
    >
      <div
        className="knob-ring"
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={display}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        title={title ?? label}
        onDoubleClick={(e) => { if (e.ctrlKey) openEditor(); }}
        onKeyDown={onKey}
      >
        <span className="knob-arc" aria-hidden="true" />
        <span className="knob-ticks" aria-hidden="true" />
        <span className="knob-face" aria-hidden="true">
          <span className="knob-indicator" />
        </span>
        {centerDetent && <span className="knob-detent" aria-hidden="true" />}
        <span className="knob-cap" aria-hidden="true" />
        {/* Per-knob "+" — a persistent, discoverable entry point into the
            same assign list right-click already opens (todo.md §91/92
            Pigments overhaul: "per-knob + to open the source view"). Right-
            click stays the primary path for anyone who already knows it;
            this is for everyone else. Hidden once the knob is already
            modded: it sits in the same corner as the mod-glow ring
            (`.is-modded .knob-ring::after`) and geometrically overlaps it at
            every knob size (found in review) — an already-routed knob still
            has the ∿ badge / right-click / hover quick-editor to add more. */}
        {modTarget && onModContext && !modGlow && (
          <button
            type="button"
            className="knob-mod-plus"
            tabIndex={-1}
            title="Add a modulation source"
            aria-label={`Add modulation to ${label ?? 'this parameter'}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onModContext(e.currentTarget.closest('.knob') as HTMLElement);
            }}
          >
            +
          </button>
        )}
        {editing ? (
          <input
            className="knob-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') setEditing(false);
              e.stopPropagation();
            }}
          />
        ) : (
          <span className="knob-value">{display}</span>
        )}
      </div>
      {label && <span className="knob-label">{label}</span>}
    </div>
  );
}
