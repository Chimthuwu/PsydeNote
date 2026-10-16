import { ReactNode, useEffect, useState } from 'react';
import { AppSettings } from '../../shared/types';

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => Promise<AppSettings> | void;
  capturing: boolean;
  popoutOpen: boolean;
  onTogglePopout: () => void;
  onOpenSettings: () => void;
  /** Controls rendered inline in the strip (used by the `bar` layout). */
  children?: ReactNode;
}

/**
 * Context-aware mode-switch button label.
 *
 * There are two UI affordances to navigate between synth and recorder mode:
 *
 *   1. `<SynthHeader>`'s "Open Recorder" button (synth→recorder)
 *   2. `<TitleBar>`'s "Open {other-mode}" button (recorder→synth AND synth→recorder)
 *
 * Both exist so neither view feels like a dead-end.
 */
// In Phase 1.6 the recorder-as-separate-view was retired at the user's
// request: every RRecdr capture path is now reachable only inside the
// synth's Sampler panel. The TitleBar's chrome therefore has no mode
// switch. The recorder's underlying capture pipeline (useCapture.ts,
// audio-capture.ts, recorder.ts, ring-buffer.ts) is preserved as
// dead-but-loadable for the Phase 1.7 system-audio sampler subproject
// (see todo.md §19).

/**
 * The app's own title bar, used when settings.titleBarMode === 'custom'.
 *
 * 26px tall against the OS bar's ~32px, and it earns that space back by
 * carrying the controls that matter for a docked window: pin, dock-to-top,
 * pop-out. In `bar` layout the transport buttons render inline here too,
 * so the whole app is one row.
 *
 * Dragging: the strip is the drag region (CSS `-webkit-app-region: drag`);
 * every button opts back out with `no-drag`.
 */
export function TitleBar({
  settings,
  onUpdate,
  capturing,
  popoutOpen,
  onTogglePopout,
  onOpenSettings,
  children,
}: Props) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => window.api.onWindowState((s) => setMaximized(s.maximized)), []);

  return (
    <div className={`titlebar ${children ? 'has-inline' : ''}`}>
      <span className={`tb-dot ${capturing ? 'on' : ''}`} aria-hidden="true" />
      <span className="tb-name">faze</span>

      {children ? <div className="tb-inline">{children}</div> : <div className="tb-spacer" />}

      <div className="tb-actions">
        <button
          type="button"
          className={`tb-btn ${settings.alwaysOnTop ? 'is-on' : ''}`}
          title={settings.alwaysOnTop ? 'Always on top: on' : 'Always on top: off'}
          onClick={() => void onUpdate({ alwaysOnTop: !settings.alwaysOnTop })}
        >
          ▲
        </button>
        <button
          type="button"
          className="tb-btn"
          title="Dock to the top edge of this monitor (full width)"
          onClick={() => window.api.snapWindow('top')}
        >
          ↥
        </button>
        <button
          type="button"
          className={`tb-btn ${popoutOpen ? 'is-on' : ''}`}
          title={popoutOpen ? 'Close the pop-out visualizer' : 'Pop the visualizer out into its own window'}
          onClick={onTogglePopout}
        >
          ⧉
        </button>
        <button type="button" className="tb-btn" title="Settings" onClick={onOpenSettings}>
          ⚙
        </button>

        <span className="tb-sep" />

        <button
          type="button"
          className="tb-btn tb-win"
          title="Minimise"
          onClick={() => window.api.windowControl('minimize')}
        >
          —
        </button>
        <button
          type="button"
          className="tb-btn tb-win"
          title={maximized ? 'Restore' : 'Maximise'}
          onClick={() => window.api.windowControl('restore-or-max')}
        >
          {maximized ? '❐' : '▢'}
        </button>
        <button
          type="button"
          className="tb-btn tb-win tb-close"
          title="Close to tray"
          onClick={() => window.api.windowControl('close')}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export default TitleBar;
