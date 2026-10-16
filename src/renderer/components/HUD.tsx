import { AppSettings } from '../../shared/types';
import { mmss } from '../../shared/utils';
import { Transport } from './Transport';

interface Props {
  settings: AppSettings;
  capturing: boolean;
  rms: number;
  bufferedSeconds: number;
  canSaveNow: boolean;
  onToggleCapture: () => void;
  onManualSave: () => void;
  onOpenSettings: () => void;
  error: string | null;
  /** Loopback device is bound but silent — see CaptureState.noSignal. */
  noSignal?: boolean;
  /** Hide the gear — the custom title bar already carries one. */
  hideSettingsButton?: boolean;
}

export function HUD({
  settings,
  capturing,
  rms,
  bufferedSeconds,
  canSaveNow,
  onToggleCapture,
  onManualSave,
  onOpenSettings,
  error,
  noSignal,
  hideSettingsButton,
}: Props) {
  const bufferPct = settings.recordMode === 'rolling'
    ? Math.min(100, (bufferedSeconds / settings.bufferSeconds) * 100)
    : 0;

  const compact = settings.uiLayout !== 'full';
  const showBuffer = settings.showBuffer && settings.recordMode === 'rolling';

  return (
    <header className={`hud ${compact ? 'is-compact' : ''}`}>
      <div className="hud-status">
        <span className={`pill ${capturing ? 'on' : 'off'}`}>
          {capturing ? '● LIVE' : '○ idle'}
        </span>
        {!compact && (
          <span className="hud-mode">
            {settings.recordMode === 'rolling' ? 'rolling' : 'press-to-record'}
          </span>
        )}
        {noSignal && !error && (
          <span
            className="hud-quiet"
            title="WASAPI loopback only delivers audio while something is actually playing on the selected output device. Play something and the waveform will appear."
          >
            ⚠ device is silent
          </span>
        )}
        {showBuffer && (
          <span className="hud-buffer">
            <progress max={100} value={bufferPct} />
            <em>{mmss(bufferedSeconds)} / {mmss(settings.bufferSeconds)}</em>
          </span>
        )}
      </div>

      {settings.showVu && (
        <div className="hud-vu" title={`RMS ${(rms * 100).toFixed(0)}%`}>
          <div className="vu-bar" style={{ width: `${Math.min(100, rms * 240)}%` }} />
        </div>
      )}

      <div className="hud-actions">
        {!hideSettingsButton && (
          <button type="button" className="ghost" onClick={onOpenSettings} title="Settings">⚙</button>
        )}
        <Transport
          capturing={capturing}
          canSaveNow={canSaveNow}
          recordMode={settings.recordMode}
          bufferSeconds={settings.bufferSeconds}
          labelMode={settings.labelMode}
          onToggleCapture={onToggleCapture}
          onManualSave={onManualSave}
        />
      </div>

      {error && <div className="hud-error">{error}</div>}

      {settings.showHint && !compact && (
        <div className="hud-hint">
          Hotkey: <kbd>{settings.hotkey}</kbd>
        </div>
      )}
    </header>
  );
}
