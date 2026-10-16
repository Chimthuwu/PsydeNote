#pragma once
// ============================================================================
// WtSpectralWarp.h — native port of dsp/wavetables.js's SPECTRAL warp modes
// (ids 13 and 16..29, the DFT/IFFT-based ones).
//
// Part of the checklist task "Port the remaining 15 spectral warp modes to
// C++ (only 14 of 29 are byte-exact against the JS reference, §135/§144)".
// The phase-domain (1-10, 12) and wave-domain (11, 14, 15) ports already live
// in PluginProcessor.cpp (wtWarpPhase / wtApplyWaveWarpSample); this header
// completes the set so the plugin renders every warp mode the JS reference
// can, instead of silently falling through to the unwarped base table.
//
// Why a header, not more code in PluginProcessor.cpp: the differential test
// harness (test/spectral-warp-diff/) compiles THIS FILE directly with cl.exe
// and compares its output bit-for-bit against dsp/wavetables.js running under
// Node. Keeping the port out of the JUCE TU is what makes that harness
// possible without dragging juce:: into it.
//
// Faithfulness rules, all load-bearing for byte-exactness:
//   * JS numbers are IEEE doubles — every intermediate below is double.
//   * mag/phase arrays in JS are Float32Array, so every STORE rounds to
//     float32. That rounding is part of the reference behaviour (the mode
//     math reads those float32 values back as doubles), so the arrays here
//     are std::vector<float>, and every `newMag[h] = expr` / `*=` in the JS
//     becomes `(float) (expr)` / `(float) ((double) v * expr)` here.
//   * Operation ORDER matches the JS line-for-line — IEEE ops are not
//     associative, and reordering changes the last bit.
//   * Math.sin/cos/atan2/hypot: V8 and the Windows CRT were measured (§162)
//     to differ by at most 1 ULP on this hardware, and the accumulated DFT
//     bin came out bit-identical in trial — re-verified by the harness over
//     the full mode/param matrix rather than assumed.
// ============================================================================

#include <cmath>
#include <vector>
#include <algorithm>
#include <cstddef>

namespace faze { namespace wt {

constexpr int   kFrameSize    = 2048;  // dsp/wavetables.js FRAME_SIZE
constexpr int   kNumHarmonics = 128;   // applySpectralWarp's fixed numHarmonics
constexpr double kPi = 3.141592653589793; // == JS Math.PI (nearest double)

// JS removeDC(): mean of the (float32) samples in double, subtract per sample.
inline void wtRemoveDC (std::vector<float>& frame)
{
    double mean = 0.0;
    for (float v : frame) mean += (double) v;
    mean /= (double) frame.size();
    for (float& v : frame) v = (float) ((double) v - mean);
}

// JS normalize(): peak-normalise to 0.92.
inline void wtNormalize (std::vector<float>& frame)
{
    float peak = 0.0f;
    for (float v : frame) peak = std::max (peak, std::abs (v));
    const double g = peak > 1e-6f ? 0.92 / (double) peak : 1.0;
    for (float& v : frame) v = (float) ((double) v * g);
}

// JS analyzeFrame(): naive DFT bin per harmonic, magnitudes + phases.
// mag/phase are Float32Array in JS — stores round to float32.
struct Spectrum
{
    std::vector<float> mag;
    std::vector<float> phase;
};

inline Spectrum analyzeFrame (const std::vector<float>& frame, int numHarmonics = kNumHarmonics)
{
    Spectrum s;
    s.mag.assign ((size_t) numHarmonics + 1, 0.0f);
    s.phase.assign ((size_t) numHarmonics + 1, 0.0f);
    const int N = (int) frame.size();

    for (int h = 1; h <= numHarmonics; ++h)
    {
        double re = 0.0;
        double im = 0.0;
        const double factor = (2.0 * kPi * (double) h) / (double) N;
        for (int n = 0; n < N; ++n)
        {
            const double theta = factor * (double) n;
            re += (double) frame[(size_t) n] * std::cos (theta);
            im -= (double) frame[(size_t) n] * std::sin (theta);
        }
        re /= (double) (N / 2);
        im /= (double) (N / 2);
        s.mag[(size_t) h]   = (float) std::hypot (re, im);   // JS Math.hypot
        s.phase[(size_t) h] = (float) std::atan2 (im, re);
    }
    return s;
}

// JS synthesizeFrame(): band-limited resynthesis, then removeDC+normalize.
inline std::vector<float> synthesizeFrame (const std::vector<float>& mag,
                                           const std::vector<float>& phase,
                                           int frameSize)
{
    std::vector<float> frame ((size_t) frameSize, 0.0f);
    const int numHarmonics = (int) mag.size() - 1;
    for (int n = 0; n < frameSize; ++n)
    {
        double s = 0.0;
        const double thetaBase = (2.0 * kPi * (double) n) / (double) frameSize;
        for (int h = 1; h <= numHarmonics; ++h)
        {
            if ((double) mag[(size_t) h] > 1e-5)
                s += (double) mag[(size_t) h] * std::sin (thetaBase * (double) h + (double) phase[(size_t) h]);
        }
        frame[(size_t) n] = (float) s;
    }
    wtRemoveDC (frame);
    wtNormalize (frame);
    return frame;
}

// JS pseudoRandom(): deterministic 0..1 from an integer-valued seed.
inline double pseudoRandom (double seed)
{
    const double x = std::sin (seed) * 10000.0; // JS seed++ post-increment: uses the original value
    return x - std::floor (x);
}

// JS applySpectralWarp(): the port itself. `allFrames` is the table's full
// base-frame set (only modes 21 and 29 read it), `currentFrameIdx` the frame
// being warped. Returns a new frame; the input is untouched.
inline std::vector<float> applySpectralWarp (const std::vector<float>& frame,
                                             int mode,
                                             double amount,
                                             double param2 = 0.5,
                                             const std::vector<std::vector<float>>* allFrames = nullptr,
                                             int currentFrameIdx = 0)
{
    if (mode == 0 || amount == 0.0)
        return frame;

    const Spectrum spec = analyzeFrame (frame);
    std::vector<float> newMag = spec.mag;
    std::vector<float> newPhase = spec.phase;
    const int numHarmonics = kNumHarmonics;
    const double a = std::max (0.0, std::min (1.0, amount));

    switch (mode)
    {
        case 13: { // Formant
            const double center = 2.0 + param2 * 30.0;
            const double sigma = 1.0 + (1.0 - a) * 8.0;
            for (int h = 1; h <= numHarmonics; ++h)
            {
                const double dh = (double) h - center;
                const double gain = std::exp (-(dh * dh) / (2.0 * sigma * sigma));
                newMag[(size_t) h] = (float) ((double) newMag[(size_t) h] * ((1.0 - a) + a * gain * 3.0));
            }
            break;
        }
        case 16: { // Harmonic Stretch
            const double factor = 0.2 + a * 3.5;
            for (int h = 1; h <= numHarmonics; ++h)
            {
                const double srcBin = (double) h / factor;
                const int iBin = (int) std::floor (srcBin);
                const double frac = srcBin - (double) iBin;
                if (iBin >= 1 && iBin < numHarmonics)
                    newMag[(size_t) h] = (float) ((double) spec.mag[(size_t) iBin]
                                        + ((double) spec.mag[(size_t) (iBin + 1)] - (double) spec.mag[(size_t) iBin]) * frac);
                else
                    newMag[(size_t) h] = 0.0f;
            }
            break;
        }
        case 17: { // Comb / Ripple
            const double freq = 0.1 + param2 * 1.5;
            for (int h = 1; h <= numHarmonics; ++h)
            {
                const double ripple = 1.0 + a * std::sin ((double) h * freq * kPi);
                newMag[(size_t) h] = (float) ((double) newMag[(size_t) h] * std::max (0.0, ripple));
            }
            break;
        }
        case 18: { // Inharmonic Stretch
            const double shift = 0.1 + a * 1.2;
            for (int h = 1; h <= numHarmonics; ++h)
            {
                const double srcBin = std::pow ((double) h, 1.0 / shift);
                const int iBin = (int) std::floor (srcBin);
                newMag[(size_t) h] = (iBin >= 1 && iBin < numHarmonics) ? spec.mag[(size_t) iBin] : 0.0f;
            }
            break;
        }
        case 19: { // Smear
            const int radius = (int) std::floor (1.0 + a * 12.0);
            for (int h = 1; h <= numHarmonics; ++h)
            {
                double sum = 0.0;
                double wSum = 0.0;
                for (int k = -radius; k <= radius; ++k)
                {
                    const int bin = h + k;
                    if (bin >= 1 && bin <= numHarmonics)
                    {
                        const double w = std::exp (-((double) (k * k)) / (2.0 * std::pow ((double) radius / 2.0, 2.0)));
                        sum += (double) spec.mag[(size_t) bin] * w;
                        wSum += w;
                    }
                }
                newMag[(size_t) h] = wSum > 0.0 ? (float) (sum / wSum) : spec.mag[(size_t) h];
            }
            break;
        }
        case 20: { // Phase Disperse
            for (int h = 1; h <= numHarmonics; ++h)
                newPhase[(size_t) h] = (float) ((double) newPhase[(size_t) h]
                                      + a * std::sin ((double) h * param2 * kPi * 2.0));
            break;
        }
        case 21: { // Spectral Freeze
            if (allFrames != nullptr && ! allFrames->empty() && ! (*allFrames)[0].empty())
            {
                const Spectrum firstSpec = analyzeFrame ((*allFrames)[0]);
                for (int h = 1; h <= numHarmonics; ++h)
                    newMag[(size_t) h] = (float) ((double) firstSpec.mag[(size_t) h] * a
                                        + (double) spec.mag[(size_t) h] * (1.0 - a));
            }
            break;
        }
        case 22: { // Odd / Even
            const double balance = (param2 - 0.5) * 2.0; // -1 (odd) .. +1 (even)
            for (int h = 1; h <= numHarmonics; ++h)
            {
                if (h % 2 == 1) // odd
                    newMag[(size_t) h] = (float) ((double) newMag[(size_t) h] * std::max (0.0, 1.0 - a * balance));
                else            // even
                    newMag[(size_t) h] = (float) ((double) newMag[(size_t) h] * std::max (0.0, 1.0 + a * balance));
            }
            break;
        }
        case 23: { // Harmonic Shift
            const int shift = (int) std::floor ((param2 - 0.5) * 40.0 * a);
            for (int h = 1; h <= numHarmonics; ++h)
            {
                const int src = h - shift;
                newMag[(size_t) h] = (src >= 1 && src <= numHarmonics) ? spec.mag[(size_t) src] : 0.0f;
            }
            break;
        }
        case 24: { // Spectral Fold
            const int cutoff = std::max (4, (int) std::floor ((1.0 - a) * (double) numHarmonics));
            for (int h = 1; h <= numHarmonics; ++h)
            {
                if (h > cutoff)
                {
                    const int foldBin = cutoff - (h - cutoff);
                    if (foldBin >= 1 && foldBin <= numHarmonics)
                        newMag[(size_t) foldBin] = (float) ((double) newMag[(size_t) foldBin]
                                              + (double) spec.mag[(size_t) h] * 0.8);
                    newMag[(size_t) h] = 0.0f;
                }
            }
            break;
        }
        case 25: { // Harmonic Random
            const double seed = std::floor (param2 * 10000.0);
            for (int h = 1; h <= numHarmonics; ++h)
            {
                const double r = pseudoRandom (seed + (double) h);
                newMag[(size_t) h] = (float) ((double) newMag[(size_t) h] * ((1.0 - a) + a * r * 2.0));
            }
            break;
        }
        case 26: { // Phase Randomize
            const double seed = std::floor (param2 * 10000.0);
            for (int h = 1; h <= numHarmonics; ++h)
            {
                const double r = (pseudoRandom (seed + (double) h * 3.0) - 0.5) * kPi * 2.0;
                newPhase[(size_t) h] = (float) ((double) newPhase[(size_t) h] + a * r);
            }
            break;
        }
        case 27: { // Harmonic Rotate
            const int rot = (int) std::floor (a * (double) numHarmonics * param2);
            for (int h = 1; h <= numHarmonics; ++h)
            {
                const int src = ((h - 1 + rot) % numHarmonics) + 1;
                newMag[(size_t) h] = spec.mag[(size_t) src];
            }
            break;
        }
        case 28: { // Spectral Warp
            const double p = std::pow (2.0, (param2 - 0.5) * 4.0);
            for (int h = 1; h <= numHarmonics; ++h)
            {
                const double norm = (double) h / (double) numHarmonics;
                const double warpedNorm = std::pow (norm, p);
                const double srcBin = std::max (1.0, std::min ((double) numHarmonics, warpedNorm * (double) numHarmonics));
                const int iBin = (int) std::floor (srcBin);
                newMag[(size_t) h] = spec.mag[(size_t) iBin];
            }
            break;
        }
        case 29: { // Spectral Morph
            if (allFrames != nullptr && allFrames->size() > 1)
            {
                const int nextIdx = std::min ((int) allFrames->size() - 1, currentFrameIdx + 1);
                const Spectrum nextSpec = analyzeFrame ((*allFrames)[(size_t) nextIdx]);
                for (int h = 1; h <= numHarmonics; ++h)
                {
                    newMag[(size_t) h]   = (float) ((double) spec.mag[(size_t) h] * (1.0 - a)
                                          + (double) nextSpec.mag[(size_t) h] * a);
                    newPhase[(size_t) h] = (float) ((double) spec.phase[(size_t) h] * (1.0 - a)
                                          + (double) nextSpec.phase[(size_t) h] * a);
                }
            }
            break;
        }
        default:
            break;
    }

    return synthesizeFrame (newMag, newPhase, (int) frame.size());
}

}} // namespace faze::wt
