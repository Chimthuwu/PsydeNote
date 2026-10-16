import { ChangeEvent, useEffect, useState, useRef } from 'react';
import {
  AppSettings,
  CaptureBackend,
  CaptureSource,
  LoopbackDevice,
  Theme,
  VisualizerMode,
  RecordMode,
  FILENAME_TOKENS,
  TitleBarMode,
  LabelMode,
  SnapTarget,
  applyVelocityCurve,
  VELOCITY_MIN,
} from '../../shared/types';
import { listSources } from '../lib/audio-capture';
import { Knob } from './Knob';

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  onClose: () => void;
  /** Called when a folder is picked — used to display the result. */
  onPickFolder: () => Promise<string | null>;
  /** Whether the recorder is currently active (used for UX guards). */
  active: boolean;
  /** Whether the WASAPI loopback helper can be used on this platform. */
  loopbackSupported: boolean;
  /** Whether the pop-out visualizer window is currently up. */
  popoutOpen: boolean;
  onTogglePopout: () => void;
}

const TITLEBARS: { value: TitleBarMode; label: string; help: string }[] = [
  {
    value: 'custom',
    label: 'Minimal in-app bar',
    help: '26px strip with pin, dock-to-top, pop-out and window buttons. Frameless window.',
  },
  {
    value: 'system',
    label: 'Windows title bar',
    help: 'The standard OS title bar. Taller, but with the usual snap gestures and window menu.',
  },
];

const LABEL_MODES: { value: LabelMode; label: string }[] = [
  { value: 'auto', label: 'Auto (shrink with the window)' },
  { value: 'icon', label: 'Icons only' },
  { value: 'text', label: 'Always text' },
];

const SNAPS: { target: SnapTarget; label: string }[] = [
  { target: 'top', label: 'Dock top' },
  { target: 'bottom', label: 'Dock bottom' },
  { target: 'top-left', label: 'Top left' },
  { target: 'top-right', label: 'Top right' },
  { target: 'center', label: 'Centre' },
];

const VISIBILITY: { key: keyof AppSettings; label: string }[] = [
  { key: 'showVu', label: 'VU meter' },
  { key: 'showBuffer', label: 'Buffer fill bar' },
  { key: 'showSourcePicker', label: 'Source / output-device picker' },
  { key: 'showVizChips', label: 'Visualizer mode chips' },
  { key: 'showHint', label: 'Hotkey hint line' },
];

const THEMES: { value: Theme; label: string; preview: string }[] = [
  { value: 'black-ice', label: 'Black ice', preview: '#7fe3f5' },
  { value: 'aurora-ice', label: 'Aurora ice', preview: '#6df0ff' },
  { value: 'graphite', label: 'Graphite', preview: '#d8dee6' },
];

const VISUALIZERS: { value: VisualizerMode; label: string }[] = [
  { value: 'oscilloscope', label: 'Oscilloscope' },
  { value: 'spectrum', label: 'Spectrum bars' },
  { value: 'spectrogram', label: 'Spectrogram' },
];

const VELOCITY_CURVE_PRESETS: { value: number; label: string }[] = [
  { value: -0.7, label: 'Soft' },
  { value: 0, label: 'Linear' },
  { value: 0.7, label: 'Hard' },
];

/**
 * Polyline points for the velocity-curve preview: X = click position (top of
 * the key → bottom), Y = resulting velocity (quiet → loud), using the same
 * `applyVelocityCurve` mapping the piano keyboard applies.
 */
function velocityCurvePoints(curve: number, w: number, h: number, n = 25): string {
  const pad = 4;
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const rel = i / (n - 1);
    const v = applyVelocityCurve(rel, curve);
    const x = pad + rel * (w - pad * 2);
    const y = h - pad - ((v - VELOCITY_MIN) / (1 - VELOCITY_MIN)) * (h - pad * 2);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(' ');
}

const RECORD_MODES: { value: RecordMode; label: string; help: string }[] = [
  {
    value: 'rolling',
    label: 'Rolling buffer',
    help: 'Always recording — keeps last N minutes in memory. Hotkey saves that window.',
  },
  {
    value: 'traditional',
    label: 'Press to record',
    help: 'Hotkey starts/stops a fresh recording each time.',
  },
];

const HOTKEY_PRESETS = [
  'Shift+Alt+R',
  'Ctrl+Shift+R',
  'F9',
  'CommandOrControl+Alt+S',
];

const CAPTURE_BACKENDS: { value: CaptureBackend; label: string; help: string }[] = [
  {
    value: 'desktop',
    label: 'Screen / window',
    help: 'Use Electron desktopCapturer. On Windows the loopback mixer routes audio from the chosen source.',
  },
  {
    value: 'loopback',
    label: 'Per-output device (WASAPI)',
    help: 'True per-speaker capture via WASAPI. Pick from Speakers, Headphones, etc. Requires the bundled helper.',
  },
];

export function SettingsPanel({
  settings,
  onUpdate,
  onClose,
  onPickFolder,
  active,
  loopbackSupported,
  popoutOpen,
  onTogglePopout,
}: Props) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [folderBusy, setFolderBusy] = useState(false);
  const templateRef = useRef<HTMLInputElement | null>(null);

  // ----- Sample source (todo.md §33) ---------------------------------------
  // The oscillators' sample-record capture reuses this same backend/source
  // selection (captureBackend/sourceId/loopbackDeviceId) — this is the ONE
  // place that picks it, so an oscillator in sample mode only ever shows a
  // bare Record toggle.
  const [captureSources, setCaptureSources] = useState<CaptureSource[]>([]);
  const [captureDevices, setCaptureDevices] = useState<LoopbackDevice[]>([]);
  const [sourceBusy, setSourceBusy] = useState(false);
  const refreshCaptureSources = async (backend: CaptureBackend) => {
    setSourceBusy(true);
    try {
      if (backend === 'loopback') setCaptureDevices(await window.api.listLoopbackDevices());
      else setCaptureSources(await listSources());
    } catch { /* enumeration failure — picker just shows "no sources found" */ }
    finally { setSourceBusy(false); }
  };
  useEffect(() => {
    void refreshCaptureSources(draft.captureBackend);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.captureBackend]);

  function insertTemplateToken(token: string) {
    const el = templateRef.current;
    if (!el) {
      set('fileNameTemplate', draft.fileNameTemplate + token);
      return;
    }
    const start = el.selectionStart ?? draft.fileNameTemplate.length;
    const end = el.selectionEnd ?? start;
    const before = draft.fileNameTemplate.slice(0, start);
    const after = draft.fileNameTemplate.slice(end);
    const next = before + token + after;
    set('fileNameTemplate', next);
    // Preserve caret position after React re-render.
    requestAnimationFrame(() => {
      const caret = (before + token).length;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  function set<K extends keyof AppSettings>(key: K, val: AppSettings[K]) {
    setDraft((d) => ({ ...d, [key]: val }));
  }

  function setVelocityCurve(v: number) {
    setDraft((d) => ({ ...d, synth: { ...d.synth, velocityCurve: v } }));
  }

  /**
   * Interface toggles apply the moment they're clicked rather than on Save —
   * you can't judge a layout you can't see, and every one of them is
   * reversible with a second click.
   */
  function applyNow(patch: Partial<AppSettings>) {
    setDraft((d) => ({ ...d, ...patch }));
    void onUpdate(patch);
  }

  async function save() {
    await onUpdate(draft);
    onClose();
  }

  async function pickFolder() {
    setFolderBusy(true);
    try {
      const folder = await onPickFolder();
      if (folder) set('saveFolder', folder);
    } finally {
      setFolderBusy(false);
    }
  }

  function onAccel(e: ChangeEvent<HTMLInputElement>) {
    set('hotkey', e.target.value.trim());
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <header>
          <h2>Settings</h2>
          <button className="ghost" onClick={onClose}>×</button>
        </header>

        <section>
          <label>Recording mode</label>
          <div className="radio-group">
            {RECORD_MODES.map((m) => (
              <label key={m.value} className="radio">
                <input
                  type="radio"
                  name="mode"
                  value={m.value}
                  checked={draft.recordMode === m.value}
                  onChange={() => set('recordMode', m.value)}
                  disabled={active}
                />
                <span>
                  <strong>{m.label}</strong>
                  <em>{m.help}</em>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section>
          <label>Capture backend</label>
          <div className="radio-group">
            {CAPTURE_BACKENDS.map((b) => {
              const disabled = active || (b.value === 'loopback' && !loopbackSupported);
              return (
                <label key={b.value} className="radio">
                  <input
                    type="radio"
                    name="backend"
                    value={b.value}
                    checked={draft.captureBackend === b.value}
                    onChange={() => set('captureBackend', b.value)}
                    disabled={disabled}
                  />
                  <span>
                    <strong>{b.label}</strong>
                    <em>{b.help}</em>
                  </span>
                </label>
              );
            })}
          </div>
          {!loopbackSupported && (
            <small>
              WASAPI loopback requires Windows. macOS / Linux users can still use
              the desktopCapturer path.
            </small>
          )}
        </section>

        <section>
          <label>Sample source</label>
          <div className="folder-row">
            <select
              value={draft.captureBackend === 'desktop' ? draft.sourceId ?? '' : draft.loopbackDeviceId ?? ''}
              disabled={sourceBusy}
              onChange={(e) => {
                const v = e.target.value === '' ? null : e.target.value;
                if (draft.captureBackend === 'desktop') set('sourceId', v);
                else set('loopbackDeviceId', v);
              }}
            >
              <option value="">
                {draft.captureBackend === 'desktop'
                  ? captureSources.length === 0 ? 'No screens found…' : 'Pick a screen…'
                  : captureDevices.length === 0 ? 'No devices found…' : 'Pick an output device…'}
              </option>
              {draft.captureBackend === 'desktop'
                ? captureSources.filter((s) => s.kind === 'screen').map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))
                : captureDevices.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}{d.isDefault ? ' (default)' : ''}</option>
                  ))}
            </select>
            <button
              type="button"
              className="ghost"
              disabled={sourceBusy}
              onClick={() => void refreshCaptureSources(draft.captureBackend)}
              title="Re-enumerate sources"
            >
              ↻
            </button>
          </div>
          <small>
            Used by any oscillator in sample mode — "Record what I hear" on the
            oscillator itself uses whichever backend + source is picked here.
          </small>
        </section>

        <section>
          <label htmlFor="hotkey">Recording hotkey</label>
          <input
            id="hotkey"
            type="text"
            value={draft.hotkey}
            onChange={onAccel}
            placeholder="Shift+Alt+R"
          />
          <div className="preset-row">
            {HOTKEY_PRESETS.map((p) => (
              <button key={p} type="button" className="chip" onClick={() => set('hotkey', p)}>
                {p}
              </button>
            ))}
          </div>
          <small>
            Use Electron's accelerator syntax (Shift / Alt / Ctrl / Super / F-keys).
            The hotkey must not be in use by another app.
          </small>
        </section>

        <section>
          <label>Save folder</label>
          <div className="folder-row">
            <code title={draft.saveFolder || 'unset'}>
              {draft.saveFolder || '(not set)'}
            </code>
            <button type="button" className="primary" onClick={pickFolder} disabled={folderBusy}>
              {folderBusy ? '…' : 'Pick folder…'}
            </button>
          </div>
        </section>

        <section>
          <label>Buffer length (rolling mode)</label>
          <div className="slider-row">
            <input
              type="range"
              min={60}
              max={3600}
              step={30}
              value={draft.bufferSeconds}
              onChange={(e) => set('bufferSeconds', Number(e.target.value))}
            />
            <span>{Math.round(draft.bufferSeconds / 60)} min</span>
          </div>
        </section>

        <section>
          <label htmlFor="bitrate">Opus bitrate</label>
          <select
            id="bitrate"
            value={draft.bitrateKbps}
            onChange={(e) => set('bitrateKbps', Number(e.target.value))}
          >
            {[64, 96, 128, 192, 256].map((b) => (
              <option key={b} value={b}>{b} kbps</option>
            ))}
          </select>
        </section>

        <section>
          <label>Default visualizer</label>
          <div className="chip-row">
            {VISUALIZERS.map((v) => (
              <button
                key={v.value}
                type="button"
                className={`chip ${draft.visualizer === v.value ? 'on' : ''}`}
                onClick={() => set('visualizer', v.value)}
              >
                {v.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <label>Keyboard velocity curve</label>
          <div className="vel-curve-row">
            <Knob
              label="Curve"
              value={draft.synth.velocityCurve}
              min={-1}
              max={1}
              onChange={setVelocityCurve}
              format={(v) =>
                v > 0.15 ? 'Hard' : v < -0.15 ? 'Soft' : 'Linear'
              }
              centerDetent
            />
            <svg
              className="vel-curve-preview"
              viewBox="0 0 140 64"
              role="img"
              aria-label="Velocity curve preview"
            >
              <polyline
                className="vel-curve-axis"
                points="4,60 136,60 136,4"
                fill="none"
              />
              <polyline
                className="vel-curve-line"
                points={velocityCurvePoints(draft.synth.velocityCurve, 140, 64)}
                fill="none"
              />
              <text className="vel-curve-tick" x="4" y="62" textAnchor="start">top</text>
              <text className="vel-curve-tick" x="136" y="62" textAnchor="end">bottom</text>
            </svg>
          </div>
          <div className="chip-row">
            {VELOCITY_CURVE_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`chip ${draft.synth.velocityCurve === p.value ? 'on' : ''}`}
                onClick={() => setVelocityCurve(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <small>
            How click position on a key maps to velocity — deeper on the key =
            louder. Soft favours light clicks; Hard needs a full-depth click to
            reach full volume. Applies to pointer notes (computer keys use a
            fixed velocity).
          </small>
        </section>

        <section>
          <label>Theme</label>
          <div className="theme-row">
            {THEMES.map((t) => (
              <button
                key={t.value}
                type="button"
                className={`theme-card ${draft.theme === t.value ? 'on' : ''}`}
                onClick={() => {
                  set('theme', t.value);
                  void onUpdate({ theme: t.value });
                }}
              >
                <span className="swatch" style={{ background: t.preview }} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <label>Title bar</label>
          <div className="radio-group">
            {TITLEBARS.map((t) => (
              <label key={t.value} className="radio">
                <input
                  type="radio"
                  name="titlebar"
                  value={t.value}
                  checked={draft.titleBarMode === t.value}
                  onChange={() => applyNow({ titleBarMode: t.value })}
                />
                <span>
                  <strong>{t.label}</strong>
                  <em>{t.help}</em>
                </span>
              </label>
            ))}
          </div>
          <small>
            Switching rebuilds the window — Electron can't add or remove a frame
            in place. Any capture in progress stops, so do it while idle.
          </small>
        </section>

        <section>
          <label>Button labels</label>
          <div className="chip-row">
            {LABEL_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                className={`chip ${draft.labelMode === m.value ? 'on' : ''}`}
                onClick={() => applyNow({ labelMode: m.value })}
              >
                {m.label}
              </button>
            ))}
          </div>
          <small>
            "Save last 15 min" is the widest control in the app. Auto swaps it
            for "Save 15m" and then a ⇩ glyph as the window narrows.
          </small>
        </section>

        <section>
          <label>Show in the interface</label>
          <div className="chip-row">
            {VISIBILITY.map((v) => (
              <button
                key={v.key as string}
                type="button"
                className={`chip ${draft[v.key] ? 'on' : ''}`}
                onClick={() => applyNow({ [v.key]: !draft[v.key] } as Partial<AppSettings>)}
              >
                {draft[v.key] ? '✓ ' : ''}{v.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <label>Window</label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.alwaysOnTop}
              onChange={(e) => applyNow({ alwaysOnTop: e.target.checked })}
            />
            <span>
              <strong>Always on top</strong>
              <em>Keeps Faze above other windows. The same toggle is reachable from the system-tray icon menu.</em>
            </span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.magneticSnap}
              onChange={(e) => applyNow({ magneticSnap: e.target.checked })}
            />
            <span>
              <strong>Magnetic edge snap</strong>
              <em>Drop the window near a screen edge and it clicks flush against it.</em>
            </span>
          </label>
          <div className="preset-row">
            {SNAPS.map((s) => (
              <button
                key={s.target}
                type="button"
                className="chip"
                onClick={() => window.api.snapWindow(s.target)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.dockReservesSpace}
              onChange={(e) => applyNow({ dockReservesSpace: e.target.checked })}
              disabled={window.api.platform !== 'win32'}
            />
            <span>
              <strong>Docking reserves screen space</strong>
              <em>
                While docked to the top, shrink the desktop work area so other applications lay
                out <em>below</em> the strip instead of being covered by it — the same mechanism
                the taskbar uses. Affects every application, so it's off by default. Windows only.
              </em>
            </span>
          </label>
          <small>
            Dock top spans the full width of the current monitor as a compact
            strip across the top of the screen.
          </small>
        </section>

        <section>
          <label>Pop-out visualizer</label>
          <div className="preset-row">
            <button type="button" className="primary" onClick={onTogglePopout}>
              {popoutOpen ? 'Close pop-out' : 'Open pop-out'}
            </button>
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.popoutControls}
              onChange={(e) => applyNow({ popoutControls: e.target.checked })}
            />
            <span>
              <strong>Transport buttons inside the pop-out</strong>
              <em>Start/stop, save and the visualizer modes, over the waveform. Fade in on hover.</em>
            </span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.popoutAlwaysOnTop}
              onChange={(e) => applyNow({ popoutAlwaysOnTop: e.target.checked })}
            />
            <span>
              <strong>Pop-out always on top</strong>
              <em>Keeps the floating visualizer above other applications.</em>
            </span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.hideMainWhenPopped}
              onChange={(e) => applyNow({ hideMainWhenPopped: e.target.checked })}
            />
            <span>
              <strong>Hide the main window while popped out</strong>
              <em>
                Popping out moves the app into the monitor window instead of leaving two on
                screen. Recording keeps running; the tray icon and the hotkey still work, and
                closing the pop-out brings the main window back.
              </em>
            </span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.hideBoardWhenPopped}
              onChange={(e) => applyNow({ hideBoardWhenPopped: e.target.checked })}
              disabled={draft.hideMainWhenPopped}
            />
            <span>
              <strong>Hide only the main visualizer while popped out</strong>
              <em>
                Leaves the main window as controls only, so it can shrink much further. Has no
                effect while the whole window is hidden.
              </em>
            </span>
          </label>
          <div className="slider-row">
            <input
              type="range"
              min={20}
              max={100}
              step={5}
              value={Math.round(draft.popoutOpacity * 100)}
              onChange={(e) => applyNow({ popoutOpacity: Number(e.target.value) / 100 })}
            />
            <span>{Math.round(draft.popoutOpacity * 100)}% opacity</span>
          </div>
        </section>

        <section>
          <label htmlFor="fileNameTemplate">File name template</label>
          <input
            id="fileNameTemplate"
            ref={templateRef}
            type="text"
            value={draft.fileNameTemplate}
            onChange={(e) => set('fileNameTemplate', e.target.value)}
            placeholder="faze_{date}_{time}"
          />
          <div className="chip-row template-tokens">
            {FILENAME_TOKENS.map((t) => (
              <button
                key={t.token}
                type="button"
                className="chip"
                onClick={() => insertTemplateToken(t.token)}
                title={`e.g. ${t.example}`}
              >
                {t.token}
              </button>
            ))}
          </div>
          <small>
            Plain text + the tokens above. Illegal filename characters are
            sanitised; the .webm extension is added if missing.
          </small>
        </section>

        <footer>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" onClick={save}>Save</button>
        </footer>
      </div>
    </div>
  );
}
