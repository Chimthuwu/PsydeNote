/**
 * Tiny external store for the native voice readout: how many voices sound,
 * which MIDI notes the voice pool holds, and a burst counter that ticks each
 * time the held-note count grows (drives the FX reflection flash).
 *
 * Why this is not React state in the plugin root: the native plugin pushes a
 * state update whenever a voice changes, and with the arp running that is
 * several times a second. Held in `useState` in PluginApp, every push
 * re-rendered the whole app (oscillator panel, sequencer, 88-key piano, FX).
 * Here only the components that read a field re-render. Same pattern as
 * `arpStore.ts`.
 */
import { useSyncExternalStore } from 'react';

const EMPTY: ReadonlySet<number> = new Set<number>();

let activeVoices = 0;
let heldNotes: ReadonlySet<number> = EMPTY;
let burst = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error('[voice] store listener threw', err); }
  }
}

function sameNotes(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const n of a) if (!b.has(n)) return false;
  return true;
}

/** Feed one native readout. Does nothing (and wakes no one) when nothing changed. */
export function setVoiceReadout(active: number, held: ReadonlySet<number>): void {
  let changed = false;
  if (active !== activeVoices) { activeVoices = active; changed = true; }
  if (!sameNotes(held, heldNotes)) {
    if (held.size > heldNotes.size) burst += 1;   // a note was added: fire the FX burst
    heldNotes = held;
    changed = true;
  }
  if (changed) emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
const getActive = () => activeVoices;
const getHeld = () => heldNotes;
const getBurst = () => burst;

export function useActiveVoices(): number { return useSyncExternalStore(subscribe, getActive, getActive); }
export function useHeldNotes(): ReadonlySet<number> { return useSyncExternalStore(subscribe, getHeld, getHeld); }
export function useVoiceBurst(): number { return useSyncExternalStore(subscribe, getBurst, getBurst); }
