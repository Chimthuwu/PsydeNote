import { useEffect, useState, useCallback } from 'react';
import { RecorderEvent } from '../../shared/types';
import { humanBytes as _hb } from '../../shared/utils';

/** Human bytes helper shared across renderer for status messages. */
export function humanBytes(n: number): string {
  return _hb(n);
}

export interface RecorderEventState {
  lastToasts: { id: number; kind: 'saved' | 'error'; message: string }[];
}

/**
 * Subscribes to recorder events from main (e.g. "hotkey-pressed") and tracks
 * the last few toast notifications the UI should display.
 */
export function useRecorderEvents(opts: {
  onHotkey: () => void | Promise<void>;
}) {
  const [toasts, setToasts] = useState<RecorderEventState['lastToasts']>([]);

  useEffect(() => {
    const unsub = window.api.onRecorderEvent(async (ev: RecorderEvent) => {
      if (ev.type === 'hotkey-pressed') {
        await opts.onHotkey();
        return;
      }
      if (ev.type === 'saved') {
        pushToast(setToasts, {
          kind: 'saved',
          message: `Saved ${humanBytes(ev.bytes)} (${ev.durationSec.toFixed(1)}s)`,
        });
        return;
      }
      if (ev.type === 'error') {
        pushToast(setToasts, { kind: 'error', message: ev.message });
      }
    });
    return unsub;
  }, [opts]);

  return { toasts };
}

function pushToast(
  setter: React.Dispatch<React.SetStateAction<RecorderEventState['lastToasts']>>,
  toast: { id?: number; kind: 'saved' | 'error'; message: string },
) {
  const id = Date.now() + Math.random();
  setter((t) => [...t, { id, ...toast }].slice(-3));
  setTimeout(() => {
    setter((t) => t.filter((x) => x.id !== id));
  }, 4000);
}

export const useSaveAction = () => {
  return useCallback(async (folder: string, blob: Blob, durationSec: number) => {
    const buf = new Uint8Array(await blob.arrayBuffer());
    return window.api.saveRecording({ folder, bytes: buf, durationSec });
  }, []);
};
