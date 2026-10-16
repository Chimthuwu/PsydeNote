import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, SynthPreset, SynthSettings } from '../../shared/types';
import { normalizeSynthSettings } from '../../shared/types';

interface Props {
  synth: SynthSettings;
  onChange: (patch: Partial<AppSettings>) => Promise<AppSettings> | void;
}

type BrowserItem = { name: string; synth: SynthSettings; init?: boolean };

/**
 * Vital-style preset control: a compact current-patch selector with previous /
 * next arrows. Clicking the selector opens the browser; right-clicking it is a
 * deliberate shortcut to the same browser, matching the annotated mockup.
 */
export function PresetBar({ synth, onChange }: Props) {
  const [presets, setPresets] = useState<SynthPreset[] | null>(null);
  const [open, setOpen] = useState<'browser' | 'save' | null>(null);
  const [name, setName] = useState('');
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight?: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const selectorRef = useRef<HTMLButtonElement | null>(null);
  const saveRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const initSynth = useMemo(() => normalizeSynthSettings({}), []);
  const factoryPresets = useMemo<BrowserItem[]>(() => [
    { name: 'Init Preset', synth: initSynth, init: true },
    {
      name: 'Sub Bass',
      init: true,
      synth: normalizeSynthSettings({
        oscillators: [{ enabled: true, level: 0.9, wave: 'sine', pitch: -12 }],
        filterA: { type: 'lowpass', cutoffHz: 350, resonance: 0.8 },
      }),
    },
    {
      name: 'Super Saw',
      init: true,
      synth: normalizeSynthSettings({
        oscillators: [
          { enabled: true, level: 0.8, wave: 'sawtooth', pitch: 0, pan: -0.4 },
          { enabled: true, level: 0.8, wave: 'sawtooth', pitch: 0.08, pan: 0.4 },
          { enabled: true, level: 0.6, wave: 'sawtooth', pitch: -12, pan: 0 },
        ],
        filterA: { type: 'lowpass', cutoffHz: 4500, resonance: 0.7 },
      }),
    },
    {
      name: 'Pluck Lead',
      init: true,
      synth: normalizeSynthSettings({
        ampEnv: { attackSec: 0.002, decaySec: 0.25, sustainLevel: 0.0, releaseSec: 0.2 },
        oscillators: [{ enabled: true, level: 0.85, wave: 'square', pitch: 0 }],
        filterA: { type: 'lowpass', cutoffHz: 3200, resonance: 1.2 },
      }),
    },
  ], [initSynth]);

  const items = useMemo<BrowserItem[]>(() => [
    ...factoryPresets,
    ...(presets ?? []).map((p) => ({ name: p.name, synth: p.synth })),
  ], [factoryPresets, presets]);

  const patchKey = (value: SynthSettings) => JSON.stringify(normalizeSynthSettings(value));
  const currentIndex = useMemo(() => {
    const key = patchKey(synth);
    return items.findIndex((item) => patchKey(item.synth) === key);
  }, [items, synth]);
  const currentName = currentIndex >= 0 ? items[currentIndex].name : 'Edited Patch';
  const currentSaved = currentIndex > 0 ? presets?.find((p) => p.name === currentName) : undefined;

  const refresh = useCallback(async () => {
    const api = (window as unknown as { api?: { listPresets: () => Promise<SynthPreset[]> } }).api;
    if (api && typeof api.listPresets === 'function') {
      try { setPresets(await api.listPresets()); } catch { setPresets([]); }
    } else {
      try {
        const raw = localStorage.getItem('faze.presets');
        setPresets(raw ? (JSON.parse(raw) as SynthPreset[]) : []);
      } catch {
        setPresets([]);
      }
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const toast = (kind: 'saved' | 'error', message: string) => {
    window.dispatchEvent(new CustomEvent('faze:local-toast', { detail: { kind, message } }));
  };

  // Undo/redo for whole-patch swaps (New/Init, preset load, prev/next): the
  // patch being replaced is stacked so a mis-click on New doesn't lose work.
  // Individual knob edits are not tracked here.
  // Each entry: the state to return to + a short label of the change that LEFT it (shown in the history menu).
  type Hist = { s: SynthSettings; label: string };
  const undoRef = useRef<Hist[]>([]);
  const redoRef = useRef<Hist[]>([]);
  const [histOpen, setHistOpen] = useState(false);
  const diffLabel = (a: SynthSettings, b: SynthSettings): string => {
    const A = a as unknown as Record<string, unknown>;
    const B = b as unknown as Record<string, unknown>;
    const keys = Object.keys(B).filter((k) => JSON.stringify(A[k]) !== JSON.stringify(B[k]));
    if (keys.length === 0) return 'Edit';
    const nice = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
    return keys.length <= 2 ? keys.map(nice).join(' + ') : `${nice(keys[0])} + ${keys.length - 1} more`;
  };
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 });
  const syncDepth = () => setHistoryDepth({ undo: undoRef.current.length, redo: redoRef.current.length });

  // Every OTHER change to `synth` (knob drags, toggles, modulation routes…) is recorded too, coalesced
  // into one undo step per burst of edits (500 ms idle), so Undo steps back through your edits, not just
  // patch swaps.
  const lastSynthRef = useRef<SynthSettings>(synth);   // the settled state before the current burst
  const curSynthRef = useRef<SynthSettings>(synth);
  const skipRef = useRef<SynthSettings | null>(null);  // a state WE just applied (undo/redo/swap) — not a user edit
  const burstRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushBurst = () => {
    if (burstRef.current == null) return;
    clearTimeout(burstRef.current);
    burstRef.current = null;
    if (lastSynthRef.current !== curSynthRef.current && JSON.stringify(lastSynthRef.current) !== JSON.stringify(curSynthRef.current)) {
      undoRef.current = [...undoRef.current.slice(-49), { s: lastSynthRef.current, label: diffLabel(lastSynthRef.current, curSynthRef.current) }];
      redoRef.current = [];
      syncDepth();
    }
    lastSynthRef.current = curSynthRef.current;
  };
  useEffect(() => {
    curSynthRef.current = synth;
    if (skipRef.current && JSON.stringify(skipRef.current) === JSON.stringify(synth)) {
      skipRef.current = null;
      lastSynthRef.current = synth;
      return;
    }
    if (burstRef.current != null) clearTimeout(burstRef.current);
    burstRef.current = setTimeout(flushBurst, 500);
  }, [synth]);
  const undoFnRef = useRef<() => void>(() => {});
  const redoFnRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest('textarea, [contenteditable="true"], input:not([type="range"]):not([type="checkbox"])')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoFnRef.current(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redoFnRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => () => { if (burstRef.current != null) clearTimeout(burstRef.current); }, []);

  const apply = (next: SynthSettings, label: string) => {
    flushBurst();
    undoRef.current = [...undoRef.current.slice(-49), { s: synth, label }];
    redoRef.current = [];
    syncDepth();
    skipRef.current = next;
    void onChange({ synth: next });
    toast('saved', label);
    setOpen(null);
  };

  const undo = () => {
    flushBurst();
    const h = undoRef.current.pop();
    if (!h) return;
    redoRef.current.push({ s: synth, label: h.label });
    syncDepth();
    skipRef.current = h.s;
    void onChange({ synth: h.s });
    toast('saved', 'Undo');
    setOpen(null);
  };

  const redo = () => {
    flushBurst();
    const h = redoRef.current.pop();
    if (!h) return;
    undoRef.current.push({ s: synth, label: h.label });
    syncDepth();
    skipRef.current = h.s;
    void onChange({ synth: h.s });
    toast('saved', 'Redo');
    setOpen(null);
  };

  /** Jump to any point in the history: n>0 undoes n steps, n<0 redoes -n steps. */
  const jump = (n: number) => {
    flushBurst();
    let cur = synth;
    for (let i = 0; i < Math.abs(n); i++) {
      if (n > 0) {
        const h = undoRef.current.pop(); if (!h) break;
        redoRef.current.push({ s: cur, label: h.label }); cur = h.s;
      } else {
        const h = redoRef.current.pop(); if (!h) break;
        undoRef.current.push({ s: cur, label: h.label }); cur = h.s;
      }
    }
    syncDepth();
    skipRef.current = cur;
    void onChange({ synth: cur });
    setHistOpen(false);
  };
  useEffect(() => {
    if (!histOpen) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.preset-hist')) setHistOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setHistOpen(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc); };
  }, [histOpen]);

  undoFnRef.current = undo;
  redoFnRef.current = redo;

  useEffect(() => {
    if (!open) { setPos(null); return; }
    const anchor = open === 'browser' ? selectorRef.current : saveRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = open === 'browser' ? 290 : 250;
    const maxHeight = open === 'browser' ? Math.min(340, window.innerHeight - 24) : 150;
    let left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.bottom + 6;
    if (top + maxHeight > window.innerHeight - 8) top = Math.max(8, rect.top - maxHeight - 6);
    setPos({ left, top, width, maxHeight });
  }, [open, items.length]);

  useEffect(() => {
    if (open === 'save') inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(null); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const openBrowser = () => {
    if (!presets) void refresh();
    setOpen(open === 'browser' ? null : 'browser');
  };

  const move = (direction: -1 | 1) => {
    const nextIndex = currentIndex < 0 ? (direction > 0 ? 0 : items.length - 1) : currentIndex + direction;
    if (nextIndex >= 0 && nextIndex < items.length) apply(items[nextIndex].synth, `Preset “${items[nextIndex].name}” loaded`);
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const api = (window as unknown as { api?: { savePreset: (n: string, s: SynthSettings) => Promise<{ ok: boolean; presets: SynthPreset[]; error?: string }> } }).api;
    if (api && typeof api.savePreset === 'function') {
      const result = await api.savePreset(trimmed, synth);
      setPresets(result.presets);
      if (result.ok) {
        toast('saved', `Preset “${trimmed}” saved`);
        setName('');
        setOpen(null);
      } else toast('error', result.error ?? 'Could not save preset');
    } else {
      const now = Date.now();
      const normalized = normalizeSynthSettings(synth);
      const cur = presets ?? [];
      const idx = cur.findIndex((p) => p.name.toLowerCase() === trimmed.toLowerCase());
      let next: SynthPreset[];
      if (idx >= 0) {
        next = [...cur];
        next[idx] = { ...next[idx], updatedAt: now, synth: normalized };
      } else {
        next = [{ name: trimmed, createdAt: now, updatedAt: now, synth: normalized }, ...cur];
      }
      try { localStorage.setItem('faze.presets', JSON.stringify(next)); } catch { /* noop */ }
      setPresets(next);
      toast('saved', `Preset “${trimmed}” saved`);
      setName('');
      setOpen(null);
    }
  };

  const handleDelete = async (presetName: string) => {
    const api = (window as unknown as { api?: { deletePreset: (n: string) => Promise<{ ok: boolean; presets: SynthPreset[]; error?: string }> } }).api;
    if (api && typeof api.deletePreset === 'function') {
      const result = await api.deletePreset(presetName);
      setPresets(result.presets);
      toast('saved', `Preset “${presetName}” deleted`);
    } else {
      const next = (presets ?? []).filter((p) => p.name.toLowerCase() !== presetName.toLowerCase());
      try { localStorage.setItem('faze.presets', JSON.stringify(next)); } catch { /* noop */ }
      setPresets(next);
      toast('saved', `Preset “${presetName}” deleted`);
    }
  };

  const nameExists = !!presets?.some((p) => p.name.toLowerCase() === name.trim().toLowerCase());

  return (
    <div className="preset-bar" ref={wrapRef} role="group" aria-label="Presets">
      <div className="preset-hist">
      <button
        type="button"
        className="preset-nav-arrow"
        disabled={historyDepth.undo === 0}
        onClick={undo}
        title="Undo last change (Ctrl+Z)"
        aria-label="Undo patch change"
      >↶</button>
      <button
        type="button"
        className="preset-nav-arrow"
        disabled={historyDepth.redo === 0}
        onClick={redo}
        title="Redo patch swap"
        aria-label="Redo patch change"
      >↷</button>
        <button type="button" className={`preset-hist-toggle ${histOpen ? 'is-on' : ''}`}
          disabled={historyDepth.undo + historyDepth.redo === 0}
          onClick={() => { flushBurst(); syncDepth(); setHistOpen((v) => !v); }}
          title="Undo history" aria-label="Undo history" aria-expanded={histOpen}>▾</button>
        {histOpen && (
          <div className="preset-hist-menu" role="listbox" aria-label="Undo history">
            {[...redoRef.current].map((h, i) => ({ h, n: -(redoRef.current.length - i) })).map(({ h, n }) => (
              <button key={`r${n}`} type="button" className="preset-hist-item is-redo" onClick={() => jump(n)}>↷ {h.label}</button>
            ))}
            <div className="preset-hist-cur">● Current state</div>
            {[...undoRef.current].reverse().map((h, i) => (
              <button key={`u${i}`} type="button" className="preset-hist-item" onClick={() => jump(i + 1)}>↶ {h.label}</button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className="preset-new-btn"
        onClick={() => apply(initSynth, 'New patch (Init)')}
        title="New patch — reset to Init"
        aria-label="New patch"
      >
        {/* blank document with a folded corner = "new" (the far-right + is Save/Add preset) */}
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M9.5 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        type="button"
        className="preset-nav-arrow"
        disabled={currentIndex <= 0}
        onClick={() => move(-1)}
        title="Previous preset"
        aria-label="Previous preset"
      >‹</button>
      <button
        ref={selectorRef}
        type="button"
        className={`preset-selector ${open === 'browser' ? 'is-on' : ''}`}
        onClick={openBrowser}
        onContextMenu={(event) => { event.preventDefault(); openBrowser(); }}
        aria-haspopup="listbox"
        aria-expanded={open === 'browser'}
        title="Click to browse presets · right-click to open the preset browser"
      >
        <span className="preset-selector-name">{currentName}</span>
        <span className="preset-selector-chevron" aria-hidden="true">⌄</span>
      </button>
      <button
        type="button"
        className="preset-nav-arrow"
        disabled={currentIndex >= items.length - 1 || items.length < 2}
        onClick={() => move(1)}
        title="Next preset"
        aria-label="Next preset"
      >›</button>
      <button
        ref={saveRef}
        type="button"
        className={`preset-save-icon ${open === 'save' ? 'is-on' : ''}`}
        onClick={() => setOpen(open === 'save' ? null : 'save')}
        title={currentSaved ? `Save changes to “${currentSaved.name}”` : 'Save current patch as a preset'}
        aria-label="Save preset"
      >
        ＋
      </button>

      {open === 'browser' && pos && (
        <div
          className="preset-pop preset-browser"
          style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}
          role="listbox"
          aria-label="Preset browser"
        >
          <div className="preset-browser-head">
            <span>Preset Browser</span>
            <button type="button" onClick={() => setOpen('save')} title="Save current patch">Save</button>
          </div>
          {!presets ? <p className="preset-empty">Loading…</p> : items.map((item, index) => {
            const selected = currentIndex === index;
            return (
              <div key={item.name} className={`preset-item ${selected ? 'is-selected' : ''}`} role="option" aria-selected={selected}>
                <button type="button" className="preset-item-load" onClick={() => apply(item.synth, `Preset “${item.name}” loaded`)}>
                  <span className="preset-item-name">{item.name}</span>
                  <span className="preset-item-summary">{item.init ? 'Factory preset' : presetSummary(item.synth)}</span>
                </button>
                {!item.init && (
                  <button type="button" className="preset-item-del" title={`Delete “${item.name}”`} onClick={() => void handleDelete(item.name)}>×</button>
                )}
              </div>
            );
          })}
          <div className="preset-browser-foot">Right-click the selector to reopen this browser</div>
        </div>
      )}

      {open === 'save' && pos && (
        <div className="preset-pop preset-save-pop" style={{ left: pos.left, top: pos.top, width: pos.width }} role="dialog" aria-label="Save preset">
          <input
            ref={inputRef}
            className="preset-name-input"
            placeholder="Preset name…"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void handleSave(); }}
          />
          <div className="preset-pop-actions">
            <button type="button" className={`preset-pop-btn primary ${nameExists ? 'overwrite' : ''}`} disabled={!name.trim()} onClick={() => void handleSave()}>
              {nameExists ? 'Overwrite' : 'Save'}
            </button>
            <button type="button" className="preset-pop-btn" onClick={() => setOpen(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function presetSummary(synth: SynthSettings): string {
  const waves = synth.oscillators.filter((osc) => osc.level > 0).map((osc) => osc.wave === 'sample' ? 'sample' : osc.wave).join(' + ');
  const routes = Object.values(synth.mod).reduce((count, routeList) => count + (routeList?.length ?? 0), 0);
  return `${waves || 'silent'} · ${routes} route${routes === 1 ? '' : 's'}`;
}
