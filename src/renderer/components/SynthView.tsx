import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, ModMap, ModSourceId, ModTargetId, OperatorId, SynthSettings } from '../../shared/types';
import { MAX_SAMPLE_CAPTURE_SECONDS } from '../../shared/types';
import { useSynth } from '../hooks/useSynth';
import { useSamplerCapture } from '../hooks/useSamplerCapture';
import { useArpEngine } from '../hooks/useArpEngine';
import { VisualizerBoard } from './VisualizerBoard';
import { OscillatorPanel, OperatorCaptureContext } from './OscillatorPanel';
import { ArpPanel } from './ArpPanel';
import { EnvelopePanel } from './EnvelopePanel';
import { PianoKeyboard } from './PianoKeyboard';
import { SynthHeader } from './SynthHeader';
import { MOD_SOURCES, MOD_TARGETS, addModRoute } from '../lib/mod-sources';

/**
 * Phase 1 synth surface — header / visualiser / 2-column oscillator + thumb /
 * piano. The synth engine (and its AnalyserLike) is owned by the hook; this
 * component is purely a wiring layer plus a local active-note set so the
 * piano keys can light up.
 */
interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => Promise<AppSettings> | void;
}

const DEFAULT_PIANO_START_MIDI = 36; // C2
const DEFAULT_PIANO_END_MIDI = 84; // C6 (4 octaves visible — narrower keys)

// MIDI round-up: any octave/semitone offset we apply expands/reduces the
// visible range so the user can play what they're actually hearing. We do
// the offset at render time only; the engine handles pitch separately.
const OCTAVE_OFFSETS = 12;
const SEMITONE_OFFSETS = 1;

export function SynthView({ settings, onChange }: Props) {
  const {
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
  } = useSynth(settings.synth);

  // System-audio capture — "what I hear", record-button style — now targets
  // whichever oscillator's Record toggle was pressed (Phase 1.11 — todo.md
  // §33; there's no more single dedicated sampler operator). Only one
  // oscillator can record at a time since there's one MediaRecorder.
  const [recordingTarget, setRecordingTarget] = useState<OperatorId | null>(null);
  const recordingTargetRef = useRef<OperatorId | null>(null);
  const capture = useSamplerCapture({
    backend: settings.captureBackend,
    sourceId: settings.sourceId,
    loopbackDeviceId: settings.loopbackDeviceId,
    maxSeconds: MAX_SAMPLE_CAPTURE_SECONDS,
    onBuffer: (buffer) => {
      const id = recordingTargetRef.current;
      if (id) setSampleBuffer(id, buffer);
    },
  });
  // Clear the target once the recorder actually stops (Stop button, the
  // 5-minute cap, or an error) so a stale target doesn't linger.
  useEffect(() => {
    if (!capture.recording) {
      recordingTargetRef.current = null;
      setRecordingTarget(null);
    }
  }, [capture.recording]);
  const hasCaptureSource =
    settings.captureBackend === 'desktop' ? !!settings.sourceId : !!settings.loopbackDeviceId;
  const toggleRecord = useCallback(
    (id: OperatorId) => {
      if (capture.recording) {
        void capture.stop();
        return;
      }
      recordingTargetRef.current = id;
      setRecordingTarget(id);
      void capture.start();
    },
    [capture],
  );
  const operatorCapture: OperatorCaptureContext = {
    recordingId: recordingTarget,
    level: capture.level,
    elapsed: capture.elapsed,
    maxSeconds: MAX_SAMPLE_CAPTURE_SECONDS,
    hasSource: hasCaptureSource,
    onToggleRecord: toggleRecord,
    sampleDuration,
    samplePeaks,
    clearSampleBuffer,
    sampleVersion,
  };

  // Local active-note set drives the keyboard's highlight; the engine is
  // the source of truth for which voices are sounding.
  const [heldNotes, setHeldNotes] = useState<Set<number>>(new Set());
  const lastNoteRef = useRef<number | null>(null);
  const [, force] = useState(0);
  useArpEngine(heldNotes, settings.synth.arp, noteOn, noteOff);

  const handleNoteOn = useCallback(
    (midi: number, velocity = 1) => {
      setHeldNotes((prev) => {
        const next = new Set(prev);
        next.add(midi);
        return next;
      });
      lastNoteRef.current = midi;
      force((x) => x + 1); // show last-note readout
      // While the arp is running it owns noteOn/noteOff for the pattern —
      // holding a key should arm the arp, not ALSO sound a sustained tone.
      if (!settings.synth.arp.on) noteOn(midi, velocity);
    },
    [noteOn, settings.synth.arp.on],
  );
  const handleNoteOff = useCallback(
    (midi: number) => {
      setHeldNotes((prev) => {
        if (!prev.has(midi)) return prev;
        const next = new Set(prev);
        next.delete(midi);
        return next;
      });
      if (!settings.synth.arp.on) noteOff(midi);
    },
    [noteOff, settings.synth.arp.on],
  );

  const handleChangeSynth = useCallback(
    (patch: Partial<SynthSettings>) => {
      void onChange({ synth: { ...settings.synth, ...patch } });
    },
    [onChange, settings.synth],
  );

  const synth = settings.synth;
  // History was removed from the main board's chip row; a settings file that
  // still has `visualizer: 'history'` from an older build would otherwise
  // render an unrecoverable empty state. Fall back to oscilloscope.
  const mainVizMode = settings.visualizer === 'history' ? 'oscilloscope' : settings.visualizer;

  // ----- Pigments-style cable routing (ENV dot → knob) -------------------
  // A pointer-down on an ENV source dot raises this state; a window-level
  // pointermove/up pair draws a cable under the cursor. While the pointer is
  // held, the knob currently under the cursor is *auditioned* — the route is
  // pushed straight to the engine (audible) but NOT to persisted state, so
  // you can sweep across several knobs and hear each one in turn. Nothing
  // stays: release over a knob commits that one; release over empty space
  // reverts everything (todo.md §64). The cable is drawn imperatively (no
  // React re-render per mouse move).
  const [cableSource, setCableSource] = useState<ModSourceId | null>(null);
  const dragRef = useRef<{
    source: ModSourceId;
    from: { x: number; y: number };
    to: { x: number; y: number };
    baseMod: ModMap;              // persisted routes at drag start — the revert target
    previewTarget: ModTargetId | null; // knob currently being auditioned
  } | null>(null);
  const pathRef = useRef<SVGPathElement | null>(null);
  const endDotRef = useRef<SVGCircleElement | null>(null);
  const hoverElRef = useRef<HTMLElement | null>(null);
  // The commit path flows through a ref so this effect only re-runs when a
  // drag starts or ends, not on every pointermove.
  const modRef = useRef(synth.mod);
  modRef.current = synth.mod;
  const commitRef = useRef(handleChangeSynth);
  commitRef.current = handleChangeSynth;
  const engineRef = useRef(engine);
  engineRef.current = engine;

  const handleSourceDragStart = useCallback((source: ModSourceId, point: { x: number; y: number }) => {
    dragRef.current = {
      source,
      from: point,
      to: point,
      baseMod: modRef.current ?? {},
      previewTarget: null,
    };
    setCableSource(source);
  }, []);

  // BUG3: while a cable is being dragged, the root gets `is-mod-dragging`
  // (CSS illuminates every modulatable knob so the user can see where the
  // drop is allowed) + `--drag-color` (the SOURCE's identity colour, so the
  // hovered knob lights up in the colour it's about to be tinted).
  const dragColor = cableSource ? MOD_SOURCES[cableSource].color : undefined;

  useEffect(() => {
    if (!cableSource) return;

    const cableColor = MOD_SOURCES[cableSource].color;
    const paintPath = () => {
      const d = dragRef.current;
      const p = pathRef.current;
      const dot = endDotRef.current;
      if (!d || !p) return;
      const dx = Math.max(64, Math.abs(d.to.x - d.from.x) * 0.5);
      p.setAttribute('d', `M ${d.from.x} ${d.from.y} C ${d.from.x + dx} ${d.from.y}, ${d.to.x - dx} ${d.to.y}, ${d.to.x} ${d.to.y}`);
      if (dot) {
        dot.setAttribute('cx', String(d.to.x));
        dot.setAttribute('cy', String(d.to.y));
      }
    };

    // Audition whatever knob is under the cursor right now, engine-only.
    const previewTarget = (targetId: ModTargetId | null) => {
      const d = dragRef.current;
      if (!d) return;
      d.previewTarget = targetId;
      const map = targetId ? addModRoute(d.baseMod, d.source, targetId) : d.baseMod;
      engineRef.current?.setModRoutes(map);
    };

    // The knob (or dial/graph) under a point — only real controls carry
    // `data-mod-target`; the ∿ badge does NOT (it just opens the popover),
    // so a cable can only ever land on the control itself (todo.md §69).
    // A target is only a valid drop if THIS source is offered for it (e.g.
    // ENV 1 is not offered on level targets); an invalid one isn't
    // highlighted and can't be dropped on.
    const src = cableSource;
    const targetUnder = (x: number, y: number): ModTargetId | null => {
      const el = document.elementFromPoint(x, y)?.closest('[data-mod-target]') as HTMLElement | null;
      const raw = (el?.getAttribute('data-mod-target') as ModTargetId | null) ?? null;
      const valid = raw && MOD_TARGETS[raw]?.sources.includes(src) ? raw : null;
      const hl = valid ? el : null;
      if (hl !== hoverElRef.current) {
        hoverElRef.current?.classList.remove('is-mod-drop');
        hoverElRef.current = hl;
        hoverElRef.current?.classList.add('is-mod-drop');
      }
      return valid;
    };

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      d.to = { x: e.clientX, y: e.clientY };
      paintPath();
      const targetId = targetUnder(e.clientX, e.clientY);
      if (targetId !== d.previewTarget) previewTarget(targetId);
    };
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      // Fast/small drags may never fire a pointermove over the target — do a
      // final hit-test at the release point so the drop still lands.
      if (d && !d.previewTarget) {
        const t = targetUnder(e.clientX, e.clientY);
        if (t) previewTarget(t);
      }
      hoverElRef.current?.classList.remove('is-mod-drop');
      hoverElRef.current = null;
      if (d?.previewTarget) {
        // Release over a knob → this route stays. commitRef writes persisted
        // state; the useSynth effect then re-pushes it to the engine (no-op,
        // the preview already applied it).
        commitRef.current({ mod: addModRoute(d.baseMod, d.source, d.previewTarget) });
      } else {
        // Release over nothing → revert the audition, commit nothing.
        engineRef.current?.setModRoutes(d?.baseMod ?? modRef.current ?? {});
      }
      dragRef.current = null;
      setCableSource(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    paintPath();
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      hoverElRef.current?.classList.remove('is-mod-drop');
      hoverElRef.current = null;
      // Drag interrupted (unmount / forced cancel) with an un-committed
      // audition still applied — put the engine back to persisted state.
      if (dragRef.current) {
        engineRef.current?.setModRoutes(dragRef.current.baseMod);
        dragRef.current = null;
      }
    };
  }, [cableSource]);

  // Piano range follows pitch offset so what the user sees is what they
  // hear. Costs nothing to recompute each render.
  const pianoStart = useMemo(
    () => DEFAULT_PIANO_START_MIDI + synth.octave * OCTAVE_OFFSETS + synth.semitone * SEMITONE_OFFSETS,
    [synth.octave, synth.semitone],
  );
  const pianoEnd = useMemo(
    () => DEFAULT_PIANO_END_MIDI + synth.octave * OCTAVE_OFFSETS + synth.semitone * SEMITONE_OFFSETS,
    [synth.octave, synth.semitone],
  );

  const [activeViewTab, setActiveViewTab] = useState<'synth' | 'fx'>('synth');
  const scrollRef = useRef<HTMLDivElement>(null);
  const envRef = useRef<HTMLDivElement>(null);

  const jumpToSynth = useCallback(() => {
    setActiveViewTab('synth');
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const jumpToFx = useCallback(() => {
    setActiveViewTab('fx');
    envRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <div
      className={`synth-root ${cableSource ? 'is-mod-dragging' : ''}`}
      style={{ '--drag-color': dragColor } as React.CSSProperties}
      onContextMenu={(e) => {
        // Right-click on the synth body: keys keep their click logic; the
        // synthesiser surface itself can fall through to the OS quick menu,
        // which is fine.
        if ((e.target as HTMLElement).closest('.pk-row')) return;
      }}
    >
      <SynthHeader
        settings={settings}
        lastNoteMidi={lastNoteRef.current}
        activeVoices={activeVoices}
        onChange={onChange}
        onPanic={panic}
        activeViewTab={activeViewTab}
        onJumpToSynth={jumpToSynth}
        onJumpToFx={jumpToFx}
      />

      {/* Only THIS region scrolls (todo.md §57 — "piano keys should always
          be visible"). The header above and the piano below are pinned
          outside it as fixed-size flex siblings, so no amount of content
          in the board/oscillator/envelope area can ever push either off
          screen — shrink the window and this region grows a scrollbar
          instead, exactly like §54 intended, but without also carrying the
          piano and header along for the ride. */}
      <div className="synth-scroll" ref={scrollRef}>
        <main className="synth-board">
          <VisualizerBoard
            analyser={engine}
            mode={mainVizMode}
            theme={settings.theme}
          />
        </main>

        {/* Modulators moved BELOW the oscillator engine, full width
            (todo.md §58) — no more narrow right-hand sidebar. */}
        <section className="synth-controls">
          <OscillatorPanel
            settings={synth}
            onChange={handleChangeSynth}
            activeVoices={activeVoices}
            lastNoteMidi={lastNoteRef.current}
            capture={operatorCapture}
            engine={engine}
            theme={settings.theme}
          />
          <ArpPanel arp={synth.arp} onChange={(patch) => handleChangeSynth({ arp: { ...synth.arp, ...patch } })} />
          <div ref={envRef} style={{ width: '100%' }}>
            <EnvelopePanel
              ampEnv={synth.ampEnv}
              modEnv={synth.modEnv}
              lfo1={synth.lfo1}
              lfo2={synth.lfo2}
              shRateHz={synth.shRateHz}
              filterA={synth.filterA}
              filterB={synth.filterB}
              mod={synth.mod}
              onChange={handleChangeSynth}
              onSourceDragStart={handleSourceDragStart}
            />
          </div>
        </section>
      </div>

      <footer className="synth-keys">
        <PianoKeyboard
          startMidi={pianoStart}
          endMidi={pianoEnd}
          activeNotes={heldNotes}
          onNoteOn={handleNoteOn}
          onNoteOff={handleNoteOff}
          velocityCurve={synth.velocityCurve}
        />
      </footer>

      {/* Pigments-style cable overlay, drawn while an ENV dot is dragged. */}
      {cableSource && (
        <svg className="mod-cable-layer" aria-hidden="true">
          <path
            ref={pathRef}
            className="mod-cable"
            style={{ stroke: MOD_SOURCES[cableSource].color } as React.CSSProperties}
          />
          <circle
            ref={endDotRef}
            className="mod-cable-end"
            style={{ fill: MOD_SOURCES[cableSource].color } as React.CSSProperties}
          />
        </svg>
      )}
    </div>
  );
}
