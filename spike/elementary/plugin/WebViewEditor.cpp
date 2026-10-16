#include "PluginProcessor.h"
#include "WebViewEditor.h"
#include "Assets.h"
#include "Diag.h"
#if JucePlugin_Build_Standalone
 #include <juce_audio_utils/juce_audio_utils.h>
 #include <juce_audio_plugin_client/Standalone/juce_StandaloneFilterWindow.h>
#endif

static inline void appendUiLog (const juce::String& line) { fazeDiagLog (line); }

// Adapted from elemaudio/srvb (MIT). Changes: class renamed, dev URL -> :5174,
// and the resource handler serves EMBEDDED assets (Assets.h) instead of files
// on disk — see the note in Assets.h for why.

// DIAGNOSTIC/FIX (todo.md §137/§138/§139 — live crash investigation).
// The old version's final branch called v.getInt64() UNCONDITIONALLY for
// anything that wasn't float32/float64/int32 — but choc's getInt64() (per
// its own doc comment) THROWS a choc::value::Error (a std::exception) if the
// value isn't actually an int64. This function is called from inside
// webView->bind("__postNativeMessage__", ...)'s lambda, which the WebView2
// COM layer invokes as a message-received callback — a boundary a C++
// exception cannot safely cross (COM callback ABIs don't support it; an
// escaping exception here is exactly the kind of thing that triggers
// std::terminate()/abort(), which matches the STATUS_STACK_BUFFER_OVERRUN /
// ucrtbase.dll crash signature seen repeatedly this session). Any JS-
// originated value reaching this function is untrusted, external-boundary
// input — genuinely validate it here rather than assume it's always numeric.
static double numberFromChocValue (const choc::value::ValueView& v)
{
    if (v.isFloat32()) return (double) v.getFloat32();
    if (v.isFloat64()) return v.getFloat64();
    if (v.isInt32())   return (double) v.getInt32();
    if (v.isInt64())   return (double) v.getInt64();
    if (v.isBool())    return v.getBool() ? 1.0 : 0.0;

    // Anything else (void/null — e.g. JSON.stringify(NaN) becomes `null` on
    // the JS side — string, object, array) isn't a number the JS UI could
    // have sensibly sent for a numeric field. Log it (so a repro pins down
    // exactly what arrived) and fall back to 0 instead of throwing.
    juce::String kind = v.isVoid() ? "void/null" : v.isString() ? "string"
                       : v.isObject() ? "object" : v.isArray() ? "array"
                       : v.isVector() ? "vector" : "unknown";
    fazeDiagLog ("[wtdiag][ERROR] numberFromChocValue: value is not numeric (type=" + kind + ")");
    return 0.0;
}

//==============================================================================
WebViewEditor::WebViewEditor (juce::AudioProcessor* proc, int width, int height)
    : juce::AudioProcessorEditor (proc)
{
    appendUiLog ("--- WebViewEditor ctor ---");

    // FROZEN at a fixed size (todo.md §94, user: "lets just freeze the UI at
    // this size for now") — user resized by hand to a layout with no
    // clipping AND no dead space (4-across OSC row, Filter/VELO row and
    // piano all visible, no gap), screenshotted it, and asked to lock it
    // there rather than keep chasing reflow edge cases across arbitrary
    // window sizes. Was resizable 912x888..3000x2100 (§88.5/§92/§94); now
    // pinned to exactly the screenshotted size, both ways, until a real
    // resizable-layout pass happens.
    setResizable (false, false);
    setResizeLimits (width, height, width, height);
    setSize (width, height);

    choc::ui::WebView::Options opts;
#if JUCE_DEBUG
    opts.enableDebugMode = true;
#endif

#if ! ELEM_DEV_LOCALHOST
    opts.fetchResource = [] (const choc::ui::WebView::Options::Path& p)
        -> std::optional<choc::ui::WebView::Options::Resource>
    {
        // p is "/" for the root, otherwise "/name.ext". Strip the slash and
        // default the root to index.html.
        std::string name = (p.empty() || p == "/") ? "index.html"
                          : (p.front() == '/' ? p.substr (1) : p);

        if (auto a = getEmbeddedAsset (name))
            return choc::ui::WebView::Options::Resource {
                std::vector<uint8_t> (a->data, a->data + a->size),
                mimeTypeForPath (name)
            };
        return {};
    };
#endif

    webView = std::make_unique<choc::ui::WebView> (opts);

#if JUCE_MAC
    viewContainer.setView (webView->getViewHandle());
#elif JUCE_WINDOWS
    viewContainer.setHWND (webView->getViewHandle());
#endif

    addAndMakeVisible (viewContainer);
    viewContainer.setBounds (getLocalBounds());

    webView->bind ("__postNativeMessage__", [=] (const choc::value::ValueView& args) -> choc::value::Value {
        // DIAGNOSTIC/FIX (todo.md §137/§138/§139) — this whole lambda is
        // invoked directly from WebView2's COM message-received callback.
        // ANY C++ exception escaping this boundary (a choc::value::Error
        // from a type-mismatched accessor anywhere below, for instance) is
        // undefined behaviour across a COM ABI and reliably fires
        // std::terminate()/abort() on MSVC — matching the exact
        // STATUS_STACK_BUFFER_OVERRUN crash signature seen repeatedly this
        // session. Defense-in-depth: catch anything, log it, degrade to a
        // no-op instead of taking the whole process down. This is a genuine
        // external-input boundary (untrusted JS-originated JSON), not a
        // blanket catch-all for internal logic.
        try
        {
        if (args.isArray())
        {
            auto eventName = args[0].getString();

            if (eventName == "ready")
            {
                appendUiLog ("<- ready; dispatching state");
                if (auto* p = dynamic_cast<SynthPluginProcessor*> (getAudioProcessor()))
                {
                    p->dispatchStateChange();
                    p->pushUserWavetableNames();
                }
                appendUiLog ("-> state dispatched");
            }

#if ELEM_DEV_LOCALHOST
            if (eventName == "reload")
                if (auto* p = dynamic_cast<SynthPluginProcessor*> (getAudioProcessor()))
                {
                    p->initJavaScriptEngine();
                    p->dispatchStateChange();
                }
#endif

            if (eventName == "log" && args.size() > 2)
            {
                auto k = args[1].getString();
                auto m = args[2].getString();
                appendUiLog ("[" + juce::String::fromUTF8 (k.data(), (int) k.size()) + "] "
                             + juce::String::fromUTF8 (m.data(), (int) m.size()));
                return {};
            }

            if (eventName == "setParameterValue" && args.size() > 1)
                return handleSetParameterValueEvent (args[1]);

            // [SYNTH] on-screen piano (todo.md §73 P7a): ['midiNote', midi, on, vel]
            if (eventName == "midiNote" && args.size() > 2)
            {
                const int note = (int) numberFromChocValue (args[1]);
                const bool on = numberFromChocValue (args[2]) > 0.5;
                appendUiLog ("<- midiNote " + juce::String (note) + (on ? " on" : " off"));
                if (auto* p = dynamic_cast<SynthPluginProcessor*> (getAudioProcessor()))
                    p->pushUiNote (note, on,
                                   args.size() > 3 ? (float) numberFromChocValue (args[3]) : 0.8f);
            }

            // Standalone window chrome: ['winDrag', 'start'|'move'], ['winCtl', 'min'|'close'|'options']
            if (eventName == "winDrag" && args.size() > 1)
            {
                auto ph = args[1].getString();
                if (ph == "start") windowDragStart(); else windowDragMove();
            }
            if (eventName == "winCtl" && args.size() > 1)
                windowControl (juce::String (std::string (args[1].getString())));

            // Wavetable folder button: ['openWavetableFolder']
            if (eventName == "openWavetableFolder")
                if (auto* p = dynamic_cast<SynthPluginProcessor*> (getAudioProcessor()))
                    p->openWavetableFolder();

            // Pick a custom wavetable library folder: ['setWavetableLibrary']
            if (eventName == "setWavetableLibrary")
                handleSetWavetableLibraryEvent();

            // Re-scan the wavetable folder: ['rescanWavetables']
            if (eventName == "rescanWavetables")
                if (auto* p = dynamic_cast<SynthPluginProcessor*> (getAudioProcessor()))
                    p->rescanUserWavetables();

            // EQ editor mounted/unmounted: ['eqScopes', on]
            if (eventName == "eqScopes" && args.size() > 1)
                if (auto* p = dynamic_cast<SynthPluginProcessor*> (getAudioProcessor()))
                    p->setEqScopesWanted (numberFromChocValue (args[1]) > 0.5);

            // [SYNTH] Sampler file-load (todo.md §114): ['pickSampleFile', opIndex]
            if (eventName == "pickSampleFile" && args.size() > 1)
                handlePickSampleFileEvent ((int) numberFromChocValue (args[1]));

            // [SYNTH] Sampler clear (todo.md §114): ['clearSampleFile', opIndex]
            if (eventName == "clearSampleFile" && args.size() > 1)
                if (auto* p = dynamic_cast<SynthPluginProcessor*> (getAudioProcessor()))
                    p->clearSampleFile ((int) numberFromChocValue (args[1]));

            // [SYNTH] LFO Function editor (todo.md — "all LFOs are
            // functions"): ['setFunctionShape', lfoIndex(1..10), shapeJson].
            // Point data isn't a bounded host float, so it travels here
            // instead of setParameterValue — same precedent as
            // pickSampleFile's file path above.
            if (eventName == "setFunctionShape" && args.size() > 2)
            {
                const int lfoIndex = (int) numberFromChocValue (args[1]);
                auto json = args[2].getString();
                if (auto* p = dynamic_cast<SynthPluginProcessor*> (getAudioProcessor()))
                    p->setFunctionShape (lfoIndex, juce::String::fromUTF8 (json.data(), (int) json.size()));
            }

            // [SYNTH] multi-point envelope shape: ['setEnvShape', envId, shapeJson].
            // Same reasoning as setFunctionShape above — point data is not a
            // bounded host float, so it does not go through setParameterValue.
            if (eventName == "setEnvShape" && args.size() > 2)
            {
                auto id = args[1].getString();
                auto json = args[2].getString();
                if (auto* p = dynamic_cast<SynthPluginProcessor*> (getAudioProcessor()))
                    p->setEnvShape (juce::String::fromUTF8 (id.data(), (int) id.size()),
                                    juce::String::fromUTF8 (json.data(), (int) json.size()));
            }

            // [SYNTH] resample recording (todo.md §167 S1): ['resampleRec', opIndex, on]
            if (eventName == "resampleRec" && args.size() > 2)
                if (auto* p = dynamic_cast<SynthPluginProcessor*> (getAudioProcessor()))
                    p->setResampleRecording ((int) numberFromChocValue (args[1]), numberFromChocValue (args[2]) > 0.5,
                                             args.size() > 3 ? (int) numberFromChocValue (args[3]) : 0);

            // [SYNTH] native arp/seq settings: ['setArpConfig', json]
            if (eventName == "setArpConfig" && args.size() > 1)
            {
                auto json = args[1].getString();
                if (auto* p = dynamic_cast<SynthPluginProcessor*> (getAudioProcessor()))
                    p->setArpConfig (juce::String::fromUTF8 (json.data(), (int) json.size()));
            }

            // [SYNTH] Parametric EQ band list (todo.md): ['setEqBands',
            // bandsJson]. Array data, same "not a bounded host float"
            // reasoning as setFunctionShape just above.
            if (eventName == "setEqBands" && args.size() > 1)
            {
                auto json = args[1].getString();
                if (auto* p = dynamic_cast<SynthPluginProcessor*> (getAudioProcessor()))
                    p->setEqBands (juce::String::fromUTF8 (json.data(), (int) json.size()));
            }
        }
        return {};
        }
        catch (const std::exception& e)
        {
            fazeDiagLog (juce::String ("[wtdiag][ERROR] __postNativeMessage__ threw: ") + juce::String (e.what()));
            return {};
        }
        catch (...)
        {
            fazeDiagLog ("[wtdiag][ERROR] __postNativeMessage__ threw (non-std)");
            return {};
        }
    });

#if ELEM_DEV_LOCALHOST
    webView->navigate ("http://localhost:5174");
#endif
}

choc::ui::WebView* WebViewEditor::getWebViewPtr() { return webView.get(); }

void WebViewEditor::paint (juce::Graphics&) {}

void WebViewEditor::resized() { viewContainer.setBounds (getLocalBounds()); }

//==============================================================================
// Standalone window chrome. The stock JUCE StandaloneFilterWindow draws a
// native title bar (title + an "Options" button + min/close) that cost ~30px
// of the user's screen (todo.md: "lets not have a top bar"). In the
// Standalone build only, strip it once the editor is parented: switch to the
// JUCE-drawn frame with a zero-height title bar, hide the stock Options
// button, and let the UI's own header provide drag / Options / min / close
// through the messages handled below.
bool WebViewEditor::isStandalone() const
{
    return processor.wrapperType == juce::AudioProcessor::wrapperType_Standalone;
}

juce::DocumentWindow* WebViewEditor::standaloneWindow() const
{
    return isStandalone() ? findParentComponentOfClass<juce::DocumentWindow>() : nullptr;
}

void WebViewEditor::parentHierarchyChanged()
{
    if (chromeStripped)
        return;
    if (auto* win = standaloneWindow())
    {
        chromeStripped = true;
        win->setUsingNativeTitleBar (false);
        win->setTitleBarHeight (0);
        win->setTitleBarButtonsRequired (0, false);
        win->setDropShadowEnabled (false);
        for (auto* c : win->getChildren())
            if (auto* b = dynamic_cast<juce::TextButton*> (c))
                b->setVisible (false); // the stock "Options" button
        win->resized();
    }
}

void WebViewEditor::windowDragStart()
{
    if (auto* win = standaloneWindow())
    {
        dragMouseStart = juce::Desktop::getMousePosition();
        dragWindowStart = win->getPosition();
    }
}

void WebViewEditor::windowDragMove()
{
    if (auto* win = standaloneWindow())
        win->setTopLeftPosition (dragWindowStart + (juce::Desktop::getMousePosition() - dragMouseStart));
}

void WebViewEditor::windowControl (const juce::String& what)
{
    auto* win = standaloneWindow();
    if (win == nullptr)
        return;
    if (what == "min")        win->minimiseButtonPressed();
    else if (what == "close") win->closeButtonPressed();
    else if (what == "options")
    {
#if JucePlugin_Build_Standalone
        // Straight to the Audio/MIDI settings dialog — the stock Options menu also offered
        // "Reset to default state" / save / load, which the synth's own preset bar replaces.
        if (auto* holder = juce::StandalonePluginHolder::getInstance())
            holder->showAudioSettingsDialog();
#endif
    }
}

//==============================================================================
choc::value::Value WebViewEditor::handleSetParameterValueEvent (const choc::value::ValueView& e)
{
    if (e.isObject() && e.hasObjectMember ("paramId") && e.hasObjectMember ("value"))
    {
        auto const& paramId = e["paramId"].getString();
        double const v = numberFromChocValue (e["value"]);

        for (auto& p : getAudioProcessor()->getParameters())
            if (auto* pf = dynamic_cast<juce::AudioParameterFloat*> (p))
                if (pf->paramID.toStdString() == paramId)
                {
                    // The webview sends values in the parameter's REAL units
                    // (Hz, semitones, 0..1…); setValueNotifyingHost wants a
                    // normalised 0..1. (todo.md §73 P7a.)
                    pf->setValueNotifyingHost (pf->convertTo0to1 ((float) v));
                    break;
                }
    }
    return choc::value::Value();
}

//==============================================================================
void WebViewEditor::handleSetWavetableLibraryEvent()
{
    wavetableFolderChooser = std::make_unique<juce::FileChooser> (
        "Choose your wavetable library folder",
        faze::uwt::activeFolder());

    wavetableFolderChooser->launchAsync (
        juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectDirectories,
        [this] (const juce::FileChooser& chooser)
        {
            auto dir = chooser.getResult();
            if (dir != juce::File() && dir.isDirectory())
                if (auto* p = dynamic_cast<SynthPluginProcessor*> (getAudioProcessor()))
                    p->setWavetableLibraryFolder (dir);
        });
}

//==============================================================================
void WebViewEditor::handlePickSampleFileEvent (int opIndex)
{
    sampleFileChooser = std::make_unique<juce::FileChooser> (
        "Load a sample for OSC " + juce::String (opIndex + 1),
        juce::File(),
        "*.wav;*.aif;*.aiff;*.flac;*.ogg;*.mp3");

    // launchAsync's callback runs later on the message thread; capture `this`
    // (the editor outlives the chooser — it owns `sampleFileChooser`) and
    // opIndex by value.
    sampleFileChooser->launchAsync (
        juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
        [this, opIndex] (const juce::FileChooser& chooser)
        {
            auto file = chooser.getResult();
            if (file != juce::File() && file.existsAsFile())
                if (auto* p = dynamic_cast<SynthPluginProcessor*> (getAudioProcessor()))
                    p->loadSampleFile (opIndex, file);
        });
}
