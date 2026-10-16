import { useEffect, useRef } from 'react';
import type { ArpSettings } from '../../shared/types';
import { SEQ_STEPS } from '../../shared/types';
import { setSeqPlayhead } from '../lib/seqPlayhead';
import { snapToKey } from '../../shared/scales';

/**
 * Arpeggiator engine (todo.md §166 v1, scope trimmed to Arp mode — no Seq
 * step lanes yet). Deliberately a plain JS `setTimeout` scheduler driving
 * the existing `noteOn`/`noteOff` calls, NOT the sample-accurate
 * audio-thread engine §166-E eventually wants (that needs a native/DSP
 * port, same class of work as the allocator and the spectral warps) — this
 * is the fast path to something real and audible to iterate the UI/feature
 * against, not a mockup. Self-corrects drift by scheduling off of
 * `performance.now()` each step rather than accumulating `setTimeout` error.
 *
 * `held` is the RAW input set (piano/host notes currently down) — this
 * hook does not mutate it; the caller is responsible for NOT also calling
 * noteOn/noteOff directly for those same notes while `settings.on` (see
 * SynthView/PluginApp), so the arp's own triggers are the only sound.
 */
/** How long after an arp note-off the native voice snapshot may still report it as held. */
const OWN_NOTE_GRACE_MS = 400;
const EMPTY_SET: ReadonlySet<number> = new Set<number>();

export function useArpEngine(
  held: ReadonlySet<number>,
  settings: ArpSettings,
  noteOn: (midi: number, velocity?: number) => void,
  noteOff: (midi: number) => void,
  /**
   * Notes reported by the native voice pool (plugin host MIDI). These include
   * the arp's own output, so they are filtered against what this engine emitted.
   * `held` is trusted as-is (UI keys the arp itself never re-reports).
   */
  nativeHeld: ReadonlySet<number> = EMPTY_SET,
) {
  const stateRef = useRef({
    timer: 0 as ReturnType<typeof setTimeout> | 0,
    stepIndex: 0,
    sounding: null as number | null,
    orderedKey: '', // last-built order, to detect when held notes change mid-run
    order: [] as number[],
    frozenHeld: new Set<number>(), // latches the chord when `hold` is on and keys release
    /**
     * Live playhead for the UI (todo.md §166 v2). The step sequencer editor
     * draws a moving cursor, and it needs the index from the audio-side
     * scheduler — but the scheduler runs on a `setTimeout` loop OUTSIDE
     * React, so it can't set state without re-rendering the whole panel on
     * every single step (at 20 Hz that is 20 wasted renders/sec of a 68-knob
     * UI, and §168's perf pass specifically took care not to add those).
     * Instead this publishes to an external store the editor subscribes to
     * with its own cheap rAF-batched selector, leaving `ArpPanel`'s render
     * untouched. -1 = stopped/no playhead.
     */
    playhead: -1 as number,
    /**
     * Notes this engine itself triggered -> expiry time (ms, performance.now()
     * clock). The plugin's `held` set is derived from the native voices' gate
     * snapshot, which includes the arp's OWN notes (arriving ~50-100 ms late).
     * Without filtering them out the arp re-reads its output as input: it
     * self-sustains after the keys are released, octave/semitone lane offsets
     * climb the pitch every cycle, and `hold` latches the garbage into
     * frozenHeld — the "arp off breaks the synth until restart" report.
     * Infinity while the note is on; a grace window after the note-off covers
     * the snapshot lag.
     */
    emitted: new Map<number, number>(),
  });

  // Keep a live ref of the latest settings/held/callbacks so the recursive
  // setTimeout loop (started once) always sees current values without
  // needing to be torn down and restarted every render.
  const liveRef = useRef({ held, settings, noteOn, noteOff });
  const emitted = stateRef.current.emitted;
  const ownNoteOn = (midi: number, velocity?: number) => { emitted.set(midi, Infinity); noteOn(midi, velocity); };
  const ownNoteOff = (midi: number) => { emitted.set(midi, performance.now() + OWN_NOTE_GRACE_MS); noteOff(midi); };
  // Filtered lazily (getter) so each step sees the arp's latest emitted notes,
  // not the set as of the last React render.
  const rawNative = nativeHeld;
  liveRef.current = {
    get held(): ReadonlySet<number> {
      const out = new Set<number>(held);
      const now = performance.now();
      for (const n of rawNative) {
        const exp = emitted.get(n);
        if (exp === undefined || exp < now) { out.add(n); if (exp !== undefined) emitted.delete(n); }
      }
      return out;
    },
    settings, noteOn: ownNoteOn, noteOff: ownNoteOff,
  };

  useEffect(() => {
    const s = stateRef.current;

    function buildOrder(notes: number[], mode: ArpSettings['mode']): number[] {
      const sorted = [...notes].sort((a, b) => a - b);
      switch (mode) {
        case 'down': return sorted.slice().reverse();
        case 'updown': return sorted.length > 2 ? [...sorted, ...sorted.slice(1, -1).reverse()] : sorted;
        case 'random': return sorted; // reshuffled per-cycle in step(), not here
        case 'asPlayed': return notes; // insertion order as given
        case 'up':
        default: return sorted;
      }
    }

    function stopSounding() {
      if (s.sounding != null) { liveRef.current.noteOff(s.sounding); s.sounding = null; }
    }

    function step() {
      // One mode now: the arp. The sequencer's lanes are read by the engine, not a second loop.
      setSeqPlayhead(-1);
      const { held: h, settings: cfg, noteOn: on, noteOff: off } = liveRef.current;
      stopSounding();

      const effectiveHeld = h.size > 0 ? h : (cfg.hold ? s.frozenHeld : new Set<number>());
      if (h.size > 0) s.frozenHeld = new Set(h);

      if (!cfg.on || effectiveHeld.size === 0) {
        s.timer = setTimeout(step, 1000 / Math.max(0.5, cfg.rateHz));
        return;
      }

      const base = buildOrder([...effectiveHeld], cfg.mode);
      const octaveCount = Math.max(1, Math.min(4, cfg.octaves));
      let pool: number[] = [];
      for (let o = 0; o < octaveCount; o++) for (const n of base) pool.push(n + o * 12);
      if (cfg.mode === 'random') {
        const pick = pool[Math.floor(Math.random() * pool.length)];
        pool = [pick];
        s.stepIndex = 0;
      }

      if (pool.length === 0) {
        s.timer = setTimeout(step, 1000 / Math.max(0.5, cfg.rateHz));
        return;
      }

      const idx = cfg.mode === 'random' ? 0 : s.stepIndex % pool.length;
      const rawNote = pool[idx];
      const note = Math.max(0, Math.min(127, cfg.keySnap ? snapToKey(rawNote, cfg.keyRoot, cfg.keyScale) : rawNote));
      s.stepIndex = idx + 1;

      const stepMs = 1000 / Math.max(0.5, cfg.rateHz);
      on(Math.max(0, Math.min(127, note)), 0.9);
      s.sounding = note;

      const gateMs = Math.max(5, stepMs * Math.max(0.05, Math.min(1, cfg.gate)));
      if (gateMs < stepMs) {
        setTimeout(() => { if (s.sounding === note) { off(note); s.sounding = null; } }, gateMs);
      }

      s.timer = setTimeout(step, stepMs);
    }

    s.timer = setTimeout(step, 1000 / Math.max(0.5, settings.rateHz));
    return () => {
      if (s.timer) clearTimeout(s.timer);
      stopSounding();
      // Clear the cursor on unmount. Without this, closing the sequencer editor
      // (or unmounting the whole app) leaves the last step highlighted in the
      // store forever, and the next mount would open with a stale cursor on a
      // pattern that isn't even playing.
      setSeqPlayhead(-1);
    };
    // Intentionally only re-arm the loop on mount/unmount — liveRef carries
    // fresh values into the recursive step() so the timer never needs to
    // reset mid-pattern just because a knob moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
