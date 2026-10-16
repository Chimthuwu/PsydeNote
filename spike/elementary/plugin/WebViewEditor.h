#pragma once

// Verbatim from elemaudio/srvb (MIT), class renamed. A juce::AudioProcessorEditor
// that hosts a choc::ui::WebView filling the editor bounds.

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_extra/juce_gui_extra.h>

#include <choc_WebView.h>


class WebViewEditor : public juce::AudioProcessorEditor
{
public:
    WebViewEditor (juce::AudioProcessor* proc, int width, int height);

    choc::ui::WebView* getWebViewPtr();

    void paint (juce::Graphics& g) override;
    void resized() override;
    void parentHierarchyChanged() override;

    /** Standalone only: the stock JUCE window's native title bar is removed
     *  (the UI draws its own drag area + Options/min/close), so these are the
     *  hooks the UI's header buttons call. No-ops inside a plugin host. */
    bool isStandalone() const;
    void windowDragStart();
    void windowDragMove();
    void windowControl (const juce::String& what);

private:
    juce::DocumentWindow* standaloneWindow() const;
    bool chromeStripped = false;
    juce::Point<int> dragMouseStart, dragWindowStart;
    choc::value::Value handleSetParameterValueEvent (const choc::value::ValueView& e);
    /** [SYNTH] Sampler file-load (todo.md §114) — 'pickSampleFile' opens this
     *  for operator `opIndex`. */
    void handlePickSampleFileEvent (int opIndex);
    /** 'setWavetableLibrary': async folder chooser -> processor persists + rescans. */
    void handleSetWavetableLibraryEvent();

    std::unique_ptr<choc::ui::WebView> webView;
    // Must outlive the async FileChooser callback (juce::FileChooser docs) —
    // a local/stack instance would be destroyed the moment launchAsync()
    // returns, before the user ever picks a file.
    std::unique_ptr<juce::FileChooser> sampleFileChooser;
    std::unique_ptr<juce::FileChooser> wavetableFolderChooser;

#if JUCE_MAC
    juce::NSViewComponent viewContainer;
#elif JUCE_WINDOWS
    juce::HWNDComponent viewContainer;
#else
 #error "Mac and Windows only for now."
#endif
};
