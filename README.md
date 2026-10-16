# PsydeNote

A software synthesizer (VST3 plugin and Windows standalone) built on Elementary Audio: four FM/PM operators,
wavetable and sample sources, a dual filter bus, an FX chain, modulators, and a layered arpeggiator and step
sequencer.

See [WHAT_WORKS.md](WHAT_WORKS.md) for what is working, what is still being tested, and known issues.

## Build

- Plugin: `spike/elementary/plugin` (CMake, JUCE, MSVC). Build notes in `spike/elementary/plugin/BUILD.md`.
- UI assets: `npm install` then `npm run build:plugin-assets` in `spike/elementary`.
- Installer: `spike/elementary/installer/FAEZ.nsi` (NSIS).

JUCE and Elementary are git submodules (`git submodule update --init --recursive`).

Status: early test builds. Not yet licensed for redistribution; all rights reserved until a licence is added.
