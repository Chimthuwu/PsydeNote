import { useEffect, useState } from 'react';
import { AppSettings, DEFAULT_SETTINGS } from '../../shared/types';

/** Loads and reflects the persisted AppSettings; updates flow back via api.setSettings. */
export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    window.api.getSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
    // Settings can change outside this window — the tray's always-on-top
    // toggle, or the other window when the pop-out is open — so mirror the
    // broadcast main sends after every write.
    return window.api.onSettingsChanged(setSettings);
  }, []);

  async function update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const merged = await window.api.setSettings(patch);
    setSettings(merged);
    return merged;
  }

  return { settings, loaded, update };
}
