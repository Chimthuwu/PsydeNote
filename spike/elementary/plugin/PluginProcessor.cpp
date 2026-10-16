#include "PluginProcessor.h"
#include "WebViewEditor.h"
#include "Assets.h"
#include "Diag.h"
#include "CtlOut.h"
#include "WtSpectralWarp.h"
#include "WavetableBin.h"

#include <choc_javascript_QuickJS.h>

#include <cmath>
#include <unordered_map>

// ---------------------------------------------------------------------------
// Adapted from elemaudio/srvb (MIT). Diff from that template:
//   * constructor: output-only bus layout (instrument, no audio in)     [SYNTH]
//   * acceptsMidi() -> true                                             [SYNTH]
//   * processBlock: handleMidi() drives the VoicePool; the pool is
//     snapshotted for the main thread                                   [SYNTH]
//   * handleAsyncUpdate: folds the voice snapshot into `state` as
//     v{i}_gate / v{i}_freq before dispatching                          [SYNTH]
// Everything else — the QuickJS engine, the manifest-driven parameters, the
// state dispatch protocol — is srvb's, unchanged.
// ---------------------------------------------------------------------------

//==============================================================================
SynthPluginProcessor::SynthPluginProcessor()
    : AudioProcessor (BusesProperties()
                      // [SYNTH] audio input: the Audio Follower's sidechain AND the sampler's "Input"
                      // recording source. ON by default: JUCE's standalone host only leaves the MAIN buses
                      // at their default state (it calls disableNonMainBuses()), so a default-off input
                      // meant the standalone could never receive input at all. The standalone still MUTES
                      // its input until you un-mute it in the audio settings (JUCE's default), so no mic
                      // feedback; DAWs simply see an unconnected stereo input.
                      .withInput  ("Input", juce::AudioChannelSet::stereo(), true)
                      .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
    , jsContext (choc::javascript::createQuickJSContext())
{
#if ELEM_DEV_LOCALHOST
    auto manifestContents = juce::URL ("http://localhost:5174/manifest.json")
        .readEntireTextStream().toStdString();
#else
    auto manifestContents = getEmbeddedAssetAsString ("manifest.json");
    if (manifestContents.empty()) return;
#endif

    auto manifest = elem::js::parseJSON (manifestContents);
    if (! manifest.isObject()) return;

    auto parameters = manifest.getWithDefault ("parameters", elem::js::Array());

    for (size_t i = 0; i < parameters.size(); ++i)
    {
        auto d = parameters[i];
        if (! d.isObject()) continue;

        auto paramId  = d.getWithDefault ("paramId", elem::js::String ("unknown"));
        auto name     = d.getWithDefault ("name", elem::js::String ("Unknown"));
        auto minValue = d.getWithDefault ("min", elem::js::Number (0));
        auto maxValue = d.getWithDefault ("max", elem::js::Number (1));
        auto defValue = d.getWithDefault ("defaultValue", elem::js::Number (0));

        auto* p = new juce::AudioParameterFloat (
            juce::ParameterID (paramId, 1), name,
            { (float) minValue, (float) maxValue }, (float) defValue);

        p->addListener (this);
        addParameter (p);

        paramReadouts.emplace_back (ParameterReadout { (float) defValue, false });
        state.insert_or_assign (paramId, defValue);

        if (paramId == "voice_mode") voiceModeParam = p;
    }

    // [SYNTH] Sampler (todo.md §114) — seed the per-operator sample keys so
    // setStateInformation's "only update existing keys" guard accepts them
    // on reload. Not manifest params (a file path/version isn't a bounded
    // AudioParameterFloat), but `state` is a plain JSON object underneath,
    // so a string/int here round-trips through getStateInformation exactly
    // like every float param does.
    sampleFormatManager.registerBasicFormats();
    for (int k = 0; k < 4; ++k)
    {
        state.insert_or_assign ("op" + std::to_string (k) + "_samplepath", std::string());
        state.insert_or_assign ("op" + std::to_string (k) + "_sampleversion", 0.0);
        state.insert_or_assign ("op" + std::to_string (k) + "_sampleduration", 0.0);
        state.insert_or_assign ("op" + std::to_string (k) + "_samplepeaks", std::string());
        // [SYNTH] Sampler upgrade (Task 6, multi-agent work order) — the
        // resampled buffer's exact frame count, so dsp/synth.js can convert
        // the UI's 0..1 start/end trim fractions into the native
        // SampleNode's sample-unit startOffset/stopOffset.
        state.insert_or_assign ("op" + std::to_string (k) + "_sampleframes", 0.0);
    }

    // [SYNTH] LFO Function editor (todo.md — "all LFOs are functions") —
    // seed lfo{1,2,3}_functionShape so setStateInformation's "only update
    // existing keys" guard accepts a saved project's shape on reload, same
    // precedent as the sampler keys above. Point data isn't a bounded host
    // float, so it never became a manifest AudioParameterFloat — see
    // `setFunctionShape` (travels over its own native message instead). A
    // simple non-flat bump (matching shared/types.ts's
    // DEFAULT_FUNCTION_SHAPE) so a brand new instance isn't silent before
    // the UI's first mount round-trip replaces it with the real patch.
    {
        static const std::string kDefaultFunctionShapeJson =
            "{\"points\":[{\"time\":0,\"level\":0,\"curve\":0},"
            "{\"time\":0.5,\"level\":1,\"curve\":0},"
            "{\"time\":1,\"level\":0,\"curve\":0}],"
            "\"drawMode\":\"edit\",\"bipolar\":true}";
        for (int n = 1; n <= 10; ++n)
            state.insert_or_assign ("lfo" + std::to_string (n) + "_functionShape",
                                     elem::js::parseJSON (kDefaultFunctionShapeJson));
    }

    // [SYNTH] Parametric EQ band list (todo.md) — same "seed it so
    // setStateInformation's guard accepts a reload" reasoning as the LFO
    // shapes above. An empty array is a fully valid (flat/no-op) EQ state,
    // matching shared/types.ts's default `{ bands: [] }`.
    state.insert_or_assign ("fx_eq_bands", elem::js::parseJSON ("[]"));

    // [SYNTH] P7c — drain el.scope frames toward the webview at ~30Hz.
    // Was 20Hz; bumped once (todo.md §99 — user compared Faze's scope
    // motion unfavourably to Recordr's, which reads a LIVE Web Audio
    // AnalyserNode every rAF tick, ~60fps — not possible here since the
    // audio lives in native Elementary DSP, not a Web Audio node, so the
    // webview only ever sees whatever this timer forwards). Kept well
    // below 60Hz deliberately: this codebase has hit real perf/freeze
    // issues before from per-frame native<->webview traffic (§73/§91), so
    // this is a modest, bounded step (+50%) rather than jumping straight
    // to matching Recordr's rate — re-evaluate with real measurement
    // before pushing further.
    scopeTimer.fn = [this] { drainScopes(); };
    scopeTimer.startTimerHz (60); // 60Hz: main scope frames are 1024 samples (~47/s), so 30Hz threw half of them away
}

SynthPluginProcessor::~SynthPluginProcessor()
{
    scopeTimer.stopTimer();
    for (auto& p : getParameters())
        p->removeListener (this);
}

//==============================================================================
juce::AudioProcessorEditor* SynthPluginProcessor::createEditor()
{
    // FROZEN size (todo.md §94, user request) — exactly the window the user
    // screenshotted and asked to lock: no clipping, no dead space. See the
    // comment in WebViewEditor's ctor; this is now the ONLY size, resizing
    // is off.
    return new WebViewEditor (this, 1272, 984); // 952 + 32 (title bar) + 32 (taller top bar for the arp/seq strip)
}

bool SynthPluginProcessor::hasEditor() const { return true; }

const juce::String SynthPluginProcessor::getName() const { return JucePlugin_Name; }

bool SynthPluginProcessor::acceptsMidi() const   { return true; }   // [SYNTH]
bool SynthPluginProcessor::producesMidi() const  { return false; }
bool SynthPluginProcessor::isMidiEffect() const  { return false; }
double SynthPluginProcessor::getTailLengthSeconds() const { return 3.0; } // longest release

int SynthPluginProcessor::getNumPrograms() { return 1; }
int SynthPluginProcessor::getCurrentProgram() { return 0; }
void SynthPluginProcessor::setCurrentProgram (int) {}
const juce::String SynthPluginProcessor::getProgramName (int) { return {}; }
void SynthPluginProcessor::changeProgramName (int, const juce::String&) {}

//==============================================================================
void SynthPluginProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    if (sampleRate != lastKnownSampleRate || samplesPerBlock != lastKnownBlockSize)
    {
        lastKnownSampleRate = sampleRate;
        lastKnownBlockSize = samplesPerBlock;
        shouldInitialize.store (true);
    }

    scratchBuffer.setSize (2, samplesPerBlock);
    sidechainBuf.setSize (2, samplesPerBlock);
    sidechainBuf.clear();
    triggerAsyncUpdate();
}

void SynthPluginProcessor::releaseResources() {}

bool SynthPluginProcessor::isBusesLayoutSupported (const AudioProcessor::BusesLayout& layouts) const
{
    const auto in = layouts.getMainInputChannelSet();
    return layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo()
        && (in.isDisabled() || in == juce::AudioChannelSet::mono() || in == juce::AudioChannelSet::stereo());
}

//==============================================================================
void SynthPluginProcessor::handleMidi (const juce::MidiBuffer& midi)   // [SYNTH]
{
    // Block-rate allocation: good enough for a spike (one 128-sample block at
    // 48k is ~2.7 ms of jitter on note timing). Sample-accurate scheduling
    // would split the block on each MIDI timestamp.
    bool anyNoteEvent = false;

    // Voice mode (poly/mono/legato) comes straight off the host param; a
    // change drops sounding notes. A mono retrigger dipped the gate for the
    // previous block: bring it back now.
    if (voiceModeParam != nullptr)
    {
        const int before = voicePool.mode;
        voicePool.setMode ((int) std::lround (voiceModeParam->get()));
        if (voicePool.mode != before) anyNoteEvent = true;
    }
    if (voicePool.endRetrigger()) anyNoteEvent = true;

    for (const auto meta : midi)
    {
        const auto m = meta.getMessage();
        if (m.isNoteOn())
        {
            const int note = m.getNoteNumber();
            const int slot = voicePool.noteOn (note, m.getFloatVelocity());
            // Per-voice slide / tight-release from the arp (non-arp notes reset to 0).
            float slideMs = 0.0f, tight = 0.0f;
            if (arpCfgLive.on && note >= 0 && note < 128)
            {
                slideMs = arp.slideMsForNote[(size_t) note];
                tight   = arp.tightForNote[(size_t) note] != 0 ? 1.0f : 0.0f;
            }
            voiceCtlBank->setSlideTight (slot, slideMs, tight);
            anyNoteEvent = true;
        }
        else if (m.isNoteOff())
        {
            voicePool.noteOff (m.getNoteNumber());
            anyNoteEvent = true;
        }
        else if (m.isAllNotesOff() || m.isAllSoundOff())
        {
            voicePool.allNotesOff();
            anyNoteEvent = true;
        }
    }

    // Feed the audio-thread graph node straight away (no lock, no JS).
    if (anyNoteEvent)
        for (int i = 0; i < kNumVoices; ++i)
            voiceCtlBank->set (i, voicePool.voices[i].gate, voicePool.voices[i].freq, voicePool.voices[i].vel);

    // Publish the voice snapshot ONLY when a note actually changed (plus a
    // retry if a prior publish couldn't get the lock). Doing it every block
    // set voicesDirty every block → triggerAsyncUpdate every block → a full
    // renderSynth reconcile on the message thread, continuously: ~100% of a
    // core at idle once P5 grew the graph (§73).
    if (! anyNoteEvent && ! voiceSnapshotPending.load())
        return;

    // PERF: every note on/off publishes a snapshot, and every publish runs a full
    // renderSynth reconcile on the message thread (~54 ms, up to 216 ms). With the
    // arp running that is one rebuild per step, which starves the UI and makes
    // parameter changes take seconds to land. The audio does NOT wait for this:
    // gates and frequencies reach the DSP through the voicectl bank, which is set
    // every block above. So the UI-side snapshot is throttled to 5 a second and the
    // pending flag guarantees the latest state is still published.
    const juce::uint32 nowMs = juce::Time::getMillisecondCounter();
    if (nowMs - lastVoicePublishMs < 200)
    {
        voiceSnapshotPending.store (true);
        return;
    }
    lastVoicePublishMs = nowMs;

    const juce::SpinLock::ScopedTryLockType sl (voiceLock);
    if (sl.isLocked())
    {
        for (int i = 0; i < kNumVoices; ++i)
        {
            voiceSnapshot.gate[i] = voicePool.voices[i].gate;
            voiceSnapshot.freq[i] = voicePool.voices[i].freq;
            voiceSnapshot.vel[i]  = voicePool.voices[i].vel;
        }
        voiceSnapshotPending.store (false);
        voicesDirty.store (true);
    }
    else
    {
        voiceSnapshotPending.store (true); // retry next block, note not lost
    }
}

void SynthPluginProcessor::pushUiNote (int midiNote, bool on, float velocity)   // [SYNTH]
{
    if (midiNote < 0 || midiNote > 127) return;
    const juce::SpinLock::ScopedLockType sl (uiMidiLock);
    uiMidiQueue.add (on ? juce::MidiMessage::noteOn (1, midiNote, juce::jlimit (0.0f, 1.0f, velocity))
                        : juce::MidiMessage::noteOff (1, midiNote));
}

void SynthPluginProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages)
{
    juce::ScopedNoDenormals noDenormals;

    // [SYNTH] fold any webview-piano notes into the MIDI stream (sample 0).
    {
        const juce::SpinLock::ScopedTryLockType sl (uiMidiLock);
        if (sl.isLocked() && ! uiMidiQueue.isEmpty())
        {
            for (auto& m : uiMidiQueue)
                midiMessages.addEvent (m, 0);
            uiMidiQueue.clearQuick();
        }
    }

    if (auto* ph = getPlayHead())              // host tempo → LFO sync (§88.A)
        if (auto pos = ph->getPosition())
            if (auto bpm = pos->getBpm(); bpm && *bpm > 1.0)
                lastKnownBpm.store (*bpm);

    // [SYNTH] arp/seq: consumes the raw note stream, emits sample-accurate
    // note on/off (identity pass-through while the arp is off).
    if (arpCfgDirty.load())
    {
        const juce::SpinLock::ScopedTryLockType al (arpLock);
        if (al.isLocked()) { arpCfgLive = arpCfgPending; arpCfgDirty.store (false); }
    }
    {
        ArpTransport tr;
        tr.bpm = lastKnownBpm.load();
        if (auto* ph = getPlayHead())
            if (auto pos = ph->getPosition())
            {
                if (auto bpm = pos->getBpm(); bpm && *bpm > 1.0) tr.bpm = *bpm;
                tr.playing = pos->getIsPlaying();
                if (auto ppq = pos->getPpqPosition())
                {
                    tr.ppq = *ppq;
                    tr.ppqValid = true;
                }
            }
        // Graph-side modulation of the native arp (ctlout nodes, one block old).
        std::array<float, kArpMods> mod {};
        for (size_t i = 0; i < mod.size() && i < (size_t) kCtlOutSlots; ++i)
            mod[i] = ctlOutBank->v[i].load();
        // The pattern selector and Chaos master are HOST PARAMS, not part of the
        // arp JSON, so they arrive here rather than through setArpConfig. Applying
        // them to the live config every block is what keeps the pattern grid, the
        // slider and host automation from disagreeing: the param is the authority
        // and the UI writes it whenever a pattern tile is clicked.
        arpCfgLive.patternPos  = arpPatternParam.load();
        arpCfgLive.chaosAmount = arpChaosParam.load();
        arp.process (midiMessages, arpOut, buffer.getNumSamples(), getSampleRate(), arpCfgLive, tr, mod);
    }
    midiMessages.swapWith (arpOut);

    handleMidi (midiMessages);                 // [SYNTH]

    if (voicesDirty.exchange (false))          // [SYNTH] push note changes toward JS
        triggerAsyncUpdate();

    // [SYNTH] Sidechain: the host's input channels share `buffer` with the
    // output, so copy them out BEFORE clearing. Always hand the runtime two
    // input channels (zeros when the bus is off / absent) so `el.in` is valid.
    const int nSamples = buffer.getNumSamples();
    if (sidechainBuf.getNumSamples() < nSamples) sidechainBuf.setSize (2, nSamples, false, false, true);
    sidechainBuf.clear (0, nSamples);
    if (getBusCount (true) > 0)
        if (auto* sb = getBus (true, 0); sb != nullptr && sb->isEnabled())
        {
            auto in = getBusBuffer (buffer, true, 0);
            const int nIn = juce::jmin (in.getNumChannels(), 2);
            for (int ch = 0; ch < 2; ++ch)
                if (nIn > 0)
                    sidechainBuf.copyFrom (ch, 0, in, juce::jmin (ch, nIn - 1), 0, nSamples);
        }

    buffer.clear();

    if (runtime != nullptr)
    {
        runtime->process (
            const_cast<const float**> (sidechainBuf.getArrayOfReadPointers()), 2,
            const_cast<float**> (buffer.getArrayOfWritePointers()),
            buffer.getNumChannels(),
            nSamples,
            nullptr);
    }

    // [SYNTH] recording: mono-mix the finished master output (source 0) or the audio INPUT (source 1).
    if (recOp.load() >= 0)
    {
        const juce::SpinLock::ScopedTryLockType rl (recLock);
        if (rl.isLocked() && recOp.load() >= 0)
        {
            const int cap = (int) recBuf.size();
            const int pos = recPos.load();
            const int n = juce::jmin (buffer.getNumSamples(), cap - pos);
            if (recSource.load() == 1)
            {
                for (int i = 0; i < n; ++i)
                    recBuf[(size_t) (pos + i)] = 0.5f * (sidechainBuf.getReadPointer (0)[i] + sidechainBuf.getReadPointer (1)[i]);
            }
            else
            {
                const int nch = buffer.getNumChannels();
                for (int i = 0; i < n; ++i)
                {
                    float s = 0.0f;
                    for (int ch = 0; ch < nch; ++ch) s += buffer.getReadPointer (ch)[i];
                    recBuf[(size_t) (pos + i)] = s / (float) juce::jmax (1, nch);
                }
            }
            recPos.store (pos + n);
            if (pos + n >= cap)
            {
                recDone.store (true);
                triggerAsyncUpdate();
            }
        }
    }
}

//==============================================================================
void SynthPluginProcessor::parameterValueChanged (int parameterIndex, float newValue)
{
    auto& pr = *std::next (paramReadouts.begin(), parameterIndex);
    pr.store ({ newValue, true });
    triggerAsyncUpdate();
}

void SynthPluginProcessor::parameterGestureChanged (int, bool) {}

//==============================================================================
void SynthPluginProcessor::handleAsyncUpdate()
{
    // DIAGNOSTIC (todo.md §137 — live crash investigation, wtPos/FM/PM knobs).
    // handleAsyncUpdate and dispatchStateChange are only ever supposed to run
    // on the message thread, non-reentrantly. This is a cheap, decisive check
    // for the opposite — a stray nested message pump (WebView2 completion
    // callback, a modal, anything) re-entering this call while one is already
    // in flight, mutating `state`/`runtime` (neither built for reentrancy)
    // out from under itself. Logs loudly and once per depth level if it ever
    // happens; near-zero cost otherwise (one thread_local int compare).
    static thread_local int wtDiagAsyncDepth = 0;
    struct DepthGuard {
        int& depth;
        DepthGuard (int& d) : depth (d)
        {
            ++depth;
            if (depth > 1)
                fazeDiagLog ("[REENTRANCY][ERROR] handleAsyncUpdate re-entered at depth " + juce::String (depth));
        }
        ~DepthGuard() { --depth; }
    } wtDiagGuard (wtDiagAsyncDepth);

    if (recDone.exchange (false))
        finishResampleRecording();

    if (shouldInitialize.exchange (false))
    {
        runtime = std::make_unique<elem::Runtime<float>> (lastKnownSampleRate, lastKnownBlockSize);
        runtime->registerNodeType ("voicectl",
            [bank = voiceCtlBank] (elem::NodeId const id, double sr, int const bs)
                -> std::shared_ptr<elem::GraphNode<float>>
            { return std::make_shared<VoiceCtlNode<float>> (id, sr, bs, bank); });
        runtime->registerNodeType ("ctlout",
            [bank = ctlOutBank] (elem::NodeId const id, double sr, int const bs)
                -> std::shared_ptr<elem::GraphNode<float>>
            { return std::make_shared<CtlOutNode<float>> (id, sr, bs, bank); });
        initJavaScriptEngine();
        // [SYNTH] Sampler (todo.md §114) — a fresh runtime has none of the
        // versioned sample resources registered; re-decode from whatever
        // paths setStateInformation already parsed (which may have run
        // before this branch ever fired, since hosts often call it before
        // the first prepareToPlay).
        reloadSamplesFromPaths();
        // [SYNTH] Load precomputed wavetables.bin from plugin directory
        // (81 MB is too large to embed as C++ code - MSVC C1060 out of heap)
        auto binPath = juce::File::getSpecialLocation (juce::File::currentExecutableFile)
                          .getParentDirectory().getChildFile ("wavetables.bin");
        
        // Fallback: try relative to plugin directory for dev builds
        if (!binPath.existsAsFile())
            binPath = juce::File (__FILE__).getParentDirectory().getChildFile ("wavetables.bin");
        
        if (binPath.existsAsFile())
        {
            if (binPath.loadFileAsData (wavetableBinData))
            {
                auto parsed = faze::wt::WavetableBin::parse (
                    static_cast<const char*>(wavetableBinData.getData()), 
                    wavetableBinData.getSize());
                if (parsed.has_value())
                {
                    wavetableBin = std::move(*parsed);
                    wavetableBinValid = true;
                    fazeDiagLog ("[wt] Loaded wavetables.bin: " + juce::String ((int) wavetableBin.header.tableCount) + 
                                 " tables, " + juce::String ((int) wavetableBin.header.frameSize) + " samples/frame from " + binPath.getFullPathName());
                }
                else
                    fazeDiagLog ("[wt] wavetables.bin parse failed");
            }
            else
                fazeDiagLog ("[wt] Failed to read wavetables.bin");
        }
        else
            fazeDiagLog ("[wt] wavetables.bin not found at " + binPath.getFullPathName() + " - tables will use generated fallback");
        
        // [SYNTH] Real wavetable synthesis (Task 4) — constant curated
        // data, so just register it fresh every time the runtime is
        // (re)built, same lifecycle spot as the sample reload above.
        userWavetables.scan (faze::uwt::activeFolder());
        registerBuiltinWavetables();
        // A fresh runtime has none of the warped resources registered
        // either — drop the tracking cache so ensureWavetableWarpResources()
        // (below, every call) regenerates them against the new runtime
        // rather than trusting stale keys from a runtime that no longer
        // exists.
        registeredWavetableWarpKeys.clear();
        registeredWavetableIds.clear();
    }

    auto& params = getParameters();

    for (size_t i = 0; i < paramReadouts.size(); ++i)
    {
        auto& current = *std::next (paramReadouts.begin(), i);
        auto pr = current.exchange ({ 0.0f, false });

        if (pr.dirty)
            if (auto* pf = dynamic_cast<juce::AudioParameterFloat*> (params[(int) i]))
                // `pr.value` is the normalised 0..1 the listener received;
                // `state` (and the DSP + webview) speak REAL units. Convert
                // back. (todo.md §73 P7a — before this, any host/UI param
                // change fed the DSP a 0..1 value it read as Hz/semitones.)
                state.insert_or_assign (pf->paramID.toStdString(),
                                        elem::js::Number (pf->convertFrom0to1 (pr.value)));
    }

    // [SYNTH] fold the latest voice snapshot into state
    {
        const juce::SpinLock::ScopedLockType sl (voiceLock);
        for (int i = 0; i < kNumVoices; ++i)
        {
            state.insert_or_assign ("v" + std::to_string (i) + "_gate", elem::js::Number (voiceSnapshot.gate[i]));
            state.insert_or_assign ("v" + std::to_string (i) + "_freq", elem::js::Number (voiceSnapshot.freq[i]));
            state.insert_or_assign ("v" + std::to_string (i) + "_vel",  elem::js::Number (voiceSnapshot.vel[i]));
        }
    }

    // [SYNTH] arp host params -> audio thread. These two live in `state` like any
    // other manifest param, but the arp is native and takes its config as JSON,
    // so they cross over here as plain atomics (read in processBlock, above).
    {
        auto pick = [this] (const char* key, float fallback) {
            auto it = state.find (key);
            return (it != state.end() && it->second.isNumber()) ? (float) (double) it->second : fallback;
        };
        arpPatternParam.store (juce::jlimit (0.0f, 1.0f, pick ("arp_pattern", 0.0f)));
        arpChaosParam.store   (juce::jlimit (0.0f, 1.0f, pick ("arp_chaos", 1.0f)));
    }

    // [SYNTH] Wavetable Warp resource pipeline (minimal proof) — every
    // handleAsyncUpdate, not just on runtime creation, since warp params
    // arrive here via the ordinary state-folding loop above just like any
    // other oscillator param. Cheap when nothing new is dialed in (an
    // unordered_set lookup per operator); only generates when a genuinely
    // new warp key shows up.
    ensureWavetableWarpResources();

    scheduleStateDispatch();
}

// Debounce with a hard ceiling: (re)start a short timer so a burst pushes
// once it settles, but never defer longer than ~90ms so a sustained stream
// (arpeggio, automation sweep) still tracks. A held chord already coalesces
// via the AsyncUpdater; the problem was rapid on/off across blocks queuing
// one 60-80ms renderSynth rebuild per event and saturating the message
// thread (froze Bitwig + FL — §73).
void SynthPluginProcessor::scheduleStateDispatch()
{
    const auto now = juce::Time::getMillisecondCounter();
    if (! isTimerRunning())
        firstDeferMs = now;
    // Adaptive: a reconcile costs ~50ms in QuickJS (measured, median 54ms,
    // max 216ms) and runs on the message thread. Debouncing at a fixed 18ms
    // meant a knob drag queued a new rebuild the instant the last one
    // finished, pinning the message thread (UI + scope drain starve). Wait
    // at least as long as the last rebuild took, so the thread keeps ~50%
    // headroom for painting and scope frames.
    const int lastCost = (int) lastReconcileMs.load();
    const int ceiling = juce::jmax (90, lastCost * 3);
    if (now - firstDeferMs >= (juce::uint32) ceiling)
    {
        stopTimer();
        dispatchStateChange();
        firstDeferMs = now;
        return;
    }
    startTimer (juce::jmax (18, lastCost));
}

void SynthPluginProcessor::timerCallback()
{
    stopTimer();
    firstDeferMs = juce::Time::getMillisecondCounter();
    dispatchStateChange();
}

//==============================================================================
void SynthPluginProcessor::initJavaScriptEngine()
{
    jsContext = choc::javascript::createQuickJSContext();

    jsContext.registerFunction ("__postNativeMessage__", [this] (choc::javascript::ArgumentList args) {
        auto const batch = elem::js::parseJSON (args[0]->toString());
        // DIAGNOSTIC (todo.md §137) — throttled the same way
        // dispatchStateChange's own timing log already is, so this doesn't
        // meaningfully add to per-call cost during a knob drag.
        static std::atomic<int> applyCount { 0 };
        const int an = ++applyCount;
        const size_t batchSize = batch.isArray() ? batch.getArray().size() : 0;
        // Timed, so a slow dispatch can be split into the QuickJS render (JS) and this native apply.
        const auto tApply0 = juce::Time::getMillisecondCounterHiRes();
        auto const rc = runtime->applyInstructions (batch);
        const auto applyMs = juce::Time::getMillisecondCounterHiRes() - tApply0;
        if (applyMs > 20.0)
            fazeDiagLog ("[perf] applyInstructions took " + juce::String (applyMs, 1) + "ms, batchSize="
                         + juce::String ((int) batchSize));
        if (rc != elem::ReturnCode::Ok())
        {
            dispatchError ("Runtime Error", elem::ReturnCode::describe (rc));
            // A failed batch leaves the native graph and the JS renderer's idea of it out of step, so every
            // later batch fails too (total silence). Rebuild the runtime + JS engine from `state` — rate
            // limited so a persistent fault cannot loop.
            {
                static std::atomic<juce::int64> lastRecoverMs { 0 };
                static std::atomic<int> recoverCount { 0 };
                const auto nowMs = juce::Time::currentTimeMillis();
                if (recoverCount.load() < 5 && nowMs - lastRecoverMs.load() > 2000)
                {
                    lastRecoverMs.store (nowMs);
                    ++recoverCount;
                    fazeDiagLog ("[recover] rebuilding the audio graph after a failed batch (#" + juce::String (recoverCount.load()) + ")");
                    shouldInitialize.store (true);
                    triggerAsyncUpdate();
                }
            }
            fazeDiagLog ("[wtdiag][ERROR] applyInstructions #" + juce::String (an) + " FAILED, batchSize="
                         + juce::String ((int) batchSize) + ": " + juce::String (elem::ReturnCode::describe (rc)));
        }
        else if (an <= 40 || (an % 50) == 0)
        {
            fazeDiagLog ("[wtdiag] applyInstructions #" + juce::String (an) + " ok, batchSize=" + juce::String ((int) batchSize));
        }
        return choc::value::Value();
    });

    jsContext.registerFunction ("__log__", [this] (choc::javascript::ArgumentList args) {
        for (size_t i = 0; i < args.numArgs; ++i)
            DBG (choc::json::toString (*args[i]));
        return choc::value::Value();
    });

    jsContext.evaluate (R"shim(
(function() {
  if (typeof globalThis.console === 'undefined') {
    globalThis.console = {
      log:  (...a) => __log__('[dsp:log]', ...a),
      warn: (...a) => __log__('[dsp:warn]', ...a),
      error:(...a) => __log__('[dsp:error]', ...a),
    };
  }
})();
    )shim");

#if ELEM_DEV_LOCALHOST
    auto dspSrc = juce::URL ("http://localhost:5174/dsp.main.js")
        .readEntireTextStream().toStdString();
#else
    auto dspSrc = getEmbeddedAssetAsString ("dsp.main.js");
    if (dspSrc.empty()) return;
#endif
    jsContext.evaluate (dspSrc);
}

void SynthPluginProcessor::dispatchStateChange()
{
    // DIAGNOSTIC (todo.md §137) — same reentrancy check as handleAsyncUpdate,
    // separate counter since this can also be called directly (not just via
    // handleAsyncUpdate) — see initJavaScriptEngine's "ready"/"reload" paths.
    static thread_local int wtDiagDispatchDepth = 0;
    struct DepthGuard {
        int& depth;
        DepthGuard (int& d) : depth (d)
        {
            ++depth;
            if (depth > 1)
                fazeDiagLog ("[REENTRANCY][ERROR] dispatchStateChange re-entered at depth " + juce::String (depth));
        }
        ~DepthGuard() { --depth; }
    } wtDiagGuard (wtDiagDispatchDepth);

    // A sample version in `state` that has no registered resource behind it (file missing/unreadable after a
    // reload, state restored from an older session, runtime rebuilt) makes Elementary reject the node's path
    // and FAIL THE WHOLE BATCH — every later batch then fails too (silent synth, "sampler doesn't work").
    // Only ever advertise versions that are really loaded.
    for (int k = 0; k < 4; ++k)
    {
        const auto vk = "op" + std::to_string (k) + "_sampleversion";
        auto it = state.find (vk);
        if (it != state.end() && it->second.isNumber() && (double) it->second > 0.5 && (! sampleLoaded[k] || runtime == nullptr))
        {
            fazeDiagLog ("[sample] op" + juce::String (k) + " advertises an unloaded sample version - zeroed");
            state.insert_or_assign (vk, 0.0);
            state.insert_or_assign ("op" + std::to_string (k) + "_sampleframes", 0.0);
        }
    }

    static std::atomic<int> callCount { 0 };
    const int n = ++callCount;
    const auto t0 = juce::Time::getMillisecondCounterHiRes();

    const auto* kScript = R"script(
(function() {
  if (typeof globalThis.__receiveStateChange__ !== 'function') return false;
  globalThis.__receiveStateChange__(%);
  return true;
})();
)script";

    auto localState = state;
    localState.insert_or_assign ("sampleRate", lastKnownSampleRate);
    localState.insert_or_assign ("bpm", lastKnownBpm.load());
    localState.insert_or_assign ("standalone", elem::js::Number (wrapperType == wrapperType_Standalone ? 1.0 : 0.0));

    auto expr = juce::String (kScript)
        .replace ("%", elem::js::serialize (elem::js::serialize (localState))).toStdString();

    const auto tSer = juce::Time::getMillisecondCounterHiRes();

    if (auto* editor = static_cast<WebViewEditor*> (getActiveEditor()))
        editor->getWebViewPtr()->evaluateJavascript (expr);

    const auto tWv = juce::Time::getMillisecondCounterHiRes();

    // FIX (todo.md §141/§142) — ROOT CAUSE of the wtPos/FM-PM/pure-idle
    // crash finally confirmed via a symbolized minidump (RelWithDebInfo +
    // cdb, after cross-thread-race/reentrancy/other-call-site theories all
    // came up empty): dsp.main.js's renderSynth can throw a JS-level runtime
    // error under certain state combinations, which QuickJSContext::evaluate
    // surfaces as a THROWN C++ exception — and nothing anywhere in the call
    // chain (this function -> JUCE's Timer/message dispatch loop -> the
    // CRT's unhandled-exception filter) ever caught it, so it always reached
    // terminate()/abort(). This one call — not applyInstructions, not
    // __postNativeMessage__, not drainScopes — was the actual throw site.
    // Same surfacing pattern applyInstructions failures already use
    // (dispatchError), so a real DSP bug is still visible in the UI instead
    // of silently swallowed, but it no longer takes the whole process down.
    try
    {
        jsContext.evaluate (expr); // DSP reconcile — synchronous on the message thread
    }
    catch (const std::exception& e)
    {
        fazeDiagLog (juce::String ("[wtdiag][ERROR][ROOT CAUSE] dispatchStateChange's jsContext.evaluate threw: ") + juce::String (e.what()));
        dispatchError ("DSP Reconcile Error", e.what());
    }
    catch (...)
    {
        fazeDiagLog ("[wtdiag][ERROR][ROOT CAUSE] dispatchStateChange's jsContext.evaluate threw (non-std)");
    }

    const auto tEnd = juce::Time::getMillisecondCounterHiRes();
    lastReconcileMs.store ((float) (tEnd - tWv));
    if (n <= 40 || (n % 50) == 0)
        fazeDiagLog ("dispatchStateChange #" + juce::String (n)
                     + "  serialize=" + juce::String (tSer - t0, 1) + "ms"
                     + " webview=" + juce::String (tWv - tSer, 1) + "ms"
                     + " dspReconcile=" + juce::String (tEnd - tWv, 1) + "ms");
}

//==============================================================================
void SynthPluginProcessor::drainScopes()
{
    // DIAGNOSTIC (todo.md §139/§140) — this runs continuously at 30Hz for
    // the ENTIRE processor lifetime (scopeTimer starts in the constructor,
    // stops only in the destructor — not tied to the editor being open),
    // completely independent of any user interaction. Every crash reproduced
    // so far happened 1-8s after launch with ZERO log activity from any
    // knob/MIDI/dispatch code in between — that's 30-240 silent ticks of
    // THIS function, the one remaining unlogged, continuously-running path.
    // Heartbeat + a tight try/catch to test it directly.
    static std::atomic<int> scopeTickCount { 0 };
    const int stc = ++scopeTickCount;
    if (stc <= 10 || (stc % 60) == 0) // first 10 ticks, then ~every 2s
        fazeDiagLog ("[wtdiag] drainScopes tick #" + juce::String (stc));

    // Arp/seq playhead -> UI (only on change; <=60 Hz).
    if (auto* wed = static_cast<WebViewEditor*> (getActiveEditor()))
    {
        const int ph = arp.playhead.load();
        const int bar = arp.barCount.load();
        if (ph != lastSentPlayhead || bar != lastSentBar)
        {
            lastSentPlayhead = ph;
            lastSentBar = bar;
            wed->getWebViewPtr()->evaluateJavascript ("window.__arpPlayhead__&&window.__arpPlayhead__("
                                                      + std::to_string (ph) + "," + std::to_string (bar) + ");");
        }

        // Dice overlay (built here on the message thread, never on the audio thread).
        const bool overlayChanged = arp.readOverlay (lastOverlay);
        if (overlayChanged || overlayResend)
        {
            const auto& snap = lastOverlay;
            overlayResend = false;
            static const char* laneNames[7] = { "on", "prob", "pitch", "octave", "vel", "gate", "slide" };
            juce::String js ("window.__arpOverlay__&&window.__arpOverlay__({lanes:{");
            for (int l = 0; l < 7; ++l)
            {
                if (l > 0) js << ",";
                js << laneNames[l] << ":[";
                for (int i = 0; i < 16; ++i)
                {
                    if (i > 0) js << ",";
                    if (snap.has[l][i]) js << juce::String ((double) snap.v[l][i], 4);
                    else                js << "null";
                }
                js << "]";
            }
            js << "}});";
            wed->getWebViewPtr()->evaluateJavascript (js.toStdString());
        }
    }
    else
    {
        lastSentPlayhead = -2; // editor closed: resend on next open
        lastSentBar = -2;
        overlayResend = true;
    }

    // Resample-recording readout (op, elapsed seconds in 0.1 s steps; -1 idle).
    if (auto* wed = static_cast<WebViewEditor*> (getActiveEditor()))
    {
        const int ro = recOp.load();
        const int tenths = ro < 0 ? -1 : (int) (recPos.load() * 10.0 / juce::jmax (1.0, lastKnownSampleRate));
        if (tenths != lastSentRecTenths)
        {
            lastSentRecTenths = tenths;
            wed->getWebViewPtr()->evaluateJavascript ("window.__resampleState__&&window.__resampleState__("
                                                      + std::to_string (ro) + "," + std::to_string (tenths) + ");");
        }
    }

    if (runtime == nullptr)
        return;

    try
    {

    auto* ed = static_cast<WebViewEditor*> (getActiveEditor());
    if (ed == nullptr)                       // nobody's watching — but still
    {                                        // drain so the ring buffers don't
        runtime->processQueuedEvents ([] (std::string const&, elem::js::Value) {});
        return;
    }

    // Points forwarded per scope frame. Was a flat 128 for every source —
    // fine for a per-operator scope (~240px wide in the UI, ~1.9px/point),
    // but the relocated main visualizer (todo.md §96) renders ~1200px
    // wide, so the SAME 128 points there is ~9.4px/point: far coarser,
    // which is the real reason it "still looks a lil whack" next to the
    // per-op ones even after the render-side fixes (todo.md §101/§102 —
    // those fixed HOW the points are drawn, not how MANY there are). Give
    // `main` enough points to match the per-op scopes' density at its
    // actual on-screen width instead of raising every stream uniformly —
    // this only grows ONE of the 5 scope payloads, not all of them.
    // Scope transport (todo.md SS168). Every frame is now int16 little-endian
    // (was int8: ~-42 dB floor, visible as grain in the spectrum) and
    // decimated by a BOX AVERAGE (was "pick every 4th sample": no low-pass, so
    // everything above the new Nyquist aliased back into the FFT). `main` goes
    // out at its full 1024 samples — no decimation at all.
    constexpr int kOutDefault = 128;
    constexpr int kOutEq = 512;
    const bool wantEq = eqScopesWanted.load();
    std::map<std::string, juce::String> frames; // source -> base64(int16le[kOut]); last wins

    runtime->processQueuedEvents ([&frames, wantEq, kOutDefault, kOutEq] (std::string const& type, elem::js::Value data)
    {
        if (type != std::string ("scope") || ! data.isObject())
            return;

        auto const& obj = data.getObject();
        if (obj.count ("source") == 0 || obj.count ("data") == 0)
            return;
        if (! obj.at ("source").isString() || ! obj.at ("data").isArray())
            return;

        auto const& arr = obj.at ("data").getArray();
        if (arr.empty() || ! arr[0].isFloat32Array())
            return;
        auto const& s = arr[0].getFloat32Array();
        if (s.empty())
            return;

        const elem::js::String source = obj.at ("source");
        const bool isMain = (source == elem::js::String ("main"));
        const bool isEq = (source == elem::js::String ("eq_pre") || source == elem::js::String ("eq_post"));
        if (isEq && ! wantEq)
            return; // EQ editor not open: don't pay to encode/ship two scopes at 60Hz
        const bool isMainOrEq = isMain || isEq;
        const int kOut = isMain ? juce::jmin ((int) s.size(), 2048) : (isEq ? kOutEq : kOutDefault);

        juce::HeapBlock<juce::uint8> q ((size_t) kOut * 2);
        float peak = 0.0f;
        const auto srcN = (juce::int64) s.size();
        for (int i = 0; i < kOut; ++i)
        {
            const auto i0 = (size_t) ((juce::int64) i * srcN / kOut);
            const auto i1 = juce::jmax (i0 + 1, (size_t) ((juce::int64) (i + 1) * srcN / kOut));
            float acc = 0.0f;
            for (size_t j = i0; j < i1 && j < s.size(); ++j) acc += s[j];
            const float v = juce::jlimit (-1.0f, 1.0f, acc / (float) (i1 - i0));
            peak = juce::jmax (peak, std::abs (v));
            const int iv = juce::jlimit (-32767, 32767, juce::roundToInt (v * 32767.0f));
            q[(size_t) i * 2]     = (juce::uint8) (iv & 0xff);
            q[(size_t) i * 2 + 1] = (juce::uint8) ((iv >> 8) & 0xff);
        }

        // Skip a dead-silent operator scope — but always send `main` and EQ scopes (so a
        // release tail / silence still clears the scope).
        if (peak < 0.001f && ! isMainOrEq)
        {
            frames[source] = juce::String(); // empty -> UI draws a flat line
            return;
        }
        frames[source] = juce::Base64::toBase64 (q.getData(), (size_t) kOut * 2);
    });

    if (frames.empty())
        return;

    juce::String js = "window.__receiveScopes__&&window.__receiveScopes__({";
    bool first = true;
    for (auto const& kv : frames)
    {
        js << (first ? "" : ",") << '"' << juce::String (kv.first) << "\":\"" << kv.second << '"';
        first = false;
    }
    js << "});";
    ed->getWebViewPtr()->evaluateJavascript (js.toStdString());

    } // try
    catch (const std::exception& e)
    {
        fazeDiagLog (juce::String ("[wtdiag][ERROR] drainScopes threw: ") + juce::String (e.what()));
    }
    catch (...)
    {
        fazeDiagLog ("[wtdiag][ERROR] drainScopes threw (non-std)");
    }
}

void SynthPluginProcessor::dispatchError (std::string const& name, std::string const& message)
{
    const auto* kScript = R"script(
(function() {
  if (typeof globalThis.__receiveError__ !== 'function') return false;
  let e = new Error(%); e.name = @;
  globalThis.__receiveError__(e);
  return true;
})();
)script";

    auto expr = juce::String (kScript)
        .replace ("@", elem::js::serialize (name))
        .replace ("%", elem::js::serialize (message)).toStdString();

    // Defensive (todo.md §142) — this can be called FROM dispatchStateChange's
    // own catch block after a QuickJS eval already threw once; don't let a
    // second throw from here (e.g. an engine left in a bad state) escape
    // uncaught too.
    try { jsContext.evaluate (expr); }
    catch (const std::exception& e) { fazeDiagLog (juce::String ("[wtdiag][ERROR] dispatchError's own evaluate threw: ") + juce::String (e.what())); }
    catch (...) { fazeDiagLog ("[wtdiag][ERROR] dispatchError's own evaluate threw (non-std)"); }
}

//==============================================================================
// [SYNTH] Sampler file-load (todo.md §114). See the header comment for the
// versioned-resource-key reasoning (SharedResourceMap only allows insertion,
// never an update, hence "sample:opK:V" rather than a stable "sample:opK").
namespace {
    constexpr double kMaxSampleSeconds = 300.0; // matches shared/types.ts MAX_SAMPLE_CAPTURE_SECONDS
    constexpr int kSamplePeakPoints = 256;
}

void SynthPluginProcessor::loadSampleFile (int opIndex, const juce::File& file, bool dispatch)
{
    if (opIndex < 0 || opIndex > 3 || runtime == nullptr)
        return;

    std::unique_ptr<juce::AudioFormatReader> reader (sampleFormatManager.createReaderFor (file));
    if (reader == nullptr)
    {
        dispatchError ("Sample Load Error", "Couldn't read \"" + file.getFullPathName().toStdString() + "\" as audio.");
        return;
    }

    const double srcRate = reader->sampleRate > 0 ? reader->sampleRate : lastKnownSampleRate;
    const int numSamples = (int) juce::jlimit (
        (juce::int64) 1, (juce::int64) (kMaxSampleSeconds * srcRate),
        reader->lengthInSamples);

    juce::AudioBuffer<float> buffer ((int) juce::jmax (1, (int) reader->numChannels), numSamples);
    reader->read (&buffer, 0, numSamples, 0, true, true);

    // The per-operator DSP path is mono — downmix here rather than teaching
    // dsp/synth.js a stereo sample case it doesn't need yet.
    std::vector<float> mono ((size_t) numSamples, 0.0f);
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
    {
        auto* src = buffer.getReadPointer (ch);
        for (int i = 0; i < numSamples; ++i) mono[(size_t) i] += src[i] / (float) buffer.getNumChannels();
    }

    // Resample to the engine's current rate so playback pitch is correct
    // regardless of the source file's native sample rate.
    std::vector<float> resampled;
    float* playData = mono.data();
    int playLength = numSamples;
    if (lastKnownSampleRate > 0 && std::abs (srcRate - lastKnownSampleRate) > 1.0)
    {
        const double ratio = srcRate / lastKnownSampleRate;
        const int outLen = juce::jmax (1, (int) std::ceil ((double) numSamples / ratio));
        resampled.resize ((size_t) outLen);
        juce::LagrangeInterpolator interp;
        interp.reset();
        interp.process (ratio, mono.data(), resampled.data(), outLen);
        playData = resampled.data();
        playLength = outLen;
    }

    const int version = ++sampleVersions[opIndex];
    const auto key = "sample:op" + std::to_string (opIndex) + ":" + std::to_string (version);
    // AudioBufferResource deep-copies [data, data+numSamples) in its ctor
    // (see AudioBufferResource.h), so `resampled`/`mono` going out of scope
    // right after this call is safe.
    runtime->addSharedResource (key, std::make_unique<elem::AudioBufferResource> (playData, (size_t) playLength));
    runtime->pruneSharedResources(); // reclaim this operator's previous version once the graph drops it
    // The prune also drops every REGISTERED-BUT-UNUSED resource — i.e. all wavetable frames no operator is
    // playing right now — while our tracking sets still claim they exist. Switching an operator back from the
    // sampler to a wavetable then referenced a pruned resource and failed the whole batch (broken synth).
    // Forget the tracking so they are re-registered on demand (and re-register the ones in use now).
    registeredWavetableIds.clear();
    registeredWavetableWarpKeys.clear();
    ensureWavetableWarpResources();
    sampleLoaded[opIndex] = true;

    samplePaths[opIndex] = file.getFullPathName();
    const double duration = (double) playLength / (lastKnownSampleRate > 0 ? lastKnownSampleRate : srcRate);

    // Waveform preview for the UI — same base64 int8 encoding drainScopes
    // already uses for live scope frames, one more consumer of it.
    juce::HeapBlock<juce::int8> peaks ((size_t) kSamplePeakPoints);
    for (int i = 0; i < kSamplePeakPoints; ++i)
    {
        const auto idx = (size_t) ((juce::int64) i * (juce::int64) playLength / kSamplePeakPoints);
        const float v = juce::jlimit (-1.0f, 1.0f, playData[idx]);
        peaks[i] = (juce::int8) juce::jlimit (-127, 127, juce::roundToInt (v * 127.0f));
    }

    const auto prefix = "op" + std::to_string (opIndex);
    state.insert_or_assign (prefix + "_samplepath", samplePaths[opIndex].toStdString());
    state.insert_or_assign (prefix + "_sampleversion", (double) version);
    state.insert_or_assign (prefix + "_sampleduration", duration);
    state.insert_or_assign (prefix + "_sampleframes", (double) playLength);
    state.insert_or_assign (prefix + "_samplepeaks", juce::Base64::toBase64 (peaks.getData(), (size_t) kSamplePeakPoints).toStdString());

    if (dispatch)
        dispatchStateChange();
}

void SynthPluginProcessor::setResampleRecording (int opIndex, bool on, int source)
{
    if (on)
    {
        recSource.store (source == 1 ? 1 : 0);
        if (opIndex < 0 || opIndex > 3 || recOp.load() >= 0 || lastKnownSampleRate <= 0)
            return;
        {
            const juce::SpinLock::ScopedLockType rl (recLock);
            recBuf.assign ((size_t) (30.0 * lastKnownSampleRate), 0.0f);
            recPos.store (0);
            recDone.store (false);
        }
        recTargetOp = opIndex;
        recOp.store (opIndex); // audio thread starts copying from the next block
    }
    else if (recOp.load() >= 0)
        finishResampleRecording();
}

void SynthPluginProcessor::finishResampleRecording()
{
    if (recOp.load() < 0 || recTargetOp < 0)
        return;

    juce::AudioBuffer<float> take;
    {
        const juce::SpinLock::ScopedLockType rl (recLock);   // waits out an in-flight block copy
        recOp.store (-1);
        const int n = recPos.load();
        if (n > 0)
        {
            take.setSize (1, n);
            take.copyFrom (0, 0, recBuf.data(), n);
        }
        recPos.store (0);
        std::vector<float>().swap (recBuf);
    }
    const int op = recTargetOp;
    recTargetOp = -1;
    if (take.getNumSamples() < 256)
        return; // nothing worth keeping

    auto dir = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                   .getChildFile ("Faze").getChildFile ("Samples");
    dir.createDirectory();
    auto file = dir.getChildFile ("take-" + juce::Time::getCurrentTime().formatted ("%Y%m%d-%H%M%S")
                                  + "-osc" + juce::String (op + 1) + ".wav");
    {
        juce::WavAudioFormat wav;
        std::unique_ptr<juce::FileOutputStream> os (file.createOutputStream());
        if (os == nullptr)
        {
            dispatchError ("Resample Error", "Couldn't write " + file.getFullPathName().toStdString());
            return;
        }
        std::unique_ptr<juce::AudioFormatWriter> w (wav.createWriterFor (os.get(), lastKnownSampleRate, 1, 24, {}, 0));
        if (w == nullptr)
        {
            dispatchError ("Resample Error", "Couldn't create a WAV writer.");
            return;
        }
        os.release(); // the writer owns the stream now
        w->writeFromAudioSampleBuffer (take, 0, take.getNumSamples());
    }
    loadSampleFile (op, file);
}

void SynthPluginProcessor::clearSampleFile (int opIndex)
{
    if (opIndex < 0 || opIndex > 3)
        return;

    samplePaths[opIndex] = {};
    sampleLoaded[opIndex] = false;
    // Version 0 is never a real registered resource (loadSampleFile always
    // pre-increments before registering) — the DSP's `el.sample` node just
    // gets a path nothing was ever added under, which Sample.h's own
    // "no active buffer" guard already renders as silence.
    sampleVersions[opIndex] = 0;

    const auto prefix = "op" + std::to_string (opIndex);
    state.insert_or_assign (prefix + "_samplepath", std::string());
    state.insert_or_assign (prefix + "_sampleversion", 0.0);
    state.insert_or_assign (prefix + "_sampleduration", 0.0);
    state.insert_or_assign (prefix + "_sampleframes", 0.0);
    state.insert_or_assign (prefix + "_samplepeaks", std::string());

    dispatchStateChange();
}

void SynthPluginProcessor::setArpConfig (const juce::String& json)
{
    ArpConfig c;
    if (! ArpConfig::fromJson (json, c))
    {
        fazeDiagLog ("[arp] bad config JSON ignored");
        return;
    }
    const juce::SpinLock::ScopedLockType sl (arpLock);
    arpCfgPending = c;
    arpCfgDirty.store (true);
}

void SynthPluginProcessor::setFunctionShape (int lfoIndex, const juce::String& shapeJson)
{
    if (lfoIndex < 1 || lfoIndex > 10)
        return;

    try
    {
        auto parsed = elem::js::parseJSON (shapeJson.toStdString());
        state.insert_or_assign ("lfo" + std::to_string (lfoIndex) + "_functionShape", parsed);
        // Debounced, not immediate — the Function editor's Ctrl/Alt paint
        // tools call this on every pointermove, same "sustained stream"
        // shape scheduleStateDispatch's own comment warns about (a chord,
        // an automation sweep); an immediate dispatchStateChange() per
        // paint step would (a) risk the exact message-thread flood that
        // comment describes and (b) can race an in-flight parameter write
        // (e.g. a wave-index correction from `synthToFlat`), letting the UI
        // see a stale echo and wrongly revert it (todo.md — "knobs snap
        // back and forth" / "LFOs don't do anything").
        scheduleStateDispatch();
    }
    catch (...) {}
}

void SynthPluginProcessor::setEnvShape (const juce::String& envId, const juce::String& shapeJson)
{
    // envId is 'env1'..'env11'. Validate rather than trust the webview: this key
    // goes straight into `state`, which is serialized into the plugin's saved
    // chunk, so an arbitrary id would let the UI write junk into saved projects.
    if (! envId.startsWith ("env")) return;
    const int n = envId.substring (3).getIntValue();
    if (n < 1 || n > 11 || envId != ("env" + juce::String (n))) return;

    try
    {
        auto parsed = elem::js::parseJSON (shapeJson.toStdString());
        state.insert_or_assign (envId.toStdString() + "_envShape", parsed);
        // Debounced for the same reason setFunctionShape is: the Function editor's
        // paint tools fire this on every pointermove.
        scheduleStateDispatch();
    }
    catch (...) {}
}

void SynthPluginProcessor::setEqBands (const juce::String& bandsJson)
{
    try
    {
        auto parsed = elem::js::parseJSON (bandsJson.toStdString());
        state.insert_or_assign ("fx_eq_bands", parsed);
        // Debounced, not immediate — same reasoning as setFunctionShape
        // above: a point drag calls this on every pointermove.
        scheduleStateDispatch();
    }
    catch (...) {}
}

void SynthPluginProcessor::reloadSamplesFromPaths()
{
    for (auto& l : sampleLoaded) l = false;   // a fresh runtime holds none of them until re-registered below
    for (int k = 0; k < 4; ++k)
        if (samplePaths[k].isNotEmpty())
            loadSampleFile (k, juce::File (samplePaths[k]), /*dispatch*/ false);   // the caller dispatches once everything is registered
}

//==============================================================================
// [SYNTH] Real wavetable synthesis (Task 4, multi-agent work order). Built-in
// tables ported 1:1 from dsp/wavetables.js — same frame size, same frame
// count, same maths — so the plugin sounds identical to the offline test
// harness / browser preview, which register the JS-generated versions of
// these exact same frames via virtualFileSystem. Registered once per fresh
// `runtime` (constant data, no file I/O, unlike samples) under
// "wavetable:{tableId}:{frameIndex}", matching dsp/synth.js's
// wavetableResourceKey().
//
// ESW (Echo Sound Works) tables, todo.md §149 item 7 / §162 / §165 2b: ids
// 2..380 used to all fall into the "unknown id" branch of wtGenerateFrame and
// render as the id-0 harmonic fallback, because registerBuiltinWavetables()
// only ever looped tableId < 2. Unlike the JS-side loader (dsp/wavetables.js
// loadEswWavetableFrames), the plugin's QuickJS context has no fs module to
// read the 379 .wav files — but NATIVE C++ always has real file I/O (the
// sampler already proves this, see loadSampleFile below), so the fix lives
// here: resolve the ESW directory, decode each table's wav with the same
// AudioFormatManager the sampler uses, chunk it into kWtFrameSize=2048-sample
// frames exactly like the JS loader (parseWavBuffer: sequential chunks, DC
// removed, peak-normalised to 0.92 — same numbers as wtNormalize above), and
// pick kWtNumFrames=8 evenly spread across however many chunks the file has.
// Decoded once per table id (eswFrameCache below), on first use.
namespace {
    constexpr int kWtFrameSize = 2048;
    constexpr int kWtNumFrames = 8;
    constexpr int kNumEswTables = 379; // dsp/esw-tables.json entry count; ids 2..380
    constexpr int kNumWavetables = 2 + kNumEswTables; // 0/1 built-in + ESW

    std::vector<float> wtNormalize (std::vector<float> frame)
    {
        float peak = 0.0f;
        for (auto v : frame) peak = std::max (peak, std::abs (v));
        const float g = peak > 1e-6f ? 0.92f / peak : 1.0f;
        for (auto& v : frame) v *= g;
        return frame;
    }

    // Sine->buzzy-sawtooth sweep: harmonics 1..count, 1/h rolloff.
    std::vector<float> wtHarmonicFrame (int count)
    {
        std::vector<float> frame ((size_t) kWtFrameSize, 0.0f);
        for (int n = 0; n < kWtFrameSize; ++n)
        {
            const double theta = (2.0 * juce::MathConstants<double>::pi * n) / kWtFrameSize;
            double s = 0.0;
            for (int h = 1; h <= count; ++h) s += std::sin (theta * h) / h;
            frame[(size_t) n] = (float) s;
        }
        return wtNormalize (std::move (frame));
    }

    // Moving Gaussian-weighted "formant" emphasis centred on harmonic `center`.
    std::vector<float> wtFormantFrame (double center, double sigma)
    {
        constexpr int kHarmonics = 32;
        std::vector<float> frame ((size_t) kWtFrameSize, 0.0f);
        for (int n = 0; n < kWtFrameSize; ++n)
        {
            const double theta = (2.0 * juce::MathConstants<double>::pi * n) / kWtFrameSize;
            double s = 0.0;
            for (int h = 1; h <= kHarmonics; ++h)
            {
                const double w = std::exp (-((h - center) * (h - center)) / (2.0 * sigma * sigma));
                s += (w / h) * std::sin (theta * h);
            }
            frame[(size_t) n] = (float) s;
        }
        return wtNormalize (std::move (frame));
    }

    // ----- ESW directory + table-list resolution (mirrors
    // dsp/wavetables.js's resolveEswBaseDir/eswCandidateDirs candidate
    // chain, env override first, then known checkout locations). -----
    juce::File resolveEswBaseDir()
    {
        static juce::File cached;
        static bool resolved = false;
        if (resolved) return cached;
        resolved = true;

        const auto dirName = juce::String ("Echo Sound Works Core Tables");

        if (auto env = juce::SystemStats::getEnvironmentVariable ("FAZE_ESW_TABLES", {}); env.isNotEmpty())
        {
            juce::File envDir (env);
            if (envDir.isDirectory()) { cached = envDir; return cached; }
        }

        // Walk up from the current executable looking for a repo checkout
        // that still has the folder (covers running the Standalone/VST3
        // straight out of the build tree during development).
        auto exeDir = juce::File::getSpecialLocation (juce::File::currentExecutableFile).getParentDirectory();
        for (int up = 0; up < 8 && exeDir.exists(); ++up)
        {
            auto candidate = exeDir.getChildFile (dirName);
            if (candidate.isDirectory()) { cached = candidate; return cached; }
            exeDir = exeDir.getParentDirectory();
        }

        // Known dev checkout locations, last — same precedent as the JS
        // loader's own legacy-path fallback and other dev-only fallbacks in
        // this codebase (pre-release spike, not a shipped installer path).
        const juce::File fallbacks[] = {
            juce::File ("Z:/github/AUDIO · FAZE-RECORDER").getChildFile (dirName),
            juce::File ("Z:/GITHUB/AUDIO · FAZE-RECORDER").getChildFile (dirName),
        };
        for (auto& c : fallbacks)
            if (c.isDirectory()) { cached = c; return cached; }

        cached = juce::File();
        return cached;
    }

    struct EswEntry { int id; juce::String path; };

    const std::vector<EswEntry>& eswTableList()
    {
        static std::vector<EswEntry> list;
        static bool loaded = false;
        if (loaded) return list;
        loaded = true;

        auto base = resolveEswBaseDir();
        if (base == juce::File()) return list;
        // `base` IS the "Echo Sound Works Core Tables" dir, which sits at
        // the repo root right next to spike/ — so its own parent is repo root.
        auto jsonFile = base.getParentDirectory().getChildFile ("spike/elementary/dsp/esw-tables.json");
        if (! jsonFile.existsAsFile()) return list;

        auto parsed = juce::JSON::parse (jsonFile);
        if (! parsed.isArray()) return list;
        if (auto* arr = parsed.getArray())
        {
            list.reserve ((size_t) arr->size());
            for (auto& entry : *arr)
            {
                if (! entry.isObject()) continue;
                const int id = (int) entry.getProperty ("id", -1);
                const auto path = entry.getProperty ("path", juce::var()).toString();
                if (id >= 0 && path.isNotEmpty()) list.push_back ({ id, path });
            }
        }
        return list;
    }

    // DC-removal + peak-normalise, matching dsp/wavetables.js's
    // removeDC+normalize on each chunk.
    std::vector<float> wtNormalizeRemoveDc (std::vector<float> frame)
    {
        double mean = 0.0;
        for (auto v : frame) mean += v;
        mean /= (double) frame.size();
        for (auto& v : frame) v -= (float) mean;
        return wtNormalize (std::move (frame));
    }

    // Decode one ESW .wav into kWtNumFrames chunks of kWtFrameSize samples,
    // picked evenly across the file's available chunks (matching the JS
    // loader's "frameSamples = 2048, sequential chunks" scheme, but spread
    // across the whole file rather than just the first 8 chunks so WT Pos
    // sweeps across real variety instead of the file's first 16384 samples).
    std::vector<std::vector<float>> decodeEswFrames (juce::AudioFormatManager& fmt, const juce::File& wavFile)
    {
        std::vector<std::vector<float>> frames;
        std::unique_ptr<juce::AudioFormatReader> reader (fmt.createReaderFor (wavFile));
        if (reader == nullptr || reader->lengthInSamples <= 0)
            return frames;

        const juce::int64 total = reader->lengthInSamples;
        const int numChunks = (int) juce::jmax ((juce::int64) 1, total / kWtFrameSize);

        juce::AudioBuffer<float> scratch (1, kWtFrameSize);
        frames.reserve ((size_t) kWtNumFrames);
        for (int f = 0; f < kWtNumFrames; ++f)
        {
            const int chunkIdx = numChunks <= 1 ? 0
                : (int) ((juce::int64) f * (numChunks - 1) / juce::jmax (1, kWtNumFrames - 1));
            const juce::int64 start = (juce::int64) chunkIdx * kWtFrameSize;
            const int toRead = (int) juce::jmin ((juce::int64) kWtFrameSize, total - start);

            scratch.clear();
            if (toRead > 0)
                reader->read (&scratch, 0, toRead, start, true, false);

            std::vector<float> chunk ((size_t) kWtFrameSize, 0.0f);
            auto* data = scratch.getReadPointer (0);
            for (int n = 0; n < kWtFrameSize; ++n) chunk[(size_t) n] = data[n];
            frames.push_back (wtNormalizeRemoveDc (std::move (chunk)));
        }
        return frames;
    }

    // tableId -> its 8 decoded frames. Populated lazily (first use), one
    // file read per table, never per audio block.
    std::unordered_map<int, std::vector<std::vector<float>>>& eswFrameCache()
    {
        static std::unordered_map<int, std::vector<std::vector<float>>> cache;
        return cache;
    }

    juce::AudioFormatManager& eswFormatManager()
    {
        static juce::AudioFormatManager mgr;
        static bool initialised = false;
        if (! initialised) { mgr.registerBasicFormats(); initialised = true; }
        return mgr;
    }

    std::vector<float> wtGenerateFrame (int tableId, int frameIndex)
    {
        if (tableId == 1)
            return wtFormantFrame (2.0 + frameIndex * 3.5, 1.6);
        if (tableId == 0)
            return wtHarmonicFrame (1 + frameIndex * 4);

        // ESW table (id 2..380 -> esw-tables.json id 0..378).
        auto& cache = eswFrameCache();
        auto it = cache.find (tableId);
        if (it == cache.end())
        {
            std::vector<std::vector<float>> decoded;
            auto base = resolveEswBaseDir();
            if (base != juce::File())
            {
                for (auto& entry : eswTableList())
                {
                    if (entry.id + 2 != tableId) continue;
                    auto wavFile = base.getChildFile (entry.path);
                    if (wavFile.existsAsFile())
                        decoded = decodeEswFrames (eswFormatManager(), wavFile);
                    break;
                }
            }
            it = cache.emplace (tableId, std::move (decoded)).first;
        }
        const auto& frames = it->second;
        if (frames.empty())
            return wtHarmonicFrame (1 + frameIndex * 4); // dir/file missing — same fallback as before, not silence
        return frames[(size_t) (frameIndex % (int) frames.size())];
    }
}

void SynthPluginProcessor::openWavetableFolder()
{
    // The ACTIVE flat user folder: the custom library if one is set, else
    // Documents/Faze/Wavetables (created on demand).
    auto dir = faze::uwt::activeFolder();
    if (dir.isDirectory())
        dir.startAsProcess(); // opens it in Explorer / Finder
    else
        fazeDiagLog ("[wt] openWavetableFolder: couldn't create " + dir.getFullPathName());
}

void SynthPluginProcessor::rescanUserWavetables()
{
    userWavetables.scan (faze::uwt::activeFolder());
    // NOTE: ids already registered with the runtime this session keep their frames
    // (shared resources are insert-only); a restart picks up changed files. Ids
    // shift when files are added/removed (presets store the numeric id).
    pushUserWavetableNames();
}

void SynthPluginProcessor::setWavetableLibraryFolder (const juce::File& dir)
{
    faze::uwt::saveLibraryPath (dir == juce::File() ? juce::String() : dir.getFullPathName());
    rescanUserWavetables();
}

void SynthPluginProcessor::pushUserWavetableNames()
{
    auto* wed = static_cast<WebViewEditor*> (getActiveEditor());
    if (wed == nullptr || wed->getWebViewPtr() == nullptr)
        return;

    juce::Array<juce::var> arr;
    for (auto& n : userWavetables.getNames())
        arr.add (n);
    const auto json = juce::JSON::toString (juce::var (arr), true);
    wed->getWebViewPtr()->evaluateJavascript (
        ("window.__userWavetables__&&window.__userWavetables__(" + json + ");").toStdString());
}

void SynthPluginProcessor::registerBuiltinWavetables()
{
    if (runtime == nullptr)
        return;

    // Wavetables are now registered lazily via ensureWavetableRegistered()
    // when first used. This just logs the bin status.
    if (wavetableBinValid)
        fazeDiagLog ("[wt] Ready for lazy registration (" + juce::String ((int) wavetableBin.header.tableCount) + " tables available)");
    else
        fazeDiagLog ("[wt] No wavetables.bin loaded - tables will fall back to generated frames");
}

std::vector<float> SynthPluginProcessor::getBaseWavetableFrame (int tableId, int slot)
{
    // The JS graph (dsp/synth.js wavetableOsc) always crossfades NUM_FRAMES=8
    // slots, so a table with more frames in wavetables.bin (up to 64) is
    // sampled evenly down to 8 slots; fewer-than-8 tables clamp to their last.
    constexpr int kSlots = 8;
    if (wavetableBinValid)
    {
        const int n = wavetableBin.getFrameCount (tableId);
        if (n > 0)
        {
            const int idx = juce::jlimit (0, n - 1, (int) ((juce::int64) slot * (n - 1) / (kSlots - 1)));
            if (auto frame = wavetableBin.getFrame (tableId, idx))
                return std::move (*frame);
        }
    }
    // User wavetable (flat folder, ids 381+index): sampled down to 8 slots like bin tables.
    if (tableId >= faze::uwt::kUserBaseId)
    {
        const int n = userWavetables.getFrameCount (tableId);
        if (n > 0)
        {
            const int idx = juce::jlimit (0, n - 1, (int) ((juce::int64) slot * (n - 1) / (kSlots - 1)));
            auto frame = userWavetables.getFrame (tableId, idx);
            if (! frame.empty())
                return frame;
        }
        // Missing/unreadable file: harmonic fallback (never silence).
        return wtGenerateFrame (0, slot);
    }
    // Not in the bin (or bin failed to load): generated / ESW-wav fallback.
    return wtGenerateFrame (tableId, slot);
}

void SynthPluginProcessor::ensureWavetableRegistered (int tableId)
{
    if (runtime == nullptr)
        return;

    if (registeredWavetableIds.count (tableId) > 0)
        return; // already done

    for (int f = 0; f < getWavetableFrameCount (tableId); ++f)
    {
        auto frame = getBaseWavetableFrame (tableId, f);
        const auto key = "wavetable:" + std::to_string (tableId) + ":" + std::to_string (f);
        runtime->addSharedResource (key, std::make_unique<elem::AudioBufferResource> (
            frame.data(), frame.size()));
    }
    registeredWavetableIds.insert (tableId);
}

int SynthPluginProcessor::getWavetableFrameCount (int)
{
    return 8; // matches dsp/wavetables.js NUM_FRAMES (slots, see getBaseWavetableFrame)
}

//==============================================================================
// [SYNTH] Wavetable Warp resource pipeline — minimal proof (see header
// comment on ensureWavetableWarpResources for scope). This is the fix for
// the "fake wavetable" issue documented in challenges.md / the WT
// Architecture doc: dsp/synth.js's wavetableOsc() (dsp/synth.js) always
// builds a resource key via wavetableResourceKey() and references it as
// `el.table({ path: resKey })`, but nothing — neither QuickJS nor C++ — ever
// generated or registered the WARPED variant of that key. Base (unwarped)
// keys are covered by registerBuiltinWavetables() above; this covers the
// warped ones, generated natively (Option A from the architecture report:
// C++ owns generation, since the warp params already arrive in `state` for
// free via the same generic channel as every other oscillator param, and
// porting the warp math mirrors the precedent registerBuiltinWavetables()
// already set for the base frames).
namespace {
    // Mirrors dsp/wavetables.js's wavetableResourceKey() exactly, including
    // the amount/param2 quantization to whole percent — the native key MUST
    // match what dsp/synth.js's el.table({ path }) requests, or the
    // resource simply won't be found (same failure this whole pipeline
    // exists to fix).
    std::string wtWarpResourceKey (int id, int frameIndex,
                                    int warpMode, double warpAmount, double warpParam2,
                                    int warpMode2, double warpAmount2, double warpParam2_2)
    {
        const bool warp1Active = warpMode != 0 && warpAmount != 0.0;
        const bool warp2Active = warpMode2 != 0 && warpAmount2 != 0.0;

        if (! warp1Active && ! warp2Active)
            return "wavetable:" + std::to_string (id) + ":" + std::to_string (frameIndex);

        const int amtQ  = (int) std::floor (warpAmount * 100.0 + (warpAmount >= 0.0 ? 0.5 : -0.5));
        const int p2Q   = (int) std::floor (warpParam2 * 100.0 + (warpParam2 >= 0.0 ? 0.5 : -0.5));
        const int amtQ2 = (int) std::floor (warpAmount2 * 100.0 + (warpAmount2 >= 0.0 ? 0.5 : -0.5));
        const int p2Q2  = (int) std::floor (warpParam2_2 * 100.0 + (warpParam2_2 >= 0.0 ? 0.5 : -0.5));

        return "wavetable:" + std::to_string (id) + ":" + std::to_string (frameIndex)
             + ":w" + std::to_string (warpMode) + ":" + std::to_string (amtQ) + ":" + std::to_string (p2Q)
             + ":w2_" + std::to_string (warpMode2) + ":" + std::to_string (amtQ2) + ":" + std::to_string (p2Q2);
    }

    // Mirrors dsp/wavetables.js's warpPhase() exactly, mode-for-mode
    // (including its exact clamps) — phase-domain warps resample a frame by
    // remapping the read phase, no amplitude change. Modes 1-10 and 12 are
    // ported; 11 is intentionally NOT here (see the routing note above
    // wtApplyWaveWarpSample). The spectral modes (13, 16-29) live in
    // WtSpectralWarp.h — see wtIsSpectralWarp.
    double wtWarpPhase (int mode, double phase01, double amount, double param2)
    {
        const double p = juce::jlimit (0.0, 0.999999, phase01);
        const double a = juce::jlimit (-0.99, 0.99, amount);

        switch (mode)
        {
            case 1: { // Bend+
                const double center = juce::jlimit (0.1, 0.9, param2);
                if (p < center) return (p / center) * (0.5 * (1.0 + a));
                return 0.5 * (1.0 + a) + ((p - center) / (1.0 - center)) * (1.0 - 0.5 * (1.0 + a));
            }
            case 2: { // Bend-
                const double center = juce::jlimit (0.1, 0.9, param2);
                const double invA = -a;
                if (p < center) return (p / center) * (0.5 * (1.0 + invA));
                return 0.5 * (1.0 + invA) + ((p - center) / (1.0 - center)) * (1.0 - 0.5 * (1.0 + invA));
            }
            case 3: { // Asymmetry
                const double k = a * 0.99;
                return k >= 0.0 ? p * (1.0 - k) + p * p * k : p * (1.0 + k) - p * p * k;
            }
            case 4: { // Sync
                const double cycles = 1.0 + a * (1.0 + param2 * 15.0);
                return std::fmod (p * cycles, 1.0);
            }
            case 5: { // Mirror
                const double thresh = juce::jlimit (0.05, 0.95, param2);
                if (p < thresh) return (p / thresh) * 0.5;
                return 0.5 + ((1.0 - (p - thresh) / (1.0 - thresh)) * 0.5);
            }
            case 6: { // Reflect
                const int segs = 1 + (int) std::floor (a * 7.0);
                const double x = p * (double) segs;
                const double segF = std::floor (x);
                const double local = x - segF;
                const int segI = (int) segF;
                return (segI % 2 == 1) ? (1.0 - local) : local;
            }
            case 7: { // PWM
                const double width = juce::jlimit (0.05, 0.95, param2);
                const double skew = 0.5 + a * 0.45;
                if (p < width) return (p / width) * skew;
                return skew + ((p - width) / (1.0 - width)) * (1.0 - skew);
            }
            case 8: { // Quantize
                const double steps = juce::jmax (2.0, std::floor (2.0 + a * 30.0));
                return std::floor (p * steps) / steps;
            }
            case 9: { // Squeeze/Expand
                const double exp = std::pow (2.0, (a - 0.5) * 4.0);
                return std::pow (p, exp);
            }
            case 10: { // FM-Like
                const double ratio = 1.0 + std::floor (param2 * 8.0);
                const double mod = std::sin (2.0 * juce::MathConstants<double>::pi * p * ratio) * a * 0.5;
                return std::fmod (p + mod + 1.0, 1.0);
            }
            case 12: { // Shear
                const double offset = (p - 0.5) * a;
                return std::fmod (p + offset + 1.0, 1.0);
            }
            default:
                return p;
        }
    }

    void wtRemoveDCInPlace (std::vector<float>& frame)
    {
        double mean = 0.0;
        for (auto v : frame) mean += v;
        mean /= (double) frame.size();
        for (auto& v : frame) v = (float) ((double) v - mean);
    }

    // Mirrors dsp/wavetables.js's applyWaveWarp() — amplitude/sample-domain
    // warps, applied per-sample to the BASE frame (no phase resampling),
    // followed by the same removeDC+normalize the JS version applies.
    //
    // NOTE on mode 11 (Wavefold): dsp/wavetables.js's WARP_MODES metadata
    // tags it `domain: 'phase'`, and generateWavetableFrames()'s own
    // `warpMode >= 1 && warpMode <= 12` range check routes it into
    // warpPhase() — which has no `case 11` and silently no-ops (falls to
    // `default: return p`). applyWaveWarp() DOES implement Wavefold
    // correctly (an amplitude waveshaper, not a phase remap) but is
    // unreachable for mode 11 given that routing. This looks like a genuine
    // pre-existing JS bug (dead code today, so never actually exercised) —
    // flagged in todo.md rather than fixed there, out of scope for this
    // native pass. Here, mode 11 is wired to the amplitude waveshaper
    // (matching applyWaveWarp, i.e. the evidently-intended behavior) since
    // there's no reason to reproduce a bug nothing has ever run.
    double wtApplyWaveWarpSample (int mode, double x, double amount, double param2)
    {
        const double a = juce::jlimit (0.0, 1.0, amount);

        if (mode == 11) { // Wavefold
            const double drive = 1.0 + a * 7.0;
            return std::sin (x * drive * (juce::MathConstants<double>::pi / 2.0));
        }
        if (mode == 14) { // Bitcrush
            const double bits = juce::jmax (2.0, std::floor (2.0 + (1.0 - a) * 14.0));
            const double levels = std::pow (2.0, bits);
            return std::round (x * levels) / levels;
        }
        if (mode == 15) { // Wave Rectify
            if (param2 > 0.5) return std::abs (x) * 2.0 - 1.0; // full-wave
            return x > 0.0 ? x : 0.0; // half-wave
        }
        return x;
    }

    bool wtIsPhaseDomainWarp (int mode) { return (mode >= 1 && mode <= 10) || mode == 12; }
    bool wtIsWaveDomainWarp (int mode)  { return mode == 11 || mode == 14 || mode == 15; }
    bool wtIsSpectralWarp (int mode)    { return mode == 13 || (mode >= 16 && mode <= 29); }

    double stateNum (elem::js::Object const& s, std::string const& key, double fallback)
    {
        auto it = s.find (key);
        if (it == s.end() || ! it->second.isNumber())
            return fallback;
        return (double) it->second;
    }
}

void SynthPluginProcessor::ensureWavetableWarpResources()
{
    if (runtime == nullptr)
        return;

    for (int k = 0; k < 4; ++k)
    {
        const auto prefix = "op" + std::to_string (k) + "_";

        // dsp.main.js's toSynthState reads these same flat lowercase keys
        // straight out of the synced state object — see the header comment
        // for why no dedicated bridge call was needed to get warp params
        // into C++.
        const int wave = (int) stateNum (state, prefix + "wave", 0.0);
        if (wave != 5) // wavetable oscillator mode only
            continue;

        // Unwarped playback reads the base keys, so register them even when no
        // warp is active (previously only the warped path did, which left
        // plain table playback with no resource).
        ensureWavetableRegistered ((int) stateNum (state, prefix + "wtid", 0.0));

        const int warpMode   = (int) stateNum (state, prefix + "warpmode", 0.0);
        const double warpAmt = stateNum (state, prefix + "warpamount", 0.0);

        // Phase-domain (1-10, 12) and wave-domain (11, 14, 15) warps are
        // ported natively. The spectral warps (13, 16-29, DFT/IFFT-based)
        // are ported too — WtSpectralWarp.h, the exact math the
        // differential harness (test/spectral-warp-diff/) proved
        // byte-exact against dsp/wavetables.js (mode 29 differs by at
        // most 1 f32 ULP in a minority of configs; V8 vs CRT atan2, see
        // that harness's notes). An unknown mode still falls through and
        // keeps resolving to the unwarped base key (already registered),
        // so an unimplemented warp is a silent audible no-op, not a
        // crash, matching "no silent failure that looks like success".
        const bool phaseWarp = wtIsPhaseDomainWarp (warpMode);
        const bool waveWarp  = wtIsWaveDomainWarp (warpMode);
        const bool specWarp  = wtIsSpectralWarp (warpMode);

        const int warpMode2 = (int) stateNum (state, prefix + "warpmode2", 0.0);
        const int wtId          = (int) stateNum (state, prefix + "wtid", 0.0);
        const double warpParam2 = stateNum (state, prefix + "warpparam2", 0.5);
        const double warpAmt2   = stateNum (state, prefix + "warpamount2", 0.0);
        const double warpP2_2   = stateNum (state, prefix + "warpparam2_2", 0.5);

        // Warp 2 is a SECOND STAGE over Warp 1's output, not an alternative to
        // it — this mirrors `generateWavetableFrames` in dsp/wavetables.js
        // exactly ("Apply Warp 1", then "Apply Warp 2" over `step1Frames`).
        //
        // It used to `continue` here instead, which was not merely "Warp 2 does
        // nothing": dsp/synth.js asks for the `:w2_` resource key
        // unconditionally, and `TableNode::setProperty` returns
        // InvalidPropertyValue() for a path missing from the SharedResourceMap.
        // A failed property fails the WHOLE setState instruction batch, so
        // selecting Warp 2 silenced every operator, not just the warped one.
        // That is the "actively destructive" half of the report.
        const bool warp1Active = warpMode != 0 && warpAmt != 0.0;
        const bool warp2Active = warpMode2 != 0 && warpAmt2 != 0.0;
        const bool phaseWarp2 = wtIsPhaseDomainWarp (warpMode2);
        const bool waveWarp2  = wtIsWaveDomainWarp (warpMode2);
        const bool specWarp2  = wtIsSpectralWarp (warpMode2);

        // Nothing to bake when neither stage is active — and crucially, this
        // must agree with `wtWarpResourceKey`'s own "is either active" test, or
        // JS and C++ disagree about which key a given state maps to.
        if (! warp1Active && ! warp2Active)
            continue;

        // Ensure the base wavetable is registered before generating warped variants
        ensureWavetableRegistered (wtId);
        
        const int numFrames = getWavetableFrameCount (wtId);

        bool anyMissing = false;
        for (int f = 0; f < numFrames; ++f)
        {
            const auto key = wtWarpResourceKey (wtId, f, warpMode, warpAmt, warpParam2, warpMode2, warpAmt2, warpP2_2);
            if (registeredWavetableWarpKeys.count (key) == 0) { anyMissing = true; break; }
        }
        if (! anyMissing)
            continue;

        // DIAGNOSTIC (todo.md §136/137 — user-reported crash turning
        // wavetable/warp and FM/PM knobs after this pipeline landed).
        // Written before any generation work below so the trail survives
        // even a hard crash a few lines down — fazeDiagLog's appendText
        // opens/writes/closes per call, no buffering to lose.
        fazeDiagLog ("[wtwarp] op" + juce::String (k) + " generating: wtId=" + juce::String (wtId)
                     + " warpMode=" + juce::String (warpMode) + " warpAmt=" + juce::String (warpAmt, 4)
                     + " warpParam2=" + juce::String (warpParam2, 4));

        // Frame generation happens here, on the message thread (this method
        // only ever runs from handleAsyncUpdate), never on the audio
        // callback — matching the architecture doc's real-time-thread
        // prohibition. All modes are cheap even at 8 frames x 2048 samples
        // (the spectral ones run a 128-bin DFT per frame; still no FFT).
        // Spectral warps read the table's full base-frame set (modes 21 and
        // 29 analyze other frames), matching the JS reference, which passes
        // baseFrames into applySpectralWarp. Only built when actually needed.
        std::vector<std::vector<float>> specBaseFrames;
        if (specWarp)
        {
            specBaseFrames.reserve ((size_t) numFrames);
            for (int f2 = 0; f2 < numFrames; ++f2)
                specBaseFrames.push_back (getBaseWavetableFrame (wtId, f2));
        }
        // Stage-1 output, kept only when a SPECTRAL stage 2 needs it: the JS
        // reference passes `step1Frames` (not `baseFrames`) into stage 2, so a
        // spectral Warp 2 analyses the already-warped spectrum. Collecting it
        // costs one vector per frame and only in that case.
        std::vector<std::vector<float>> specStage1Frames;
        if (specWarp2)
            specStage1Frames.reserve ((size_t) numFrames);

        for (int f = 0; f < numFrames; ++f)
        {
            const auto key = wtWarpResourceKey (wtId, f, warpMode, warpAmt, warpParam2, warpMode2, warpAmt2, warpP2_2);
            if (registeredWavetableWarpKeys.count (key) > 0)
                continue;

            // Wrapped defensively while this exact code path is under live
            // crash investigation (todo.md §137) — if generation ever throws,
            // log it and skip that one resource (the graph then falls back
            // to whatever's already registered, or fails the same
            // InvalidPropertyValue() way it always did pre-this-pipeline,
            // rather than taking the whole process down). Not a blanket
            // catch-all elsewhere in this file — scoped tightly to the newest,
            // least-proven code in the plugin.
            try
            {
                auto base = getBaseWavetableFrame (wtId, f);
                std::vector<float> warped ((size_t) kWtFrameSize);

                // Stage 1 runs only when Warp 1 is actually active. With Warp 1
                // off and Warp 2 on, `warped` stays as the base frame and stage 2
                // below warps THAT — which is what the JS reference does too
                // (its Warp-1 map returns each frame unchanged when mode is 0),
                // and is what makes a Warp-2-only patch work at all.
                if (warp1Active && phaseWarp)
                {
                    for (int s = 0; s < kWtFrameSize; ++s)
                    {
                        const double ph = (double) s / (double) kWtFrameSize;
                        const double warpedPh = wtWarpPhase (warpMode, ph, warpAmt, warpParam2);
                        const int idx = juce::jlimit (0, kWtFrameSize - 1, (int) std::floor (warpedPh * (double) kWtFrameSize));
                        warped[(size_t) s] = base[(size_t) idx];
                    }
                }
                else if (warp1Active && waveWarp)
                {
                    for (int s = 0; s < kWtFrameSize; ++s)
                        warped[(size_t) s] = (float) wtApplyWaveWarpSample (warpMode, (double) base[(size_t) s], warpAmt, warpParam2);

                    wtRemoveDCInPlace (warped);
                    warped = wtNormalize (std::move (warped));
                }
                else if (warp1Active && specWarp) // WtSpectralWarp.h's port of applySpectralWarp
                {
                    warped = faze::wt::applySpectralWarp (base, warpMode, warpAmt, warpParam2,
                                                          &specBaseFrames, f);
                }
                else
                {
                    // No Warp 1: carry the base frame through untouched.
                    warped.assign (base.begin(), base.end());
                }

                // ---- stage 2: Warp 2, applied to stage 1's output ----------
                // Matches `generateWavetableFrames`: "Apply Warp 1" then
                // "Apply Warp 2" over `step1Frames`. Composition order matters
                // and is not symmetric — resampling an already-resampled frame
                // is not the same as doing it the other way round.
                //
                // Left out entirely when stage 2 is inactive, so a Warp-1-only
                // patch takes exactly the code path it did before this change.
                if (warp2Active)
                {
                    if (specWarp2)
                    {
                        // A spectral stage 2 analyses the STAGE-1 frames, which
                        // is why they were collected above — passing the base
                        // frames here would silently give a different spectrum.
                        warped = faze::wt::applySpectralWarp (warped, warpMode2, warpAmt2, warpP2_2,
                                                              &specStage1Frames, f);
                    }
                    else if (phaseWarp2)
                    {
                        // Read from `warped` and write to a scratch buffer: an
                        // in-place resample would read indices it has already
                        // overwritten.
                        std::vector<float> stage2 ((size_t) kWtFrameSize);
                        for (int s = 0; s < kWtFrameSize; ++s)
                        {
                            const double ph = (double) s / (double) kWtFrameSize;
                            const double warpedPh = wtWarpPhase (warpMode2, ph, warpAmt2, warpP2_2);
                            const int idx = juce::jlimit (0, kWtFrameSize - 1, (int) std::floor (warpedPh * (double) kWtFrameSize));
                            stage2[(size_t) s] = warped[(size_t) idx];
                        }
                        warped = std::move (stage2);
                    }
                    else if (waveWarp2)
                    {
                        for (int s = 0; s < kWtFrameSize; ++s)
                            warped[(size_t) s] = (float) wtApplyWaveWarpSample (warpMode2, (double) warped[(size_t) s], warpAmt2, warpP2_2);

                        wtRemoveDCInPlace (warped);
                        warped = wtNormalize (std::move (warped));
                    }
                    // An unknown mode falls through untouched, leaving stage 1's
                    // result — the same "silent audible no-op, not a crash"
                    // contract the stage-1 path already uses.

                    if (specWarp2)
                        specStage1Frames.push_back (warped);
                }

                // addSharedResource returns false (silent no-op) if the key
                // already exists — SharedResourceMap only allows insertion,
                // per its own comment — so a lost race between the count()
                // check above and here is harmless, not a duplicate bug.
                runtime->addSharedResource (key, std::make_unique<elem::AudioBufferResource> (warped.data(), warped.size()));
                registeredWavetableWarpKeys.insert (key);
                fazeDiagLog ("[wtwarp] registered " + juce::String (key));
            }
            catch (const std::exception& e)
            {
                fazeDiagLog ("[wtwarp][ERROR] generation threw for " + juce::String (key) + ": " + juce::String (e.what()));
            }
            catch (...)
            {
                fazeDiagLog ("[wtwarp][ERROR] generation threw (non-std) for " + juce::String (key));
            }
        }
    }
}

//==============================================================================
void SynthPluginProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    auto serialized = elem::js::serialize (state);
    destData.replaceAll ((void*) serialized.c_str(), serialized.size());
}

void SynthPluginProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    try
    {
        auto parsed = elem::js::parseJSON (std::string (static_cast<const char*> (data), (size_t) sizeInBytes));
        for (auto& kv : parsed.getObject())
            if (state.find (kv.first) != state.end())
                state.insert_or_assign (kv.first, kv.second);

        // [SYNTH] Sampler (todo.md §114) — a reloaded project/preset carries
        // FILE PATHS, not decoded audio (path-only persistence, see the
        // header comment). Re-decode each one now so the versioned
        // resources exist again; `loadSampleFile` no-ops safely if `runtime`
        // isn't built yet (fresh instance, setStateInformation often lands
        // before the first prepareToPlay) — handleAsyncUpdate's
        // shouldInitialize branch calls this again once it is.
        for (int k = 0; k < 4; ++k)
        {
            auto const& v = state.at ("op" + std::to_string (k) + "_samplepath");
            samplePaths[k] = v.isString() ? juce::String (std::string (v)) : juce::String();
        }
        reloadSamplesFromPaths();
    }
    catch (...) {}
}

//==============================================================================
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new SynthPluginProcessor();
}
