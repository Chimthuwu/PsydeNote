import { useEffect, useRef, useState } from 'react';
import type { ArpBlueRow, ArpMode, ArpSettings, ModMap, ModRoute, ModTargetId, RateDiv } from '../../shared/types';
import { modGlowFor } from '../lib/mod-sources';
import { Knob } from './Knob';
import { ModBadge, ModPopover } from './ModPopover';
import { SCALES, NOTE_NAMES } from '../../shared/scales';

interface Props {
  arp: ArpSettings;
  onChange: (patch: Partial<ArpSettings>) => void;
  /** One-row strip sized for the FX-chain slot on the Synth view. */
  compact?: boolean;
  /** Opens the docked detail view ('seq' or 'arpdetail' in the shell). */
  onOpenDetail?: (which: 'seq' | 'arp') => void;
  /** True while a docked detail view is open (lights the ♪ button in the mode colour). */
  detailOpen?: boolean;
  /** Close the open detail view (the ♪ button toggles). */
  onCloseDetail?: () => void;
  /** Modulation map + setter (enables cable-drop / right-click assign on Rate, Swing, Gate). */
  mod?: ModMap;
  onModChange?: (mod: ModMap) => void;
}

export interface ArpPattern {
  value: ArpMode;
  label: string;
  short: string;
  /** Note indexes (0 = lowest of a 4-note chord) in play order; `poly` = all at once. */
  shape: number[];
  chord?: boolean;
}

/** All 18 arp patterns. `shape` drives the little contour icons.
 *  ORDER MUST MATCH `ARP_MODES` in shared/types.ts and `ArpConfig::Mode` in
 *  plugin/ArpEngine.h — the pattern selector maps a 0..1 position onto this
 *  index, so a mismatch silently selects the wrong pattern. */
export const ARP_PATTERNS: ArpPattern[] = [
  { value: 'up', label: 'Up', short: 'Up', shape: [0, 1, 2, 3] },
  { value: 'down', label: 'Down', short: 'Down', shape: [3, 2, 1, 0] },
  { value: 'updown', label: 'Up / Down', short: 'Up/Dn', shape: [0, 1, 2, 3, 3, 2, 1, 0] },
  { value: 'updownExcl', label: 'Up / Down (no repeat)', short: 'Up/Dn-', shape: [0, 1, 2, 3, 2, 1] },
  { value: 'downup', label: 'Down / Up', short: 'Dn/Up', shape: [3, 2, 1, 0, 0, 1, 2, 3] },
  { value: 'random', label: 'Random', short: 'Rand', shape: [2, 0, 3, 1] },
  { value: 'asPlayed', label: 'As Played', short: 'Played', shape: [1, 3, 0, 2] },
  { value: 'convergeUp', label: 'Converge Up', short: 'Conv↑', shape: [0, 3, 1, 2] },
  { value: 'convergeDown', label: 'Converge Down', short: 'Conv↓', shape: [3, 0, 2, 1] },
  { value: 'divergeUp', label: 'Diverge Up', short: 'Div↑', shape: [1, 2, 0, 3] },
  { value: 'divergeDown', label: 'Diverge Down', short: 'Div↓', shape: [2, 1, 3, 0] },
  { value: 'thumbUp', label: 'Thumb Up', short: 'Thumb↑', shape: [0, 1, 0, 2, 0, 3] },
  { value: 'thumbDown', label: 'Thumb Down', short: 'Thumb↓', shape: [3, 2, 3, 1, 3, 0] },
  { value: 'pinkyUp', label: 'Pinky Up', short: 'Pinky↑', shape: [3, 0, 3, 1, 3, 2] },
  { value: 'pinkyDown', label: 'Pinky Down', short: 'Pinky↓', shape: [0, 3, 0, 2, 0, 1] },
  { value: 'skipUp', label: 'Skip Up', short: 'Skip↑', shape: [0, 2, 1, 3] },
  { value: 'repeatUp', label: 'Repeat Up', short: 'Rep↑', shape: [0, 0, 1, 1, 2, 2, 3, 3] },
  { value: 'walk', label: 'Walk', short: 'Walk', shape: [1, 2, 1, 0, 1, 2, 3, 2] },
];

const QUICK_MODES: ArpMode[] = ['up', 'down', 'updown', 'random', 'asPlayed'];
const PATTERN_BY_ID: Record<string, ArpPattern> = Object.fromEntries(ARP_PATTERNS.map((p) => [p.value, p]));

export const RATE_DIVS: RateDiv[] = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32'];
export const FEELS: { value: 'straight' | 'triplet' | 'dotted'; label: string; short: string }[] = [
  { value: 'straight', label: 'Straight', short: '' },
  { value: 'triplet', label: 'Triplet', short: 'T' },
  { value: 'dotted', label: 'Dotted', short: '.' },
];

/** Tiny contour icon of an arp pattern (4-note chord played in order). */
export function PatternIcon({ pattern, active }: { pattern: ArpPattern; active?: boolean }) {
  const n = pattern.shape.length;
  const cw = 7;
  const rh = 5;
  const w = Math.max(n, 4) * cw + 2;
  const h = 4 * rh + 2;
  if (pattern.chord) {
    return (
      <svg className="arp-pat-icon" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        {[0, 1, 2, 3].map((r) => (
          <rect key={r} x={w / 2 - 6} y={h - 2 - (r + 1) * rh + 1} width={12} height={rh - 2} rx={1} fill="currentColor" opacity={active ? 1 : 0.8} />
        ))}
      </svg>
    );
  }
  const pts = pattern.shape.map((r, i) => [1 + i * cw + cw / 2, h - 1 - r * rh - rh / 2] as const);
  return (
    <svg className="arp-pat-icon" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="currentColor" strokeWidth={1} opacity={0.45} />
      {pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={1.9} fill="currentColor" />
      ))}
    </svg>
  );
}

export interface KnobModBind {
  targetId: ModTargetId;
  routes: ModRoute[];
  onModContext: (el: HTMLElement) => void;
}

interface KnobFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  size?: 'sm' | 'md' | 'lg';
  centerDetent?: boolean;
  title?: string;
  bind?: KnobModBind;
  /** Override the theme accent for this one knob. Omit to use `var(--accent)`.
   *  Needed when the colour has to differ per-instance (the arp's rainbow dice
   *  rows) rather than per-theme, which CSS alone cannot express here because
   *  the Knob resolves its colour in JS. */
  color?: string;
}

/** Label + readable value text + mod badge above a knob (same pattern as the Synth header). */
export function ArpKnobField({ label, value, min, max, onChange, format, size = 'md', centerDetent, title, bind, color }: KnobFieldProps) {
  let glow: { color: string; amount: number } | null = null;
  if (bind) {
    try { glow = modGlowFor(bind.targetId, bind.routes); } catch { glow = null; }
  }
  return (
    <div className="knob-field arp-knob-field">
      <label className="arp-knob-label">
        <span className="arp-knob-name">{label}</span>
        <span className="arp-knob-val">{format(value)}</span>
        {bind && <ModBadge targetId={bind.targetId} routes={bind.routes} />}
      </label>
      <Knob
        label={label}
        value={value}
        min={min}
        max={max}
        onChange={onChange}
        format={format}
        // `color` lets a caller override the theme accent per knob — the arp's
        // dice rows use it to carry their own rainbow hue, which cannot come
        // from CSS because the Knob resolves its colour in JS and hands it
        // down as an inline prop.
        color={color ?? 'var(--accent)'}
        size={size}
        centerDetent={centerDetent}
        title={title}
        modTarget={bind?.targetId}
        modGlow={glow}
        onModContext={bind?.onModContext}
      />
    </div>
  );
}

/** Quaver (eighth note) glyph for the detail button. */
function QuaverIcon() {
  return (
    <svg className="arp-quaver" width="16" height="18" viewBox="0 0 16 18" aria-hidden="true">
      <ellipse cx="5" cy="14" rx="3.6" ry="2.7" transform="rotate(-20 5 14)" fill="currentColor" />
      <path d="M8.2 13.2 V2.2 C 9.2 4.6 14 5.2 13.2 9.4 C 12.8 7.4 10.6 6.6 8.2 6.2 Z" fill="currentColor" />
    </svg>
  );
}

/**
 * Arp strip / panel. Plays back whatever's currently held (piano or host MIDI)
 * in a pattern; the audio side is native (ArpEngine). The quaver button opens
 * the docked detail view that matches the current mode (arp / seq).
 */
/** The mini panel’s Rate / Octaves / Gate are master controls for BOTH arp rows, RELATIVE: a change on the mini
 *  panel moves the blue row by the same amount, from wherever the blue row already is. The rows keep their own
 *  settings; they are not snapped to the same value. */
function mirrorToBlue(compact: boolean | undefined, arp: ArpSettings, patch: Partial<ArpSettings>): Partial<ArpSettings> {
  if (!compact) return patch;
  const b = arp.blue;
  const next: Partial<ArpBlueRow> = {};
  if (patch.octaves !== undefined) {
    const d = patch.octaves - arp.octaves;
    next.octaves = Math.max(1, Math.min(4, Math.round(b.octaves + d)));
  }
  if (patch.gate !== undefined) {
    const d = patch.gate - arp.gate;
    next.gate = Math.max(0.05, Math.min(4, Math.round((b.gate + d) * 100) / 100));
  }
  if (patch.rate) {
    const o = arp.rate, n = patch.rate;
    if (o.sync && n.sync && b.rate.sync) {
      const d = RATE_DIVS.indexOf(n.div) - RATE_DIVS.indexOf(o.div);
      const i = Math.max(0, Math.min(RATE_DIVS.length - 1, RATE_DIVS.indexOf(b.rate.div) + d));
      next.rate = { ...b.rate, div: RATE_DIVS[i] };
    } else if (!o.sync && !n.sync && !b.rate.sync) {
      const d = n.hz - o.hz;
      next.rate = { ...b.rate, hz: Math.max(0.5, Math.min(20, Math.round((b.rate.hz + d) * 10) / 10)) };
    }
  }
  if (patch.mode !== undefined) {
    // Pattern: move the blue row by the same number of steps through the pattern list (Up .. Walk), clamped.
    const list = ARP_PATTERNS.map((x) => x.value);
    const d = list.indexOf(patch.mode) - list.indexOf(arp.mode);
    const i = Math.max(0, Math.min(list.length - 1, list.indexOf(b.pattern) + d));
    next.pattern = list[i];
  }
  if (Object.keys(next).length === 0) return patch;
  return { ...patch, blue: { ...b, ...next } };
}

export function ArpPanel({ arp, onChange, compact, onOpenDetail, detailOpen, onCloseDetail, mod, onModChange }: Props) {
  // No on/off button: clicking a pattern turns the arp on with that pattern,
  // clicking a different pattern switches, clicking the active one turns it off.
  const pickMode = (m: ArpMode) => {
    if (!arp.on) onChange({ on: true, mode: m });
    else if (arp.mode === m) onChange({ on: false });
    else onChange({ mode: m });
  };

  // ----- all-patterns popover (fixed-positioned so the strip never clips it) -----
  const [menu, setMenu] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || moreRef.current?.contains(t)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);
  const toggleMenu = () => {
    if (menu) { setMenu(null); return; }
    const r = moreRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(4, Math.min(r.left, window.innerWidth - 330));
    if (r.bottom + 260 > window.innerHeight) setMenu({ left, bottom: window.innerHeight - r.top + 4 });
    else setMenu({ left, top: r.bottom + 4 });
  };

  // ----- modulation (Rate / Swing / Gate) -----
  const [modOpen, setModOpen] = useState<ModTargetId | null>(null);
  const anchorRefs = useRef<Partial<Record<ModTargetId, HTMLElement | null>>>({});
  const bindFor = (id: string): KnobModBind | undefined => {
    if (!mod || !onModChange) return undefined;
    const targetId = id as ModTargetId;
    return {
      targetId,
      routes: mod[targetId] ?? [],
      onModContext: (el) => { anchorRefs.current[targetId] = el; setModOpen(targetId); },
    };
  };

  const moreActive = arp.on && !QUICK_MODES.includes(arp.mode);
  const curPattern = PATTERN_BY_ID[arp.mode];

  // ONE pattern selector (all 16 patterns live in its menu) + an explicit on/off, instead of five quick buttons.
  // One source of truth: the arp is on exactly when an ARP layer is lit (arp.on is derived from the layers).
  const zeroOn = arp.on;
  const modes = (
    <div className="arp-modes">
      <button type="button" className={`arp-power ${zeroOn ? 'is-on' : ''}`} aria-pressed={zeroOn}
        onClick={() => {
          // Macro for the ARP layer zero button (row 1, offset 0): same state, always in sync.
          // On lights / clears every ARP layer together, so the button can never disagree with what plays.
          const turnOn = !zeroOn;
          const rows = arp.arp.layers.arp.map((r) => (turnOn ? r.slice() : r.map(() => false)));
          if (turnOn && !rows.some((r) => r.some(Boolean))) rows[0][2] = true;
          onChange({ on: turnOn, arp: { ...arp.arp, layers: { ...arp.arp.layers, arp: rows } } });
        }}
        title={zeroOn ? 'Arp ON - this is the ARP layer 1 zero button; click to turn off' : 'Arp OFF - click to turn on (same as ARP layer 1 zero)'}>
        On
      </button>
      {!compact && (
      <button ref={moreRef} type="button"
        className={`arp-mode-btn arp-pattern-btn ${arp.on ? 'is-on' : ''} ${menu ? 'is-open' : ''}`}
        onClick={toggleMenu}
        aria-haspopup="listbox" aria-expanded={!!menu}
        title="Arp pattern — all 16 patterns">
        {curPattern ? curPattern.label : 'Pattern'} {'▾'}
      </button>
      )}
    </div>
  );

  const keyControls = (
    <div className="arp-key">
      <button type="button" className={`arp-hold ${arp.keySnap ? 'is-on' : ''}`}
        onClick={() => onChange({ keySnap: !arp.keySnap })}
        title="Key snap — every arp / sequencer note is pulled to the nearest note in this key">
        <svg className="arp-key-ico" width="22" height="14" viewBox="0 0 22 14" aria-hidden="true">
          <rect x="0.75" y="0.75" width="20.5" height="12.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M7.5 1v12M14.5 1v12" stroke="currentColor" strokeWidth="1.1" />
          <rect x="5" y="1" width="5" height="7.5" rx="0.8" fill="currentColor" />
          <rect x="12" y="1" width="5" height="7.5" rx="0.8" fill="currentColor" />
        </svg>
        <span className="arp-sr">Key</span>
      </button>
      <select className="arp-key-sel" value={arp.keyRoot} disabled={!arp.keySnap}
        onChange={(e) => onChange({ keyRoot: parseInt(e.target.value, 10) })} title="Key root">
        {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
      </select>
      <select className="arp-key-sel" value={arp.keyScale} disabled={!arp.keySnap}
        onChange={(e) => onChange({ keyScale: e.target.value as typeof arp.keyScale })} title="Scale">
        {SCALES.map((sc) => <option key={sc.id} value={sc.id}>{sc.label}</option>)}
      </select>
    </div>
  );

  // One arp, one sequencer view: the detail button always opens the merged sequencer.
  const detailBtn = (
    <button type="button" className={`arp-detail-btn ${detailOpen ? 'is-open' : ''}`}
      onClick={() => (detailOpen ? onCloseDetail?.() : onOpenDetail?.('seq'))}
      disabled={!onOpenDetail}
      aria-pressed={!!detailOpen}
      title={detailOpen ? 'Close the detailed view' : 'Open the detailed arpeggiator (layers, step lanes, patterns)'}
      aria-label="Open detailed arpeggiator">
      <QuaverIcon />
    </button>
  );

  const hold = (
    <button type="button" className={`arp-hold ${arp.hold ? 'is-on' : ''}`}
      onClick={() => onChange({ hold: !arp.hold })}
      title="Hold — keep arpeggiating the last chord after releasing the keys">
      Hold
    </button>
  );

  // ----- rate group -----
  const r = arp.rate;
  const divIdx = Math.max(0, RATE_DIVS.indexOf(r.div));
  const feelSuffix = r.feel === 'triplet' ? 'T' : r.feel === 'dotted' ? '.' : '';
  const rateGroup = (
    <div className="arp-rate-group">
      <div className="arp-rate-sel">
        <button type="button" className={`arp-hold arp-sync-btn ${r.sync ? 'is-on' : ''}`}
          onClick={() => onChange({ rate: { ...r, sync: !r.sync } })}
          title={r.sync ? 'Tempo-synced rate — click for free Hz' : 'Free rate (Hz) — click to sync to tempo'}>
          Sync
        </button>
        <select className="arp-key-sel" value={r.feel} disabled={!r.sync}
          onChange={(e) => onChange({ rate: { ...r, feel: e.target.value as typeof r.feel } })} title="Feel">
          {FEELS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </div>
      <ArpKnobField
        label="Rate"
        size={compact ? 'md' : 'lg'}
        value={r.sync ? divIdx : r.hz}
        min={r.sync ? 0 : 0.5}
        max={r.sync ? RATE_DIVS.length - 1 : 20}
        onChange={(v) => {
          if (r.sync) onChange(mirrorToBlue(compact, arp, { rate: { ...r, div: RATE_DIVS[Math.max(0, Math.min(RATE_DIVS.length - 1, Math.round(v)))] } }));
          else onChange(mirrorToBlue(compact, arp, { rate: { ...r, hz: Math.round(v * 10) / 10 } }));
        }}
        format={(v) => (r.sync ? `${RATE_DIVS[Math.max(0, Math.min(RATE_DIVS.length - 1, Math.round(v)))]}${feelSuffix}` : `${v.toFixed(1)} Hz`)}
        title={r.sync ? 'Rate division (tempo-synced)' : 'Rate in Hz'}
        bind={bindFor('seqRate')}
      />
    </div>
  );

  // Chord hit + Tight: shown beside the knobs in both the strip and the full panel.
  const knobToggles = (
    <div className="arp-knob-toggles">
      <button type="button" className={`arp-hold ${arp.arp.chordHit ? 'is-on' : ''}`} aria-pressed={arp.arp.chordHit}
        title="Chord hit: every step sounds every held note (the stab). Off: one note per step, picked by the pattern"
        onClick={() => onChange({ arp: { ...arp.arp, chordHit: !arp.arp.chordHit } })}>Chord hit</button>
      <button type="button" className={`arp-hold ${arp.arp.tightRelease ? 'is-on' : ''}`} aria-pressed={arp.arp.tightRelease}
        title="Tight release: cut the note tail when the gate ends"
        onClick={() => onChange({ arp: { ...arp.arp, tightRelease: !arp.arp.tightRelease } })}>Tight</button>
    </div>
  );

  const knobs = (
    <div className={compact ? 'arp-strip-knobs' : 'arp-knobs'}>
      {rateGroup}
      {!compact && (
        <ArpKnobField label="Swing" size="lg" value={arp.swing} min={50} max={75}
          onChange={(v) => onChange({ swing: Math.round(v) })} format={(v) => `${Math.round(v)}%`}
          title="Swing — 50% is straight" bind={bindFor('seqSwing')} />
      )}
      {compact && (
        <ArpKnobField label="Pattern" size="md" value={Math.max(0, ARP_PATTERNS.findIndex((p) => p.value === arp.mode))}
          min={0} max={ARP_PATTERNS.length - 1}
          format={() => ARP_PATTERNS.find((p) => p.value === arp.mode)?.short ?? arp.mode}
          onChange={(v) => onChange(mirrorToBlue(compact, arp, { mode: ARP_PATTERNS[Math.max(0, Math.min(ARP_PATTERNS.length - 1, Math.round(v)))].value }))}
          title="Pattern: lowest = Up, highest = Walk (sets the green row)" />
      )}
      <ArpKnobField label="Octaves" size={compact ? 'md' : 'lg'} value={arp.octaves} min={1} max={4}
        onChange={(v) => onChange(mirrorToBlue(compact, arp, { octaves: Math.round(v) }))} format={(v) => String(Math.round(v))} />
      <ArpKnobField label="Gate" size={compact ? 'md' : 'lg'} value={arp.gate} min={0.05} max={4}
        onChange={(v) => onChange(mirrorToBlue(compact, arp, { gate: Math.round(v * 100) / 100 }))} format={(v) => `${Math.round(v * 100)}%`}
        title="Gate — note length as % of a step (up to 400%)" bind={bindFor('seqGate')} />
      {knobToggles}
    </div>
  );

  const menuEl = menu ? (
    <div ref={menuRef} className="arp-pattern-menu" role="listbox" aria-label="Arp patterns"
      style={{ left: menu.left, top: menu.top, bottom: menu.bottom }}>
      {ARP_PATTERNS.map((p) => (
        <button key={p.value} type="button" role="option" aria-selected={arp.on && arp.mode === p.value}
          className={`arp-pattern-item ${arp.on && arp.mode === p.value ? 'is-on' : ''}`}
          title={p.label}
          onClick={() => { onChange({ on: true, mode: p.value }); setMenu(null); }}>
          <PatternIcon pattern={p} active={arp.on && arp.mode === p.value} />
          <span>{p.label}</span>
        </button>
      ))}
    </div>
  ) : null;

  const modEl = modOpen && mod && onModChange ? (
    <ModPopover
      targetId={modOpen}
      routes={mod[modOpen] ?? []}
      anchorEl={anchorRefs.current[modOpen] ?? null}
      onChange={(routes) => onModChange({ ...mod, [modOpen]: routes })}
      onClose={() => setModOpen(null)}
    />
  ) : null;

  if (compact) {
    return (
      <>
        <div className="arp-strip arp-metal arp-m-arp" aria-label="Arpeggiator">
          <div className="arp-row">
            {modes}
            {hold}
          </div>
          {knobs}
        </div>
        {menuEl}
        {modEl}
      </>
    );
  }
  return (
    <>
      <section className="arp-panel arp-metal arp-m-arp" aria-label="Arpeggiator">
        <header className="op-section-title">Arpeggiator</header>
        <div className="arp-row">
          {modes}
          {hold}
          {keyControls}
          {detailBtn}
        </div>
        {knobs}
        <p className="arp-hint">Hold a chord on the keyboard (or send host MIDI) to hear it arpeggiate. The quaver button opens the step lanes.</p>
      </section>
      {menuEl}
      {modEl}
    </>
  );
}
