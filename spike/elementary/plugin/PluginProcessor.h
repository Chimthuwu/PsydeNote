#pragma once

#include <type_traits>
#include <unordered_set>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_processors/juce_audio_processors.h>

#include <choc_javascript.h>
#include <elem/Runtime.h>

#include "ArpEngine.h"
#include "VoiceCtl.h"
#include "CtlOut.h"
#include "Voices.h"
#include "WavetableBin.h"
#include "UserWavetables.h"

// ---------------------------------------------------------------------------
// Adapted from elemaudio/srvb's PluginProcessor (MIT). Structural changes for
// an instrument are marked  // [SYNTH]  below and summarised in BUILD.md.
// ---------------------------------------------------------------------------

// Polyphony. Each voice is a full P5 sub-graph; a patch change rebuilds +
// diffs the whole tree in QuickJS (cost scales with voice count, ~2x going
// 6 -> 16). Note on/off no longer rebuilds (native voicectl, VoiceCtl.h).
// 12 leaves room for arp/seq tails and chords. MUST match NUM_VOICES in
// dsp.main.js; kVoiceCtlMax (VoiceCtl.h) is the hard ceiling.
static constexpr int kNumVoices = 12;
class SynthPluginProcessor
    : public juce::AudioProcessor,
      public juce::AudioProcessorParameter::Listener,
      private juce::AsyncUpdater,
      private juce::Timer
{
public:
    SynthPluginProcessor();
    ~SynthPluginProcessor() override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    bool isBusesLayoutSupported (const juce::AudioProcessor::BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    const juce::String getName() const override;
    bool acceptsMidi() const override;      // [SYNTH] true
    bool producesMidi() const override;
    bool isMidiEffect() const override;
    double getTailLengthSeconds() const override;

    int getNumPrograms() override;
    int getCurrentProgram() override;
    void setCurrentProgram (int index) override;
    const juce::String getProgramName (int index) override;
    void changeProgramName (int index, const juce::String& newName) override;

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    void parameterValueChanged (int parameterIndex, float newValue) override;
    void parameterGestureChanged (int parameterIndex, bool gestureIsStarting) override;

    void handleAsyncUpdate() override;
    void timerCallback() override;

    void initJavaScriptEngine();
    void dispatchStateChange();
    /** Drain `el.scope` frames from the runtime and forward them to the webview
        (todo.md §73 P7c). Runs on `scopeTimer` at ~30Hz (todo.md §99), only
        while the editor is open. */
    void drainScopes();
    /** UI tells us when the EQ editor is mounted so the two EQ scopes are only shipped then. */
    void setEqScopesWanted (bool on) { eqScopesWanted.store (on); }
    /** Reveal the wavetable folder in the OS file browser. */
    void openWavetableFolder();
    /** Re-scan the active wavetable folder and push the name list to the UI. */
    void rescanUserWavetables();
    /** Persist `dir` as the custom wavetable library (empty = back to the default
        Documents/Faze/Wavetables folder), then rescan. Message thread. */
    void setWavetableLibraryFolder (const juce::File& dir);
    /** window.__userWavetables__(names[]) -> UI (no-op if no editor). */
    void pushUserWavetableNames();
    /** Debounced state push — coalesces bursts (a chord, an automation sweep)
        into one reconcile so the ~60-80ms `renderSynth` rebuild can't stack up
        on the message thread and freeze the host (todo.md §73). */
    void scheduleStateDispatch();
    void dispatchError (std::string const& name, std::string const& message);

    // [SYNTH] Sampler file-load (todo.md §114). One sample slot per operator
    // (0..3) — a decoded file becomes a versioned `elem::AudioBufferResource`
    // named "sample:opK:V"; V increments on every (re)load, because
    // `SharedResourceMap::add` only allows insertion, never an update. The
    // FILE PATH (not the decoded bytes) is what persists in `state`/presets
    // — decided over embedding raw bytes as the lower-effort/lower-risk
    // start; a moved/deleted source file means silence on reload, not a
    // crash (loadSampleFileFromPath no-ops if the file can't be read).
    /** `dispatch=false` is used when re-registering saved samples while the runtime is being (re)built: pushing the
        graph at that moment would reference wavetable resources that are not registered yet (batch fails => silence). */
    void loadSampleFile (int opIndex, const juce::File& file, bool dispatch = true);
    void clearSampleFile (int opIndex);

    /** LFO Function editor point data (todo.md — "all LFOs are functions")
     *  isn't a bounded host float (see dsp.main.js's `toSynthState`
     *  comment), so it never became a manifest AudioParameterFloat — it
     *  travels over its own `setFunctionShape` native message
     *  (WebViewEditor.cpp) instead, same precedent as the sampler file path
     *  above. `lfoIndex` is 1..3. */
    void setFunctionShape (int lfoIndex, const juce::String& shapeJson);

    /** The parametric EQ's band list (todo.md) — an arbitrary-count array of
     *  {id,freq,gain,q,type}, same "not a bounded host float" reasoning as
     *  `setFunctionShape` above; travels over its own `setEqBands` native
     *  message (WebViewEditor.cpp). `bandsJson` is a JSON-stringified
     *  `EqBand[]` (an empty array is a valid, flat-EQ state). */
    void setEqBands (const juce::String& bandsJson);

    /** Start (on) / stop (off) recording the master output into operator
     *  `opIndex`'s sampler. Stopping (or hitting the 30 s cap) writes the take
     *  to <AppData>/Faze/Samples and loads it as that operator's sample. */
    void setResampleRecording (int opIndex, bool on, int source = 0);   // source: 0 = master output, 1 = audio input

    /** Native arp/sequencer settings (JSON of ArpSettings) from the UI. */
    void setArpConfig (const juce::String& json);
    void setEnvShape (const juce::String& envId, const juce::String& shapeJson);

private:
    // [SYNTH] sample-accurate arp/seq run inside processBlock (ArpEngine.h).
    ArpEngine arp;
    ArpConfig arpCfgPending;          // written by the message thread under arpLock
    ArpConfig arpCfgLive;             // audio-thread copy
    juce::SpinLock arpLock;
    std::atomic<bool> arpCfgDirty { false };
    // Arp host params (manifest `arp_pattern` / `arp_chaos`). The arp takes its
    // config as JSON via setArpConfig, so these two cross the thread boundary
    // on their own: written in handleAsyncUpdate, read in processBlock.
    std::atomic<float> arpPatternParam { 0.0f };
    std::atomic<float> arpChaosParam { 1.0f };
    juce::MidiBuffer arpOut;
    int lastSentPlayhead { -2 };       // message thread only
    int lastSentBar { -2 };            // message thread only
    // Type of ArpEngine::readOverlay's argument (works whether OverlaySnapshot is nested or global).
    template <typename F> struct OverlayArg;
    template <typename R, typename C, typename A> struct OverlayArg<R (C::*) (A)> { using type = std::remove_reference_t<A>; };
    template <typename R, typename C, typename A> struct OverlayArg<R (C::*) (A) const> { using type = std::remove_reference_t<A>; };
    using OverlaySnap = typename OverlayArg<decltype (&ArpEngine::readOverlay)>::type;
    OverlaySnap lastOverlay {};        // message thread only: last overlay received from the engine
    bool overlayResend { true };       // message thread only: push the overlay on (re)open
    std::shared_ptr<CtlOutBank> ctlOutBank { std::make_shared<CtlOutBank>() }; // graph -> native arp mod bank
    /** Re-decode from `samplePaths[k]` for every operator that has one —
     *  called once `runtime` exists (end of the shouldInitialize branch in
     *  handleAsyncUpdate) and again right after a `setStateInformation`
     *  project/preset reload, since a fresh `runtime` (or a fresh session)
     *  has none of the versioned resources registered yet. */
    void reloadSamplesFromPaths();
    // [SYNTH] Real wavetable synthesis (Task 4, multi-agent work order).
    // Built-in curated tables are pure generated data (no file I/O) — unlike
    // samples, they're identical every session, so this just needs to run
    // ONCE per fresh `runtime` (same call site as reloadSamplesFromPaths:
    // end of the shouldInitialize branch in handleAsyncUpdate). Ported 1:1
    // from dsp/wavetables.js's generators — keep the two in lock-step.
    void registerBuiltinWavetables();
    std::vector<float> getBaseWavetableFrame (int tableId, int slot); // bin-aware base frame
    void ensureWavetableRegistered (int tableId); // lazy per-table registration
    int getWavetableFrameCount (int tableId); // per-table frame count (non-const)

    // [SYNTH] Wavetable Warp resource pipeline — minimal proof (todo.md,
    // WT Architecture doc). Unlike the base tables above, a warped frame
    // depends on live per-operator state (wtId/warpMode/warpAmount/
    // warpParam2), so this must re-check every handleAsyncUpdate, not just
    // once per fresh runtime. Only warpMode 1 ("Bend +") is ported to C++ so
    // far — proving the resource pipeline end-to-end before generalizing to
    // the rest of the 29 warp modes, per the architecture doc's explicit
    // "prove one warp mode first" sequencing. Every other warp mode still
    // resolves to the unwarped base key (already registered), which is a
    // silent no-op rather than a crash — intentional for this proof, not a
    // final behavior.
    void ensureWavetableWarpResources();
    // Tracks which warped resource keys this SPECIFIC runtime instance has
    // already registered, so ensureWavetableWarpResources() doesn't redo the
    // (non-trivial) frame-generation work on every debounced state dispatch
    // once a warp is dialed in. SharedResourceMap itself has no public
    // `has()` on Runtime — this is the "one authoritative cache" the
    // architecture doc asks for, cleared whenever `runtime` is rebuilt.
    std::unordered_set<std::string> registeredWavetableWarpKeys;
    std::unordered_set<int> registeredWavetableIds; // lazy registration tracker
    juce::MemoryBlock wavetableBinData; // owns the binary data
    faze::wt::WavetableBin wavetableBin; // views wavetableBinData
    bool wavetableBinValid = false;
    faze::uwt::UserWavetables userWavetables; // flat user folder, ids 381+index
    juce::AudioFormatManager sampleFormatManager;
    juce::String samplePaths[4];
    int sampleVersions[4] {};
    bool sampleLoaded[4] {};   // true only while a decoded buffer is REALLY registered with the current runtime

    // [SYNTH] Resample recording (todo.md §167 S1): captures the plugin's own
    // master output into recBuf (mono) while recOp >= 0, then writes a WAV and
    // feeds it through loadSampleFile. recLock only guards the audio-thread
    // copy against the message thread reading the finished take.
    juce::SpinLock recLock;
    std::vector<float> recBuf;
    std::atomic<int> recOp { -1 };          // operator being recorded into, -1 = idle
    std::atomic<int> recSource { 0 };       // 0 = master output (resample), 1 = audio input
    std::atomic<int> recPos { 0 };
    std::atomic<bool> recDone { false };    // buffer filled on the audio thread -> finish on message thread
    int recTargetOp { -1 };                 // message thread
    int lastSentRecTenths { -2 };           // message thread (UI readout throttle)
    void finishResampleRecording();
    std::atomic<bool> shouldInitialize { false };
    double lastKnownSampleRate = 0;
    std::atomic<double> lastKnownBpm { 120.0 }; // host tempo for LFO sync (§88.A)
    int lastKnownBlockSize = 0;

    elem::js::Object state;
    choc::javascript::Context jsContext;

    juce::AudioBuffer<float> scratchBuffer;
    juce::AudioBuffer<float> sidechainBuf;   // copy of the sidechain input for the Audio Follower
    std::unique_ptr<elem::Runtime<float>> runtime;

    // [SYNTH] --------------------------------------------------------------
    // Voice allocation runs on the audio thread (it walks the MidiBuffer).
    // We snapshot it under a short spin-lock for the main thread to fold into
    // `state` before each dispatch. A spin-lock (not a mutex) because the
    // critical section is a 64-byte memcpy and must never block the audio
    // thread; a spike-grade choice — a lock-free double buffer would be the
    // production move.
    VoicePool<kNumVoices> voicePool;
    juce::AudioParameterFloat* voiceModeParam = nullptr; // read on the audio thread (atomic get)
    // Mirror of voicePool read by the "voicectl" graph node (VoiceCtl.h).
    std::shared_ptr<VoiceCtlBank> voiceCtlBank { std::make_shared<VoiceCtlBank>() };
    juce::SpinLock voiceLock;
    struct VoiceSnapshot { float gate[kNumVoices] {}; float freq[kNumVoices] {}; float vel[kNumVoices] {}; };
    VoiceSnapshot voiceSnapshot;
    std::atomic<bool> voicesDirty { false };
    // Throttle for the voice snapshot (see handleMidi): at most one publish per 200 ms.
    juce::uint32 lastVoicePublishMs = 0;
    std::atomic<bool> voiceSnapshotPending { false }; // note event lost the lock; retry
    std::atomic<float> lastReconcileMs { 0.0f }; // cost of the last DSP rebuild (adaptive debounce)
    std::atomic<bool> eqScopesWanted { false };
    juce::uint32 firstDeferMs { 0 }; // when the current debounce window started

    // [SYNTH] P7c visualizer — a separate ~30Hz timer drains el.scope frames.
    struct FrameTimer : juce::Timer {
        std::function<void()> fn;
        void timerCallback() override { if (fn) fn(); }
    };
    FrameTimer scopeTimer;

    void handleMidi (const juce::MidiBuffer& midi);

    // [SYNTH] on-screen-piano notes from the webview UI (todo.md §73 P7a).
    // The UI thread appends; processBlock drains under a try-lock and folds
    // them into the MIDI stream. Spike-grade (matches the voice-snapshot
    // spin-lock choice above).
public:
    void pushUiNote (int midiNote, bool on, float velocity);
private:
    juce::SpinLock uiMidiLock;
    juce::Array<juce::MidiMessage> uiMidiQueue;
    // --------------------------------------------------------------------

    struct ParameterReadout { float value = 0; bool dirty = false; };
    std::list<std::atomic<ParameterReadout>> paramReadouts;
    static_assert(std::atomic<ParameterReadout>::is_always_lock_free);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SynthPluginProcessor)
};
