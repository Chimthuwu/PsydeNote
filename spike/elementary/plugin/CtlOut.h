#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <memory>
#include <string>

#include <elem/GraphNode.h>

// ---------------------------------------------------------------------------
// "ctlout" graph node: the reverse of "voicectl". Stores the LAST sample of its
// input into an atomic bank slot each block and outputs silence. The arp runs
// natively (ArpEngine.h), so graph-side modulation of Seq Rate / Swing / Gate /
// Transpose / Velocity / Random is read back by PluginProcessor at the top of
// processBlock (same audio thread, so the value is one block old).
//   createNode('ctlout', { slot: 0..15 }, [signal])
// ---------------------------------------------------------------------------

constexpr int kCtlOutSlots = 16;

struct CtlOutBank
{
    std::array<std::atomic<float>, kCtlOutSlots> v;

    CtlOutBank() { for (auto& a : v) a.store (0.0f); }
};

template <typename FloatType>
struct CtlOutNode : public elem::GraphNode<FloatType>
{
    CtlOutNode (elem::NodeId id, double sr, int blockSize, std::shared_ptr<CtlOutBank> b)
        : elem::GraphNode<FloatType> (id, sr, (size_t) blockSize), bank (std::move (b)) {}

    int setProperty (std::string const& key, elem::js::Value const& val) override
    {
        if (key == "slot")
        {
            if (! val.isNumber()) return elem::ReturnCode::InvalidPropertyType();
            slot.store (std::clamp ((int) (elem::js::Number) val, 0, kCtlOutSlots - 1));
        }
        return elem::GraphNode<FloatType>::setProperty (key, val);
    }

    void process (elem::BlockContext<FloatType> const& ctx) override
    {
        auto* out = ctx.outputData[0];
        for (size_t s = 0; s < ctx.numSamples; ++s)
            out[s] = (FloatType) 0;

        if (ctx.numInputChannels > 0 && ctx.inputData[0] != nullptr && ctx.numSamples > 0)
            bank->v[(size_t) slot.load()].store ((float) ctx.inputData[0][ctx.numSamples - 1]);
    }

    std::shared_ptr<CtlOutBank> bank;
    std::atomic<int> slot { 0 };
};
