// ---------------------------------------------------------------------------
// Framework-agnostic polyphonic voice allocator.
//
// Mirrors the allocation policy in Faze's SynthEngine (§1.3): a fixed voice
// pool, keyed by MIDI note so a retrigger of a held note is idempotent, with
// oldest-voice stealing when the pool is full.
//
// The browser preview drives this from pointer / QWERTY events; the plugin
// harness drives it from the JUCE MidiBuffer. Neither knows about Elementary.
// ---------------------------------------------------------------------------
import { midiToFreq } from './synth.js';

export function createAllocator(numVoices = 8) {
  /** @type {Array<{gate:0|1, freq:number, note:number, age:number, vel:number}>} */
  const voices = Array.from({ length: numVoices }, () => ({
    gate: 0,
    freq: 440,
    note: -1,
    age: 0,
    vel: 1,
  }));

  let clock = 0;

  function pick() {
    // 1. a never-used idle slot, 2. any idle slot, 3. steal the oldest.
    return (
      voices.find((v) => v.gate === 0 && v.note === -1) ||
      voices.find((v) => v.gate === 0) ||
      voices.reduce((a, b) => (a.age <= b.age ? a : b))
    );
  }

  return {
    voices,

    noteOn(note, velocity = 1) {
      clock += 1;
      // Idempotent retrigger: if the note is already sounding, reuse its slot.
      const existing = voices.find((v) => v.note === note && v.gate === 1);
      const slot = existing || pick();
      slot.note = note;
      slot.freq = midiToFreq(note);
      slot.vel = velocity;
      slot.gate = 1;
      slot.age = clock;
    },

    noteOff(note) {
      for (const v of voices) {
        if (v.note === note && v.gate === 1) {
          v.gate = 0;
          v.note = -1; // free immediately; the ADSR release tail still plays out
        }
      }
    },

    allNotesOff() {
      for (const v of voices) {
        v.gate = 0;
        v.note = -1;
      }
    },

    activeCount() {
      return voices.filter((v) => v.gate === 1).length;
    },
  };
}
