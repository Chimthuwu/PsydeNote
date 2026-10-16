#pragma once

#include <vector>
#include <cstdint>
#include <cstring>
#include <optional>

// ---------------------------------------------------------------------------
// Read the precomputed wavetables.bin (built by scripts/build-wavetables.mjs)
// and extract frames on demand. Format (little-endian):
//   u32 magic 'FZWT' | u32 version | u32 tableCount | u32 frameSize
//   tableCount x { u32 frameCount, u32 firstFrame }
//   payload: int16[sum(frameCount) * frameSize]
// ---------------------------------------------------------------------------

namespace faze {
namespace wt {

constexpr uint32_t BIN_MAGIC = 0x54575A46; // 'FZWT'

struct WavetableBinHeader
{
    uint32_t magic;
    uint32_t version;
    uint32_t tableCount;
    uint32_t frameSize;
};

struct TableEntry
{
    uint32_t frameCount;
    uint32_t firstFrame;
};

inline uint32_t readU32LE (const char* data, size_t offset)
{
    uint32_t val;
    std::memcpy (&val, data + offset, sizeof (val));
    #if JUCE_BIG_ENDIAN
    return juce::ByteOrder::swapIfBigEndian (val);
    #else
    return val;
    #endif
}

inline int16_t readI16LE (const char* data, size_t offset)
{
    int16_t val;
    std::memcpy (&val, data + offset, sizeof (val));
    #if JUCE_BIG_ENDIAN
    return juce::ByteOrder::swapIfBigEndian (val);
    #else
    return val;
    #endif
}

struct WavetableBin
{
    const char* data;
    size_t size;
    WavetableBinHeader header;
    std::vector<TableEntry> tables;

    // Make movable for std::optional
    WavetableBin() = default;
    WavetableBin(WavetableBin&&) = default;
    WavetableBin& operator=(WavetableBin&&) = default;
    WavetableBin(const WavetableBin&) = delete;
    WavetableBin& operator=(const WavetableBin&) = delete;

    static std::optional<WavetableBin> parse (const char* binData, size_t binSize)
    {
        if (binSize < 16)
            return std::nullopt;

        WavetableBin bin;
        bin.data = binData;
        bin.size = binSize;
        bin.header.magic = readU32LE (binData, 0);
        bin.header.version = readU32LE (binData, 4);
        bin.header.tableCount = readU32LE (binData, 8);
        bin.header.frameSize = readU32LE (binData, 12);

        if (bin.header.magic != BIN_MAGIC || bin.header.version != 1)
            return std::nullopt;

        const size_t headerBytes = 16 + bin.header.tableCount * 8;
        if (binSize < headerBytes)
            return std::nullopt;

        bin.tables.reserve (bin.header.tableCount);
        for (uint32_t i = 0; i < bin.header.tableCount; ++i)
        {
            TableEntry e;
            e.frameCount = readU32LE (binData, 16 + i * 8);
            e.firstFrame = readU32LE (binData, 20 + i * 8);
            bin.tables.push_back (e);
        }

        return bin;
    }

    std::optional<std::vector<float>> getFrame (int tableId, int frameIndex) const
    {
        if (tableId < 0 || tableId >= (int) tables.size())
            return std::nullopt;

        const auto& entry = tables[tableId];
        if (frameIndex < 0 || frameIndex >= (int) entry.frameCount)
            return std::nullopt;

        const size_t headerBytes = 16 + header.tableCount * 8;
        const size_t absoluteFrameIdx = entry.firstFrame + frameIndex;
        const size_t payloadOffset = headerBytes + absoluteFrameIdx * header.frameSize * 2;

        if (payloadOffset + header.frameSize * 2 > size)
            return std::nullopt;

        std::vector<float> frame (header.frameSize);
        for (uint32_t s = 0; s < header.frameSize; ++s)
        {
            int16_t sample = readI16LE (data, payloadOffset + s * 2);
            frame[s] = sample / 32767.0f;
        }
        return frame;
    }

    int getFrameCount (int tableId) const
    {
        if (tableId < 0 || tableId >= (int) tables.size())
            return 0;
        return (int) tables[tableId].frameCount;
    }
};

} // namespace wt
} // namespace faze
