#pragma once

// ---------------------------------------------------------------------------
// User wavetables: ONE flat folder, no categories.
//
//   * default folder   %USERPROFILE%/Documents/Faze/Wavetables  (created on demand)
//   * optional custom library folder, persisted in %APPDATA%/Faze/settings.json
//   * every .wav/.aif/.aiff/.flac under the active folder (recursive, names come
//     from the file stem only) becomes one table, sorted by name.
//   * table ids are kUserBaseId + index (index = position in the sorted list).
//
// LIMITATION: presets store the NUMERIC wtid, so ids shift when files are added
// or removed (the list is alphabetical). Also, the audio runtime's shared
// resources are insert-only, so a table whose id was already used this session
// keeps its old frames until the plugin/standalone is restarted.
//
// All of this runs on the message thread (scan + lazy decode from
// ensureWavetableRegistered); the mutex only guards against editor-side reads.
// ---------------------------------------------------------------------------

#include <juce_core/juce_core.h>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <mutex>
#include <vector>

namespace faze {
namespace uwt {

constexpr int kUserBaseId     = 381;   // first user table id (bin holds ids 0..380)
constexpr int kMaxUserTables  = 255;   // matches manifest op{k}_wtid max (380 + 255)
constexpr int kFrameSize      = 2048;
constexpr int kMaxFrames      = 64;
constexpr juce::int64 kMaxDecodeSamples = 8 * 1024 * 1024;

//==============================================================================
// Folder + settings helpers (tiny JSON in %APPDATA%/Faze/settings.json).
inline juce::File defaultFolder()
{
    return juce::File::getSpecialLocation (juce::File::userDocumentsDirectory)
               .getChildFile ("Faze").getChildFile ("Wavetables");
}

inline juce::File settingsFile()
{
    return juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
               .getChildFile ("Faze").getChildFile ("settings.json");
}

inline juce::String loadLibraryPath()
{
    auto f = settingsFile();
    if (! f.existsAsFile())
        return {};
    auto v = juce::JSON::parse (f);
    if (auto* o = v.getDynamicObject())
        return o->getProperty ("wavetableLibrary").toString();
    return {};
}

inline void saveLibraryPath (const juce::String& path)
{
    auto f = settingsFile();
    juce::var root;
    if (f.existsAsFile())
        root = juce::JSON::parse (f);

    juce::DynamicObject::Ptr obj;
    if (auto* existing = root.getDynamicObject())
        obj = existing;
    else
        obj = new juce::DynamicObject();

    obj->setProperty ("wavetableLibrary", path);
    f.getParentDirectory().createDirectory();
    f.replaceWithText (juce::JSON::toString (juce::var (obj.get())));
}

/** The folder the synth currently reads: the custom library if set and valid,
    else the default (created if missing). */
inline juce::File activeFolder()
{
    const auto custom = loadLibraryPath();
    if (custom.isNotEmpty())
    {
        juce::File c (custom);
        if (c.isDirectory())
            return c;
    }
    auto d = defaultFolder();
    if (! d.isDirectory())
        d.createDirectory();
    return d;
}

//==============================================================================
class UserWavetables
{
public:
    UserWavetables() { fmt.registerBasicFormats(); }

    /** Rebuild the sorted file list from `dir` (cheap: no decoding). Returns true if
        the list of names/paths changed. Decoded caches are dropped. */
    bool scan (const juce::File& dir)
    {
        std::vector<Entry> found;
        if (dir.isDirectory())
        {
            juce::Array<juce::File> files;
            dir.findChildFiles (files, juce::File::findFiles, true, "*");
            for (auto& f : files)
            {
                const auto ext = f.getFileExtension().toLowerCase();
                if (ext == ".wav" || ext == ".aif" || ext == ".aiff" || ext == ".flac")
                    found.push_back ({ f.getFileNameWithoutExtension(), f });
            }
        }
        std::sort (found.begin(), found.end(), [] (const Entry& a, const Entry& b)
        {
            const int c = a.name.compareIgnoreCase (b.name);
            if (c != 0) return c < 0;
            return a.file.getFullPathName() < b.file.getFullPathName();
        });
        if ((int) found.size() > kMaxUserTables)
            found.resize ((size_t) kMaxUserTables);

        const std::lock_guard<std::mutex> lock (mtx);
        bool changed = found.size() != entries.size();
        if (! changed)
            for (size_t i = 0; i < found.size(); ++i)
                if (found[i].file != entries[i].file) { changed = true; break; }
        entries = std::move (found);
        cache.clear();
        return changed;
    }

    std::vector<juce::String> getNames() const
    {
        const std::lock_guard<std::mutex> lock (mtx);
        std::vector<juce::String> n;
        n.reserve (entries.size());
        for (auto& e : entries) n.push_back (e.name);
        return n;
    }

    int count() const
    {
        const std::lock_guard<std::mutex> lock (mtx);
        return (int) entries.size();
    }

    /** Number of decoded frames for a user table id (0 if the id is not a user table / unreadable). */
    int getFrameCount (int tableId)
    {
        const std::lock_guard<std::mutex> lock (mtx);
        auto* fr = framesFor (tableId);
        return fr != nullptr ? (int) fr->size() : 0;
    }

    /** Copy of frame `frameIndex` (kFrameSize samples) or an empty vector. */
    std::vector<float> getFrame (int tableId, int frameIndex)
    {
        const std::lock_guard<std::mutex> lock (mtx);
        auto* fr = framesFor (tableId);
        if (fr == nullptr || fr->empty() || frameIndex < 0 || frameIndex >= (int) fr->size())
            return {};
        return (*fr)[(size_t) frameIndex];
    }

private:
    struct Entry { juce::String name; juce::File file; };
    using Frames = std::vector<std::vector<float>>;

    // DC removal + peak-normalise to 0.92, like the bin tables / ESW loader.
    static std::vector<float> normalise (std::vector<float> frame)
    {
        double mean = 0.0;
        for (auto v : frame) mean += v;
        mean /= (double) juce::jmax ((size_t) 1, frame.size());
        float peak = 0.0f;
        for (auto& v : frame) { v -= (float) mean; peak = std::max (peak, std::abs (v)); }
        const float g = peak > 1e-6f ? 0.92f / peak : 1.0f;
        for (auto& v : frame) v *= g;
        return frame;
    }

    Frames decode (const juce::File& file)
    {
        Frames frames;
        std::unique_ptr<juce::AudioFormatReader> reader (fmt.createReaderFor (file));
        if (reader == nullptr || reader->lengthInSamples <= 0 || reader->lengthInSamples > kMaxDecodeSamples)
            return frames;

        const juce::int64 total = reader->lengthInSamples;
        const int numCh = (int) juce::jlimit (1u, 2u, reader->numChannels);
        const bool isMultiple = (total % kFrameSize) == 0;
        const juce::int64 toRead = isMultiple ? juce::jmin ((juce::int64) kMaxFrames * kFrameSize, total) : total;

        juce::AudioBuffer<float> buf (numCh, (int) toRead);
        buf.clear();
        reader->read (&buf, 0, (int) toRead, 0, true, numCh > 1);

        std::vector<float> mono ((size_t) toRead, 0.0f);
        for (int ch = 0; ch < numCh; ++ch)
        {
            const float* src = buf.getReadPointer (ch);
            for (int i = 0; i < (int) toRead; ++i)
                mono[(size_t) i] += src[i] / (float) numCh;
        }

        if (isMultiple)
        {
            const int n = (int) (toRead / kFrameSize);
            frames.reserve ((size_t) n);
            for (int f = 0; f < n; ++f)
            {
                std::vector<float> fr (mono.begin() + (size_t) f * kFrameSize,
                                       mono.begin() + (size_t) (f + 1) * kFrameSize);
                frames.push_back (normalise (std::move (fr)));
            }
        }
        else
        {
            // Not a whole number of 2048 frames: treat the whole file as ONE cycle.
            std::vector<float> cyc ((size_t) kFrameSize, 0.0f);
            const double step = (double) toRead / (double) kFrameSize;
            for (int i = 0; i < kFrameSize; ++i)
            {
                const double pos = i * step;
                const int i0 = (int) pos;
                const int i1 = (i0 + 1) % (int) toRead;
                const float fr = (float) (pos - i0);
                cyc[(size_t) i] = mono[(size_t) juce::jmin (i0, (int) toRead - 1)] * (1.0f - fr) + mono[(size_t) i1] * fr;
            }
            frames.push_back (normalise (std::move (cyc)));
        }
        return frames;
    }

    // mtx must be held.
    const Frames* framesFor (int tableId)
    {
        const int idx = tableId - kUserBaseId;
        if (idx < 0 || idx >= (int) entries.size())
            return nullptr;
        auto it = cache.find (idx);
        if (it == cache.end())
            it = cache.emplace (idx, decode (entries[(size_t) idx].file)).first;
        return &it->second;
    }

    mutable std::mutex mtx;
    juce::AudioFormatManager fmt;
    std::vector<Entry> entries;
    std::map<int, Frames> cache;
};

} // namespace uwt
} // namespace faze
