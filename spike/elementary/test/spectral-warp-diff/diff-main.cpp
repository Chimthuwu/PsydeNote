// Differential test driver — compiled with cl.exe (same portable MSVC
// toolchain as the plugin) against WtSpectralWarp.h, dumping each warp
// result as raw float32 LE. Compared bit-for-bit against
// dsp/wavetables.js's applySpectralWarp() under Node by ../run-diff.mjs.
//
// argv: <out.bin> <mode> <amount> <param2> <allFrames.bin|null> <frameIdx>
//   allFrames.bin = 8 x 2048 float32 LE (the base-frame set), or the literal
//   "null" for none. Emits 1 x 2048 float32 LE (the warped frame 0).

#include "WtSpectralWarp.h"

#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string>

int main (int argc, char** argv)
{
    if (argc < 6) { std::fprintf (stderr, "usage: %s out.bin mode amount param2 allFrames.bin|null frameIdx\n", argv[0]); return 2; }

    const char* outPath = argv[1];
    const int mode = std::atoi (argv[2]);
    const double amount = std::atof (argv[3]);
    const double param2 = std::atof (argv[4]);
    const char* framesPath = argv[5];
    const int frameIdx = argc > 6 ? std::atoi (argv[6]) : 0;

    std::vector<float> frame ((size_t) faze::wt::kFrameSize);
    for (int i = 0; i < faze::wt::kFrameSize; ++i)
        frame[(size_t) i] = (float) ((2.0 * faze::wt::kPi * (double) i) / (double) faze::wt::kFrameSize); // exact one-cycle sine

    std::vector<std::vector<float>> allFrames;
    const std::vector<std::vector<float>>* framesPtr = nullptr;
    if (std::strcmp (framesPath, "null") != 0)
    {
        FILE* f = std::fopen (framesPath, "rb");
        if (f == nullptr) { std::fprintf (stderr, "cannot open %s\n", framesPath); return 2; }
        for (int fi = 0; fi < 8; ++fi)
        {
            std::vector<float> fr ((size_t) faze::wt::kFrameSize);
            if (std::fread (fr.data(), sizeof (float), fr.size(), f) != fr.size()) { std::fclose (f); std::fprintf (stderr, "short read\n"); return 2; }
            allFrames.push_back (std::move (fr));
        }
        std::fclose (f);
        framesPtr = &allFrames;
    }

    // Widen to double and back exactly like JS: the JS input Float32Array is
    // read as doubles by analyzeFrame, which is what the C++ double math
    // already does via the (double) casts.
    std::vector<float> out = faze::wt::applySpectralWarp (frame, mode, amount, param2, framesPtr, frameIdx);

    FILE* o = std::fopen (outPath, "wb");
    if (o == nullptr) { std::fprintf (stderr, "cannot write %s\n", outPath); return 2; }
    std::fwrite (out.data(), sizeof (float), out.size(), o);
    std::fclose (o);
    return 0;
}
