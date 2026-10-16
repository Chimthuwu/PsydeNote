cmake_minimum_required(VERSION 3.15)
project(PsydeNote VERSION 0.1.0)

# ---------------------------------------------------------------------------
# Adapted from elemaudio/srvb (MIT). The important differences from that
# template, all because this is an INSTRUMENT and not an effect:
#   * juce_add_plugin gets IS_SYNTH TRUE / NEEDS_MIDI_INPUT TRUE
#   * the plugin category is Instrument (Vst3Category "Instrument|Synth")
#   * no audio input bus (see PluginProcessor.cpp constructor)
# See BUILD.md for the toolchain + build steps.
# ---------------------------------------------------------------------------

set(TARGET_NAME PsydeNote)
set(ASSETS_DIR ${CMAKE_SOURCE_DIR}/../dist/)

option(JUCE_ENABLE_MODULE_SOURCE_GROUPS "Enable Module Source Groups" ON)
option(JUCE_BUILD_EXTRAS "Build JUCE Extras" OFF)
option(ELEM_DEV_LOCALHOST "Run against localhost for static assets" OFF)

# Submodules (see repo .gitmodules):
#   plugin/juce/         -> juce-framework/JUCE, pinned to 7.0.9
#   plugin/elementary/   -> elemaudio/elementary (bundles its own choc at
#                           elementary/cli/choc — flat layout, includes a
#                           vendored QuickJS; that's what we use, no separate
#                           choc submodule)
set(CHOC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/elementary/cli/choc)

add_subdirectory(juce)
add_subdirectory(elementary/runtime)

# Where to install the built .vst3. System folder by default (write access
# granted once via `icacls "C:\Program Files\Common Files\VST3" /grant "<user>:(OI)(CI)M"`).
# Override with -DVST3_COPY_DIR=... if needed.
if (NOT DEFINED VST3_COPY_DIR)
  set(VST3_COPY_DIR "$ENV{CommonProgramFiles}/VST3")
endif()

juce_add_plugin(${TARGET_NAME}
  COMPANY_NAME "Faze"
  BUNDLE_ID "com.serge.faze.faez"
  IS_SYNTH TRUE
  NEEDS_MIDI_INPUT TRUE
  NEEDS_MIDI_OUTPUT FALSE
  IS_MIDI_EFFECT FALSE
  EDITOR_WANTS_KEYBOARD_FOCUS TRUE
  COPY_PLUGIN_AFTER_BUILD FALSE   # done below as a NON-FATAL step instead
  PLUGIN_MANUFACTURER_CODE Srgx
  PLUGIN_CODE Fze1
  FORMATS VST3 Standalone
  VST3_CATEGORIES "Instrument" "Synth"
  PRODUCT_NAME ${TARGET_NAME})

# --- App icon -----------------------------------------------------------
# JUCE 7 has no `juce_add_icon` (that's JUCE 8) and reads JUCE_ICON_FILE at
# configure time from *inside* juce_add_plugin, so the property can't be set
# afterwards. The supported hook is JUCE_USER_DEFINED_RC_FILE: defining it
# makes JUCE's generated .rc `#include` ours instead, so we own both the
# ICON and VS_VERSION_INFO blocks. See FAEZ_icon.rc.
# Regenerate the .ico with `python ../scripts/make_icon.py`.
set(PsydeNote_ICON_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../scripts")
target_compile_definitions(${TARGET_NAME}_rc_lib
  PRIVATE JUCE_USER_DEFINED_RC_FILE="FAEZ_icon.rc")
target_include_directories(${TARGET_NAME}_rc_lib PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}"          # finds FAEZ_icon.rc
  "${PsydeNote_ICON_DIR}")               # finds FAEZ.ico
# Ninja does NOT track the .ico as a dependency of the generated .rc, so
# regenerating the icon alone leaves the resource library -- and therefore the
# linked binary -- stale while the build still reports success. Listing the
# .ico as a source makes ninja depend on its mtime and relink properly.
target_sources(${TARGET_NAME}_rc_lib PRIVATE
  "${PsydeNote_ICON_DIR}/FAEZ.ico")

# wavetables.bin is read at RUNTIME from beside the binary (PluginProcessor.cpp,
# "Load precomputed wavetables.bin"). Nothing used to copy it, so the copies
# next to PsydeNote.exe / inside the .vst3 went stale (an old 85 MB bin kept
# shipping after the table set changed). Copy the current one next to BOTH
# outputs on every build -- BEFORE the VST3 install step below copies the bundle.
# Generate it with `npm run build:wavetables` (spike/elementary).
foreach(_fmt VST3 Standalone)
  add_custom_command(TARGET ${TARGET_NAME}_${_fmt} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${CMAKE_CURRENT_SOURCE_DIR}/wavetables.bin"
            "$<TARGET_FILE_DIR:${TARGET_NAME}_${_fmt}>/wavetables.bin"
    VERBATIM)
endforeach()

# Best-effort install (install-vst3.cmake never returns nonzero, so a DAW
# holding the old .vst3 open won't fail the build).
get_target_property(_vst3_bundle ${TARGET_NAME}_VST3 JUCE_PLUGIN_ARTEFACT_FILE)
add_custom_command(TARGET ${TARGET_NAME}_VST3 POST_BUILD
  COMMAND ${CMAKE_COMMAND}
          -DSRC=${_vst3_bundle}
          -DDST_DIR=${VST3_COPY_DIR}
          -DNAME=${TARGET_NAME}
          -P "${CMAKE_CURRENT_SOURCE_DIR}/install-vst3.cmake"
  VERBATIM)

# The UI + DSP bundle (spike/elementary/dist/, built by `npm run
# build:plugin-assets`) is EMBEDDED in the binary — no runtime file lookup, so
# the plugin is relocatable and works regardless of how a host resolves paths.
# See Assets.h.
juce_add_binary_data(${TARGET_NAME}Assets
  SOURCES
  ${ASSETS_DIR}/dsp.main.js
  ${ASSETS_DIR}/index.html
  ${ASSETS_DIR}/manifest.json)

target_sources(${TARGET_NAME} PRIVATE
  PluginProcessor.cpp
  WebViewEditor.cpp)

target_include_directories(${TARGET_NAME} PRIVATE
  ${CHOC_DIR}/gui
  ${CHOC_DIR}/javascript)

target_compile_features(${TARGET_NAME} PRIVATE cxx_std_17)
if (MSVC)
  add_compile_options(/EHsc)
endif()

target_compile_definitions(${TARGET_NAME} PRIVATE
  ELEM_DEV_LOCALHOST=${ELEM_DEV_LOCALHOST}
  JUCE_VST3_CAN_REPLACE_VST2=0
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0)

target_link_libraries(${TARGET_NAME} PRIVATE
  ${TARGET_NAME}Assets
  juce::juce_audio_basics
  juce::juce_audio_devices
  juce::juce_audio_formats
  juce::juce_audio_plugin_client
  juce::juce_audio_processors
  juce::juce_audio_utils
  juce::juce_core
  juce::juce_data_structures
  juce::juce_events
  juce::juce_graphics
  juce::juce_gui_basics
  juce::juce_gui_extra
  runtime)
