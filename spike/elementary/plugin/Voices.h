#pragma once

#include <array>
#include <cmath>
#include <cstdint>

// ---------------------------------------------------------------------------
// C++ port of dsp/allocator.js. This is the ONE piece of the browser preview
// that doesn't run verbatim in the plugin: voice allocation has to happen on
// the audio thread (it reads the JUCE MidiBuffer sample-by-sample), so it
// can't be JavaScript. The interesting half — the Elementary graph in
// dsp/synth.js — IS shared verbatim (see dsp.main.js).
//
// Policy matches Faze's SynthEngine (todo.md §1.3): fixed pool, keyed by
// note so a retrigger is idempotent, oldest-voice stealing when full.
// ---------------------------------------------------------------------------

template <int NumVoices = 8>
struct VoicePool
{
    struct Voice
    {
        float gate = 0.0f;   // 1 = held, 0 = released (ADSR tail still plays)
        float freq = 440.0f;
        float vel  = 1.0f;   // note-on velocity, latched for the life of the voice
        int   note = -1;
        uint64_t age = 0;
    };

    // 0 = poly, 1 = mono (every new note retriggers), 2 = legato (an
    // overlapping note only changes pitch; the gate never drops).
    // Mono/legato play on voice 0 with a last-note-priority held-note stack.
    enum Mode { Poly = 0, Mono = 1, Legato = 2 };

    std::array<Voice, NumVoices> voices {};
    uint64_t clock = 0;
    int mode = Poly;
    // Mono retrigger: the gate is dropped for one block, then restored by
    // endRetrigger() (a 1->0->1 inside one block would be invisible to the DSP).
    bool retriggerPending = false;

    static constexpr int kMaxHeld = 32;
    std::array<int, kMaxHeld> held {};
    std::array<float, kMaxHeld> heldVel {};
    int heldCount = 0;

    /** Switching modes kills sounding notes (avoids stuck mono/poly hybrids). */
    void setMode (int m) noexcept
    {
        m = m < 0 ? 0 : (m > 2 ? 2 : m);
        if (m == mode) return;
        allNotesOff();
        mode = m;
    }

    /** Call at the start of the next block after a mono retrigger. */
    bool endRetrigger() noexcept
    {
        if (! retriggerPending) return false;
        retriggerPending = false;
        if (heldCount > 0) voices[0].gate = 1.0f;
        return true;
    }

    static float midiToFreq (int n) noexcept
    {
        return 440.0f * std::pow (2.0f, (float) (n - 69) / 12.0f);
    }

    void heldRemove (int note) noexcept
    {
        for (int i = 0; i < heldCount; ++i)
            if (held[(size_t) i] == note)
            {
                for (int j = i; j < heldCount - 1; ++j) { held[(size_t) j] = held[(size_t) j + 1]; heldVel[(size_t) j] = heldVel[(size_t) j + 1]; }
                --heldCount;
                return;
            }
    }

    void monoNoteOn (int note, float velocity) noexcept
    {
        ++clock;
        const float vel = (velocity > 0.0f) ? velocity : 1.0f;
        heldRemove (note);
        if (heldCount == kMaxHeld) heldRemove (held[0]);
        held[(size_t) heldCount] = note; heldVel[(size_t) heldCount] = vel; ++heldCount;

        auto& v = voices[0];
        const bool sounding = v.gate > 0.5f;
        v.note = note;
        v.freq = midiToFreq (note);
        v.age  = clock;
        if (sounding && mode == Legato)
            return;                       // pitch glides, envelope untouched
        v.vel = vel;
        if (sounding) { v.gate = 0.0f; retriggerPending = true; } // Mono: dip the gate for a block
        else v.gate = 1.0f;
    }

    void monoNoteOff (int note) noexcept
    {
        heldRemove (note);
        auto& v = voices[0];
        if (heldCount == 0)
        {
            retriggerPending = false;
            v.gate = 0.0f; v.note = -1;
            return;
        }
        if (v.note == note)               // released the sounding note: fall back
        {
            const int prev = held[(size_t) heldCount - 1];
            v.note = prev;
            v.freq = midiToFreq (prev);   // no retrigger on return, both modes
        }
    }

    /** Returns the voice slot used (0 in mono/legato). */
    int noteOn (int note, float velocity) noexcept
    {
        if (mode != Poly) { monoNoteOn (note, velocity); return 0; }
        ++clock;

        int slot = -1;
        // 1. the note is already sounding -> reuse (idempotent retrigger)
        for (int i = 0; i < NumVoices; ++i)
            if (voices[i].note == note && voices[i].gate > 0.5f) { slot = i; break; }
        // 2. a never-used idle slot, then any idle slot
        if (slot < 0)
            for (int i = 0; i < NumVoices; ++i)
                if (voices[i].gate < 0.5f && voices[i].note < 0) { slot = i; break; }
        if (slot < 0)
            for (int i = 0; i < NumVoices; ++i)
                if (voices[i].gate < 0.5f) { slot = i; break; }
        // 3. steal the oldest
        if (slot < 0)
        {
            slot = 0;
            for (int i = 1; i < NumVoices; ++i)
                if (voices[i].age < voices[slot].age) slot = i;
        }

        voices[slot].note = note;
        voices[slot].freq = midiToFreq (note);
        voices[slot].vel  = (velocity > 0.0f) ? velocity : 1.0f; // 0 vel = note-off in some hosts
        voices[slot].gate = 1.0f;
        voices[slot].age  = clock;
        return slot;
    }

    void noteOff (int note) noexcept
    {
        if (mode != Poly) { monoNoteOff (note); return; }
        for (auto& v : voices)
            if (v.note == note && v.gate > 0.5f) { v.gate = 0.0f; v.note = -1; }
    }

    void allNotesOff() noexcept
    {
        heldCount = 0;
        retriggerPending = false;
        for (auto& v : voices) { v.gate = 0.0f; v.note = -1; }
    }
};
