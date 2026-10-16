import { useEffect, useMemo, useRef, useState } from 'react';
import { VisualizerBoard } from './components/VisualizerBoard';
import { useSettings } from './hooks/useSettings';
import { RemoteAnalyser } from './lib/visualizer';
import { PeakBuffer } from './lib/peak-buffer';
import { VizState, VisualizerMode } from '../shared/types';

const DEFAULT_STATE: VizState = {
  capturing: false,
  hasSource: false,
  canSave: false,
  bufferedSeconds: 0,
  bufferSeconds: 900,
  recordMode: 'rolling',
  theme: 'black-ice',
  visualizer: 'oscilloscope',
  rms: 0,
};

/**
 * The pop-out visualizer window (`index.html#popout`).
 *
 * It owns no audio: the main window streams analyser frames over IPC and this
 * renders them, then sends transport commands back. That keeps a single
 * capture session alive no matter how many windows are showing it, which
 * matters because the WASAPI helper can only be spawned once.
 *
 * Controls live here too (settings.popoutControls) so the pop-out can be the
 * only thing on screen — start/stop and save without going back to the main
 * window.
 */
export default function PopoutApp() {
  const { settings, loaded } = useSettings();
  const [state, setState] = useState<VizState>(DEFAULT_STATE);
  const [hovering, setHovering] = useState(false);
  // The analyser object is stable and mutated in place: VisualizerBoard runs
  // its own requestAnimationFrame draw loop and reads it every frame, so
  // arriving IPC frames must NOT trigger a React re-render (that would tear
  // the draw loop down and rebuild it 30 times a second).
  const analyserRef = useRef(new RemoteAnalyser());
  const lastFrameAt = useRef(0);
  const [live, setLive] = useState(false);
  
  // Create a blank PeakBuffer; we will overwrite its state from IPC
  const peakBufferRef = useRef(new PeakBuffer(15 * 60));
  // A tiny dummy state to trigger React to re-pass the ref to VisualizerBoard if needed
  const [pbRev, setPbRev] = useState(0);

  useEffect(() => {
    const offFrame = window.api.onVizFrame((f) => {
      analyserRef.current.update(f);
      lastFrameAt.current = Date.now();
      setLive(true); // no-op once true — React bails on same-value setState
    });
    const offState = window.api.onVizState((s) => {
      setState(s);
      if (s.bufferSeconds !== peakBufferRef.current.getState().capacity / 100) {
        peakBufferRef.current = new PeakBuffer(s.bufferSeconds);
        setPbRev(r => r + 1);
      }
    });
    const offHistory = window.api.onVizHistory((s) => {
      peakBufferRef.current.setState(s);
      setPbRev(r => r + 1); // trigger re-render of VisualizerBoard occasionally
    });
    return () => { offFrame(); offState(); offHistory(); };
  }, []);

  // The main window stops streaming when its source goes away; fall back to
  // the idle placeholder rather than freezing on the last frame.
  useEffect(() => {
    const id = setInterval(() => {
      if (Date.now() - lastFrameAt.current > 1200) setLive(false);
    }, 400);
    return () => clearInterval(id);
  }, []);

  const analyser = useMemo(() => (live ? analyserRef.current : null), [live]);

  if (!loaded) return <div className="loading">Loading…</div>;

  const theme = state.theme ?? settings.theme;
  const vizMode = state.visualizer ?? settings.visualizer;
  const showControls = settings.popoutControls;

  return (
    <div
      className={`popout theme-${theme} ${state.capturing ? 'is-capturing' : ''}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onContextMenu={(e) => {
        e.preventDefault();
        window.api.showContextMenu();
      }}
    >
      <div className="popout-drag">
        {/* `state.capturing` is repurposed for the synth (todo.md §55): it's
            true while notes are actually sounding, not while "recording" —
            there's nothing to record any more, the recorder UI was retired. */}
        <span className={`tb-dot ${state.capturing ? 'on' : ''}`} aria-hidden="true" />
        <span className="popout-title">{state.capturing ? 'playing' : 'idle'}</span>
        {/* Docking is the whole point of a monitor window — it wants to live
            along the top edge of a display. `windowSnap` routes to whichever
            window sent it, so this parks the pop-out, not the main window. */}
        <button
          type="button"
          className="tb-btn"
          title="Dock to top of screen"
          onClick={() => window.api.snapWindow('top')}
        >
          ⤒
        </button>
        <button
          type="button"
          className="tb-btn"
          title="Quick settings"
          onClick={() => window.api.showContextMenu()}
        >
          ⋯
        </button>
        <button
          type="button"
          className="tb-btn tb-close"
          title="Close pop-out"
          onClick={() => void window.api.togglePopout(false)}
        >
          ✕
        </button>
      </div>

      <div className="popout-board">
        <VisualizerBoard
          analyser={analyser}
          mode={vizMode}
          theme={theme}
          idleText={state.hasSource ? 'waiting for audio' : 'no source selected'}
          peakBuffer={peakBufferRef.current}
          onSelectionChange={(sel) => {
            window.api.sendVizCommand({ type: 'selection-change', selection: sel });
          }}
          isPopout={true}
        />
      </div>

      {showControls && (
        <div className={`popout-controls ${hovering ? 'is-shown' : ''}`}>
          {/* The old Start/Stop + Save transport lived here — both commands
              go nowhere now that the recorder UI is retired (todo.md §55),
              and a permanently-disabled "Save" button is worse than no
              button. The viz-mode chips below are the only pop-out command
              that still does anything. */}
          <div className="popout-chips">
            {(['oscilloscope', 'spectrum', 'spectrogram', 'history'] as VisualizerMode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={`chip ${vizMode === m ? 'on' : ''}`}
                title={m}
                onClick={() => window.api.sendVizCommand({ type: 'set-visualizer', mode: m })}
              >
                {m === 'oscilloscope' ? '∿' : m === 'spectrum' ? '▥' : m === 'spectrogram' ? '▦' : '◷'}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
