#pragma once
#include <juce_core/juce_core.h>

// Diagnostic sink: the webview forwards console/errors here and the C++ side logs the state-dispatch
// handshake, so a DAW freeze leaves a trace at %TEMP%/faez-ui.log.
// PERF: high-frequency chatter (every MIDI note, the 60 Hz scope heartbeat) used to open/append/close the
// file on the message thread several times a second and grow it without bound. Those lines are dropped
// now, writes are serialised, and the file restarts when it passes ~1 MB (the previous one is kept as .old).
inline void fazeDiagLog (const juce::String& line)
{
    if (line.contains ("<- midiNote") || line.contains ("drainScopes tick"))
        return;

    static juce::CriticalSection lock;
    static juce::File f = juce::File::getSpecialLocation (juce::File::tempDirectory)
                              .getChildFile ("faez-ui.log");
    static int sinceCheck = 0;
    const juce::ScopedLock sl (lock);
    if ((sinceCheck++ % 200) == 0 && f.getSize() > 1024 * 1024)
    {
        f.copyFileTo (f.withFileExtension ("old"));
        f.deleteFile();
    }
    f.appendText (juce::Time::getCurrentTime().toISO8601 (true) + "  " + line + "\n");
}
