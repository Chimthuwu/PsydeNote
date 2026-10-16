import { useCallback, useEffect, useMemo, useRef } from 'react';
import { applyVelocityCurve } from '../../shared/types';

/**
 * Phase 1 piano keyboard.
 *
 *   - Renders a strip of white keys (flex row) with black keys absolutely
 *     positioned over the joins.
 *   - Both mouse and computer-keyboard input are dispatched through the
 *     `onNoteOn` / `onNoteOff` callbacks, so the parent owns the audio —
 *     no note logic lives in this component.
 *   - The component does NOT maintain a "currently held" set of its own;
 *     it asks the parent via the `activeNotes` prop. The parent decides
 *     what visual + audio state a held note should have. This keeps the
 *     visual in lockstep with the synth engine.
 *
 * QWERTY mapping (todo.md §55 — two physical rows, ~2.4 octaves; octave
 * knob in the panel transposes the whole thing):
 *
 *   row 2  Q W E R T Y U I O P     (+1 octave up, overlapping row 1's top)
 *   black  2 3   5 6 7   9 0
 *
 *   row 1  Z X C V B N M  , . /
 *   black  S D   G H J   L ;
 *
 * = C  D  E F G  A  B  C  D E   (white, per row, 10 semitones)
 * = C# D#  F# G# A#  C# D#      (black, per row, 7 semitones)
 *
 * Row 2 is row 1's pattern shifted +12 semitones (one octave), reusing the
 * SAME relative white/black shape one physical row up — Q sits above Z the
 * way the number row sits above the letter row, so the two rows read as
 * "the same keyboard, one octave apart" rather than two unrelated schemes.
 * They deliberately overlap by a few notes (row 1's trailing `,`/`.`/`/`
 * and row 2's leading `Q`/`W`/`E` can land on the same MIDI notes) — that's
 * intentional, not a bug: it makes chords that straddle the seam easier to
 * reach with either hand position.
 */

interface PianoKeyboardProps {
  startMidi: number; // inclusive, must be a C
  endMidi: number; // inclusive
  activeNotes: ReadonlySet<number>;
  onNoteOn: (midi: number, velocity?: number) => void;
  onNoteOff: (midi: number) => void;
  /** Global velocity curve (-1 soft .. +1 hard) shaping click-position → velocity. */
  velocityCurve: number;
}

/** MIDI note → CSS pitch class + octave label, for the small white-key caption. */
function noteLabel(midi: number): { pc: string; octave: string } {
  const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const pc = PC[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return { pc, octave: String(octave) };
}

/** Pitch class (0..11) of any MIDI note — used to test for black keys. */
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);

function isBlack(midi: number): boolean {
  return BLACK_PCS.has(midi % 12);
}

/** Velocity from a pointer's Y within the keyboard: lower (deeper) = louder, shaped by the global velocity curve. */
function pointerVelocity(rect: { top: number; height: number }, clientY: number, curve: number): number {
  if (rect.height <= 0) return 1;
  const rel = (clientY - rect.top) / rect.height;
  return applyVelocityCurve(rel, curve);
}

/**
 * QWERTY → semitone offset within the displayed keyboard.
 *
 * White keys are contiguous; black keys fit between named white pairs.
 * Offsets are *within* the visible keyboard; the startMidi prop shifts the
 * whole map up or down.
 */
const QWERTY_OFFSETS: Record<string, number> = {
  // Row 1 — see the mapping doc above.
  z: 0, x: 2, c: 4, v: 5, b: 7, n: 9, m: 11,
  s: 1, d: 3, g: 6, h: 8, j: 10,
  ',': 12, l: 13, '.': 14, ';': 15, '/': 16,
  // Row 2 — row 1's shape, +12 semitones (todo.md §55).
  q: 12, w: 14, e: 16, r: 17, t: 19, y: 21, u: 23,
  '2': 13, '3': 15, '5': 18, '6': 20, '7': 22,
  i: 24, o: 26, p: 28,
  '9': 25, '0': 27,
};

/** Normalise a keydown/keyup `e.key` to a stable identity — Shift/Caps make
 *  `e.key` flip case (and `<`/`>`/`?` stand in for `,`/`.`/`/`), so the
 *  held-key map must key off THIS value, not the raw key, or a note whose
 *  modifier changed between press and release never finds its note-off. */
function normalizeKey(rawKey: string): string {
  if (rawKey === '<') return ',';
  if (rawKey === '>') return '.';
  if (rawKey === '?') return '/';
  return rawKey.toLowerCase();
}

export function PianoKeyboard({
  startMidi,
  endMidi,
  activeNotes,
  onNoteOn,
  onNoteOff,
  velocityCurve,
}: PianoKeyboardProps) {
  // Memo the white and black key lists — the parent already memoises
  // props, but the component itself shouldn't reallocate per render.
  const whiteMidi: number[] = [];
  const blackMidi: number[] = [];
  for (let m = startMidi; m <= endMidi; m++) {
    (isBlack(m) ? blackMidi : whiteMidi).push(m);
  }

  /** Index of a white key in the run; used to position black keys. */
  function whiteIndex(midi: number): number {
    let n = 0;
    for (let m = startMidi; m <= midi; m++) if (!isBlack(m)) n++;
    return n - 1;
  }

  // ---- computer-keyboard handling --------------------------------------------
  // Tracked locally so a key-up *after* the window loses focus still triggers
  // noteOff (the browser swallows keyup when focus leaves).
  const heldPhysicalKeysRef = useRef<Map<string, number>>(new Map());

  const dispatchKeyDown = useCallback(
    (rawKey: string, fresh = true) => {
      const k = normalizeKey(rawKey);
      const off = QWERTY_OFFSETS[k];
      if (off === undefined) return;
      const midi = startMidi + off;
      if (midi > endMidi) return;
      // Already held: a genuine (non-repeat) key-down means we missed its key-up (focus change / knob
      // drag swallowed it) — release the stale note and retrigger instead of staying "locked".
      const stale = heldPhysicalKeysRef.current.get(k);
      if (stale != null) {
        if (!fresh) return; // OS auto-repeat
        heldPhysicalKeysRef.current.delete(k);
        onNoteOff(stale);
      }
      heldPhysicalKeysRef.current.set(k, midi);
      onNoteOn(midi, 0.8); // computer keys have no position → fixed velocity
    },
    [startMidi, endMidi, onNoteOn, onNoteOff],
  );
  const dispatchKeyUp = useCallback(
    (rawKey: string) => {
      const k = normalizeKey(rawKey);
      const midi = heldPhysicalKeysRef.current.get(k);
      if (midi == null) return;
      heldPhysicalKeysRef.current.delete(k);
      onNoteOff(midi);
    },
    [onNoteOff],
  );

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      // Don't capture if the user is typing in a text field (the settings
      // modal has inputs that use these same physical keys; running the
      // synth while the user is editing settings is jarring, and worse, it
      // puts a held note in a place they can't find out about).
      const target = e.target as HTMLElement | null;
      // Only real TEXT entry swallows the keys. Sliders / checkboxes / buttons / selects that merely hold
      // focus after a knob adjustment must not lock the computer keyboard out.
      if (target && target.closest('textarea, [contenteditable="true"], input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"])')) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      dispatchKeyDown(e.key, !e.repeat);
    };
    const onUp = (e: KeyboardEvent) => {
      // ALWAYS release on keyup — never skip based on the event target. If
      // focus moved into an input between keydown and keyup (e.g. the user
      // clicked the pitch-dial's type-to-edit field mid-note), skipping here
      // would strand the note and leave the key stuck.
      dispatchKeyUp(e.key);
    };
    const onBlur = () => {
      // Window lost focus — every held computer-key note is implicitly
      // released. Without this a keyup that fires before a focus change is
      // missed, leaving the synth holding a note forever.
      for (const midi of heldPhysicalKeysRef.current.values()) onNoteOff(midi);
      heldPhysicalKeysRef.current.clear();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [dispatchKeyDown, dispatchKeyUp, onNoteOff]);

  // ---- pointer handling + glissando ------------------------------------------
  // One gesture on the `.pk-row` container: pointerdown on a key sounds it and
  // captures the pointer; dragging across neighbouring keys (pointermove +
  // elementFromPoint hit-test) retriggers each newly-entered key and releases
  // the previous one, so a single held drag plays a legato sweep — the
  // click-drag glissando the old per-key handlers couldn't do. pointerup /
  // cancel releases whatever note the gesture is currently on.
  const glissRef = useRef<number | null>(null);

  const rowDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const el = (e.target as HTMLElement).closest?.('[data-midi]');
      const midi = el ? Number(el.getAttribute('data-midi')) : NaN;
      if (!Number.isFinite(midi)) return;
      e.preventDefault();
      onNoteOn(midi, pointerVelocity(e.currentTarget.getBoundingClientRect(), e.clientY, velocityCurve));
      glissRef.current = midi;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [onNoteOn, velocityCurve],
  );
  const rowMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (glissRef.current === null) return;
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-midi]');
      const midi = el ? Number(el.getAttribute('data-midi')) : NaN;
      if (!Number.isFinite(midi) || midi === glissRef.current) return;
      onNoteOff(glissRef.current);
      onNoteOn(midi, pointerVelocity(e.currentTarget.getBoundingClientRect(), e.clientY, velocityCurve));
      glissRef.current = midi;
    },
    [onNoteOn, onNoteOff, velocityCurve],
  );
  const rowUp = useCallback(
    () => {
      if (glissRef.current === null) return;
      onNoteOff(glissRef.current);
      glissRef.current = null;
    },
    [onNoteOff],
  );

  const whiteWidth = `${100 / whiteMidi.length}%`;

  // Memo the JSX lists so each key only re-renders when its note becomes
  // active (and not on every random parent re-render).
  const whiteKeys = useMemo(
    () =>
      whiteMidi.map((m, i) => {
        const { pc, octave } = noteLabel(m);
        const showOctaveLabel = m === startMidi; // show "C4" once per octave
        const rightIsBlack =
          i < whiteMidi.length - 1 && isBlack(m + 1);
        const leftIsBlack = i > 0 && isBlack(m + 1 - 2);
        void leftIsBlack; void rightIsBlack; // (reserved for visual gloss)
        return (
          <div
            key={`w-${m}`}
            role="button"
            tabIndex={-1}
            aria-label={`${pc}${m === startMidi ? octave : ''}`}
            className="pk-white"
            data-midi={m}
            data-active={activeNotes.has(m) ? '1' : '0'}
            style={{ width: whiteWidth }}
          >
            {showOctaveLabel && (
              <span className="pk-label">C{octave}</span>
            )}
          </div>
        );
      }),
    // We deliberately do not memo over whiteMidi — it's stable for the
    // lifetime of a given startMidi/effective state setup, and re-creating the
    // inner key styles every render is cheap; React will skip attribute writes
    // for inactive keys anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [startMidi, endMidi, activeNotes],
  );

  const blackKeys = useMemo(
    () =>
      blackMidi.map((m) => {
        const wIdx = whiteIndex(m);
        // Position: centre of the black key sits at the join between white wIdx
        // and white wIdx+1, i.e. at (wIdx + 0.5) / numWhites. We compute left
        // as a percentage relative to the row.
        const leftPct = ((wIdx + 0.5) / whiteMidi.length) * 100;
        // Black keys are ~65% of a white key's width, so their width scales
        // with however many white keys are visible (4 octaves = 28 whites).
        const widthPct = (0.65 / whiteMidi.length) * 100;
        return (
          <div
            key={`b-${m}`}
            role="button"
            tabIndex={-1}
            aria-label={noteLabel(m).pc}
            className="pk-black"
            data-midi={m}
            data-active={activeNotes.has(m) ? '1' : '0'}
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
          />
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [startMidi, endMidi, activeNotes],
  );

  return (
    <div
      className="pk-row"
      role="group"
      aria-label="Piano keyboard"
      onPointerDown={rowDown}
      onPointerMove={rowMove}
      onPointerUp={rowUp}
      onPointerCancel={rowUp}
    >
      <div className="pk-whites">{whiteKeys}</div>
      <div className="pk-blacks">{blackKeys}</div>
    </div>
  );
}
