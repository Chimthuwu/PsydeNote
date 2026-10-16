# PsydeNote: what it is and what works

PsydeNote is a software synthesizer (VST3 plugin and Windows standalone) built on Elementary Audio.
It has four oscillator operators with wavetable and sample sources, FM and PM between them, a filter bus,
an FX chain, modulators, and a layered arpeggiator and step sequencer. This file is a status snapshot, not a
spec. The detailed history is in `todo.md`.

## Sound engine

| Area | Status | Notes |
|---|---|---|
| Four operators: waveform, level, pan, filter routing | Works | Waveforms, wavetables and samples per operator. |
| FM and PM between operators | Works, slow to change | Turning these knobs is slow, because each change rebuilds the graph (see Known issues). |
| Dual filter bus (A and B) | Works | Low-pass, high-pass, band-pass, cutoff and resonance per filter. |
| FX chain (delay, reverb, chorus, flanger, phaser, distortion, compressor, EQ) | Works, slow to change | Same rebuild issue as FM and PM. |
| Voices, glide, master, polyphony modes | Works | |

## Modulation

| Area | Status | Notes |
|---|---|---|
| Envelopes (ENV 1 amp, ENV 2 and 3 mod) | Works | The envelope card can show an empty white box at times; under investigation. |
| LFOs 1 to 3 (more can be added) | Works | Rate, shape and depth are modulatable. |
| Audio Follower | Works | |
| Cable drag from a source to a target | Works | |
| Minimised Mods strip: double-click a card to open a floating popout | Works | Popouts can be dragged, stacked, and closed with Esc. Modulation assignment from a popout not yet confirmed. |
| Modulation targets on FX parameters, ADSR and LFO rate and depth | Partly | FX parameters are not all split into separate controls yet (Reverb Width and Diffusion share a node). |

## Arpeggiator and sequencer

| Area | Status | Notes |
|---|---|---|
| Arp layers: green row (Arp row 1) and blue row (Arp row 2), plus Chord | Works | Lighting any ARP button starts the arp. |
| Green and blue rows with their own rate, octaves, gate, chaos and dice | Built, not heard | Each row has its own clock. Blue sounds only with a blue layer lit. |
| Pattern per row (green from the big grid, blue from its own knob) | Built, not heard | With only two notes, Up, Down and Walk sound the same. Hold three or more notes to hear pattern changes. |
| Mini panel Rate, Octaves, Gate: move both rows, relative | Built, not heard | |
| Mini panel Pattern knob: moves both rows, relative | Built, not heard | |
| Step lanes (On, Prob, Pitch, Oct, Vel, Gate, Slide) with dice | Works | |
| Auto-regen (default 2 bars) and Live chaos (default) | Works | |
| Snap to scale with a key and scale | Works | |
| Chord hit and Tight | Works | In the mini panel only. |
| Mini On button and ARP layers stay in step | Fixed, to confirm | On now follows the layers: on while any layer is lit. |

## Keyboard and input

| Area | Status | Notes |
|---|---|---|
| QWERTY keyboard playing notes | Works | Changing the key or scale dropdowns no longer blocks the keys. |
| Knob drag never highlights text | Works | Enforced by `npm run test:ui-select`. |
| Mouse wheel and double-click editing on knobs | Works | |

## Known issues

1. **Slow response when turning graph-changing parameters** (FM, PM, FX). Each change rebuilds the audio graph,
   about 0.5 to 1 second per change on the plugin's message thread. The fast path for PM and FM amounts is
   built and checked headlessly (132 values match a full rebuild); the plugin has not yet been timed with it.
   FX parameters still use the slow path.
2. **Envelope card sometimes shows a blank white box.** Possibly the global colour filter on the page root;
   the filter was removed in the last test build and that build has not yet been checked.
3. **Mini panel layout.** The knobs and the On, Up and Hold stack have needed several passes at different
   window sizes; the strip height is fixed at a minimum of 100 px.

## Build

- Plugin: `spike/elementary/plugin` (CMake, JUCE 7, MSVC). Assets: `npm run build:plugin-assets` in
  `spike/elementary`. See `spike/elementary/plugin/BUILD.md`.
- Installer: `spike/elementary/installer/FAEZ.nsi` (NSIS). The installer build is not run in this snapshot.
- Tests: `npm run test:wire`, `npm run test:ui-select` in `spike/elementary`.
