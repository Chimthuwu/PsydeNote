import { LabelMode, RecordMode } from '../../shared/types';

interface Props {
  capturing: boolean;
  canSaveNow: boolean;
  recordMode: RecordMode;
  bufferSeconds: number;
  labelMode: LabelMode;
  onToggleCapture: () => void;
  onManualSave: () => void;
  /** Rendered smaller, for the bar strip and the pop-out. */
  tight?: boolean;
}

/**
 * Start/stop + save, shared by the HUD, the `bar` strip and the pop-out
 * window so all three stay in step.
 *
 * Label handling is the reason this is a component rather than two buttons:
 * "Save last 15 min" is the widest thing in the app, and at small sizes it has
 * to become "Save 15m" and then a bare glyph. `labelMode: 'auto'` renders all
 * three and lets the CSS breakpoints choose; 'icon' and 'text' pin it.
 */
export function Transport({
  capturing,
  canSaveNow,
  recordMode,
  bufferSeconds,
  labelMode,
  onToggleCapture,
  onManualSave,
  tight,
}: Props) {
  const minutes = Math.round(bufferSeconds / 60);
  const saveFull = recordMode === 'rolling' ? `Save last ${minutes} min` : 'Save recording';
  const saveShort = recordMode === 'rolling' ? `Save ${minutes}m` : 'Save';

  const cls = `labels-${labelMode}${tight ? ' is-tight' : ''}`;

  return (
    <>
      {recordMode === 'traditional' && (
        <button
          type="button"
          className={`ghost transport-toggle ${cls} ${capturing ? 'is-live' : ''}`}
          onClick={onToggleCapture}
          title={capturing ? 'Stop capturing' : 'Start capturing'}
        >
          <span className="lbl-icon" aria-hidden="true">{capturing ? '■' : '▶'}</span>
          <span className="lbl-full">{capturing ? 'Stop' : 'Start'}</span>
          <span className="lbl-short">{capturing ? 'Stop' : 'Start'}</span>
        </button>
      )}

      <button
        type="button"
        className={`primary big transport-save ${cls}`}
        onClick={onManualSave}
        disabled={!canSaveNow}
        title={saveFull}
      >
        <span className="lbl-icon" aria-hidden="true">⇩</span>
        <span className="lbl-full">{saveFull}</span>
        <span className="lbl-short">{saveShort}</span>
      </button>
    </>
  );
}

export default Transport;
