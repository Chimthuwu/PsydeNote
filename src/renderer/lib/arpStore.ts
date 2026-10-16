/**
 * Tiny external store for the native arp/sequencer read-back (contract §5):
 * the playhead (global step + bar) and the engine's dice overlays.
 *
 * Fed by `window.__arpPlayhead__` / `window.__arpOverlay__` (installed by the
 * plugin shell). Deliberately NOT React state in the app root — consumers
 * subscribe through useSyncExternalStore so only the lane editors repaint.
 */
import { useSyncExternalStore } from 'react';
import type { LaneId } from '../../shared/types';

export interface ArpPlayhead { step: number; bar: number }
export type ArpOverlay = Partial<Record<LaneId, (number | null)[]>>;

type Listener = () => void;

let playhead: ArpPlayhead = { step: -1, bar: 0 };
let overlay: ArpOverlay = {};
const headListeners = new Set<Listener>();
const overlayListeners = new Set<Listener>();

function emit(set: Set<Listener>): void {
  for (const fn of set) {
    try { fn(); } catch (err) { console.error('[arp] store listener threw', err); }
  }
}

/** step -1 = arp off / nothing playing. A new object is only made on change (stable snapshot). */
export function setArpPlayhead(step: number, bar?: number): void {
  const s = Number.isFinite(step) ? Math.round(step) : -1;
  const b = bar !== undefined && Number.isFinite(bar) ? Math.round(bar) : playhead.bar;
  if (s === playhead.step && b === playhead.bar) return;
  playhead = { step: s, bar: b };
  emit(headListeners);
}

/** Replace the overlay. Accepts either `{on:[…],…}` or `{lanes:{on:[…],…}}`. */
export function setArpOverlay(obj: unknown): void {
  const src = obj && typeof obj === 'object' ? (obj as Record<string, any>) : {};
  const lanes = src.lanes && typeof src.lanes === 'object' ? (src.lanes as Record<string, any>) : src;
  const next: ArpOverlay = {};
  for (const id of ['on', 'prob', 'pitch', 'octave', 'vel', 'gate', 'slide'] as LaneId[]) {
    const a = lanes[id];
    if (Array.isArray(a)) next[id] = a.map((v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
  }
  overlay = next;
  emit(overlayListeners);
}

export function getArpPlayhead(): ArpPlayhead { return playhead; }
export function getArpOverlay(): ArpOverlay { return overlay; }

function subHead(fn: Listener): () => void {
  headListeners.add(fn);
  return () => { headListeners.delete(fn); };
}
function subOverlay(fn: Listener): () => void {
  overlayListeners.add(fn);
  return () => { overlayListeners.delete(fn); };
}

export function useArpPlayhead(): ArpPlayhead {
  return useSyncExternalStore(subHead, getArpPlayhead, getArpPlayhead);
}
export function useArpOverlay(): ArpOverlay {
  return useSyncExternalStore(subOverlay, getArpOverlay, getArpOverlay);
}
