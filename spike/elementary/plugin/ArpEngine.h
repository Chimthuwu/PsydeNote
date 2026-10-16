#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>

// ---------------------------------------------------------------------------
// Native arpeggiator + step sequencer (docs/ARP-SEQ-CONTRACT.md sections 1+2,
// docs/ARP-SEQ-PLAN.md section 3). Runs on the AUDIO thread inside
// processBlock: steps and gate-offs land on exact sample offsets and go
// straight into the MidiBuffer that handleMidi() feeds to the VoicePool.
// No allocation in process(): fixed-size arrays only.
//
// PUBLIC API (for the glue in PluginProcessor)
//   ArpConfig::fromJson (json, cfg)          parse JSON.stringify(synth.arp) (also the OLD shape)
//   ArpEngine::process (in, out, numSamples, sr, cfg, transport, mod)
//        in  = host + UI MIDI, out = result (cleared first). Pass-through when !cfg.on.
//        mod = 9 values from the ctlout bank (one block old); see kArpMods.
//   side channels, valid for the notes of the `out` buffer of the SAME block (the arrays are
//   zeroed at the top of each process() call; notes that did not come from the arp stay 0):
//        slideMsForNote[note]  slide ms for the note-on just emitted for that MIDI note
//        tightForNote[note]    1 = note-on came from the arp/seq with cfg.tightRelease on
//   atomics: playhead (global step position, -1 when off), barCount (bars since the arp started)
//   readOverlay (snapshot)  lock-free; message thread; true only when the overlay changed
//   reset()                 call from prepareToPlay (not while processing)
//
// Behavioural notes
//   * Arp mode lanes: on/prob/octave/slide always apply; velocity = midiVel * lerp(1, velLane, velocityPct);
//   * ARP-MODE step lanes (4 of them, all optional and all neutral by default):
//     stepTranspose[pos] adds semitones; stepShorten[pos] SHORTENS the note as 1/(1+v) on top of
//     cfg.gate (length itself is the Gate KNOB's job); stepVel[pos] multiplies the note's velocity
//     (1 = the held note's own, so an untouched lane is a no-op); stepSlide[pos] adds glide ms.
//     gate = cfg.gate * (useStepLanes ? 1/(1+stepShorten[pos]) : 1) * (1 + mod[2]).
//     They are gated only by useStepLanes, which the normalizer now always sets — the flag used to
//     default false with no writer anywhere, so every painted lane was discarded (see the field note).
//   * The pitch lane is Seq-mode only.
//   * Chord layers are Arp-mode only. If an arp note-on collides with a MIDI note the chord layer is
//     already sustaining, the arp note is skipped (the chord note keeps ringing).
//   * Lane rotation r > 0 shifts the lane left (step index r plays first).
//   * Rolling the 'on' lane writes the PROB overlay (dice moves probability, never flips steps).
// ---------------------------------------------------------------------------

constexpr int kArpMods = 9;   // [0] rate (octaves) [1] swing (pts) [2] gate (x(1+v)) [3] transpose (st) [4] velocityPct (add) [5] random (add) [6] octaves (add) [7] pattern (add, 0..1) [8] chaos (add, 0..1)

/** The four CONTINUOUS arp parameters that carry their own dice amount, in the
 *  order the rainbow dice rows show them. These are knobs, not sequencer lanes:
 *  each has ONE amount (no per-step lock array), and the draw is live, once per
 *  step. Indices are shared with the JS/manifest mirrors — see `KNOB_DICE_TARGETS`
 *  in `dsp/synth.js` and `seqKnobDice` in `src/shared/types.ts`. Changing the
 *  order here without changing those breaks host automation silently. */
constexpr int kKnobDice = 5;
enum KnobDice
{
    kDiceRate    = 0,
    kDiceOctaves = 1,
    kDiceSwing   = 2,
    kDicePattern = 3,
    kDiceGate    = 4,
};

struct ArpTransport
{
    double bpm = 120.0;
    double ppq = 0.0;
    bool playing = false;
    bool ppqValid = false;
};

struct ArpConfig
{
    static constexpr int kSteps = 16;
    static constexpr int kLanes = 7;
    enum LaneId { LOn = 0, LProb, LPitch, LOctave, LVel, LGate, LSlide };   // == LANE_IDS order
    // 18 patterns. `Poly` was REMOVED (it was the one mode that fired the whole
    // chord at once rather than picking an index, so it was really a chord mode
    // wearing a pattern's clothes); saved presets migrate poly -> up in
    // types.ts's normaliser. SkipUp / RepeatUp / Walk are appended. Order here
    // is the UI's display order and the pattern slider's 0..1 mapping.
    enum Mode { Up = 0, Down, UpDown, UpDownExcl, DownUp, Random, AsPlayed,
                ConvergeUp, ConvergeDown, DivergeUp, DivergeDown,
                ThumbUp, ThumbDown, PinkyUp, PinkyDown,
                SkipUp, RepeatUp, Walk, kNumModes };
    enum Dir { Fwd = 0, Bwd, Bounce, BounceExcl, RandomDir, RandomNoRepeat, Drunk, Converge, Diverge };

    static constexpr float kLaneDefault[kLanes] = { 1.0f, 1.0f, 0.0f, 0.0f, 0.8f, 0.6f, 0.0f };
    static constexpr double kDivBeats[6] = { 4.0, 2.0, 1.0, 0.5, 0.25, 0.125 };   // 1/1 .. 1/32

    struct LaneCfg
    {
        std::array<float, kSteps> base {};
        float amount = 0.0f;
        int length = 16;
        int div = 1;
        int rotation = 0;
        std::array<bool, kSteps> locked {};
        int64_t rollToken = 0;
        /** Dice direction: 0 = roll down only, 1 = either way (default), 2 = roll up only. */
        int polarity = 1;
    };

    // --- top level ---
    bool  on = false;
    int   mode = Up;
    bool  hold = false;
    int   octaves = 1;
    bool  rateSync = true;
    int   rateDiv = 4;           // index into kDivBeats (4 = 1/16)
    int   rateFeel = 0;          // 0 straight 1 triplet 2 dotted
    float rateHz = 8.0f;
    float swing = 50.0f;
    float gate = 0.6f;
    float velocityPct = 0.5f;
    bool  keySnap = false;
    int   keyRoot = 0;
    int   scale = 0;

    /** Row 1 (blue) has its own clock and knobs. Row 0 (green) uses the top-level
     *  Rate/Oct/Swing/Gate and `generation.chaosAmount` above. `enabled` is set when
     *  the JSON carries a `blue` object; without it row 1 is silent, as before. */
    struct BlueRow
    {
        bool  enabled = false;
        int   mode = Up;             // the blue row's own pattern (Mode index: Up = lowest, Walk = highest)
        bool  rateSync = true;
        int   rateDiv = 4;
        int   rateFeel = 0;
        float rateHz = 8.0f;
        int   octaves = 1;
        float swing = 50.0f;
        float gate = 0.6f;
        float chaosAmount = 1.0f;
        std::array<float, kKnobDice> knobDice {};
        std::array<float, kKnobDice> knobDiceBipolar { { 1.0f, 1.0f, 1.0f, 1.0f, 1.0f } };
    };
    BlueRow blue;

    /** `cfg` with the blue row's knobs in place of the top-level ones. Pattern dice stay
     *  global: the pattern is one selector for both rows. */
    static ArpConfig forBlue (const ArpConfig& cfg)
    {
        ArpConfig b = cfg;
        const BlueRow& k = cfg.blue;
        // The pattern is chosen from patternPos (see effMode), so the blue pattern goes in there the same way
        // the default does (parse sets patternPos = mode / (kNumModes - 1)). The host selector is green's only.
        b.mode = k.mode;
        b.patternPos = (float) k.mode / (float) juce::jmax (1, kNumModes - 1);
        b.rateSync = k.rateSync; b.rateDiv = k.rateDiv; b.rateFeel = k.rateFeel; b.rateHz = k.rateHz;
        b.octaves = k.octaves; b.swing = k.swing; b.gate = k.gate; b.chaosAmount = k.chaosAmount;
        b.knobDice = k.knobDice; b.knobDiceBipolar = k.knobDiceBipolar;
        b.knobDice[(size_t) kDicePattern] = cfg.knobDice[(size_t) kDicePattern];
        b.knobDiceBipolar[(size_t) kDicePattern] = cfg.knobDiceBipolar[(size_t) kDicePattern];
        return b;
    }

    // --- seq ---
    int   direction = Fwd;
    int   seqLength = 8;
    bool  polymetry = true;
    int   resetAfter = 0;
    int   pitchTranspose = 0;
    std::array<LaneCfg, kLanes> lanes {};

    // --- arp extras ---
    bool  useStepLanes = false;
    std::array<int, kSteps>   stepTranspose {};
    /** How much SHORTER than the Gate knob each step plays: 0 = the knob's
     *  length, 1 = half, 4 = a fifth. Applied as `1 / (1 + value)`, so the
     *  stored 0..4 is the displayed "shorten %" and the Gate KNOB keeps sole
     *  ownership of note LENGTH (still 0.05..4). Splitting them is what makes the
     *  lane read bottom-up as "shorten this step" without duplicating the knob.
     *
     *  REPLACED `stepGate` (16 x 0.05..4, higher = longer), which duplicated the
     *  knob above it. Still parsed, for patches written by an older build — see
     *  the migration note in src/shared/types.ts. */
    std::array<float, kSteps> stepShorten {};
    /** Per-step velocity, 0..1. 1 = the held note's own velocity, so an
     *  untouched lane is a strict no-op on existing patches. */
    std::array<float, kSteps> stepVel {};
    /** Per-step portamento in ms, 0..1000. */
    std::array<float, kSteps> stepSlide {};
    /** Per-step randomness for the two ARP-MODE lanes (transpose, gate). These
     *  are NOT the Seq lane dice (`cfg.lanes[L*].amount`) — those belong to the
     *  sequencer view, this is the arp detail view's own pair. Index 0 =
     *  transpose, 1 = gate, matching `LANE_DICE_COUNT` in src/shared/types.ts.
     *
     *  This field was declared and written by the UI for a long time and READ by
     *  nothing, so the transpose/gate dice in the arp detail panel were a pair
     *  of decorative sliders: the die face animated, the value persisted, and
     *  the arp did not move. A control that looks alive and isn't is worse than
     *  an absent one, so the dice is applied at the seam that consumes each
     *  value — the per-step draw in runStep, not here at parse time. */
    std::array<float, 2> laneDice {};
    /** Direction flag per lane dice, index-matched to `laneDice`.
     *  1 = bipolar (the draw may go either way), 0 = one-way toward the floor.
     *  Default 1 is the behaviour-preserving choice: a one-way dice on a fresh
     *  patch would be a surprise the user did not ask for. */
    std::array<float, 2> laneDiceBipolar {};
    std::array<bool, 5> layerChord {};
    std::array<std::array<bool, 5>, 2> layerArp {};
    bool  tightRelease = true;
    /** Seq mode: true = every held note on every step (the stab sound). false = one note per step. */
    bool  chordHit = false;
    float humanize = 0.0f;
    float shape = 0.0f;

    // --- generation ---
    /** Chaos master (host param `arp_chaos`, mod target seqChaos): scales EVERY
     *  lane's dice amount. 1 = the lanes' own amounts, 0 = dice fully disabled.
     *  Applied in effAmount(), so it covers rolls, regen and live chaos alike. */
    float   chaosAmount = 1.0f;
    /** Pattern-selector position 0..1 (host param `arp_pattern`). The processor
     *  overlays this onto `mode` every block, so the slider, the pattern grid and
     *  host automation cannot disagree — see PluginProcessor's applyArpParams. */
    float   patternPos = 0.0f;
    float   autoRegen = 0.0f;    // bars
    bool    chaosLive = false;
    uint32_t seed = 1;
    int64_t regenToken = 0, clearToken = 0;

    // --- per-knob dice (the "rainbow dice rows") --------------------------
    /** Four CONTINUOUS arp parameters get their own dice amount, drawn once per
     *  step. This is a different mechanism from lane dice on purpose: a lane is
     *  a 16-step overlay the user can lock per step, whereas rate/octaves/
     *  swing/pattern are single knobs, so there is no per-step array to lock —
     *  only an amount, and the draw is live.
     *
     *  Order matches `kKnobDice`: rate, octaves, swing, pattern. Each amount is
     *  scaled by the SAME chaos master as the lanes (see `knobAmount()`), so the
     *  Chaos knob still means "no randomness anywhere" at 0 — one control for
     *  all randomness, rather than a second dial the user has to find.
     *
     *  A fresh draw per step is what makes this read as a groove rather than a
     *  single static offset: the rate genuinely wanders step to step. */
    std::array<float, kKnobDice> knobDice {};
    /** Per-knob dice DIRECTION: 1 = bipolar (draw either way), 0 = one-way.
     *  Index-matched to `knobDice` (the `KnobDice` enum). Read by
     *  `signedDraw()`; see the note there for why pattern ignores it. */
    std::array<float, kKnobDice> knobDiceBipolar {};

    /** A knob's effective dice amount: its own amount, scaled by the chaos
     *  master, clamped. Shares the chaos semantics with `effAmount()` on
     *  purpose — Chaos at 0 disables knob dice exactly as it disables lane
     *  dice. Written as one function so the two can't drift apart. */
    static float knobAmount (const ArpConfig& cfg, int k)
    {
        if (k < 0 || k >= kKnobDice) return 0.0f;
        // Plain comparisons rather than `clampf` — that helper is a static
        // member of ArpEngine, declared ~380 lines below this struct, so it is
        // not in scope inside ArpConfig. (Using it here fails to compile:
        // `error C3861: 'clampf': identifier not found`.)
        const float chaos = cfg.chaosAmount < 0.0f ? 0.0f : (cfg.chaosAmount > 1.0f ? 1.0f : cfg.chaosAmount);
        const float raw = cfg.knobDice[(size_t) k] * chaos;
        return raw < 0.0f ? 0.0f : (raw > 1.0f ? 1.0f : raw);
    }

    /** One signed random deviate in [-1, 1], shaped by knob `k`'s direction.
     *
     *  BIPOLAR (both flags on) is the plain symmetric draw in [-1, 1]. One-way
     *  is the HALF of it on a chosen side — [-1, 0] or [0, 1] — so the knob
     *  can only move one way but still moves smoothly across the whole range.
     *  Squaring the bipolar draw instead would concentrate it near zero and
     *  make "randomise" sound like a subtle wobble rather than a real wander.
     *
     *  The side for a one-way dice is derived from the KNOB, not drawn: rate
     *  goes one way on odd steps and the other on even ones, so a one-way
     *  "faster" dice alternates and reads as a groove instead of a drift that
     *  immediately pins against the clamp. `u()` is passed in rather than
     *  pulled from the engine's PRNG so `ArpConfig` stays a plain data struct
     *  with no RNG access.
     *
     *  `kDicePattern` ignores direction entirely: pattern is a discrete index,
     *  not an ordered axis, so "only positive" has no meaning for it. The flag
     *  is still stored so the UI can be uniform and the indices can't shift. */
    static float signedDraw (const ArpConfig& cfg, int k, float u, bool positiveOneWay)
    {
        const float bipolar = (k >= 0 && k < kKnobDice) ? cfg.knobDiceBipolar[(size_t) k] >= 0.5f : true;
        const float sym = u * 2.0f - 1.0f;
        if (bipolar) return sym;
        // One-way: take the half on the requested side, then restore full scale
        // so a one-way dice at 100 % reaches exactly as far as a bipolar one.
        const float half = positiveOneWay ? u : (1.0f - u);
        return (half * 2.0f - 1.0f) * 0.5f;
    }

    /** A LANE dice's effective amount: its own amount scaled by the chaos
     *  master, exactly like `knobAmount` does for the knob dice. Deliberately
     *  written as its own function rather than reusing `knobAmount`, because the
     *  two live in DIFFERENT arrays with different widths — `knobDice` is
     *  `kKnobDice` (5) wide and `laneDice` is 2. Folding them into one indexed
     *  helper is how a count mismatch reads past the end of an array.
     *
     *  Chaos must gate these too: "Chaos 0 % = no randomness anywhere" is only
     *  true while every dice goes through a chaos-scaled amount. */
    static float knobAmountLane (const ArpConfig& cfg, int k)
    {
        if (k < 0 || k >= 2) return 0.0f;
        const float chaos = cfg.chaosAmount < 0.0f ? 0.0f : (cfg.chaosAmount > 1.0f ? 1.0f : cfg.chaosAmount);
        const float raw = cfg.laneDice[(size_t) k] * chaos;
        return raw < 0.0f ? 0.0f : (raw > 1.0f ? 1.0f : raw);
    }

    /** `signedDraw` for the lane dice — same bipolar/one-way semantics, read
     *  from `laneDiceBipolar` instead of `knobDiceBipolar`. */
    static float signedDrawLane (const ArpConfig& cfg, int k, float u, bool positiveOneWay)
    {
        const float bipolar = (k >= 0 && k < 2) ? cfg.laneDiceBipolar[(size_t) k] >= 0.5f : true;
        if (bipolar) return u * 2.0f - 1.0f;
        const float half = positiveOneWay ? u : (1.0f - u);
        return (half * 2.0f - 1.0f) * 0.5f;
    }

    // --- scale weights ---
    std::array<float, 12> scaleWeights {};
    bool  scaleSnap = false;

    ArpConfig()
    {
        for (int L = 0; L < kLanes; ++L) lanes[(size_t) L].base.fill (kLaneDefault[L]);
        // Every ARP-MODE step lane defaults to NEUTRAL: shorten 0 (play at the
        // Gate knob's length), velocity 1 (play at the held note's own), slide 0
        // (no glide). Anything else would alter every existing song on load with
        // no visible cause.
        stepShorten.fill (0.0f);
        stepVel.fill (1.0f);
        stepSlide.fill (0.0f);
        scaleWeights.fill (1.0f);
        layerArp[0][2] = true;
    }

    /** Pitch-class bitmask (relative to the key root) of a scale, same order as SCALES in src/shared/scales.ts. */
    static unsigned scaleMask (int idx)
    {
        static constexpr int iv[10][8] = {
            { 0, 2, 4, 5, 7, 9, 11, -1 }, { 0, 2, 3, 5, 7, 8, 10, -1 }, { 0, 2, 3, 5, 7, 8, 11, -1 },
            { 0, 2, 3, 5, 7, 9, 10, -1 }, { 0, 1, 3, 5, 7, 8, 10, -1 }, { 0, 2, 4, 6, 7, 9, 11, -1 },
            { 0, 2, 4, 5, 7, 9, 10, -1 }, { 0, 2, 4, 7, 9, -1, -1, -1 }, { 0, 3, 5, 7, 10, -1, -1, -1 },
            { 0, 3, 5, 6, 7, 10, -1, -1 } };
        unsigned m = 0;
        const int s = idx < 0 ? 0 : (idx > 9 ? 9 : idx);
        for (int i = 0; i < 8 && iv[s][i] >= 0; ++i) m |= (1u << iv[s][i]);
        return m;
    }

    static int scaleIndexFromId (const juce::String& id)
    {
        static const char* ids[] = { "major", "minor", "harmonicMinor", "dorian", "phrygian",
                                     "lydian", "mixolydian", "pentMajor", "pentMinor", "blues" };
        for (int i = 0; i < 10; ++i) if (id == ids[i]) return i;
        return 0;
    }

    static int modeFromId (const juce::String& id)
    {
        static const char* ids[kNumModes] = { "up", "down", "updown", "updownExcl", "downup", "random", "asPlayed",
                                              "convergeUp", "convergeDown", "divergeUp", "divergeDown",
                                              "thumbUp", "thumbDown", "pinkyUp", "pinkyDown",
                                              "skipUp", "repeatUp", "walk" };
        for (int i = 0; i < kNumModes; ++i) if (id == ids[i]) return i;
        return Up;
    }

    static int dirFromId (const juce::String& id)
    {
        static const char* ids[] = { "fwd", "bwd", "bounce", "bounceExcl", "random", "randomNoRepeat", "drunk", "converge", "diverge" };
        for (int i = 0; i < 9; ++i) if (id == ids[i]) return i;
        return Fwd;
    }

    static int divFromId (const juce::String& id)
    {
        static const char* ids[] = { "1/1", "1/2", "1/4", "1/8", "1/16", "1/32" };
        for (int i = 0; i < 6; ++i) if (id == ids[i]) return i;
        return 4;
    }

    static int laneDivValid (int d)
    {
        switch (d) { case 1: case 2: case 3: case 4: case 6: case 8: case 16: return d; default: return 1; }
    }

    // ---- JSON helpers ----
    static double num (const juce::var& x, double d)
    {
        return (x.isDouble() || x.isInt() || x.isInt64()) ? (double) x : d;
    }
    static bool flag (const juce::var& x, bool d)
    {
        return x.isBool() ? (bool) x : ((x.isInt() || x.isInt64() || x.isDouble()) ? ((double) x != 0.0) : d);
    }
    static void readNumArray (const juce::var& v, float* dst, int n, double lo, double hi)
    {
        if (auto* a = v.getArray())
            for (int i = 0; i < n && i < a->size(); ++i)
            {
                const auto& e = (*a)[i];
                if (e.isDouble() || e.isInt() || e.isInt64()) dst[i] = (float) juce::jlimit (lo, hi, (double) e);
                else if (e.isBool()) dst[i] = (bool) e ? 1.0f : 0.0f;
            }
    }
    static void readBoolArray (const juce::var& v, bool* dst, int n)
    {
        if (auto* a = v.getArray())
            for (int i = 0; i < n && i < a->size(); ++i)
            {
                const auto& e = (*a)[i];
                if (e.isBool()) dst[i] = (bool) e;
                else if (e.isInt() || e.isInt64() || e.isDouble()) dst[i] = ((double) e != 0.0);
            }
    }
    static void laneRange (int L, double& lo, double& hi)
    {
        switch (L)
        {
            case LPitch:  lo = -12.0; hi = 12.0; break;
            case LOctave: lo = -2.0;  hi = 2.0;  break;
            case LGate:   lo = 0.05;  hi = 4.0;  break;
            case LSlide:  lo = 0.0;   hi = 1000.0; break;
            default:      lo = 0.0;   hi = 1.0;  break;
        }
    }

    /** Parse the JSON the UI sends (a JSON.stringify of ArpSettings). Missing fields get defaults; the OLD shape is migrated. */
    static bool fromJson (const juce::String& text, ArpConfig& out)
    {
        const auto v = juce::JSON::parse (text);
        auto* o = v.getDynamicObject();
        if (o == nullptr) return false;

        ArpConfig c;
        c.on      = flag (o->getProperty ("on"), false);
        c.mode    = modeFromId (o->getProperty ("mode").toString());
        // Seed the selector from the parsed mode so any path that never writes the
        // `arp_pattern` host param (offline tests, the browser preview) still plays
        // the right pattern; the processor overwrites it when the param exists.
        c.patternPos = (float) c.mode / (float) juce::jmax (1, kNumModes - 1);
        c.hold    = flag (o->getProperty ("hold"), false);
        c.octaves = juce::jlimit (1, 4, (int) std::lround (num (o->getProperty ("octaves"), 1)));

        if (auto* ro = o->getProperty ("rate").getDynamicObject())
        {
            c.rateSync = flag (ro->getProperty ("sync"), true);
            c.rateDiv  = divFromId (ro->getProperty ("div").toString());
            const auto feel = ro->getProperty ("feel").toString();
            c.rateFeel = feel == "triplet" ? 1 : (feel == "dotted" ? 2 : 0);
            c.rateHz   = (float) juce::jlimit (0.5, 40.0, num (ro->getProperty ("hz"), 8.0));
        }
        else if (o->hasProperty ("rateHz"))   // old shape
        {
            c.rateSync = false;
            c.rateHz = (float) juce::jlimit (0.5, 40.0, num (o->getProperty ("rateHz"), 8.0));
        }

        c.swing       = (float) juce::jlimit (50.0, 75.0, num (o->getProperty ("swing"), 50.0));
        c.gate        = (float) juce::jlimit (0.05, 4.0, num (o->getProperty ("gate"), 0.6));
        c.velocityPct = (float) juce::jlimit (0.0, 1.0, num (o->getProperty ("velocityPct"), 0.5));
        c.keySnap     = flag (o->getProperty ("keySnap"), false);
        c.keyRoot     = ((int) num (o->getProperty ("keyRoot"), 0) % 12 + 12) % 12;
        c.scale       = scaleIndexFromId (o->getProperty ("keyScale").toString());

        // --- seq ---
        if (auto* so = o->getProperty ("seq").getDynamicObject())
        {
            c.direction  = dirFromId (so->getProperty ("direction").toString());
            const double lenDefault = num (so->getProperty ("steps"), 8.0);     // old shape fallback
            c.seqLength  = juce::jlimit (1, kSteps, (int) std::lround (num (so->getProperty ("length"), lenDefault)));
            c.polymetry  = flag (so->getProperty ("polymetry"), true);
            c.resetAfter = juce::jlimit (0, 4096, (int) std::lround (num (so->getProperty ("resetAfter"), 0.0)));
            c.pitchTranspose = juce::jlimit (-24, 24, (int) std::lround (num (so->getProperty ("pitchTranspose"), 0.0)));

            const auto lv = so->getProperty ("lanes");
            if (auto* lo = lv.getDynamicObject())
            {
                static const char* ids[kLanes] = { "on", "prob", "pitch", "octave", "vel", "gate", "slide" };
                for (int L = 0; L < kLanes; ++L)
                {
                    auto* l = lo->getProperty (ids[L]).getDynamicObject();
                    if (l == nullptr) continue;
                    auto& lc = c.lanes[(size_t) L];
                    double rlo, rhi; laneRange (L, rlo, rhi);
                    readNumArray (l->getProperty ("base"), lc.base.data(), kSteps, rlo, rhi);
                    lc.amount   = (float) juce::jlimit (0.0, 1.0, num (l->getProperty ("amount"), 0.0));
                    lc.length   = juce::jlimit (1, kSteps, (int) std::lround (num (l->getProperty ("length"), 16.0)));
                    lc.div      = laneDivValid ((int) std::lround (num (l->getProperty ("div"), 1.0)));
                    lc.rotation = juce::jlimit (-64, 64, (int) std::lround (num (l->getProperty ("rotation"), 0.0)));
                    readBoolArray (l->getProperty ("locked"), lc.locked.data(), kSteps);
                    lc.rollToken = (int64_t) num (l->getProperty ("rollToken"), 0.0);
                    {
                        const juce::String pol = l->getProperty ("dicePolarity").toString();
                        lc.polarity = pol == "neg" ? 0 : (pol == "pos" ? 2 : 1);
                    }
                }
            }
            else if (auto* arr = lv.getArray())   // OLD shape: lanes[] of {on, velocity, gate, octave, semitone}
            {
                for (int i = 0; i < kSteps && i < arr->size(); ++i)
                    if (auto* s = (*arr)[i].getDynamicObject())
                    {
                        c.lanes[LOn].base[(size_t) i]     = flag (s->getProperty ("on"), true) ? 1.0f : 0.0f;
                        c.lanes[LVel].base[(size_t) i]    = (float) juce::jlimit (0.0, 1.0, num (s->getProperty ("velocity"), 0.9));
                        c.lanes[LGate].base[(size_t) i]   = (float) juce::jlimit (0.05, 4.0, num (s->getProperty ("gate"), 0.6));
                        c.lanes[LOctave].base[(size_t) i] = (float) juce::jlimit (-2, 2, (int) std::lround (num (s->getProperty ("octave"), 0.0)));
                        c.lanes[LPitch].base[(size_t) i]  = (float) juce::jlimit (-12, 12, (int) std::lround (num (s->getProperty ("semitone"), 0.0)));
                    }
            }
        }

        // --- arp extras ---
        if (auto* ao = o->getProperty ("arp").getDynamicObject())
        {
            c.useStepLanes = flag (ao->getProperty ("useStepLanes"), false);
            std::array<float, kSteps> tmp {};
            tmp.fill (0.0f);
            readNumArray (ao->getProperty ("stepTranspose"), tmp.data(), kSteps, -12.0, 12.0);
            for (int i = 0; i < kSteps; ++i) c.stepTranspose[(size_t) i] = (int) std::lround (tmp[(size_t) i]);
            readNumArray (ao->getProperty ("stepShorten"), c.stepShorten.data(), kSteps, 0.0, 4.0);
            readNumArray (ao->getProperty ("stepVel"), c.stepVel.data(), kSteps, 0.0, 1.0);
            readNumArray (ao->getProperty ("stepSlide"), c.stepSlide.data(), kSteps, 0.0, 1000.0);
            // LEGACY `stepGate`: an older patch stored a per-step note LENGTH
            // (0.05..4, higher = longer, default 0.6) where the new field holds a
            // SHORTEN amount. Convert rather than copy, or every saved song would
            // load with its notes stretched: the old ratio R becomes
            // `0.6 / (1 + shorten)`, i.e. `shorten = 0.6 / R - 1`. A step that
            // was already longer than the 0.6 baseline maps negative and clamps
            // to 0 (the Gate KNOB is the control for length from here).
            // Only consulted when `stepShorten` is absent, so a patch written by
            // this build is never re-converted — reading it unconditionally
            // would overwrite the new field with the old meaning on every load.
            if (! ao->hasProperty ("stepShorten"))
            {
                std::array<float, kSteps> legacy {};
                legacy.fill (-1.0f);
                readNumArray (ao->getProperty ("stepGate"), legacy.data(), kSteps, 0.05, 4.0);
                for (int i = 0; i < kSteps; ++i)
                    if (legacy[(size_t) i] > 0.0f)
                        c.stepShorten[(size_t) i] = juce::jlimit (0.0f, 4.0f, 0.6f / legacy[(size_t) i] - 1.0f);
            }
            // Lane dice + direction, rebuilt to FULL width (2) so an older preset
            // without the field still yields a full array — indexing a short one
            // would read out of bounds, and a stale buffer would carry the
            // previous patch's randomness into this one.
            {
                float tmpDice[2] = { 0.0f, 0.0f };
                float tmpDir[2] = { 1.0f, 1.0f };
                readNumArray (ao->getProperty ("laneDice"), tmpDice, 2, 0.0, 1.0);
                readNumArray (ao->getProperty ("laneDiceBipolar"), tmpDir, 2, 0.0, 1.0);
                for (int k = 0; k < 2; ++k)
                {
                    c.laneDice[(size_t) k] = tmpDice[k];
                    c.laneDiceBipolar[(size_t) k] = tmpDir[k];
                }
            }
            c.tightRelease = flag (ao->getProperty ("tightRelease"), true);
            c.chordHit = flag (ao->getProperty ("chordHit"), false);
            c.humanize = (float) juce::jlimit (0.0, 1.0, num (ao->getProperty ("humanize"), 0.0));
            c.shape    = (float) juce::jlimit (-1.0, 1.0, num (ao->getProperty ("shape"), 0.0));
            if (auto* lyr = ao->getProperty ("layers").getDynamicObject())
            {
                if (lyr->getProperty ("chord").getArray() != nullptr)
                {
                    c.layerChord.fill (false);
                    readBoolArray (lyr->getProperty ("chord"), c.layerChord.data(), 5);
                }
                if (auto* rows = lyr->getProperty ("arp").getArray())
                {
                    for (auto& r : c.layerArp) r.fill (false);
                    for (int r = 0; r < 2 && r < rows->size(); ++r)
                        readBoolArray ((*rows)[r], c.layerArp[(size_t) r].data(), 5);
                }
            }
        }

        // --- blue row (row 1): its own rate, octaves, swing, gate, chaos and dice ---
        if (auto* bo = o->getProperty ("blue").getDynamicObject())
        {
            ArpConfig::BlueRow& b = c.blue;
            b.enabled = true;
            b.mode = modeFromId (bo->getProperty ("pattern").toString());
            if (auto* ro = bo->getProperty ("rate").getDynamicObject())
            {
                b.rateSync = flag (ro->getProperty ("sync"), true);
                b.rateDiv  = divFromId (ro->getProperty ("div").toString());
                const auto feel = ro->getProperty ("feel").toString();
                b.rateFeel = feel == "triplet" ? 1 : (feel == "dotted" ? 2 : 0);
                b.rateHz   = (float) juce::jlimit (0.5, 40.0, num (ro->getProperty ("hz"), 8.0));
            }
            b.octaves     = juce::jlimit (1, 4, (int) std::lround (num (bo->getProperty ("octaves"), 1)));
            b.swing       = (float) juce::jlimit (50.0, 75.0, num (bo->getProperty ("swing"), 50.0));
            b.gate        = (float) juce::jlimit (0.05, 4.0, num (bo->getProperty ("gate"), 0.6));
            b.chaosAmount = (float) juce::jlimit (0.0, 1.0, num (bo->getProperty ("chaosAmount"), 1.0));
            float tmpB[kKnobDice];
            readNumArray (bo->getProperty ("knobDice"), tmpB, kKnobDice, 0.0, 1.0);
            for (int k = 0; k < kKnobDice; ++k) b.knobDice[(size_t) k] = tmpB[k];
            readNumArray (bo->getProperty ("knobDiceBipolar"), tmpB, kKnobDice, 0.0, 1.0);
            for (int k = 0; k < kKnobDice; ++k) b.knobDiceBipolar[(size_t) k] = tmpB[k];
        }

        // --- generation ---
        if (auto* go = o->getProperty ("generation").getDynamicObject())
        {
            c.autoRegen  = (float) juce::jlimit (0.0, 64.0, num (go->getProperty ("autoRegen"), 0.0));
            c.chaosLive  = go->getProperty ("chaos").toString() == "live";
            c.chaosAmount = (float) juce::jlimit (0.0, 1.0, num (go->getProperty ("chaosAmount"), 1.0));
            // Per-knob dice (rate/octaves/swing/pattern). Read into a fixed-width
            // buffer and copied across by KNOB_DICE_COUNT, so a short array in a
            // patch leaves the rest at 0 (feature off) rather than leaving stale
            // values from the previous patch — the same "rebuild to full width"
            // rule the lanes follow.
            {
                float tmp[kKnobDice];
                readNumArray (go->getProperty ("knobDice"), tmp, kKnobDice, 0.0, 1.0);
                for (int k = 0; k < kKnobDice; ++k) c.knobDice[(size_t) k] = tmp[k];
                // Direction flags. The default is BIPOLAR (1.0), matching the UI
                // normalizer: a patch saved before this field had no direction
                // concept, and defaulting to one-way would silently change how an
                // existing song's dice behave.
                readNumArray (go->getProperty ("knobDiceBipolar"), tmp, kKnobDice, 0.0, 1.0);
                for (int k = 0; k < kKnobDice; ++k) c.knobDiceBipolar[(size_t) k] = tmp[k];
            }
            const auto s = (int64_t) num (go->getProperty ("seed"), 1.0);
            c.seed       = (uint32_t) s == 0 ? 1u : (uint32_t) s;
            c.regenToken = (int64_t) num (go->getProperty ("regenToken"), 0.0);
            c.clearToken = (int64_t) num (go->getProperty ("clearToken"), 0.0);
        }

        // --- scale ---
        if (auto* sc = o->getProperty ("scale").getDynamicObject())
        {
            readNumArray (sc->getProperty ("weights"), c.scaleWeights.data(), 12, 0.0, 1.0);
            c.scaleSnap = flag (sc->getProperty ("snap"), false);
        }

        out = c;
        return true;
    }
};

class ArpEngine
{
public:
    struct OverlaySnapshot { bool has[7][16]; float v[7][16]; uint32_t rev = 0; };

    /** Playhead for the UI: global step position (direction applied), -1 when off/idle. */
    std::atomic<int> playhead { -1 };
    /** Completed bars since the arp started. */
    std::atomic<int> barCount { 0 };
    /** Per MIDI note: slide ms / tight flag for the note-on emitted in the current block. */
    std::array<float, 128> slideMsForNote {};
    std::array<uint8_t, 128> tightForNote {};

    ArpEngine() { reset(); }

    void reset()
    {
        nHeld = 0; nFrozen = 0;
        kind.fill (0); offAt.fill (-1); onAt.fill (-1);
        slideMsForNote.fill (0.0f); tightForNote.fill (0);
        active = false; nextValidR[0] = nextValidR[1] = false; prevOn = false; prevMode = -1;
        g = 0; rowCnt[0] = rowCnt[1] = 0; walkPos = 0; rngWalk = 0x6C078965u; clock = 0; internalBeats = 0.0; barBase = 0;
        slotValid = false; prevHostDomain = false; tokInit = false;
        for (auto& s : stValid) s = false;
        clearOverlays();
        playhead.store (-1);
        barCount.store (0);
    }

    /** Transform one block. */
    void process (const juce::MidiBuffer& in, juce::MidiBuffer& out, int numSamples, double sr,
                  const ArpConfig& cfg, const ArpTransport& tr, const std::array<float, kArpMods>& mod)
    {
        processInner (in, out, numSamples, sr, cfg, tr, mod);
        if (ovDirty) { publishOverlay(); ovDirty = false; }
    }

    /** Message thread. Returns true and fills dst when the overlay changed since the last call. */
    bool readOverlay (OverlaySnapshot& dst)
    {
        if (ovPubRev.load (std::memory_order_acquire) == lastReadRev) return false;
        for (int attempt = 0; attempt < 16; ++attempt)
        {
            const uint32_t s1 = ovSeq.load (std::memory_order_acquire);
            if (s1 & 1u) continue;
            for (int L = 0; L < 7; ++L)
                for (int j = 0; j < 16; ++j)
                {
                    dst.has[L][j] = pubHas[L][j].load (std::memory_order_relaxed) != 0;
                    const uint32_t b = pubBits[L][j].load (std::memory_order_relaxed);
                    float f; std::memcpy (&f, &b, sizeof (f));
                    dst.v[L][j] = f;
                }
            const uint32_t rev = ovPubRev.load (std::memory_order_relaxed);
            std::atomic_thread_fence (std::memory_order_acquire);
            if (ovSeq.load (std::memory_order_relaxed) == s1)
            {
                dst.rev = rev;
                lastReadRev = rev;
                return true;
            }
        }
        return false;
    }

private:
    struct Held { int note = 0; float vel = 0.8f; };
    struct PoolEntry { int note = 0; float vel = 0.8f; };

    // held keys
    std::array<Held, 32> held {};
    int nHeld = 0;
    std::array<Held, 32> frozen {};
    int nFrozen = 0;

    // sounding notes we generated: kind 0 none, 1 arp (timed), 2 chord layer (sustained)
    std::array<uint8_t, 128> kind {};
    std::array<int64_t, 128> offAt {};
    std::array<int64_t, 128> onAt {};

    // clock / sequencing state
    int64_t clock = 0;
    bool active = false, prevOn = false;
    int prevMode = -1;
    // One clock per row: row 0 (green) and row 1 (blue) each step on their own grid.
    bool    nextValidR[2] = { false, false };
    double  nextNominalR[2] = { 0.0, 0.0 }, nextActualR[2] = { 0.0, 0.0 };
    int64_t gR[2] = { 0, 0 };         // per-row step counter (drives that row's lanes and swing parity)
    int64_t g = 0;                    // scratch: the due row's counter, set just before runStep
    int64_t rowCnt[2] = { 0, 0 };     // arp pattern position per row
    int walkPos = 0;                  // Walk pattern's current index (see patternIndex)
    uint32_t rngWalk = 0x6C078965u;   // its own stream, so Walk never disturbs the dice
    double internalBeats = 0.0;
    int barBase = 0;
    bool prevHostDomain = false;
    bool slotValid = false; int64_t lastSlot = 0; float lastBars = 0.0f;

    // per-slot (7 lanes + playhead) stateful direction
    bool stValid[8] = {};
    int64_t stCnt[8] = {};
    int stPos[8] = {};

    // PRNGs
    uint32_t rng = 1, rng2 = 0x9E3779B9u;
    bool tokInit = false;
    uint32_t seedLast = 1;
    int64_t lastRegen = 0, lastClear = 0, lastRoll[7] = {};

    // overlays (engine-owned)
    float ov[7][16] = {};
    bool ovHas[7][16] = {};
    bool ovDirty = true;
    std::atomic<uint32_t> ovSeq { 0 };
    std::atomic<uint32_t> ovPubRev { 0 };
    std::atomic<uint32_t> pubBits[7][16] {};
    std::atomic<uint8_t> pubHas[7][16] {};
    uint32_t lastReadRev = 0xFFFFFFFFu;

    // ---------------------------------------------------------------- utils
    static uint32_t xs (uint32_t& s)
    {
        if (s == 0) s = 1;
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        return s;
    }
    static float nextU (uint32_t& s) { return (float) (xs (s) >> 8) * (1.0f / 16777216.0f); }
    float u()  { return nextU (rng); }     // dice
    float ur() { return nextU (rng2); }    // performance randomness (prob, humanize, random pattern)

    static uint32_t hash32 (uint32_t x)
    {
        x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16;
        return x;
    }

    static float clampf (float x, float lo, float hi) { return x < lo ? lo : (x > hi ? hi : x); }

    void clearOverlays()
    {
        for (int L = 0; L < 7; ++L) for (int j = 0; j < 16; ++j) { ov[L][j] = 0.0f; ovHas[L][j] = false; }
        ovDirty = true;
    }

    void setOv (int L, int j, bool has, float val)
    {
        if (ovHas[L][j] != has || (has && ov[L][j] != val)) ovDirty = true;
        ovHas[L][j] = has;
        ov[L][j] = has ? val : 0.0f;
    }

    void publishOverlay()
    {
        const uint32_t s = ovSeq.load (std::memory_order_relaxed);
        ovSeq.store (s + 1, std::memory_order_relaxed);
        std::atomic_thread_fence (std::memory_order_release);
        for (int L = 0; L < 7; ++L)
            for (int j = 0; j < 16; ++j)
            {
                uint32_t b; const float f = ov[L][j]; std::memcpy (&b, &f, sizeof (b));
                pubBits[L][j].store (b, std::memory_order_relaxed);
                pubHas[L][j].store (ovHas[L][j] ? 1 : 0, std::memory_order_relaxed);
            }
        ovPubRev.store (ovPubRev.load (std::memory_order_relaxed) + 1, std::memory_order_relaxed);
        ovSeq.store (s + 2, std::memory_order_release);
    }

    // ---------------------------------------------------------------- held notes
    void addHeld (int note, float vel)
    {
        for (int i = 0; i < nHeld; ++i) if (held[(size_t) i].note == note) { held[(size_t) i].vel = vel; return; }
        if (nHeld < (int) held.size()) held[(size_t) nHeld++] = { note, vel };
    }
    void removeHeld (int note)
    {
        for (int i = 0; i < nHeld; ++i)
            if (held[(size_t) i].note == note)
            {
                for (int j = i; j + 1 < nHeld; ++j) held[(size_t) j] = held[(size_t) j + 1];
                --nHeld;
                return;
            }
    }

    // ---------------------------------------------------------------- note emission
    void emitOff (juce::MidiBuffer& out, int note, int pos)
    {
        out.addEvent (juce::MidiMessage::noteOff (1, note), pos);
        kind[(size_t) note] = 0; offAt[(size_t) note] = -1;
    }
    void killArp (juce::MidiBuffer& out, int pos)
    {
        for (int n = 0; n < 128; ++n) if (kind[(size_t) n] == 1) emitOff (out, n, pos);
    }
    void killAll (juce::MidiBuffer& out, int pos)
    {
        for (int n = 0; n < 128; ++n) if (kind[(size_t) n] != 0) emitOff (out, n, pos);
    }

    void reconcileChord (const ArpConfig& cfg, juce::MidiBuffer& out, int pos, const Held* ch, int nc)
    {
        bool want[128] = {};
        float wantVel[128];
        if (cfg.on && ch != nullptr)
            for (int b = 0; b < 5; ++b)
                if (cfg.layerChord[(size_t) b])
                    for (int i = 0; i < nc; ++i)
                    {
                        const int n = ch[i].note + 12 * (b - 2);
                        if (n < 0 || n > 127) continue;
                        want[n] = true; wantVel[n] = ch[i].vel;
                    }
        for (int n = 0; n < 128; ++n)
        {
            const uint8_t k = kind[(size_t) n];
            if (k == 2 && ! want[n]) emitOff (out, n, pos);
            else if (k == 0 && want[n])
            {
                out.addEvent (juce::MidiMessage::noteOn (1, n, juce::jlimit (0.02f, 1.0f, wantVel[n])), pos);
                kind[(size_t) n] = 2; offAt[(size_t) n] = -1; onAt[(size_t) n] = -1;
            }
        }
    }

    /** Emit a timed arp/seq note. Never double note-on: an off precedes a retrigger. */
    void trigger (const ArpConfig& cfg, juce::MidiBuffer& out, int note, float vel, int pos,
                  int64_t evTime, int64_t gateSamples, float slideMs)
    {
        if (note < 0 || note > 127) return;
        const uint8_t k = kind[(size_t) note];
        if (k == 2) return;                                    // chord layer already sustains it
        if (k == 1)
        {
            if (onAt[(size_t) note] == evTime) return;         // already triggered this very step
            out.addEvent (juce::MidiMessage::noteOff (1, note), pos);
        }
        out.addEvent (juce::MidiMessage::noteOn (1, note, juce::jlimit (0.02f, 1.0f, vel)), pos);
        kind[(size_t) note] = 1;
        onAt[(size_t) note] = evTime;
        offAt[(size_t) note] = evTime + gateSamples;
        slideMsForNote[(size_t) note] = slideMs;
        tightForNote[(size_t) note] = cfg.tightRelease ? 1 : 0;
    }

    // ---------------------------------------------------------------- scale
    static int snapToMask (int note, int root, unsigned mask)
    {
        if (mask == 0) return note;
        auto inMask = [&] (int n) { return ((mask >> (unsigned) (((n - root) % 12 + 12) % 12)) & 1u) != 0; };
        for (int d = 0; d <= 6; ++d)
        {
            if (inMask (note - d)) return note - d;
            if (inMask (note + d)) return note + d;
        }
        return note;
    }
    static int snapNote (int n, const ArpConfig& cfg)
    {
        if (cfg.keySnap) n = snapToMask (n, cfg.keyRoot, ArpConfig::scaleMask (cfg.scale));
        if (cfg.scaleSnap)
        {
            unsigned m = 0;
            for (int i = 0; i < 12; ++i) if (cfg.scaleWeights[(size_t) i] > 0.001f) m |= (1u << i);
            n = snapToMask (n, cfg.keyRoot, m);
        }
        return n;
    }

    // ---------------------------------------------------------------- dice
    /** A lane's EFFECTIVE dice amount: its own amount, plus whatever the Random
     *  mod route adds, all scaled by the Chaos master. Chaos at 0 returns 0 for
     *  every lane, which is what "0 % disables dice" means — rollStep bails on
     *  `amt <= 0`, so no overlay is written and the base pattern plays clean. */
    static float effAmount (const ArpConfig& cfg, int L, float modAdd)
    {
        const float chaos = clampf (cfg.chaosAmount, 0.0f, 1.0f);
        return clampf ((cfg.lanes[(size_t) L].amount + modAdd) * chaos, 0.0f, 1.0f);
    }

    /** Roll one step of one lane into the overlay. (LOn is folded into LProb.) */
    /** Signed draw in -1..1 for a lane's dice direction. u is uniform in 0..1. */
    static float laneSigned (int polarity, float u)
    {
        if (polarity == 0) return -u;
        if (polarity == 2) return u;
        return u * 2.0f - 1.0f;
    }

    void rollStep (const ArpConfig& cfg, int L, int j, float modAdd)
    {
        if (L == ArpConfig::LOn) L = ArpConfig::LProb;
        const auto& ln = cfg.lanes[(size_t) L];
        float amt = effAmount (cfg, L, modAdd);
        bool locked = ln.locked[(size_t) j];
        if (L == ArpConfig::LProb)
        {
            amt = std::max (amt, effAmount (cfg, ArpConfig::LOn, modAdd));
            locked = locked || cfg.lanes[ArpConfig::LOn].locked[(size_t) j];
        }
        if (locked) { setOv (L, j, false, 0.0f); return; }
        if (amt <= 0.0f) return;
        const float base = ln.base[(size_t) j];

        switch (L)
        {
            case ArpConfig::LVel:   setOv (L, j, true, clampf (base + laneSigned (ln.polarity, u()) * amt * 1.0f, 0.02f, 1.0f)); break;
            case ArpConfig::LProb:  setOv (L, j, true, clampf (base + laneSigned (ln.polarity, u()) * amt * 1.0f, 0.0f, 1.0f)); break;
            case ArpConfig::LGate:  setOv (L, j, true, clampf (base + laneSigned (ln.polarity, u()) * amt * 3.95f, 0.05f, 4.0f)); break;
            case ArpConfig::LSlide: setOv (L, j, true, clampf (base + laneSigned (ln.polarity, u()) * amt * 1000.0f, 0.0f, 1000.0f)); break;
            case ArpConfig::LOctave:
            {
                if (u() >= amt) { setOv (L, j, false, 0.0f); break; }
                const int K = std::max (1, (int) std::lround (amt * 2.0f));
                int k = 1 + std::min (K - 1, (int) (u() * (float) K));
                const float coin = u();
                if (ln.polarity == 0 || (ln.polarity == 1 && coin < 0.5f)) k = -k;
                const int b = (int) std::lround (base);
                setOv (L, j, true, (float) juce::jlimit (-2, 2, b + k));
                break;
            }
            case ArpConfig::LPitch:
            {
                if (u() >= amt) { setOv (L, j, false, 0.0f); break; }
                const int b = (int) std::lround (base);
                const int R = (int) std::lround (amt * 11.0f) + 1;
                int cand[25]; float w[25]; int nc = 0; float tot = 0.0f;
                for (int d = -R; d <= R && nc < 25; ++d)
                {
                    if ((ln.polarity == 0 && d > 0) || (ln.polarity == 2 && d < 0)) continue;
                    const int q = juce::jlimit (-12, 12, b + d);
                    const float wt = cfg.scaleWeights[(size_t) (((q % 12) + 12) % 12)];
                    if (wt <= 0.0f) continue;
                    cand[nc] = q; w[nc] = wt; tot += wt; ++nc;
                }
                if (nc == 0 || tot <= 0.0f) { setOv (L, j, false, 0.0f); break; }
                float pick = u() * tot;
                int chosen = cand[nc - 1];
                for (int i = 0; i < nc; ++i) { if (pick < w[i]) { chosen = cand[i]; break; } pick -= w[i]; }
                setOv (L, j, true, (float) chosen);
                break;
            }
            default: break;
        }
    }

    void rollLane (const ArpConfig& cfg, int L, float modAdd)
    {
        if (L == ArpConfig::LOn) L = ArpConfig::LProb;
        for (int j = 0; j < 16; ++j) rollStep (cfg, L, j, modAdd);
    }

    void regenAll (const ArpConfig& cfg, float modAdd)
    {
        const int order[6] = { ArpConfig::LPitch, ArpConfig::LOctave, ArpConfig::LVel,
                               ArpConfig::LGate, ArpConfig::LSlide, ArpConfig::LProb };
        for (int L : order)
        {
            float a = effAmount (cfg, L, modAdd);
            if (L == ArpConfig::LProb) a = std::max (a, effAmount (cfg, ArpConfig::LOn, modAdd));
            if (a > 0.0f) rollLane (cfg, L, modAdd);
        }
    }

    void handleTokens (const ArpConfig& cfg, float modAdd)
    {
        const uint32_t seed = cfg.seed == 0 ? 1u : cfg.seed;
        if (! tokInit)
        {
            tokInit = true;
            seedLast = seed; rng = seed; rng2 = (seed ^ 0x9E3779B9u) | 1u;
            lastRegen = cfg.regenToken; lastClear = cfg.clearToken;
            for (int L = 0; L < 7; ++L) lastRoll[L] = cfg.lanes[(size_t) L].rollToken;
            return;
        }
        if (seed != seedLast) { seedLast = seed; rng = seed; rng2 = (seed ^ 0x9E3779B9u) | 1u; }
        if (cfg.clearToken != lastClear) { lastClear = cfg.clearToken; clearOverlays(); }
        if (cfg.regenToken != lastRegen) { lastRegen = cfg.regenToken; regenAll (cfg, modAdd); }
        for (int L = 0; L < 7; ++L)
            if (cfg.lanes[(size_t) L].rollToken != lastRoll[L])
            {
                lastRoll[L] = cfg.lanes[(size_t) L].rollToken;
                rollLane (cfg, L, modAdd);
            }
    }

    // ---------------------------------------------------------------- positions / patterns
    /** Position (0..n-1) inside a lane of length n at counter cnt for the given direction. Random-ish
        directions are deterministic hashes of cnt (so lanes sharing div/length stay coherent). */
    int dirPos (int slot, int64_t cnt, int n, int dir, uint32_t salt)
    {
        if (n <= 1) return 0;
        if (cnt < 0) cnt = 0;
        switch (dir)
        {
            case ArpConfig::Bwd:    return n - 1 - (int) (cnt % n);
            case ArpConfig::Bounce: { const int p = (int) (cnt % (2 * n)); return p < n ? p : 2 * n - 1 - p; }
            case ArpConfig::BounceExcl: { const int per = 2 * n - 2; const int p = (int) (cnt % per); return p < n ? p : 2 * n - 2 - p; }
            case ArpConfig::Converge: { const int k = (int) (cnt % n); return (k & 1) ? n - 1 - k / 2 : k / 2; }
            case ArpConfig::Diverge:  { const int k = n - 1 - (int) (cnt % n); return (k & 1) ? n - 1 - k / 2 : k / 2; }
            case ArpConfig::RandomDir:
            case ArpConfig::RandomNoRepeat:
            case ArpConfig::Drunk:
            {
                auto raw = [&] (int64_t c) { return (int) (hash32 ((uint32_t) c * 2654435761u ^ salt) % (uint32_t) n); };
                auto stepFrom = [&] (int pos, int64_t c)
                {
                    if (dir == ArpConfig::RandomDir) return raw (c);
                    if (dir == ArpConfig::RandomNoRepeat)
                    {
                        int a = raw (c);
                        if (a == pos) a = (a + 1 + (int) (hash32 ((uint32_t) c ^ salt ^ 0x51ED27u) % (uint32_t) (n - 1))) % n;
                        return a;
                    }
                    const int d = (hash32 ((uint32_t) c * 40503u ^ salt) & 1u) ? 1 : -1;
                    int q = pos + d;
                    if (q < 0 || q >= n) q = pos - d;
                    return juce::jlimit (0, n - 1, q);
                };
                if (stValid[slot] && cnt == stCnt[slot]) return stPos[slot] % n;
                int pos;
                if (! stValid[slot] || cnt < stCnt[slot] || cnt - stCnt[slot] > 64)
                    pos = (dir == ArpConfig::Drunk && cnt == 0) ? 0 : raw (cnt);
                else
                {
                    pos = stPos[slot] % n;
                    for (int64_t c = stCnt[slot] + 1; c <= cnt; ++c) pos = stepFrom (pos, c);
                }
                stValid[slot] = true; stCnt[slot] = cnt; stPos[slot] = pos;
                return pos;
            }
            default: return (int) (cnt % n);   // Fwd
        }
    }

    static int convergeIdx (bool upFirst, int k, int n)
    {
        return upFirst ? ((k & 1) ? n - 1 - k / 2 : k / 2)
                       : ((k & 1) ? k / 2 : n - 1 - k / 2);
    }

    /** Index into a sorted pool of n notes for arp pattern `mode` at pattern counter c. */
    /** The pattern actually playing: the selector position (0..1) plus its mod
     *  route, quantised back to a mode index. `patternPos` is the authority, not
     *  `mode` — the processor writes it from the `arp_pattern` host param every
     *  block and the UI writes that param whenever a pattern tile is clicked, so
     *  the grid, the slider and host automation can never disagree. */
    static int effMode (const ArpConfig& cfg, float modAdd)
    {
        const float pos = clampf (cfg.patternPos + modAdd, 0.0f, 1.0f);
        return juce::jlimit (0, ArpConfig::kNumModes - 1,
                             (int) std::lround (pos * (float) (ArpConfig::kNumModes - 1)));
    }

    /** `effMode` with this step's pattern dice applied. `bias` is the raw random
     *  draw in 0..kNumModes-1 (0 when the dice didn't fire), so the diced step
     *  plays a genuinely different pattern rather than drifting between two
     *  adjacent ones. Kept separate from `effMode` so every undiced caller is
     *  untouched by the dice's existence. */
    static int effModeDice (const ArpConfig& cfg, float modAdd, float bias)
    {
        if (bias <= 0.0f) return effMode (cfg, modAdd);
        return juce::jlimit (0, ArpConfig::kNumModes - 1, (int) std::lround (bias));
    }

    int patternIndex (int mode, int64_t c, int n, uint32_t rnd)
    {
        if (n <= 1) return 0;
        switch (mode)
        {
            case ArpConfig::Down:       return n - 1 - (int) (c % n);
            case ArpConfig::UpDown:     { const int p = (int) (c % (2 * n)); return p < n ? p : 2 * n - 1 - p; }
            case ArpConfig::UpDownExcl: { const int per = 2 * n - 2; const int p = (int) (c % per); return p < n ? p : 2 * n - 2 - p; }
            case ArpConfig::DownUp:     { const int p = (int) (c % (2 * n)); return p < n ? n - 1 - p : p - n; }
            case ArpConfig::Random:     return (int) (rnd % (uint32_t) n);
            case ArpConfig::ConvergeUp:   return convergeIdx (true,  (int) (c % n), n);
            case ArpConfig::ConvergeDown: return convergeIdx (false, (int) (c % n), n);
            case ArpConfig::DivergeUp:    return convergeIdx (true,  n - 1 - (int) (c % n), n);
            case ArpConfig::DivergeDown:  return convergeIdx (false, n - 1 - (int) (c % n), n);
            case ArpConfig::ThumbUp:    { const int k = (int) (c % (2 * (n - 1))); return (k & 1) ? 1 + k / 2 : 0; }
            case ArpConfig::ThumbDown:  { const int k = (int) (c % (2 * (n - 1))); return (k & 1) ? n - 1 - k / 2 : 0; }
            case ArpConfig::PinkyUp:    { const int k = (int) (c % (2 * (n - 1))); return (k & 1) ? n - 1 : k / 2; }
            case ArpConfig::PinkyDown:  { const int k = (int) (c % (2 * (n - 1))); return (k & 1) ? n - 1 : n - 2 - k / 2; }
            // Every other note going up, then the ones it skipped: 0 2 4 ... 1 3 5 ...
            // Expressed as a permutation of 0..n-1 so the period is exactly n for
            // BOTH parities — a plain stride of 2 only reaches half an even pool.
            case ArpConfig::SkipUp:
            {
                const int half = (n + 1) / 2;
                const int k = (int) (c % n);
                return k < half ? k * 2 : (k - half) * 2 + 1;
            }
            // Ascending with each note played twice: 0 0 1 1 2 2 ...
            case ArpConfig::RepeatUp:   return (int) ((c / 2) % n);
            // Random walk of +-1, reflected at the ends. Advanced from MEMBER state
            // (`walkPos`) one step at a time — deriving it from `c` would mean
            // replaying c steps on every note, i.e. unbounded work on the audio
            // thread that gets slower the longer the arp runs.
            case ArpConfig::Walk:
            {
                walkPos += (xs (rngWalk) & 1u) ? 1 : -1;
                if (walkPos < 0) walkPos = (n > 1) ? 1 : 0;
                if (walkPos > n - 1) walkPos = (n > 1) ? n - 2 : 0;
                return walkPos;
            }
            default:                    return (int) (c % n);   // Up, AsPlayed
        }
    }

    int buildPool (const ArpConfig& cfg, int row, PoolEntry* pool, int cap, const Held* ch, int nc, int octsIn) const
    {
        int np = 0;
        const int octs = juce::jlimit (1, 4, octsIn);
        for (int o = 0; o < octs; ++o)
            for (int b = 0; b < 5; ++b)
                if (cfg.layerArp[(size_t) row][(size_t) b])
                    for (int i = 0; i < nc; ++i)
                    {
                        const int n = ch[i].note + 12 * (o + b - 2);
                        if (n < 0 || n > 127 || np >= cap) continue;
                        pool[np++] = { n, ch[i].vel };
                    }
        if (cfg.mode != ArpConfig::AsPlayed)
        {
            std::sort (pool, pool + np, [] (const PoolEntry& a, const PoolEntry& b) { return a.note < b.note; });
            int k = 0;
            for (int i = 0; i < np; ++i)
                if (k == 0 || pool[k - 1].note != pool[i].note) pool[k++] = pool[i];
            np = k;
        }
        else
        {
            int k = 0;
            for (int i = 0; i < np; ++i)
            {
                bool dup = false;
                for (int j = 0; j < k; ++j) if (pool[j].note == pool[i].note) { dup = true; break; }
                if (! dup) pool[k++] = pool[i];
            }
            np = k;
        }
        return np;
    }

    // ---------------------------------------------------------------- one step
    void runStep (const ArpConfig& cfg, const std::array<float, kArpMods>& mod, juce::MidiBuffer& out,
                  int pos, int64_t evTime, double stepLen, double sr, double barPos,
                  const Held* ch, int nc, int rowFrom = 0, int rowTo = 2)
    {
        const float modAmt = mod[5];
        // Octaves is modulatable (mod slot 6, span 3 — see SEQ_TARGETS). Rounded,
        // then clamped to the knob's own 1..4 so a route can never push the pool
        // past what the user could dial by hand.
        int octsEff = juce::jlimit (1, 4, (int) std::lround ((float) cfg.octaves + mod[6]));

        // Octave dice: +/- whole octaves, because a fractional octave would land
        // between notes. Clamped to the same 1..4 as everything else, so a full
        // draw still cannot exceed what the knob itself allows.
        // Octave dice now IS the Oct step lane's dice (lanes[octave].amount, rolled with the lane), so the
        // knob-dice draw is off. Two draws would randomise the octave twice.
        const float octDice = 0.0f;
        if (octDice > 0.0f && u() < octDice)
        {
            // Signed draw decides the DIRECTION and how far: a one-way "up" dice
            // only ever adds, a one-way "down" only ever subtracts, and a bipolar
            // dice moves either way. The magnitude is scaled by the amount, so a
            // low amount still nudges rather than always jumping a full octave.
            const float dev = ArpConfig::signedDraw (cfg, kDiceOctaves, u(), true);
            const int delta = dev >= 0.0f ? (int) std::lround (dev * octDice) : -(int) std::lround (-dev * octDice);
            if (delta != 0)
                octsEff = juce::jlimit (1, 4, octsEff + delta);
        }

        // Pattern dice: pick a DIFFERENT pattern for this step. Modelled as a
        // bias toward a random index rather than a percentage of the current
        // one — a 0..1 position offset would only ever slide between two
        // neighbouring patterns, and the index space is discrete.
        float patternBias = 0.0f;
        const float patDice = ArpConfig::knobAmount (cfg, kDicePattern);
        if (patDice > 0.0f && u() < patDice)
            patternBias = (float) (u() * (double) ArpConfig::kNumModes);

        // auto-regen on bar boundaries
        if (cfg.autoRegen > 0.0f)
        {
            const int64_t slot = (int64_t) std::floor (barPos / (double) cfg.autoRegen);
            if (! slotValid || lastBars != cfg.autoRegen) { slotValid = true; lastSlot = slot; lastBars = cfg.autoRegen; }
            else if (slot != lastSlot) { lastSlot = slot; regenAll (cfg, modAmt); }
        }
        else slotValid = false;

        // lane positions
        const int seqLen = juce::jlimit (1, 16, cfg.seqLength);
        const int64_t gl = cfg.resetAfter > 0 ? g % cfg.resetAfter : g;
        const uint32_t salt = hash32 (cfg.seed ^ 0xA5A5A5A5u);
        int idx[7];
        for (int L = 0; L < 7; ++L)
        {
            const auto& ln = cfg.lanes[(size_t) L];
            const int len = cfg.polymetry ? juce::jlimit (1, 16, ln.length) : seqLen;
            const int64_t cnt = gl / juce::jmax (1, ln.div);
            const int p = dirPos (L, cnt, len, cfg.direction, salt);
            idx[L] = (((p + ln.rotation) % len) + len) % len;
        }
        const int phPos = dirPos (7, gl, seqLen, cfg.direction, salt);
        // Only the green row (row 0) drives the playhead; the blue clock would otherwise overwrite it.
        if (rowFrom == 0) playhead.store (phPos);

        // live chaos: fresh draw for the steps being played now
        if (cfg.chaosLive)
        {
            rollStep (cfg, ArpConfig::LPitch,  idx[ArpConfig::LPitch],  modAmt);
            rollStep (cfg, ArpConfig::LOctave, idx[ArpConfig::LOctave], modAmt);
            rollStep (cfg, ArpConfig::LVel,    idx[ArpConfig::LVel],    modAmt);
            rollStep (cfg, ArpConfig::LGate,   idx[ArpConfig::LGate],   modAmt);
            rollStep (cfg, ArpConfig::LSlide,  idx[ArpConfig::LSlide],  modAmt);
            rollStep (cfg, ArpConfig::LProb,   idx[ArpConfig::LProb],   modAmt);
        }

        auto eff = [&] (int L) -> float
        {
            const int j = idx[L];
            return ovHas[L][j] ? ov[L][j] : cfg.lanes[(size_t) L].base[(size_t) j];
        };

        const bool onFlag = eff (ArpConfig::LOn) >= 0.5f;
        const float prob = clampf (eff (ArpConfig::LProb), 0.0f, 1.0f);
        const bool play = onFlag && (prob >= 0.9999f || ur() < prob);
        if (! play || nc <= 0) return;

        const int pitchLane = (int) std::lround (eff (ArpConfig::LPitch));
        const int octLane   = (int) std::lround (eff (ArpConfig::LOctave));
        const float velLane = clampf (eff (ArpConfig::LVel), 0.0f, 1.0f);
        const float slideMs = clampf (eff (ArpConfig::LSlide), 0.0f, 1000.0f);
        const float pct = clampf (cfg.velocityPct + mod[4], 0.0f, 1.0f);
        const int xp = juce::jlimit (-48, 48, (int) std::lround ((double) cfg.pitchTranspose + (double) mod[3]));
        const float gateMul = 1.0f + clampf (mod[2], -0.95f, 8.0f);
        const float velJit = cfg.humanize > 0.0f ? 1.0f + (ur() * 2.0f - 1.0f) * cfg.humanize * 0.25f : 1.0f;

        // The step lanes are ALWAYS live in arp mode. They used to sit behind
        // `cfg.useStepLanes`, but no UI code path ever WROTE that flag — its
        // only value was the `false` default carried by every patch — so every
        // painted lane was silently discarded. A gate gated on a flag nobody can
        // set is dead code that looks alive, which is worse than no gate: the
        // user sees a working control that does not move a sample. The flag is
        // still PARSED and still means "force the lanes off" for the rare case
        // of disabling the feature without losing the painted data.
        const int   stepPos  = phPos & 15;
        const float shortFrac = cfg.useStepLanes
            ? clampf (1.0f / (1.0f + cfg.stepShorten[(size_t) stepPos]), 0.05f, 1.0f)
            : 1.0f;
        const float stepVelLane = cfg.useStepLanes ? cfg.stepVel[(size_t) stepPos] : 1.0f;
        const float stepSlideMs = cfg.useStepLanes
            ? clampf (cfg.stepSlide[(size_t) stepPos] * shortFrac, 0.0f, 1000.0f)
            : 0.0f;

        // The GATE LANE is the per-step gate, and it scales the Gate knob. 0.6 is the
        // lane's default, so an untouched lane leaves the knob's length exactly as it was.
        // (This used to read the legacy `stepShorten`, so the Gate lane did nothing in Arp mode.)
        const float gateLaneScale = eff (ArpConfig::LGate) / 0.6f;
        float gateFrac = cfg.gate * gateLaneScale * gateMul;

        // GATE LANE DICE — drawn HERE, at the per-step seam that consumes it,
        // not at parse time. Drawn once per block (or once at config load) it
        // would be one static offset repeated for every step in the block, which
        // the ear reads as nothing at all. Applied MULTIPLICATIVELY for the
        // same reason the global gate dice is: gate is a ratio to the step
        // length, so a factor keeps "50 % of a step" meaning half a step at any
        // rate, whereas an additive offset would be musically huge at short
        // gates and negligible at long ones. Clamped to the SAME 0.05..4.0
        // envelope the undiced gate already uses, so randomness can never push a
        // note outside the valid range.
        if (cfg.useStepLanes)
        {
            const float laneGateDice = ArpConfig::knobAmountLane (cfg, 1);
            if (laneGateDice > 0.0f)
            {
                const float dev = ArpConfig::signedDrawLane (cfg, 1, u(), true);
                gateFrac *= 1.0f + dev * laneGateDice * 0.5f;
            }
        }

        // Gate knob dice. Applied MULTIPLICATIVELY (a factor), not additively on the
        // fraction: gate is a ratio to the step length, so scaling it keeps "50 % of a
        // step" meaning half a step at any rate. An additive offset on the fraction
        // would be musically huge at short gates and negligible at long ones.
        {
            // Gate dice now IS the Gate step lane's dice (lanes[gate].amount), rolled with the lane. Knob draw off.
            const float gateDice = 0.0f;
            if (gateDice > 0.0f)
            {
                const float dev = ArpConfig::signedDraw (cfg, kDiceGate, u(), true);
                // 0.5 at 100 % -> the gate can be halved or doubled per step.
                gateFrac *= 1.0f + dev * gateDice * 0.5f;
            }
        }
        gateFrac = clampf (gateFrac, 0.05f, 4.0f);
        const int64_t gateSamples = std::max<int64_t> ((int64_t) (sr * 0.005), (int64_t) std::llround (stepLen * (double) gateFrac));

        // Chord hit works in BOTH modes. It was gated on seqEnabled, so the Chord hit
        // button in the arp strip (and in Arp mode of the sequencer) did nothing.
        if (cfg.chordHit)
        {
            // Chord hit is one stab per step, so it belongs to row 0 only: running it per row would double every note.
            if (rowFrom != 0) return;
            // Chord hit: every held note (max 4 sounding), shifted by the pitch lane.
            Held tmp[32];
            for (int i = 0; i < nc; ++i) tmp[i] = ch[i];
            std::sort (tmp, tmp + nc, [] (const Held& a, const Held& b) { return a.note < b.note; });
            const int cnt = std::min (nc, 4);
            for (int i = 0; i < cnt; ++i)
            {
                int n = tmp[i].note + pitchLane + xp;
                n = snapNote (n, cfg) + octLane * 12;
                const float v = (tmp[i].vel + (velLane - tmp[i].vel) * pct) * velJit;
                trigger (cfg, out, juce::jlimit (0, 127, n), v, pos, evTime, gateSamples, slideMs);
            }
            return;
        }

        // ---- arp mode ----
        // TRANSPOSE LANE DICE — same rule as the gate lane dice above: drawn at
        // the per-step seam that consumes it (here, where the step's pitch offset
        // is decided), never once per block. Clamped to the SAME -12..12
        // envelope the painted lane already uses, so randomness cannot push a
        // note outside what the knob itself allows. Direction defaults to
        // bipolar, matching `signedDrawLane`'s one-way-is-the-exception rule.
        int stepTr = cfg.useStepLanes ? cfg.stepTranspose[(size_t) (phPos & 15)] : 0;
        if (cfg.useStepLanes)
        {
            const float laneTrDice = ArpConfig::knobAmountLane (cfg, 0);
            if (laneTrDice > 0.0f)
            {
                const float dev = ArpConfig::signedDrawLane (cfg, 0, u(), true);
                const float delta = dev * laneTrDice * 12.0f;
                stepTr = juce::jlimit (-12, 12, stepTr + (int) std::lround (delta));
            }
        }
        bool rowOn[2] = { false, false };
        bool anyChord = false;
        for (int b = 0; b < 5; ++b) anyChord = anyChord || cfg.layerChord[(size_t) b];
        for (int r = 0; r < 2; ++r)
            for (int b = 0; b < 5; ++b) rowOn[r] = rowOn[r] || cfg.layerArp[(size_t) r][(size_t) b];
        const bool fallback = ! rowOn[0] && ! rowOn[1] && ! anyChord;

        PoolEntry pool[128];
        for (int r = rowFrom; r < rowTo; ++r)
        {
            int np;
            if (fallback && r == 0)
            {
                ArpConfig tmpCfg = cfg;   // plain copy of POD-ish arrays; no heap
                tmpCfg.layerArp[0].fill (false); tmpCfg.layerArp[0][2] = true;
                np = buildPool (tmpCfg, 0, pool, 128, ch, nc, octsEff);
            }
            else if (rowOn[r]) np = buildPool (cfg, r, pool, 128, ch, nc, octsEff);
            else continue;
            if (np <= 0) continue;

            auto fire = [&] (int i)
            {
                // The Pitch lane is the live per-step pitch. `stepTr` is the legacy array
                // the UI no longer writes, so on its own the lane did nothing in Arp mode.
                int n = pool[i].note + stepTr + pitchLane + xp;
                n = snapNote (n, cfg) + octLane * 12;
                // The per-step VELOCITY lane multiplies the note's own velocity,
                // so its neutral value (1) leaves an untouched lane a strict
                // no-op and an old patch sounding exactly as it did. It is a
                // separate multiplier rather than a replacement for `pct` (the
                // held-velocity blend), because the two answer different
                // questions: `pct` decides how much the KEYSTROKE carries, this
                // lane decides how loud this STEP of the pattern is.
                const float v = pool[i].vel * (1.0f + (velLane - 1.0f) * pct) * velJit * stepVelLane;
                // The per-step SLIDE lane adds its own glide on top of the Seq
                // lane's `slideMs`, scaled by the same shorten factor the gate
                // used so a staccato step does not get a long portamento into a
                // note that is barely audible — the two would contradict each
                // other if they were independent.
                trigger (cfg, out, juce::jlimit (0, 127, n), v, pos, evTime, gateSamples,
                         slideMs + stepSlideMs);
            };

            fire (patternIndex (effModeDice (cfg, mod[7], patternBias), rowCnt[r], np, xs (rng2) >> 4));
            ++rowCnt[r];
        }
    }

    // ---------------------------------------------------------------- the block
    void processInner (const juce::MidiBuffer& in, juce::MidiBuffer& out, int numSamples, double sr,
                       const ArpConfig& cfg, const ArpTransport& tr, const std::array<float, kArpMods>& mod)
    {
        out.clear();
        if (numSamples <= 0 || sr <= 0.0) return;
        slideMsForNote.fill (0.0f);
        tightForNote.fill (0);

        const int64_t blockStart = clock;
        const int64_t blockEnd = blockStart + numSamples;

        handleTokens (cfg, mod[5]);

        // ---- block timing ----
        const double bpm = juce::jlimit (20.0, 400.0, tr.bpm > 1.0 ? tr.bpm : 120.0);
        const double spb = 60.0 / bpm * sr;                       // samples per beat
        const bool hostDomain = tr.playing && tr.ppqValid;
        const double ppq0 = tr.ppq;

        // Two rows, two clocks. Row 0 (green) runs on `cfg`. Row 1 (blue) runs on its own
        // knobs (ArpConfig::forBlue), and only while it has a layer on. The copy means every
        // reader downstream (gate, dice, octaves, chaos) sees the row's own values.
        bool blueHasLayer = false;
        for (int b = 0; b < 5; ++b) blueHasLayer = blueHasLayer || cfg.layerArp[1][(size_t) b];
        const bool blueOn = cfg.blue.enabled && blueHasLayer;
        const ArpConfig cfgBlue = ArpConfig::forBlue (cfg);
        const ArpConfig* rowCfg[2] = { &cfg, &cfgBlue };

        // Per-row timing, from that row's own rate and swing.
        double rowLen[2] = { 0.0, 0.0 }, rowBeats[2] = { 0.0, 0.0 }, rowSwing[2] = { 50.0, 50.0 };
        bool rowLocked[2] = { false, false };
        for (int r = 0; r < 2; ++r)
        {
            const ArpConfig& c = *rowCfg[r];
            const double rateMul = std::pow (2.0, (double) juce::jlimit (-4.0f, 4.0f, mod[0]));
            double stepLen = 0.0, stepBeats = 0.0;
            if (c.rateSync)
            {
                const double feel = c.rateFeel == 1 ? (2.0 / 3.0) : (c.rateFeel == 2 ? 1.5 : 1.0);
                stepBeats = ArpConfig::kDivBeats[juce::jlimit (0, 5, c.rateDiv)] * feel / rateMul;
                stepLen = stepBeats * spb;
            }
            else stepLen = sr / ((double) std::max (0.5f, c.rateHz) * rateMul);
            stepLen = std::max (stepLen, 32.0);
            if (c.rateSync) stepBeats = stepLen / spb;
            rowLen[r] = stepLen;
            rowBeats[r] = stepBeats;
            rowSwing[r] = juce::jlimit (50.0, 75.0, (double) c.swing + (double) mod[1]);
            rowLocked[r] = c.rateSync && hostDomain;
        }

        auto barPosAt = [&] (double t) -> double
        {
            const double dt = (t - (double) blockStart) / spb;
            return hostDomain ? (ppq0 + dt) / 4.0 : (internalBeats + dt) / 4.0;
        };
        auto gridAtOrAfter = [&] (double t, double beats) -> double
        {
            const double pp = ppq0 + (t - (double) blockStart) / spb;
            const double k = std::ceil (pp / beats - 1e-4);
            return (double) blockStart + (k * beats - ppq0) * spb;
        };
        auto computeActual = [&] (int r, double nominal, int64_t stepIdx) -> double
        {
            const ArpConfig& c = *rowCfg[r];
            double a = nominal;
            if (stepIdx & 1)
            {
                // Swing dice is drawn HERE, where a step's actual time is decided.
                // One draw per step, per row.
                double sw = rowSwing[r];
                const float swingDice = ArpConfig::knobAmount (c, kDiceSwing);
                if (swingDice > 0.0f)
                {
                    // Same 50..75 envelope the undiced swing is clamped to.
                    const float dev = ArpConfig::signedDraw (c, kDiceSwing, u(), (stepIdx & 1) == 0);
                    sw = juce::jlimit (50.0, 75.0, sw + (double) dev * swingDice * 12.5);
                }
                const double d = (sw - 50.0) / 50.0 + (double) c.shape * 0.25;
                a += rowLen[r] * juce::jlimit (-0.4, 0.9, d);
            }
            if (c.humanize > 0.0f) a += (double) (ur() * 2.0f - 1.0f) * (double) c.humanize * 0.12 * rowLen[r];
            return a;
        };

        if (hostDomain != prevHostDomain)
        {
            prevHostDomain = hostDomain;
            slotValid = false;
            if (active) barBase = hostDomain ? (int) std::floor (ppq0 / 4.0) : 0;
        }

        // ---- on/off + structural changes ----
        if (cfg.on != prevOn)
        {
            if (cfg.on)
            {
                for (int i = 0; i < nHeld; ++i)
                    out.addEvent (juce::MidiMessage::noteOff (1, held[(size_t) i].note), 0);   // were sounding natively
            }
            else
            {
                killAll (out, 0);
                for (int i = 0; i < nHeld; ++i)
                    out.addEvent (juce::MidiMessage::noteOn (1, held[(size_t) i].note, held[(size_t) i].vel), 0);
                active = false; nextValidR[0] = nextValidR[1] = false;
                playhead.store (-1);
                barCount.store (0);
            }
            prevOn = cfg.on;
        }
        else if (cfg.on && cfg.mode != prevMode)
            killArp (out, 0);
        prevMode = cfg.mode;

        // ---- input events ----
        int firstOnPos = -1, lastChangePos = 0;
        for (const auto meta : in)
        {
            const auto m = meta.getMessage();
            const int pos = juce::jlimit (0, juce::jmax (0, numSamples - 1), meta.samplePosition);
            if (m.isNoteOn())
            {
                addHeld (m.getNoteNumber(), m.getFloatVelocity());
                lastChangePos = pos;
                if (cfg.on) { if (firstOnPos < 0) firstOnPos = pos; }
                else out.addEvent (m, pos);
            }
            else if (m.isNoteOff())
            {
                removeHeld (m.getNoteNumber());
                lastChangePos = pos;
                if (! cfg.on) out.addEvent (m, pos);
            }
            else if (m.isAllNotesOff() || m.isAllSoundOff())
            {
                nHeld = 0; nFrozen = 0;
                killAll (out, pos);
                out.addEvent (m, pos);
                lastChangePos = pos;
            }
            else
                out.addEvent (m, pos);
        }

        if (! cfg.on)
        {
            clock = blockEnd;
            internalBeats += (double) numSamples / spb;
            return;
        }

        // ---- active chord (hold latches the last chord) ----
        if (nHeld > 0)
        {
            nFrozen = nHeld;
            for (int i = 0; i < nHeld; ++i) frozen[(size_t) i] = held[(size_t) i];
        }
        const Held* chord = nHeld > 0 ? held.data() : frozen.data();
        const int nc = nHeld > 0 ? nHeld : (cfg.hold ? nFrozen : 0);

        reconcileChord (cfg, out, lastChangePos, nc > 0 ? chord : nullptr, nc);

        if (nc <= 0)
        {
            killArp (out, lastChangePos);
            active = false; nextValidR[0] = nextValidR[1] = false;
            for (auto& s : stValid) s = false;
            playhead.store (-1);
            barCount.store (0);
            clock = blockEnd;
            internalBeats += (double) numSamples / spb;
            return;
        }

        // A row starts on the first block it is live. Row 0 starts with the arp; row 1
        // starts when its layers come on, which can be mid-run.
        auto startRow = [&] (int r)
        {
            double nominal = (double) blockStart + (firstOnPos >= 0 ? firstOnPos : 0);
            if (rowLocked[r]) nominal = gridAtOrAfter (nominal, rowBeats[r]);
            gR[r] = 0;
            nextNominalR[r] = nominal;
            nextActualR[r] = computeActual (r, nominal, 0);
            nextValidR[r] = true;
        };

        if (! active)
        {
            active = true;
            g = 0; rowCnt[0] = rowCnt[1] = 0;
            for (auto& s : stValid) s = false;
            slotValid = false;
            if (! hostDomain) internalBeats = 0.0;
            barBase = hostDomain ? (int) std::floor (ppq0 / 4.0) : 0;
            startRow (0);
            if (blueOn) startRow (1);
            else nextValidR[1] = false;
        }
        else
        {
            if (blueOn && ! nextValidR[1]) { rowCnt[1] = 0; startRow (1); }
            if (! blueOn) nextValidR[1] = false;

            for (int r = 0; r < 2; ++r)
            {
                if (! nextValidR[r]) continue;
                if (rowLocked[r])
                {
                    // re-sync to the host grid after transport jumps / tempo changes / sync toggles
                    const double kf = (ppq0 + (nextNominalR[r] - (double) blockStart) / spb) / rowBeats[r];
                    if (std::fabs (kf - std::round (kf)) > 0.02
                        || nextNominalR[r] < (double) blockStart - 2.0 * rowLen[r]
                        || nextNominalR[r] > (double) blockEnd + 2.0 * rowLen[r])
                    {
                        nextNominalR[r] = gridAtOrAfter ((double) blockStart, rowBeats[r]);
                        nextActualR[r] = computeActual (r, nextNominalR[r], gR[r]);
                    }
                }
                else if (nextNominalR[r] < (double) blockStart - 4.0 * rowLen[r])
                {
                    // free clock: if we fell far behind (e.g. rate changed massively) don't machine-gun
                    nextNominalR[r] = (double) blockStart;
                    nextActualR[r] = computeActual (r, nextNominalR[r], gR[r]);
                }
            }
        }

        // ---- the step clocks, sample-accurate ----
        for (int guard = 0; guard < 512; ++guard)
        {
            int64_t bestOff = INT64_MAX; int bestNote = -1;
            for (int n = 0; n < 128; ++n)
                if (kind[(size_t) n] == 1 && offAt[(size_t) n] >= 0 && offAt[(size_t) n] < blockEnd && offAt[(size_t) n] < bestOff)
                { bestOff = offAt[(size_t) n]; bestNote = n; }

            // the row whose step is due first
            int due = -1;
            for (int r = 0; r < 2; ++r)
                if (nextValidR[r] && nextActualR[r] < (double) blockEnd && (due < 0 || nextActualR[r] < nextActualR[due]))
                    due = r;

            if (bestNote < 0 && due < 0) break;

            if (bestNote >= 0 && (due < 0 || (double) bestOff <= nextActualR[due]))
            {
                const int p = (int) juce::jlimit<int64_t> (0, numSamples - 1, bestOff - blockStart);
                emitOff (out, bestNote, p);
                continue;
            }

            const int r = due;
            const ArpConfig& c = *rowCfg[r];
            const int64_t evAbs = std::max<int64_t> (blockStart, (int64_t) std::floor (nextActualR[r]));
            const int p = (int) juce::jlimit<int64_t> (0, numSamples - 1, evAbs - blockStart);

            // ---- per-step knob dice: RATE (this row's own dice) ----
            // Drawn HERE, per step, so consecutive notes genuinely differ.
            double stepLenDice = rowLen[r];
            const float rateDice = ArpConfig::knobAmount (c, kDiceRate);
            if (rateDice > 0.0f)
            {
                // Multiplicative, and one-way alternates side on each step (see the old note in git history).
                const float dev = ArpConfig::signedDraw (c, kDiceRate, u(), (gR[r] & 1) == 0);
                const float f = 1.0f + dev * rateDice * 0.5f;
                stepLenDice = std::max (stepLenDice / (double) juce::jlimit (0.25f, 4.0f, f), 32.0);
            }

            g = gR[r];
            runStep (c, mod, out, p, blockStart + p, stepLenDice, sr, barPosAt (nextNominalR[r]), chord, nc, r, r + 1);

            // advance this row to its next step. The undiced length keeps the grid from drifting.
            const double prevNominal = nextNominalR[r];
            ++gR[r];
            if (rowLocked[r])
            {
                const double pp = ppq0 + (prevNominal - (double) blockStart) / spb;
                const double k = std::floor (pp / rowBeats[r] + 1e-4) + 1.0;
                nextNominalR[r] = (double) blockStart + (k * rowBeats[r] - ppq0) * spb;
                if (nextNominalR[r] < prevNominal + rowLen[r] * 0.5) nextNominalR[r] = prevNominal + rowLen[r];
            }
            else nextNominalR[r] += rowLen[r];
            nextActualR[r] = computeActual (r, nextNominalR[r], gR[r]);
        }

        barCount.store (std::max (0, (int) std::floor (barPosAt ((double) blockStart)) - barBase));
        clock = blockEnd;
        internalBeats += (double) numSamples / spb;
    }
};
