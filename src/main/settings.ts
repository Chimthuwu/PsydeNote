import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { AppSettings, DEFAULT_SETTINGS, normalizeSynthSettings } from '../shared/types';

const SETTINGS_FILENAME = 'faze-settings.json';

/**
 * Merge a parsed settings file over the defaults.
 *
 * The top level is a shallow spread, but `synth` goes through
 * `normalizeSynthSettings` on top of a shallow merge: the synth object grows
 * a field almost every phase (sample settings in 1.5, envelopes + mod in 2,
 * the 4-oscillator + sampler operator engine in 3), and a shallow spread
 * alone would silently drop new fields for anyone with an older settings
 * file on disk — or worse, hand the renderer an `oscillators`-less object
 * that crashes on `settings.synth.oscillators[0]`. `normalizeSynthSettings`
 * also migrates the Phase-1.5-era flat `wave`/`oscillatorLevel` shape into
 * the multi-operator one.
 */
function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...base,
    ...patch,
    synth: normalizeSynthSettings({
      ...base.synth,
      ...(patch.synth ?? {}),
    }),
  };
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILENAME);
}

/**
 * A fresh default synth patch. `normalizeSynthSettings({})` builds every
 * nested object/array from scratch (envelopes, LFOs, the 4 oscillator
 * slots), so this never shares references with `DEFAULT_SETTINGS.synth`.
 */
function initPatch(): AppSettings['synth'] {
  return normalizeSynthSettings({});
}

/**
 * Session settings — the source of truth for the write path.
 *
 * §49 made the synth open in the init patch EVERY launch ("currently it
 * saves my last tweaks"), and the original implementation applied that by
 * forcing `synth: initPatch()` inside `readSettings()`. That broke the
 * settings write path: `settingsSet` merges every patch over
 * `readSettings()`, so a non-synth write (changing the visualizer mode, the
 * theme, …) spread the init-patched synth into the file and reset the
 * user's live patch — "changing the main visualizer resets all settings".
 *
 * The fix: force the init patch exactly once, on the FIRST read of the
 * process (i.e. at launch), and cache that result. Every later read and
 * every write goes through the cache, so a partial write preserves whatever
 * synth the session has. Restarting the app still gives a fresh init patch.
 */
let sessionSettings: AppSettings | null = null;

export function readSettings(): AppSettings {
  if (sessionSettings) return sessionSettings;
  try {
    let raw = fs.readFileSync(settingsPath(), 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) {
      raw = raw.slice(1);
    }
    const parsed = JSON.parse(raw);
    const merged = mergeSettings(DEFAULT_SETTINGS, parsed);
    // §49: the synth block is NOT restored from disk — the app opens as the
    // init patch every time. Everything else (theme, visualizer, capture
    // source…) persists as normal. The preset system (§50) is the way to
    // save/restore a patch.
    // Removed legacy themes fall back to Black ice.
    const theme = (merged.theme === 'black-ice' || merged.theme === 'graphite')
      ? merged.theme
      : 'aurora-ice';
    sessionSettings = { ...merged, theme, synth: initPatch() };
    return sessionSettings;
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.error(`Failed to read/parse settings file at ${settingsPath()}:`, err);
    }
    sessionSettings = { ...DEFAULT_SETTINGS, synth: initPatch() };
    return sessionSettings;
  }
}

export function writeSettings(next: AppSettings): AppSettings {
  const merged = mergeSettings(DEFAULT_SETTINGS, next);
  sessionSettings = merged;
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return merged;
}
