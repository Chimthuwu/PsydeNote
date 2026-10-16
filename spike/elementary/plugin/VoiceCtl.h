#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <memory>
#include <string>

#include <elem/GraphNode.h>

// ---------------------------------------------------------------------------
// Audio-thread-owned per-voice note state, exposed to the Elementary graph as
// the "voicectl" node: { voice: 0..N-1, field: "gate"|"freq"|"vel"|"kt"|"slide"|"tight" }.
//
// Before this, gate/freq/vel travelled audio thread -> voice snapshot ->
// debounced state dispatch -> QuickJS renderSynth (~50 ms) -> el.const prop.
// Note on/off therefore reached the DSP late and jittery, and a short arp/seq
// gate could be missed entirely if on+off fell in one debounce window.
// Now handleMidi() writes the atomics below the moment the VoicePool changes
// and the node copies them into the block, so a note lands within one audio
// block. The graph STRUCTURE no longer depends on note state at all.
// ---------------------------------------------------------------------------

constexpr int kVoiceCtlMax = 16;

struct VoiceCtlBank
{
    std::array<std::atomic<float>, kVoiceCtlMax> gate, freq, vel, kt, slide, tight;

    VoiceCtlBank()
    {
        for (int i = 0; i < kVoiceCtlMax; ++i)
        {
            gate[(size_t) i].store (0.0f);
            freq[(size_t) i].store (440.0f);
            vel[(size_t) i].store (1.0f);
            kt[(size_t) i].store (0.0f);
            slide[(size_t) i].store (0.0f);   // ms, per voice (arp Slide lane)
            tight[(size_t) i].store (0.0f);   // 0/1, arp tight release
        }
    }

    void setSlideTight (int i, float slideMs, float tightFlag)
    {
        if (i < 0 || i >= kVoiceCtlMax) return;
        slide[(size_t) i].store (slideMs);
        tight[(size_t) i].store (tightFlag);
    }

    void set (int i, float g, float f, float v)
    {
        if (i < 0 || i >= kVoiceCtlMax) return;
        gate[(size_t) i].store (g);
        freq[(size_t) i].store (f);
        vel[(size_t) i].store (v);
        // Keytrack: (midi - 60) / 60 clamped to +-1, same formula as synth.js.
        const float midi = 69.0f + 12.0f * std::log2 (std::max (1.0f, f) / 440.0f);
        kt[(size_t) i].store (std::clamp ((midi - 60.0f) / 60.0f, -1.0f, 1.0f));
    }
};

template <typename FloatType>
struct VoiceCtlNode : public elem::GraphNode<FloatType>
{
    VoiceCtlNode (elem::NodeId id, double sr, int blockSize, std::shared_ptr<VoiceCtlBank> b)
        : elem::GraphNode<FloatType> (id, sr, (size_t) blockSize), bank (std::move (b)) {}

    int setProperty (std::string const& key, elem::js::Value const& val) override
    {
        if (key == "voice")
        {
            if (! val.isNumber()) return elem::ReturnCode::InvalidPropertyType();
            voice.store (std::clamp ((int) (elem::js::Number) val, 0, kVoiceCtlMax - 1));
        }
        else if (key == "field")
        {
            if (! val.isString()) return elem::ReturnCode::InvalidPropertyType();
            const auto s = (std::string) (elem::js::String) val;
            field.store (s == "gate" ? 0 : s == "freq" ? 1 : s == "vel" ? 2 : s == "kt" ? 3 : s == "slide" ? 4 : 5);
        }
        return elem::GraphNode<FloatType>::setProperty (key, val);
    }

    void process (elem::BlockContext<FloatType> const& ctx) override
    {
        const auto i = (size_t) voice.load();
        float v = 0.0f;
        switch (field.load())
        {
            case 0:  v = bank->gate[i].load(); break;
            case 1:  v = bank->freq[i].load(); break;
            case 2:  v = bank->vel[i].load();  break;
            case 3:  v = bank->kt[i].load();   break;
            case 4:  v = bank->slide[i].load(); break;
            default: v = bank->tight[i].load(); break;
        }
        auto* out = ctx.outputData[0];
        for (size_t s = 0; s < ctx.numSamples; ++s)
            out[s] = (FloatType) v;
    }

    std::shared_ptr<VoiceCtlBank> bank;
    std::atomic<int> voice { 0 }, field { 0 };
};
