import { useCallback, useEffect, useRef, useState } from 'react';
import type { OperatorId, SynthSettings } from '../../shared/types';
import { SynthEngine } from '../lib/synth';

/**
 * Owns the SynthEngine for the React tree, keeps it in sync with persisted
 * settings, and exposes the engine so the existing visualiser can consume
 * its analyser (it implements the same AnalyserLike interface as the
 * recorder's analyser — see src/renderer/lib/visualizer.ts).
 *
 * One engine per hook instance; the engine's AudioContext lives as long as
 * the component is mounted.
 */
export function useSynth(settings: SynthSettings) {
  const [engine, setEngine] = useState<SynthEngine | null>(null);
  const [activeVoices, setActiveVoices] = useState(0);
  const liveRef = useRef(false);

  // Create / dispose the engine alongside the component. We initialise with
  // the settings at mount time only — per-knob effects below keep the live
  // engine in sync, so a settings change while running does NOT recreate
  // the AudioContext (and the AnalyserNode the visualiser holds).
  useEffect(() => {
    const e = new SynthEngine({
      voiceLimit: settings.voiceLimit,
      masterLevel: settings.masterLevel,
      voiceLevel: settings.voiceLevel,
      ampEnv: settings.ampEnv,
      modEnv: settings.modEnv,
      lfo1: settings.lfo1,
      lfo2: settings.lfo2,
      shRateHz: settings.shRateHz,
      modRoutes: settings.mod,
      filterA: settings.filterA,
      filterB: settings.filterB,
      oscillators: settings.oscillators,
    });
    const cents =
      settings.octave * 1200 + settings.semitone * 100 + settings.fineTuneCents;
    e.setPitchCents(cents);
    setEngine(e);
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      void e.dispose();
      setEngine(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply each setting knob independently so an effect doesn't fight others
  // when several change at once.
  useEffect(() => {
    const cents =
      settings.octave * 1200 + settings.semitone * 100 + settings.fineTuneCents;
    engine?.setPitchCents(cents);
  }, [
    engine,
    settings.octave,
    settings.semitone,
    settings.fineTuneCents,
  ]);

  useEffect(() => {
    engine?.setOscSlots(settings.oscillators);
  }, [engine, settings.oscillators]);

  useEffect(() => {
    engine?.setVoiceLevel(settings.voiceLevel);
  }, [engine, settings.voiceLevel]);

  useEffect(() => {
    engine?.setMasterLevel(settings.masterLevel);
  }, [engine, settings.masterLevel]);

  useEffect(() => {
    engine?.setVoiceLimit(settings.voiceLimit);
  }, [engine, settings.voiceLimit]);

  useEffect(() => {
    engine?.setAmpEnv(settings.ampEnv);
  }, [engine, settings.ampEnv]);

  useEffect(() => {
    engine?.setModEnv(settings.modEnv);
  }, [engine, settings.modEnv]);

  useEffect(() => {
    engine?.setLfos(settings.lfo1, settings.lfo2);
  }, [engine, settings.lfo1, settings.lfo2]);

  useEffect(() => {
    engine?.setShRate(settings.shRateHz);
  }, [engine, settings.shRateHz]);

  useEffect(() => {
    engine?.setModRoutes(settings.mod);
  }, [engine, settings.mod]);

  useEffect(() => {
    engine?.setFilterA(settings.filterA);
  }, [engine, settings.filterA]);

  useEffect(() => {
    engine?.setFilterB(settings.filterB);
  }, [engine, settings.filterB]);

  // Throttled active-voice count for HUD display. requestAnimationFrame would
  // pause when the window is hidden, so a fast setInterval is the right
  // shape here too.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (engine && liveRef.current) setActiveVoices(engine.activeVoiceCount());
    }, 60);
    return () => window.clearInterval(id);
  }, [engine]);

  // Per-operator sample-mode buffer presence (Phase 1.11 — todo.md §33: any
  // of the 4 oscillators can independently hold a captured clip). The engine
  // owns the actual buffers; `sampleVersion` bumps on every load/clear so a
  // waveform tile repaints even when a new buffer replaces an old one of the
  // same duration.
  const [sampleVersion, setSampleVersion] = useState(0);

  // Activate the AudioContext on first user gesture (Chromium's autoplay
  // policy). noteOn also calls ensureRunning but doing it once up-front keeps
  // the first key from being silent-by-a-few-milliseconds.
  useEffect(() => {
    if (!engine) return;
    const onAny = () => {
      void engine.ensureRunning();
    };
    window.addEventListener('pointerdown', onAny, { once: true });
    window.addEventListener('keydown', onAny, { once: true });
    return () => {
      window.removeEventListener('pointerdown', onAny);
      window.removeEventListener('keydown', onAny);
    };
  }, [engine]);

  const noteOn = useCallback(
    (midi: number, velocity = 1) => {
      if (!engine) return;
      void engine.ensureRunning();
      engine.noteOn(midi, velocity);
    },
    [engine],
  );
  const noteOff = useCallback(
    (midi: number) => {
      engine?.noteOff(midi);
    },
    [engine],
  );
  const panic = useCallback(() => {
    engine?.panic();
  }, [engine]);

  // ----- Sample-mode controls ------------------------------------------------
  // The capture side lives in useSamplerCapture (system audio → AudioBuffer);
  // this hook only loads/clears/reads the buffer a given oscillator plays
  // from when it's in sample mode.
  const setSampleBuffer = useCallback(
    (id: OperatorId, buffer: AudioBuffer | null) => {
      if (!engine) return;
      engine.setSampleBuffer(id, buffer);
      setSampleVersion((v) => v + 1);
    },
    [engine],
  );
  const clearSampleBuffer = useCallback(
    (id: OperatorId) => setSampleBuffer(id, null),
    [setSampleBuffer],
  );
  const sampleDuration = useCallback(
    (id: OperatorId): number => engine?.sampleDuration(id) ?? 0,
    [engine],
  );
  const samplePeaks = useCallback(
    (id: OperatorId, maxPoints = 256): Float32Array => {
      if (!engine) return new Float32Array(0);
      return engine.samplePeaks(id, maxPoints);
    },
    [engine],
  );

  return {
    engine,
    noteOn,
    noteOff,
    panic,
    activeVoices,
    sampleVersion,
    setSampleBuffer,
    clearSampleBuffer,
    sampleDuration,
    samplePeaks,
  };
}
