import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { normalizeSynthSettings, PresetResult, SynthPreset, SynthSettings } from '../shared/types';

/**
 * Preset store (todo.md §50) — a named patch library, SEPARATE from the
 * persisted `AppSettings`. `AppSettings.synth` always opens as the init
 * patch on launch (§49); presets are how the user keeps and recalls a
 * patch. Storage is a single `faze-presets.json` in the same userData
 * folder as `faze-settings.json`, written atomically the same way
 * (`writeSettings` in settings.ts) so a crash mid-save can't corrupt it.
 *
 * The synth block is normalized through `normalizeSynthSettings` on both
 * write and read, so a preset saved by an older build migrates forward the
 * same way an old settings file does, and a hand-edited file can't inject
 * a malformed patch into the engine.
 */

const PRESETS_FILENAME = 'faze-presets.json';

function presetsPath(): string {
  return path.join(app.getPath('userData'), PRESETS_FILENAME);
}

function readPresets(): SynthPreset[] {
  try {
    let raw = fs.readFileSync(presetsPath(), 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is SynthPreset => p && typeof p === 'object' && typeof p.name === 'string')
      .map((p) => ({
        name: p.name,
        createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
        updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now(),
        synth: normalizeSynthSettings(p.synth),
      }));
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.error(`Failed to read presets file at ${presetsPath()}:`, err);
    }
    return [];
  }
}

function writePresets(presets: SynthPreset[]): void {
  const file = presetsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(presets, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Newest-first, so the browser shows the most recently touched preset on top. */
function sorted(presets: SynthPreset[]): SynthPreset[] {
  return [...presets].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listPresets(): SynthPreset[] {
  return sorted(readPresets());
}

export function savePreset(name: string, synth: SynthSettings): PresetResult {
  const trimmed = (name ?? '').trim();
  const presets = readPresets();
  if (!trimmed) {
    return { ok: false, presets: sorted(presets), error: 'Preset name cannot be empty.' };
  }
  const now = Date.now();
  const normalized = normalizeSynthSettings(synth);
  const idx = presets.findIndex((p) => p.name.toLowerCase() === trimmed.toLowerCase());
  const next: SynthPreset[] = [...presets];
  if (idx >= 0) {
    // Same name = overwrite (keeps the original creation time).
    next[idx] = { ...next[idx], updatedAt: now, synth: normalized };
  } else {
    next.push({ name: trimmed, createdAt: now, updatedAt: now, synth: normalized });
  }
  writePresets(next);
  return { ok: true, presets: sorted(next) };
}

export function deletePreset(name: string): PresetResult {
  const next = readPresets().filter((p) => p.name.toLowerCase() !== (name ?? '').toLowerCase());
  writePresets(next);
  return { ok: true, presets: sorted(next) };
}
