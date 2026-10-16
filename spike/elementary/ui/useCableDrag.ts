// Pigments-style cable-drag routing for the plugin webview (todo.md §75 P7b).
//
// Ported from src/renderer/components/SynthView.tsx's cable overlay. The one
// difference: SynthView auditions a hovered knob by pushing the route to the
// Web-Audio `SynthEngine` only (transient, never persisted), so releasing over
// empty space is a true no-op. The plugin has no such side channel — the
// native DSP is reachable only through host params — so here "audition" writes
// the real `mod{n}_*` params as you sweep and the drag REVERTS them to the
// snapshot taken at drag start if you release over nothing (todo.md §64 UX,
// param-based implementation).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModMap, ModRoute, ModSourceId, ModTargetId } from '../../../src/shared/types';
import { MOD_SOURCES, MOD_TARGETS, addModRoute, stepModAmount } from '../../../src/renderer/lib/mod-sources';
import { DSP_MOD_TARGETS, UI_ONLY_MOD_TARGETS } from './translate';

/**
 * Can `source` legally land on `raw`? Per-source PM/FM depth knobs
 * (`oscXPmoscY` / `oscXFmoscY`) are real DSP targets (todo.md §95) — a drop
 * lands on that ONE knob, not the whole operator. SELF-mod pairs
 * (`oscXPmoscX`/`oscXFmoscX`) are UI-ONLY targets (todo.md §106): the
 * audio-rate PM/FM loop can't yet make an operator modulate itself, so a
 * route stored there is inert, but it's still ITS OWN target — no longer
 * remapped onto the shared `oscXModAmount` (that remap made the self-PM and
 * self-FM knob glow together, which repeated user reports read as "these
 * knobs are secretly connected").
 */
function isValidDropTarget(source: ModSourceId, raw: ModTargetId): boolean {
  return !!MOD_TARGETS[raw]?.sources.includes(source)
    && (DSP_MOD_TARGETS.has(raw) || UI_ONLY_MOD_TARGETS.has(raw));
}

/** The nearest `[data-mod-target]` ancestor under a point — or null. */
function targetElementUnder(x: number, y: number): { el: HTMLElement; id: ModTargetId } | null {
  const el = document.elementFromPoint(x, y)?.closest('[data-mod-target]') as HTMLElement | null;
  const rawAttr = (el?.getAttribute('data-mod-target') as ModTargetId | null) ?? null;
  if (!el || !rawAttr) return null;
  return { el, id: rawAttr };
}

interface DragState {
  source: ModSourceId;
  from: { x: number; y: number };
  to: { x: number; y: number };
  baseMod: ModMap;                    // persisted routes at drag start — the revert target
  previewTarget: ModTargetId | null;  // knob currently being auditioned
  previewAmount: number;              // depth of the auditioned route (scroll-wheel adjusts it)
  /** Set once the pointer moves past the click threshold at ANY point during
   *  the gesture — checked at release instead of comparing start/end points,
   *  which would misclassify an out-and-back drag (onto a target and back to
   *  the start) as a stationary click. */
  everMoved: boolean;
}

/** Replace/insert one source's route on a target, keeping any other routes. */
function withRoute(mod: ModMap, target: ModTargetId, source: ModSourceId, amount: number): ModMap {
  const others = (mod[target] ?? []).filter((r) => r.source !== source);
  const route: ModRoute = { source, amount };
  return { ...mod, [target]: [...others, route] };
}

export interface CableDrag {
  cableSource: ModSourceId | null;
  dragColor: string | undefined;
  /** Formatted audition depth (e.g. "+0.25") while hovering a valid knob, else null. */
  amountLabel: string | null;
  /** Pass to `<EnvelopePanel onSourceDragStart>`. */
  handleSourceDragStart: (source: ModSourceId, point: { x: number; y: number }) => void;
  /** `ref` for the cable `<path>` / end `<circle>` in the overlay SVG. */
  pathRef: React.Ref<SVGPathElement>;
  endDotRef: React.Ref<SVGCircleElement>;
  /** `ref` for the floating depth readout — positioned imperatively at the cursor. */
  amtRef: React.Ref<HTMLDivElement>;
  /**
   * Click-to-assign mode (todo.md §91/92 Pigments overhaul — "click a source
   * -> mod target add-mode", the keyboard/trackpad-friendly alternative to
   * dragging a cable). Set when a source dot is clicked WITHOUT being
   * dragged; every valid knob for this source lights up (same
   * `.is-mod-dragging`/`.is-mod-drop` CSS the live drag uses) and the next
   * click on one of them adds a route at that target's default amount.
   * Escape, a click on empty space, or starting a real drag all cancel it.
   */
  assignSource: ModSourceId | null;
  assignColor: string | undefined;
  /** Cancel click-to-assign mode from outside (e.g. switching tabs). */
  cancelAssign: () => void;
}

export function useCableDrag(mod: ModMap | undefined, applyMod: (m: ModMap) => void): CableDrag {
  const [cableSource, setCableSource] = useState<ModSourceId | null>(null);
  const [amountLabel, setAmountLabel] = useState<string | null>(null);
  const [assignSource, setAssignSource] = useState<ModSourceId | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const pathRef = useRef<SVGPathElement | null>(null);
  const endDotRef = useRef<SVGCircleElement | null>(null);
  const amtRef = useRef<HTMLDivElement | null>(null);
  const hoverElRef = useRef<HTMLElement | null>(null);

  // Latest values behind refs so the effect only re-runs on drag start/end.
  const modRef = useRef(mod);
  modRef.current = mod;
  const applyRef = useRef(applyMod);
  applyRef.current = applyMod;

  const handleSourceDragStart = useCallback((source: ModSourceId, point: { x: number; y: number }) => {
    setAssignSource(null); // a fresh gesture always wins over a stale assign-mode
    dragRef.current = {
      source,
      from: point,
      to: point,
      baseMod: modRef.current ?? {},
      previewTarget: null,
      previewAmount: 0,
      everMoved: false,
    };
    setCableSource(source);
  }, []);

  const dragColor = cableSource ? MOD_SOURCES[cableSource].color : undefined;
  const assignColor = assignSource ? MOD_SOURCES[assignSource].color : undefined;
  const cancelAssign = useCallback(() => setAssignSource(null), []);

  // ----- Click-to-assign mode -------------------------------------------
  // Separate from the drag effect below: no pointer capture, no live preview
  // (a static highlight instead), and it commits on the FIRST click of a new
  // gesture rather than tracking one continuous drag.
  useEffect(() => {
    if (!assignSource) return;
    const source = assignSource;
    let hoverEl: HTMLElement | null = null;
    const clearHover = () => { hoverEl?.classList.remove('is-mod-drop'); hoverEl = null; };

    const onMove = (e: PointerEvent) => {
      const hit = targetElementUnder(e.clientX, e.clientY);
      const valid = hit && isValidDropTarget(source, hit.id) ? hit.el : null;
      if (valid !== hoverEl) { clearHover(); hoverEl = valid; hoverEl?.classList.add('is-mod-drop'); }
    };

    // Capture phase so a commit can swallow the click before the knob under
    // it starts its own value-drag (todo.md §91/92). Left button only — a
    // right-click (e.g. opening a source dot's own routes popover, or the
    // app's background context menu) must never silently commit a route.
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const hit = targetElementUnder(e.clientX, e.clientY);
      if (hit && isValidDropTarget(source, hit.id)) {
        e.preventDefault();
        e.stopPropagation();
        applyRef.current(addModRoute(modRef.current, source, hit.id));
        setAssignSource(null);
        return;
      }
      // Clicking a different source dot hands off to its own pointerdown
      // (handleSourceDragStart already clears `assignSource`) — don't
      // swallow that click, just stop highlighting for the old source.
      if ((e.target as HTMLElement | null)?.closest('.env-source-dot')) return;
      setAssignSource(null);
    };

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAssignSource(null); };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      clearHover();
    };
  }, [assignSource]);

  useEffect(() => {
    if (!cableSource) return;
    const src = cableSource;

    const clientToSvgPoint = (svg: SVGSVGElement, ctm: DOMMatrix, x: number, y: number): { x: number; y: number } => {
      const pt = svg.createSVGPoint();
      pt.x = x;
      pt.y = y;
      const local = pt.matrixTransform(ctm.inverse());
      return { x: local.x, y: local.y };
    };

    const paintPath = () => {
      const d = dragRef.current;
      const p = pathRef.current;
      if (!d || !p) return;
      const svg = p.ownerSVGElement;
      const ctm = svg?.getScreenCTM() ?? null;
      const from = svg && ctm ? clientToSvgPoint(svg, ctm, d.from.x, d.from.y) : d.from;
      const to = svg && ctm ? clientToSvgPoint(svg, ctm, d.to.x, d.to.y) : d.to;
      const dx = Math.max(64, Math.abs(to.x - from.x) * 0.5);
      p.setAttribute(
        'd',
        `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`,
      );
      const dot = endDotRef.current;
      if (dot) {
        dot.setAttribute('cx', String(to.x));
        dot.setAttribute('cy', String(to.y));
      }
      const amt = amtRef.current;
      if (amt) amt.style.transform = `translate(${d.to.x + 14}px, ${d.to.y - 10}px)`;
    };

    // Write (or revert) the route for whatever knob is under the cursor.
    // Entering a target seeds the depth from an existing route on it (so you
    // pick up where a prior route left off) or the target's default.
    const applyPreview = () => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.previewTarget) {
        applyRef.current(d.baseMod);
        setAmountLabel(null);
        return;
      }
      const meta = MOD_TARGETS[d.previewTarget];
      applyRef.current(withRoute(d.baseMod, d.previewTarget, d.source, d.previewAmount));
      setAmountLabel(meta.format(d.previewAmount));
    };
    const previewTarget = (targetId: ModTargetId | null) => {
      const d = dragRef.current;
      if (!d) return;
      d.previewTarget = targetId;
      if (targetId) {
        const existing = (d.baseMod[targetId] ?? []).find((r) => r.source === d.source);
        d.previewAmount = existing ? existing.amount : MOD_TARGETS[targetId].defaultAmount;
      }
      applyPreview();
    };

    // Scroll wheel while hovering a valid knob (button still held) sets the
    // audition depth — todo.md §81/§87. Default step is a fraction of the
    // target's range (~2.5 %); hold Shift for a fine step (the target's
    // native per-pixel sensitivity). Was cents-per-notch on pitch — too slow.
    const onWheel = (e: WheelEvent) => {
      const d = dragRef.current;
      if (!d || !d.previewTarget) return;
      e.preventDefault();
      d.previewAmount = stepModAmount(d.previewTarget, d.previewAmount, e.deltaY, e);
      applyPreview();
    };

    // Only real controls carry `data-mod-target`; the ∿ badge does not
    // (todo.md §69). A drop is valid only if this source is offered for the
    // target AND the target is wired (DSP or UI-only self-mod — see
    // `isValidDropTarget` above, shared with click-to-assign).
    const targetUnder = (x: number, y: number): ModTargetId | null => {
      const hit = targetElementUnder(x, y);
      const ok = hit != null && isValidDropTarget(src, hit.id);
      const hl = ok && hit ? hit.el : null;
      if (hl !== hoverElRef.current) {
        hoverElRef.current?.classList.remove('is-mod-drop');
        hoverElRef.current = hl;
        hoverElRef.current?.classList.add('is-mod-drop');
      }
      return ok && hit ? hit.id : null;
    };

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      d.to = { x: e.clientX, y: e.clientY };
      if (!d.everMoved && Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) > 4) d.everMoved = true;
      paintPath();
      const targetId = targetUnder(e.clientX, e.clientY);
      if (targetId !== d.previewTarget) previewTarget(targetId);
    };

    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      // Fast/small drags may never fire a move over the target.
      if (d && !d.previewTarget) {
        const t = targetUnder(e.clientX, e.clientY);
        if (t) previewTarget(t);
      }
      hoverElRef.current?.classList.remove('is-mod-drop');
      hoverElRef.current = null;
      if (d?.previewTarget) {
        applyRef.current(withRoute(d.baseMod, d.previewTarget, d.source, d.previewAmount)); // keep it at the set depth
      } else if (d && !d.everMoved) {
        // A plain click on the source dot — the pointer never travelled past
        // the click threshold at any point in the gesture (not just "isn't
        // far from the start now" — an out-and-back drag that ends near its
        // start is still a real drag, not a click) — so nothing was ever
        // previewed and there's nothing to revert. Enter click-to-assign
        // mode instead (todo.md §91/92).
        setAssignSource(d.source);
      } else {
        applyRef.current(d?.baseMod ?? modRef.current ?? {}); // revert the audition
      }
      dragRef.current = null;
      setCableSource(null);
      setAmountLabel(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('wheel', onWheel, { passive: false });
    paintPath();
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('wheel', onWheel);
      hoverElRef.current?.classList.remove('is-mod-drop');
      hoverElRef.current = null;
      setAmountLabel(null);
      // Interrupted mid-drag (unmount) with an audition still applied — restore.
      if (dragRef.current) {
        applyRef.current(dragRef.current.baseMod);
        dragRef.current = null;
      }
    };
  }, [cableSource]);

  return {
    cableSource,
    dragColor,
    amountLabel,
    handleSourceDragStart,
    pathRef: pathRef as React.Ref<SVGPathElement>,
    endDotRef: endDotRef as React.Ref<SVGCircleElement>,
    amtRef: amtRef as React.Ref<HTMLDivElement>,
    assignSource,
    assignColor,
    cancelAssign,
  };
}
