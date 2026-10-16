// Right-click-empty-space menu (todo.md §73 P7c): theme picker + options.
import type { Theme } from '../../../src/shared/types';

export const THEMES: { id: Theme; label: string; swatch: string }[] = [
  // Aurora ice is the DEFAULT (what a fresh install opens on). Graphite is the
  // neutral option — no hue in its surfaces at all.
  { id: 'aurora-ice', label: 'Aurora ice', swatch: '#6df0ff' },
  { id: 'black-ice', label: 'Black ice', swatch: '#7fe3f5' },
  { id: 'graphite', label: 'Graphite', swatch: '#d8dee6' },
];

/** Map any stored theme id (including removed legacy themes) to a valid one. */
export function normalizeTheme(t: unknown): Theme {
  if (t === 'black-ice' || t === 'graphite') return t;
  return 'aurora-ice'; // the default, including for any removed legacy id
}

interface Props {
  x: number;
  y: number;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onPanic: () => void;
  onClose: () => void;
}

export function AppMenu({ x, y, theme, onTheme, onPanic, onClose }: Props) {
  return (
    <>
      <div className="faze-scope-menu-scrim" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <ul className="faze-menu" style={{ position: 'fixed', left: x, top: y, zIndex: 60 }}>
        <li className="faze-menu-head">Theme</li>
        {THEMES.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className={t.id === theme ? 'is-on' : ''}
              onClick={() => { onTheme(t.id); onClose(); }}
            >
              <span className="swatch" style={{ background: t.swatch }} />
              {t.label}
            </button>
          </li>
        ))}
        <li className="faze-menu-sep" aria-hidden="true" />
        <li>
          <button type="button" onClick={() => { onPanic(); onClose(); }}>
            <span className="faze-menu-glyph">■</span>
            All notes off
          </button>
        </li>
      </ul>
    </>
  );
}
