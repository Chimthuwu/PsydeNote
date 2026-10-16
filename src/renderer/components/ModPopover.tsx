import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModMap, ModRoute, ModSourceId, ModTargetId } from '../../shared/types';
import { MOD_SOURCES, MOD_TARGETS, isSourceAvailable, routesForSource, stepModAmount } from '../lib/mod-sources';

/**
 * Pigments-style modulation assignment popover.
 *
 * The interaction model (borrowed from Arturia Pigments — no modulation
 * matrix): click a knob's ∿ badge, and this popover lists every modulation
 * source that can drive that parameter. Drag vertically on a source row to
 * set its amount (up = positive, down = negative); click a row to add it
 * with a sensible default; × removes it. The knob shows coloured dots for
 * every active source so you can see at a glance what is modulating what.
 *
 * This component is source-agnostic: it renders whatever
 * `MOD_TARGETS[targetId].sources` lists, so new targets (per-osc pan,
 * FM/PM amounts, filter cutoff…) get the same UI for free.
 */
interface Props {
  targetId: ModTargetId;
  /** Current routes for this target (may be empty). */
  routes: ModRoute[];
  /** Element the popover anchors to (the ∿ badge). */
  anchorEl: HTMLElement | null;
  /** Called on every amount change / add / remove with the new route list. */
  onChange: (routes: ModRoute[]) => void;
  onClose: () => void;
  /**
   * Applied-only mode (todo.md §81): list ONLY the sources currently routed
   * to this target — a quick editor for depth / mute / remove, shown on
   * plain hover of the knob rather than a click on the ∿ badge. The default
   * (false) is the full assign list every source that can drive the target.
   */
  appliedOnly?: boolean;
  /** Extra hover-intent handlers so the popover stays open while the cursor is on it. */
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}

export function ModPopover({
  targetId, routes, anchorEl, onChange, onClose,
  appliedOnly = false, onPointerEnter, onPointerLeave,
}: Props) {
  const meta = MOD_TARGETS[targetId];
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const drag = useRef<{
    source: ModSourceId;
    startY: number;
    startAmount: number;
    moved: boolean;
  } | null>(null);

  // In applied-only mode the row set is the routes themselves (order kept
  // stable so a row doesn't jump while you drag it to zero). Otherwise every
  // source the target accepts.
  const rowSources: ModSourceId[] = appliedOnly
    ? routes.filter((r) => r.amount !== 0).map((r) => r.source)
    : meta.sources.filter(isSourceAvailable);

  // Anchor below the badge, flipping above when it would overflow.
  useEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const w = 216;
    const h = Math.max(1, rowSources.length) * 36 + 44;
    let left = Math.min(r.left, window.innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    setPos({ left: Math.max(8, left), top });
  }, [anchorEl, meta, rowSources.length]);

  // Close on outside click (but not when the badge itself is clicked — the
  // badge handles toggling) and on Escape.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (ref.current?.contains(t)) return;
      if (t?.closest('.op-mod-btn')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const routeOf = (s: ModSourceId) => routes.find((r) => r.source === s);
  const amountOf = (s: ModSourceId) => routeOf(s)?.amount ?? 0;
  const mutedOf = (s: ModSourceId) => routeOf(s)?.enabled === false;

  const setAmount = (s: ModSourceId, amount: number) => {
    const clamped = Math.max(meta.min, Math.min(meta.max, amount));
    const prev = routeOf(s);
    const next = routes.filter((r) => r.source !== s);
    if (clamped !== 0) {
      next.push(prev?.enabled === false
        ? { source: s, amount: clamped, enabled: false }
        : { source: s, amount: clamped });
    }
    onChange(next);
  };

  const toggleMute = (s: ModSourceId) => {
    onChange(routes.map((r) => {
      if (r.source !== s) return r;
      return r.enabled === false ? { source: r.source, amount: r.amount } : { ...r, enabled: false };
    }));
  };

  const onRowDown = (e: React.PointerEvent, s: ModSourceId) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      source: s,
      startY: e.clientY,
      startAmount: amountOf(s),
      moved: false,
    };
  };
  const onRowMove = (e: React.PointerEvent, s: ModSourceId) => {
    const d = drag.current;
    if (!d || d.source !== s) return;
    const dy = d.startY - e.clientY;
    if (Math.abs(dy) > 2) d.moved = true;
    if (d.moved) setAmount(s, d.startAmount + dy * meta.sensitivity);
  };
  const onRowUp = (e: React.PointerEvent, s: ModSourceId) => {
    const d = drag.current;
    if (!d || d.source !== s) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    drag.current = null;
    // Plain click on an unassigned source: add it with the default amount.
    if (!d.moved && amountOf(s) === 0) setAmount(s, meta.defaultAmount);
  };

  if (!pos) return null;

  // Rendered in a portal on <body>: the popover is `position: fixed`, but
  // `.op-panel` / `.env-panel` both set `container-type: inline-size` (for
  // their container queries), which makes each of them a containing block
  // for fixed-positioned descendants. Mounted inline, the popover's
  // viewport-derived coords (getBoundingClientRect / window.innerHeight)
  // were then resolved against the panel's box instead — near-invisible for
  // the filter cards low in the modulator strip (todo.md §60). The portal
  // sidesteps every such ancestor.
  return createPortal(
    <div
      ref={ref}
      className={`mod-popover${appliedOnly ? ' mod-popover-applied' : ''}`}
      style={pos}
      role="dialog"
      aria-label={`Modulate ${meta.label}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <header className="mod-pop-head">
        <span>{meta.label}</span>
        <span className="mod-pop-hint">{appliedOnly ? 'scroll / drag ↕' : 'drag ↑↓ to set'}</span>
      </header>
      {rowSources.length === 0 && (
        <div className="mod-row mod-row-empty">no modulation — drag a source here</div>
      )}
      {rowSources.map((s) => {
        const amt = amountOf(s);
        const src = MOD_SOURCES[s];
        const muted = mutedOf(s);
        return (
          <div
            key={s}
            className={`mod-row${muted ? ' is-muted' : ''}`}
            style={{ '--src': src.color } as React.CSSProperties}
            title={`${src.label} — drag ↕ or scroll to set the amount`}
            onPointerDown={(e) => onRowDown(e, s)}
            onPointerMove={(e) => onRowMove(e, s)}
            onPointerUp={(e) => onRowUp(e, s)}
            onPointerCancel={(e) => onRowUp(e, s)}
            onWheel={(e) => {
              if (amt === 0) return;
              // The plugin UI never scrolls (no-scrollbars rule), so a passive
              // wheel handler that doesn't preventDefault is fine here.
              e.stopPropagation();
              setAmount(s, stepModAmount(targetId, amt, e.deltaY, e));
            }}
          >
            <span className="mod-chip" aria-hidden="true" />
            <span className="mod-name">{src.short}</span>
            <span className="mod-amount">{amt !== 0 ? meta.format(amt) : '—'}</span>
            {amt !== 0 && (
              <button
                type="button"
                className={`mod-mute${muted ? ' is-muted' : ''}`}
                title={muted ? 'Un-mute this modulation' : 'Mute (bypass) this modulation'}
                aria-pressed={muted}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); toggleMute(s); }}
              >
                {muted ? '⊘' : '–'}
              </button>
            )}
            <button
              type="button"
              className="mod-clear"
              disabled={amt === 0}
              title="Remove this modulation"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setAmount(s, 0);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

/**
 * Modulation indicator dots shown next to a modulatable knob (todo.md §88.C —
 * the always-visible ∿ button was removed; right-click the knob to assign).
 * Purely informative: one dot per routed source. Extra props from the old
 * `bindMod()` spread (`isOpen` / `onClick` / `buttonRef`) are ignored.
 */
interface BadgeProps {
  targetId: ModTargetId;
  routes: ModRoute[];
  isOpen?: boolean;
  onClick?: () => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}

export function ModBadge({ targetId, routes }: BadgeProps) {
  const active = routes.filter((r) => r.amount !== 0);
  if (active.length === 0) return null;
  return (
    <span className="mod-dots" aria-hidden="true">
      {active.map((r) => (
        <span
          key={r.source}
          className="mod-dot"
          style={{ '--src': MOD_SOURCES[r.source].color } as React.CSSProperties}
          title={`${MOD_SOURCES[r.source].short} → ${MOD_TARGETS[targetId].label} · right-click the knob to edit`}
        />
      ))}
    </span>
  );
}

/**
 * Reverse-view popover: right-click a modulator (an ENV/LFO/Velocity/
 * Keyboard source dot) to see everywhere IT routes to, one row per target —
 * the mirror image of `<ModPopover>`, which lists sources for one target
 * (todo.md §91/92 Pigments overhaul, "right-click inside a modulator → that
 * operator's active-routes list"). Same drag-↕-to-set / mute / clear
 * interactions and the same `.mod-popover`/`.mod-row` chrome as the regular
 * popover, just keyed by target instead of by source.
 */
interface SourceRoutesProps {
  sourceId: ModSourceId;
  mod: ModMap;
  anchorEl: HTMLElement | null;
  onChange: (mod: ModMap) => void;
  onClose: () => void;
}

export function SourceRoutesPopover({ sourceId, mod, anchorEl, onChange, onClose }: SourceRoutesProps) {
  const src = MOD_SOURCES[sourceId];
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const drag = useRef<{ target: ModTargetId; startY: number; startAmount: number; moved: boolean } | null>(null);

  const routes = routesForSource(mod, sourceId);

  useEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const w = 240;
    const h = Math.max(1, routes.length) * 36 + 44;
    let left = Math.min(r.left, window.innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    setPos({ left: Math.max(8, left), top });
  }, [anchorEl, routes.length]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (ref.current?.contains(t)) return;
      if (t?.closest('.env-source-dot')) return; // the dot itself handles its own toggle
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const setAmount = (target: ModTargetId, amount: number) => {
    const meta = MOD_TARGETS[target];
    const clamped = Math.max(meta.min, Math.min(meta.max, amount));
    const prev = (mod[target] ?? []).find((r) => r.source === sourceId);
    const rest = (mod[target] ?? []).filter((r) => r.source !== sourceId);
    const next = clamped !== 0
      ? [...rest, prev?.enabled === false ? { source: sourceId, amount: clamped, enabled: false } : { source: sourceId, amount: clamped }]
      : rest;
    onChange({ ...mod, [target]: next });
  };

  const toggleMute = (target: ModTargetId) => {
    onChange({
      ...mod,
      [target]: (mod[target] ?? []).map((r) =>
        r.source !== sourceId ? r : (r.enabled === false ? { source: r.source, amount: r.amount } : { ...r, enabled: false })),
    });
  };

  const onRowDown = (e: React.PointerEvent, target: ModTargetId, amount: number) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { target, startY: e.clientY, startAmount: amount, moved: false };
  };
  const onRowMove = (e: React.PointerEvent, target: ModTargetId) => {
    const d = drag.current;
    if (!d || d.target !== target) return;
    const dy = d.startY - e.clientY;
    if (Math.abs(dy) > 2) d.moved = true;
    if (d.moved) setAmount(target, d.startAmount + dy * MOD_TARGETS[target].sensitivity);
  };
  const onRowUp = (e: React.PointerEvent, target: ModTargetId) => {
    const d = drag.current;
    if (!d || d.target !== target) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    drag.current = null;
  };

  if (!pos) return null;

  return createPortal(
    <div
      ref={ref}
      className="mod-popover mod-popover-bysource"
      style={pos}
      role="dialog"
      aria-label={`${src.label} — active routes`}
    >
      <header className="mod-pop-head">
        <span>{src.label}</span>
        <span className="mod-pop-hint">drag ↕ or scroll</span>
      </header>
      {routes.length === 0 && (
        <div className="mod-row mod-row-empty">not routed anywhere — drag onto a knob</div>
      )}
      {routes.map(({ target, route }) => {
        const meta = MOD_TARGETS[target];
        const muted = route.enabled === false;
        return (
          <div
            key={target}
            className={`mod-row${muted ? ' is-muted' : ''}`}
            style={{ '--src': src.color } as React.CSSProperties}
            title={`${meta.label} — drag ↕ or scroll to set the amount`}
            onPointerDown={(e) => onRowDown(e, target, route.amount)}
            onPointerMove={(e) => onRowMove(e, target)}
            onPointerUp={(e) => onRowUp(e, target)}
            onPointerCancel={(e) => onRowUp(e, target)}
            onWheel={(e) => {
              e.stopPropagation();
              setAmount(target, stepModAmount(target, route.amount, e.deltaY, e));
            }}
          >
            <span className="mod-chip" aria-hidden="true" />
            <span className="mod-name">{meta.label}</span>
            <span className="mod-amount">{meta.format(route.amount)}</span>
            <button
              type="button"
              className={`mod-mute${muted ? ' is-muted' : ''}`}
              title={muted ? 'Un-mute this modulation' : 'Mute (bypass) this modulation'}
              aria-pressed={muted}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); toggleMute(target); }}
            >
              {muted ? '⊘' : '–'}
            </button>
            <button
              type="button"
              className="mod-clear"
              title="Remove this modulation"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); setAmount(target, 0); }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}