// Plain-hover quick editor for a knob's EXISTING modulation routes
// (todo.md §81). Distinct from:
//   - the ∿ badge click  → full assign list (every source for the target)
//   - a cable drag       → assign + scroll-to-set-depth (useCableDrag)
//
// Hovering (no drag) a knob that already has routes pops a small panel
// listing only those routes — drag/scroll each depth, mute, or remove.
// Rendered by PluginApp as <ModPopover appliedOnly>.
//
// Plain hover-and-SCROLL (no popover open, no drag) also adjusts the
// amount directly (todo.md — user: "In audition mode... we can change the
// amt by scrolling while hovering, but we can't... without being in
// audition mode"). Only when the target has exactly one active route —
// with more than one, there's no way to know which the user means from a
// bare hover; open the popover to disambiguate instead (unchanged).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModMap, ModSourceId, ModTargetId } from '../../../src/shared/types';
import { stepModAmount } from '../../../src/renderer/lib/mod-sources';

const OPEN_DELAY = 120;   // ms cursor must dwell on a routed knob
const CLOSE_DELAY = 260;  // ms grace after leaving both knob and popover

export interface ModHoverEdit {
  hoverTarget: ModTargetId | null;
  hoverAnchor: HTMLElement | null;
  /** Hand to <ModPopover onPointerEnter/onPointerLeave> so it counts as "inside". */
  onPopoverEnter: () => void;
  onPopoverLeave: () => void;
  close: () => void;
}

export function useModHoverEdit(
  mod: ModMap | undefined,
  disabled: boolean,
  /** Adjust one route's amount directly — the plain-hover-scroll path. */
  onAdjustRoute: (target: ModTargetId, source: ModSourceId, amount: number) => void,
): ModHoverEdit {
  const [hoverTarget, setHoverTarget] = useState<ModTargetId | null>(null);
  const [hoverAnchor, setHoverAnchor] = useState<HTMLElement | null>(null);

  const modRef = useRef(mod);
  modRef.current = mod;
  // Ref, not a dependency — keeps the wheel/pointermove listeners below
  // stable across renders regardless of the caller's callback identity
  // (same pattern modRef already uses in this file).
  const onAdjustRouteRef = useRef(onAdjustRoute);
  onAdjustRouteRef.current = onAdjustRoute;
  const overPopoverRef = useRef(false);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const currentAnchor = useRef<HTMLElement | null>(null);

  const clearTimers = () => {
    if (openTimer.current) { window.clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  const close = useCallback(() => {
    clearTimers();
    currentAnchor.current = null;
    overPopoverRef.current = false;
    setHoverTarget(null);
    setHoverAnchor(null);
  }, []);

  const scheduleClose = useCallback(() => {
    if (closeTimer.current) return;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      if (!overPopoverRef.current) close();
    }, CLOSE_DELAY);
  }, [close]);

  const onPopoverEnter = useCallback(() => {
    overPopoverRef.current = true;
    if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);
  const onPopoverLeave = useCallback(() => {
    overPopoverRef.current = false;
    scheduleClose();
  }, [scheduleClose]);

  useEffect(() => {
    if (disabled) { close(); return; }

    const routedTargetUnder = (x: number, y: number): { el: HTMLElement; id: ModTargetId } | null => {
      const hit = document.elementFromPoint(x, y)?.closest('[data-mod-target]') as HTMLElement | null;
      if (!hit) return null;
      const id = hit.getAttribute('data-mod-target') as ModTargetId | null;
      if (!id) return null;
      const routes = (modRef.current ?? {})[id] ?? [];
      return routes.some((r) => r.amount !== 0) ? { el: hit, id } : null;
    };

    const onMove = (e: PointerEvent) => {
      if (e.buttons !== 0) return; // dragging something — not a hover
      const found = routedTargetUnder(e.clientX, e.clientY);

      if (!found) {
        if (currentAnchor.current && !overPopoverRef.current) scheduleClose();
        if (openTimer.current) { window.clearTimeout(openTimer.current); openTimer.current = null; }
        return;
      }
      if (found.el === currentAnchor.current) {
        if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
        return;
      }
      // New routed knob under the cursor — (re)arm the open timer.
      if (openTimer.current) window.clearTimeout(openTimer.current);
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null;
        currentAnchor.current = found.el;
        if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
        setHoverTarget(found.id);
        setHoverAnchor(found.el);
      }, OPEN_DELAY);
    };

    // Any click that isn't inside a mod popover dismisses the hover editor —
    // in particular clicking the ∿ badge (which opens the full assign list)
    // or grabbing the knob to drag its value.
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement | null)?.closest('.mod-popover')) return;
      close();
    };

    // Plain hover-and-scroll (no drag, no popover needed) — same step
    // formula as useCableDrag's audition-mode scroll, hit-tested fresh on
    // every wheel event (not gated by the OPEN_DELAY dwell timer above) so
    // it works immediately, before the popover has even appeared.
    const onWheel = (e: WheelEvent) => {
      const found = routedTargetUnder(e.clientX, e.clientY);
      if (!found) return;
      const routes = (modRef.current ?? {})[found.id]?.filter((r) => r.amount !== 0) ?? [];
      if (routes.length !== 1) return; // ambiguous — let the popover disambiguate instead
      e.preventDefault();
      const route = routes[0];
      const amount = stepModAmount(found.id, route.amount, e.deltaY, e);
      onAdjustRouteRef.current(found.id, route.source, amount);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('wheel', onWheel);
      clearTimers();
    };
  }, [disabled, close, scheduleClose]);

  return { hoverTarget, hoverAnchor, onPopoverEnter, onPopoverLeave, close };
}
