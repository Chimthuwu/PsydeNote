import { useEffect, useRef, useState } from 'react';
import { AppSettings, CaptureBackend, CaptureSource, LoopbackDevice } from '../../shared/types';

interface Props {
  backend: CaptureBackend;
  sources: CaptureSource[];
  loopbackDevices: LoopbackDevice[];
  selectedId: string | null;
  onChange: (id: string | null) => void;
  onRefresh: () => Promise<unknown>;
  /** Whether loopback is supported on this platform. */
  loopbackSupported: boolean;
  /**
   * Drop the label column and the helper line, leaving just the trigger.
   * Used by the compact layouts, where the two of them cost more vertical
   * room than the control itself.
   */
  compact?: boolean;
  /** Notified when the listbox opens/closes (the bar layout grows the window). */
  onOpenChange?: (open: boolean) => void;
}

type Item =
  | { id: null; label: string; disabled?: boolean }
  | { id: string; label: string };

export function SourcePicker({
  backend,
  sources,
  loopbackDevices,
  selectedId,
  onChange,
  onRefresh,
  loopbackSupported,
  compact,
  onOpenChange,
}: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Build the items list for whichever backend is active.
  const baseItems =
    backend === 'loopback'
      ? loopbackDevices.map((d) => ({
          id: d.id as string | null,
          label: `${d.isDefault ? '★ ' : ''}${d.name}`,
        }))
      : sources.map((s) => ({
          id: s.id as string | null,
          label: `${s.kind === 'screen' ? '▢ ' : '◫ '}${s.name}`,
        }));

  // Insert the placeholder at the top.
  const fullItems: { id: string | null; label: string; disabled?: boolean }[] = [
    { id: null, label: '— select —', disabled: true },
    ...baseItems,
  ];
  const selectedLabel =
    fullItems.find((it) => it.id === selectedId)?.label ?? '— select —';

  // Click-away + Escape to close.
  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Re-fetch devices/sources when the dropdown opens so closing+reopening
  // shows an up-to-date enumeration.
  useEffect(() => {
    if (open) onRefresh().catch(() => {});
    onOpenChange?.(open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  const headerHint =
    backend === 'loopback'
      ? loopbackSupported
        ? 'WASAPI loopback — pick the output device whose audio you want to record.'
        : 'Loopback backend not supported on this platform.'
      : 'desktopCapturer — pick a screen / window whose audio to capture.';

  const disabled = backend === 'loopback' && !loopbackSupported;

  const labelText = backend === 'loopback' ? 'Output device' : 'Source';

  return (
    <div
      className={`picker-row picker-row-stack${compact ? ' is-compact' : ''}`}
      ref={wrapRef}
    >
      {!compact && <label htmlFor="source-trigger">{labelText}</label>}

      <div className="picker-select-wrap">
        <button
          id="source-trigger"
          type="button"
          className={`dd-trigger${disabled ? ' is-disabled' : ''}`}
          onClick={() => !disabled && setOpen((o) => !o)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-label={labelText}
          aria-expanded={open}
        >
          {compact && (
            <span className="dd-icon" aria-hidden="true">
              {backend === 'loopback' ? '🔊' : '🖵'}
            </span>
          )}
          <span className="dd-label">{selectedLabel}</span>
          <span className="dd-chevron" aria-hidden="true">
            ▾
          </span>
        </button>
        <button type="button" className="ghost" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? '…' : '↻'}
        </button>

        {open && !disabled && (
          <div className="dd-popover" role="listbox" aria-label={backend === 'loopback' ? 'Output devices' : 'Sources'}>
            {fullItems.length <= 1 ? (
              <div className="dd-empty">No {backend === 'loopback' ? 'output devices' : 'screens/windows'} found.</div>
            ) : (
              <ul className="dd-list">
                {fullItems.map((it) => {
                  const isSelected = it.id === selectedId;
                  return (
                    <li
                      key={it.id ?? 'placeholder'}
                      role="option"
                      aria-selected={isSelected}
                      className={
                        'dd-item' +
                        (isSelected ? ' is-selected' : '') +
                        (it.disabled ? ' is-placeholder' : '')
                      }
                      onClick={() => {
                        if (it.disabled) return;
                        onChange(it.id);
                        setOpen(false);
                      }}
                    >
                      <span className="dd-item-label">{it.label}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {!compact && <small>{headerHint}</small>}
    </div>
  );
}

export default SourcePicker;
