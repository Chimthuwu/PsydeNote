import { globalShortcut } from 'electron';

/**
 * Manages a single global hotkey. Re-registering is supported so the user can
 * change the combo from the settings panel without restarting the app.
 */
export class HotkeyManager {
  private current: string | null = null;
  private listener: (() => void) | null = null;

  /** Returns the currently registered combo, or null if none. */
  accel(): string | null {
    return this.current;
  }

  register(accel: string, onPress: () => void): { ok: true } | { ok: false; reason: string } {
    this.unregister();
    if (!accel) return { ok: false, reason: 'Empty accelerator' };
    try {
      const ok = globalShortcut.register(accel, onPress);
      if (!ok) return { ok: false, reason: 'Accelerator already in use by another app' };
      this.current = accel;
      this.listener = onPress;
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  unregister() {
    if (this.current) {
      try {
        globalShortcut.unregister(this.current);
      } catch {
        /* noop */
      }
      this.current = null;
      this.listener = null;
    }
  }
}
