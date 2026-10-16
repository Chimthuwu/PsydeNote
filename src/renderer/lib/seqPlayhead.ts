/**
 * Playhead store for the step sequencer (todo.md §166 v2).
 *
 * Deliberately NOT React state. `useArpEngine`'s scheduler lives on a
 * `setTimeout` loop outside React, so threading the current step through
 * `useState` would re-render the whole 68-knob panel on every step — up to 20
 * times a second, which §168's performance pass went out of its way to avoid.
 * A tiny external store with a subscriber callback lets the sequencer editor
 * repaint just its own playhead via rAF instead.
 *
 * Deliberately a module-level singleton rather than a context: there is exactly
 * one arpeggiator per app instance, and a context would mean threading a
 * provider through both PluginApp and the Electron SynthView for no benefit.
 */

/** -1 means "no playhead" — stopped, arp mode, or nothing held. */
type Listener = (step: number) => void;

let current = -1;
const listeners = new Set<Listener>();

export function getSeqPlayhead(): number {
  return current;
}

export function setSeqPlayhead(step: number): void {
  if (step === current) return;
  current = step;
  for (const fn of listeners) {
    try {
      fn(step);
    } catch (err) {
      // A throwing subscriber must not stop the others or the scheduler.
      console.error('[seq] playhead listener threw', err);
    }
  }
}

export function subscribeSeqPlayhead(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}