import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AudioFollowerSettings, ModSourceId } from '../../shared/types';
import { MOD_SOURCES } from '../lib/mod-sources';

/**
 * Plugin-only modulator cards for the "+" system (todo.md P2): the Audio
 * Follower card and the add-modulator tile. ENV 4/5 and LFO 4/5 reuse the
 * existing EnvelopeEditor / LfoEditor in EnvelopePanel.tsx.
 */

const F_MIN = 20;
const F_MAX = 20000;
const freqToPos = (f: number) => Math.log(Math.max(F_MIN, Math.min(F_MAX, f)) / F_MIN) / Math.log(F_MAX / F_MIN);
const posToFreq = (p: number) => F_MIN * Math.pow(F_MAX / F_MIN, Math.max(0, Math.min(1, p)));
const fmtHz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${Math.round(f)}`);

const BARS = 48;

/** Vertical-drag number field (double-click resets). Compact enough for a card header. */
function DragField({
  label, value, min, max, log, def, format, onChange, title,
}: {
  label: string; value: number; min: number; max: number; log?: boolean; def: number;
  format: (v: number) => string; onChange: (v: number) => void; title: string;
}) {
  const drag = useRef<{ y: number; pos: number } | null>(null);
  const toPos = (v: number) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromPos = (p: number) => {
    const c = Math.max(0, Math.min(1, p));
    return log ? min * Math.pow(max / min, c) : min + c * (max - min);
  };
  return (
    <span
      className="af-field"
      title={`${title} — drag ↕, double-click to reset`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, pos: toPos(value) };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) onChange(fromPos(d.pos + (d.y - e.clientY) / 140));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
      }}
      onDoubleClick={() => onChange(def)}
    >
      <em>{label}</em>{format(value)}
    </span>
  );
}

export function AudioFollowerCard({
  af, armed, onChange, onRemove, onSourceDragStart, onSourceContext, getLevel,
  source = 'audiofollower', title = 'Audio Follower',
}: {
  /** Which mod source this instance feeds (audiofollower, audiofollower2, ...). */
  source?: ModSourceId;
  title?: string;
  af: AudioFollowerSettings;
  armed: boolean;
  onChange: (a: AudioFollowerSettings) => void;
  onRemove: () => void;
  onSourceDragStart: (source: ModSourceId, point: { x: number; y: number }) => void;
  onSourceContext: (source: ModSourceId, anchor: HTMLElement) => void;
  /** Live follower output 0..1 (the plugin's `af` scope tap); omitted = no meter. */
  getLevel?: () => number;
}) {
  const color = MOD_SOURCES[source].color;
  const levelRef = useRef(getLevel); levelRef.current = getLevel;
  const barsRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<'lo' | 'hi' | null>(null);
  const afRef = useRef(af); afRef.current = af;

  // Meter: in-band bars rise with the live follower level.
  useEffect(() => {
    let raf = 0;
    let smooth = 0;
    const tick = () => {
      const level = levelRef.current ? levelRef.current() : 0;
      smooth += (level - smooth) * 0.3;
      const el = barsRef.current;
      if (el) {
        const a = afRef.current;
        const lo = freqToPos(a.loHz), hi = freqToPos(a.hiHz);
        const kids = el.children;
        for (let i = 0; i < kids.length; i += 1) {
          const p = (i + 0.5) / BARS;
          const inBand = p >= lo && p <= hi;
          // Shaped like a spectrum hump so it reads as a spectrum, scaled by the real level.
          const shape = 0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, p * 1.15)) ** 1.5;
          const h = inBand ? 0.1 + 0.9 * smooth * shape : 0.08 + 0.05 * shape;
          (kids[i] as HTMLElement).style.height = `${Math.round(h * 100)}%`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const posFromEvent = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return (e.clientX - r.left) / Math.max(1, r.width);
  };
  const lo = freqToPos(af.loHz), hi = freqToPos(af.hiHz);

  return (
    <div className="env-block mod-card af-card" style={{ '--src': color } as React.CSSProperties}>
      <div className="env-head">
        <span className="env-title">
          <span
            className={`env-source-dot${armed ? ' is-armed' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={`${title} — drag to a knob, or click it then click a knob`}
            title="Drag onto a knob to route it, or click then click a knob · right-click to see its routes"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onSourceDragStart(source, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
            }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onSourceContext(source, e.currentTarget as HTMLElement); }}
          />
          {title}
        </span>
        <span className="af-head-fields">
          <button type="button" className={`af-src ${af.source === 1 ? 'is-out' : ''}`}
            title={af.source === 1 ? 'Listening to the synth\'s own OUTPUT — click for the host SIDECHAIN input' : 'Listening to the host SIDECHAIN input — click to follow the synth\'s own OUTPUT instead'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onChange({ ...af, source: af.source === 1 ? 0 : 1 })}>
            {af.source === 1 ? 'OUT' : 'IN'}
          </button>
          <button type="button" className="mod-remove" title="Remove Audio Follower (also removes its routes)" onClick={onRemove}>×</button>
        </span>
      </div>
      <div
        className="af-graph"
        title={`Band ${fmtHz(af.loHz)}–${fmtHz(af.hiHz)} Hz · drag the dashed markers · follows the plugin's sidechain input`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const p = posFromEvent(e);
          // Grab the nearer marker.
          dragRef.current = Math.abs(p - lo) <= Math.abs(p - hi) ? 'lo' : 'hi';
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const f = posToFreq(p);
          onChange(dragRef.current === 'lo' ? { ...af, loHz: Math.min(f, af.hiHz) } : { ...af, hiHz: Math.max(f, af.loHz) });
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return;
          const f = posToFreq(posFromEvent(e));
          const a = afRef.current;
          onChange(dragRef.current === 'lo' ? { ...a, loHz: Math.min(f, a.hiHz) } : { ...a, hiHz: Math.max(f, a.loHz) });
        }}
        onPointerUp={(e) => {
          dragRef.current = null;
          try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
        }}
      >
        <div className="af-bars" ref={barsRef}>
          {Array.from({ length: BARS }, (_, i) => <span key={i} style={{ height: '10%' }} />)}
        </div>
        <div className="af-band" style={{ left: `${lo * 100}%`, width: `${Math.max(0, hi - lo) * 100}%` }} />
        <div className="af-marker" style={{ left: `${lo * 100}%` }} />
        <div className="af-marker" style={{ left: `${hi * 100}%` }} />
        <span className="af-band-label">{fmtHz(af.loHz)}–{fmtHz(af.hiHz)}</span>
        <span className="af-fields" onPointerDown={(e) => e.stopPropagation()}>
            <DragField label="A" value={af.attackMs} min={0.1} max={500} log def={5}
            format={(v) => (v < 10 ? v.toFixed(1) : `${Math.round(v)}`)} title="Attack (ms)"
            onChange={(attackMs) => onChange({ ...af, attackMs })} />
            <DragField label="R" value={af.releaseMs} min={1} max={3000} log def={120}
            format={(v) => `${Math.round(v)}`} title="Release (ms)"
            onChange={(releaseMs) => onChange({ ...af, releaseMs })} />
            <DragField label="G" value={af.gainDb} min={-24} max={48} def={12}
            format={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`} title="Input gain (dB)"
            onChange={(gainDb) => onChange({ ...af, gainDb })} />
        </span>
      </div>
    </div>
  );
}

export interface AddableModule { id: string; label: string; color: string; disabled?: boolean; sub?: string }

/** The dashed "+" tile: click opens a menu of modulator TYPES; picking one adds
 *  another instance (as many as the cap allows). */
export function AddModulatorTile({
  options, onAdd, title = 'Add modulator',
}: {
  title?: string;
  options: AddableModule[];
  onAdd: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // The card area scrolls (overflow clips anything hanging outside it), so the
  // menu is rendered in a PORTAL at <body> level and positioned from the
  // button's rect — never clipped, never scrolled away.
  // The UI scales the whole body with CSS `zoom`, so a fixed-position menu does not
  // land where its rect says. Instead of trusting the guess, the menu is measured
  // after it renders and nudged onto its wanted spot (a few passes at most).
  const fixes = useRef(0);
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    fixes.current = 0;
    setPos({ left: r.left, top: r.top });
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !pos || !menuRef.current || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const m = menuRef.current.getBoundingClientRect();
    // Prefer opening upward (room above the strip), otherwise below. Clamp to the window.
    const wantLeft = Math.max(8, Math.min(r.left + r.width / 2 - m.width / 2, window.innerWidth - m.width - 8));
    let wantTop = r.top - m.height - 6;
    if (wantTop < 8) wantTop = Math.min(r.bottom + 6, window.innerHeight - m.height - 8);
    if (Math.abs(m.left - wantLeft) < 1 && Math.abs(m.top - wantTop) < 1) return;
    if (fixes.current++ >= 4) return;
    const z = parseFloat(getComputedStyle(document.body).zoom) || 1;
    setPos({ left: pos.left + (wantLeft - m.left) / z, top: pos.top + (wantTop - m.top) / z });
  });

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // A fixed menu does not follow the card when it scrolls or the window resizes, so close it instead.
    const moved = () => setOpen(false);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
    };
  }, [open]);

  return (
    <div className="mod-add-tile">
      <button ref={btnRef} type="button" className="mod-add-btn" aria-label="Add modulator" title="Add a modulator" onClick={() => setOpen((o) => !o)}>+</button>
      {open && pos && createPortal(
        <div ref={menuRef} className="mod-add-menu" role="menu" style={{ position: 'fixed', left: pos.left, top: pos.top, right: 'auto', bottom: 'auto' }}>
          <div className="mod-add-menu-title">{title}</div>
          {options.map((o) => (
            <button key={o.id} type="button" role="menuitem" className="mod-add-item" disabled={o.disabled}
              onClick={() => { onAdd(o.id); }}>
              <span className="mod-add-dot" style={{ background: o.color }} />{o.label}
              {o.sub && <span className="mod-add-count">{o.sub}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
