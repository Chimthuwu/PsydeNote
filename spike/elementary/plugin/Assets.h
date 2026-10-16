#pragma once

#include <BinaryData.h>
#include <optional>
#include <string>
#include <string_view>

// ---------------------------------------------------------------------------
// The UI + DSP bundle (dsp.main.js, index.html, manifest.json) is embedded in
// the binary via juce_add_binary_data (see CMakeLists.txt), NOT read from disk.
//
// Why: a VST3 loaded by a host resolves `currentExecutableFile` unreliably
// across DAWs, so filesystem path-guessing for `Contents/Resources/dist`
// broke in Bitwig ("choc.localhost 404"). Embedding removes the whole problem
// — the plugin is relocatable and has no runtime file dependency.
// ---------------------------------------------------------------------------

struct EmbeddedAsset { const char* data; int size; };

inline std::optional<EmbeddedAsset> getEmbeddedAsset (std::string_view originalFilename)
{
    for (int i = 0; i < BinaryData::namedResourceListSize; ++i)
    {
        if (originalFilename == BinaryData::originalFilenames[i])
        {
            int size = 0;
            if (const char* data = BinaryData::getNamedResource (BinaryData::namedResourceList[i], size))
                return EmbeddedAsset { data, size };
        }
    }
    return std::nullopt;
}

inline std::string getEmbeddedAssetAsString (std::string_view originalFilename)
{
    if (auto a = getEmbeddedAsset (originalFilename))
        return std::string (a->data, static_cast<size_t> (a->size));
    return {};
}

// Map an extension to a MIME type for the webview resource handler.
inline std::string mimeTypeForPath (std::string_view path)
{
    auto ends = [&] (std::string_view s) {
        return path.size() >= s.size() && path.substr (path.size() - s.size()) == s;
    };
    if (ends (".html")) return "text/html";
    if (ends (".js"))   return "application/javascript";
    if (ends (".css"))  return "text/css";
    if (ends (".json")) return "application/json";
    if (ends (".svg"))  return "image/svg+xml";
    return "application/octet-stream";
}
