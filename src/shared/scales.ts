/**
 * Key-signature snap for the arpeggiator / step sequencer (todo.md §166).
 * A scale is a set of semitone intervals above the root pitch class.
 */
export type ScaleId =
  | 'major' | 'minor' | 'harmonicMinor' | 'dorian' | 'phrygian' | 'lydian'
  | 'mixolydian' | 'pentMajor' | 'pentMinor' | 'blues';

export const SCALES: { id: ScaleId; label: string; intervals: number[] }[] = [
  { id: 'major', label: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', label: 'Minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'harmonicMinor', label: 'Harm. minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'dorian', label: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', label: 'Phrygian', intervals: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', label: 'Lydian', intervals: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', label: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'pentMajor', label: 'Pent. major', intervals: [0, 2, 4, 7, 9] },
  { id: 'pentMinor', label: 'Pent. minor', intervals: [0, 3, 5, 7, 10] },
  { id: 'blues', label: 'Blues', intervals: [0, 3, 5, 6, 7, 10] },
];

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const intervalsOf = (id: ScaleId) => (SCALES.find((s) => s.id === id) ?? SCALES[0]).intervals;
const pc = (n: number) => ((n % 12) + 12) % 12;

/** Nearest in-key MIDI note to `note` (ties go down). Notes already in key are unchanged. */
export function snapToKey(note: number, root: number, scale: ScaleId): number {
  const iv = intervalsOf(scale);
  for (let d = 0; d <= 6; d += 1) {
    if (iv.includes(pc(note - d - root))) return note - d;
    if (iv.includes(pc(note + d - root))) return note + d;
  }
  return note;
}

/** Nearest in-key semitone OFFSET from the root (what a step's pitch slider steps through). */
export function snapOffsetToKey(offset: number, scale: ScaleId): number {
  return snapToKey(offset, 0, scale);
}
