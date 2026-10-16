// Standalone check of VoicePool poly/mono/legato (plugin/Voices.h).
// g++ -std=c++17 -I../../plugin voices-test.cpp && ./a.out
#include "Voices.h"
#include <cstdio>
static int fails = 0;
#define CHECK(c) do { if (!(c)) { std::printf("FAIL line %d: %s\n", __LINE__, #c); ++fails; } } while (0)
int main()
{
    { VoicePool<6> p; p.noteOn (60, 1); p.noteOn (64, 1);
      CHECK (p.voices[0].gate > 0.5f && p.voices[1].gate > 0.5f); }          // poly unchanged
    { VoicePool<6> p; p.setMode (VoicePool<6>::Mono);
      p.noteOn (60, 0.8f); CHECK (p.voices[0].gate == 1.0f && ! p.retriggerPending);
      p.noteOn (64, 0.5f); CHECK (p.voices[0].gate == 0.0f && p.retriggerPending); // gate dips
      CHECK (p.endRetrigger() && p.voices[0].gate == 1.0f);
      CHECK (std::abs (p.voices[0].freq - VoicePool<6>::midiToFreq (64)) < 0.01f);
      CHECK (p.voices[1].gate == 0.0f);                                      // one voice only
      p.noteOff (64); CHECK (p.voices[0].note == 60 && p.voices[0].gate == 1.0f); // fall back
      p.noteOff (60); CHECK (p.voices[0].gate == 0.0f); }
    { VoicePool<6> p; p.setMode (VoicePool<6>::Legato);
      p.noteOn (60, 1); p.noteOn (67, 1);
      CHECK (p.voices[0].gate == 1.0f && ! p.retriggerPending);              // no gate edge
      CHECK (std::abs (p.voices[0].freq - VoicePool<6>::midiToFreq (67)) < 0.01f);
      p.noteOff (60); CHECK (p.voices[0].gate == 1.0f && p.voices[0].note == 67); // released held-under note
      p.noteOff (67); CHECK (p.voices[0].gate == 0.0f); }
    { VoicePool<6> p; p.noteOn (60, 1); p.setMode (VoicePool<6>::Mono);
      CHECK (p.voices[0].gate == 0.0f); }                                    // mode switch silences
    std::printf (fails ? "voices-test FAILED\n" : "voices-test: all passed\n");
    return fails;
}
