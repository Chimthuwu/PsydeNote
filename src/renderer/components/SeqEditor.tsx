import { useCallback, useRef, useState, useEffect } from 'react';
import type { ArpBlueRow, ArpMode, ArpRate, ArpSettings, DicePolarity, LaneId, RateDiv, SeqDirection, SeqLane } from '../../shared/types';
import { ARP_MODES, DICE_POLARITIES, LANE_IDS, SEQ_STEPS } from '../../shared/types';
import { SCALES, NOTE_NAMES } from '../../shared/scales';
import { ARP_PATTERNS, PatternIcon } from './ArpPanel';
import { getArpOverlay, useArpOverlay, useArpPlayhead } from '../lib/arpStore';
import { Knob } from './Knob';

/**
 * Docked step-sequencer editor (Pigments-style): header with global playback
 * controls, then 7 lanes x 16 steps. Lanes are painted with pointer drags
 * (Shift = proportional edit of the whole lane). The dice overlay computed by
 * the engine is drawn as a ghost marker; effective value = overlay ?? base.
 *
 * Contract: docs/ARP-SEQ-CONTRACT.md §1, §5. All styles live in seq-ui.css (seqv-*).
 */

/** Sequencer view states (MEGA ARP.md section 4). */
export const SEQ_DEFAULT = 'SEQ_DEFAULT';
export const SEQ_SCALE_WEIGHTS_EDIT = 'SEQ_SCALE_WEIGHTS_EDIT';
export type SeqViewState = typeof SEQ_DEFAULT | typeof SEQ_SCALE_WEIGHTS_EDIT;

/** Octave offsets of the chord and arp layer buttons (ArpLayers: 5 per row). */
const CHORD_OFFSETS = [-2, -1, 0, 1, 2];

/** The mockup shows the 18 patterns in three blocks of six (3 columns x 2 rows each). */
const PATTERN_BLOCKS: (typeof ARP_PATTERNS)[] = [0, 6, 12].map((i) => ARP_PATTERNS.slice(i, i + 6));

interface Props {
  arp: ArpSettings;
  onChange: (patch: Partial<ArpSettings>) => void;
  onClose: () => void;
  /** Tells the parent when the Scale Weights overlay opens or closes, so the mods can collapse. */
  onWeightsEditChange?: (editing: boolean) => void;
}

interface LaneCfg {
  id: LaneId;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  def: number;
  /** >1 gives finer resolution near the minimum (gate, slide). */
  curve: number;
  /** true = bars grow from the middle (pitch, octave). */
  bipolar: boolean;
  /** true = on/off toggle cells. */
  toggle?: boolean;
  /** true = high values sit at the BOTTOM of the lane's shape: the stored value stays the same, only the
   *  pointer mapping, bar paint and readout flip. Used by Gate, where a higher % means a shorter note. */
  reverse?: boolean;
  fmt: (v: number) => string;
}

const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);
/** Gate lane readout: 100 % = the shortest tick (stored 0.05), 0 % = the longest (stored 4). Same curve as the lane. */
const gateShown = (v: number) => `${Math.round((1 - Math.sqrt(clamp((v - 0.05) / 3.95, 0, 1))) * 100)}`;

const LANES: LaneCfg[] = [
  { id: 'on', label: 'On', hint: 'Step on / off (rest)', min: 0, max: 1, step: 1, def: 1, curve: 1, bipolar: false, toggle: true, fmt: (v) => (v >= 0.5 ? 'on' : '-') },
  { id: 'prob', label: 'Prob', hint: 'Probability that the step plays', min: 0, max: 1, step: 0.01, def: 1, curve: 1, bipolar: false, fmt: (v) => `${Math.round(v * 100)}` },
  { id: 'pitch', label: 'Pitch', hint: 'Semitones relative to each held note (-12..+12)', min: -12, max: 12, step: 1, def: 0, curve: 1, bipolar: true, fmt: (v) => signed(Math.round(v)) },
  { id: 'octave', label: 'Oct', hint: 'Octave offset (-2..+2)', min: -2, max: 2, step: 1, def: 0, curve: 1, bipolar: true, fmt: (v) => signed(Math.round(v)) },
  { id: 'vel', label: 'Vel', hint: 'Step velocity', min: 0, max: 1, step: 0.01, def: 0.8, curve: 1, bipolar: false, fmt: (v) => `${Math.round(v * 127)}` },
  { id: 'gate', label: 'Gate', hint: 'Note length: higher % = shorter note (100 % = staccato tick)', min: 0.05, max: 4, step: 0.05, def: 0.6, curve: 2, bipolar: false, reverse: true, fmt: gateShown },
  { id: 'slide', label: 'Slide', hint: 'Glide time into the step (0..1000 ms)', min: 0, max: 1000, step: 5, def: 0, curve: 2, bipolar: false, fmt: (v) => `${Math.round(v)}` },
];

const DIRECTIONS: { id: SeqDirection; label: string }[] = [
  { id: 'fwd', label: '→  Forward' },
  { id: 'bwd', label: '←  Backward' },
  { id: 'bounce', label: '↔  Bounce (ends repeat)' },
  { id: 'bounceExcl', label: '⇄  Bounce (no repeat)' },
  { id: 'random', label: '?  Random' },
  { id: 'randomNoRepeat', label: '?≠  Random (no repeat)' },
  { id: 'drunk', label: '∿  Drunk walk' },
  { id: 'converge', label: '⇥⇤  Converge (out to in)' },
  { id: 'diverge', label: '⇤⇥  Diverge (in to out)' },
];

const RATE_DIVS: RateDiv[] = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32'];
const LANE_DIVS: SeqLane['div'][] = [1, 2, 3, 4, 6, 8, 16];
const REGEN_OPTS: { v: number; label: string }[] = [
  { v: 0, label: 'Off' }, { v: 0.0625, label: '1/16 bar' }, { v: 0.125, label: '1/8 bar' },
  { v: 0.25, label: '1/4 bar' }, { v: 0.5, label: '1/2 bar' }, { v: 1, label: '1 bar' },
  { v: 2, label: '2 bars' }, { v: 4, label: '4 bars' }, { v: 8, label: '8 bars' },
];
const DEGREE_NAMES = ['Root', 'm2', 'M2', 'm3', 'M3', 'P4', 'TT', 'P5', 'm6', 'M6', 'm7', 'M7'];
/** Label on the dice toggle for each direction (-, -+, +). */
const POLARITY_GLYPH: Record<DicePolarity, string> = { neg: '-', both: '-+', pos: '+' };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function toNorm(c: LaneCfg, v: number): number {
  const t = clamp((v - c.min) / (c.max - c.min), 0, 1);
  return c.curve === 1 ? t : Math.pow(t, 1 / c.curve);
}
function fromNorm(c: LaneCfg, t: number): number {
  const u = c.curve === 1 ? clamp(t, 0, 1) : Math.pow(clamp(t, 0, 1), c.curve);
  const raw = c.min + u * (c.max - c.min);
  const q = Math.round(raw / c.step) * c.step;
  return clamp(Number(q.toFixed(4)), c.min, c.max);
}
/** Bar height 0..1 of a stored value, after the lane's reverse flip. */
const posOf = (c: LaneCfg, v: number) => (c.reverse ? 1 - toNorm(c, v) : toNorm(c, v));
/** Stored value for a bar height 0..1 (the inverse of `posOf`). */
const valOf = (c: LaneCfg, t: number) => fromNorm(c, c.reverse ? 1 - t : t);

const Dice = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="5" cy="5" r="1.15" fill="currentColor" /><circle cx="11" cy="5" r="1.15" fill="currentColor" />
    <circle cx="8" cy="8" r="1.15" fill="currentColor" />
    <circle cx="5" cy="11" r="1.15" fill="currentColor" /><circle cx="11" cy="11" r="1.15" fill="currentColor" />
  </svg>
);
const Lock = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
    <rect x="2" y="5.5" width="8" height="5.5" rx="1" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" />
    <path d={on ? 'M3.8 5.5V4a2.2 2.2 0 0 1 4.4 0v1.5' : 'M3.8 5.5V4a2.2 2.2 0 0 1 4.2-0.9'} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

/** Rainbow ring that fills with the Chaos amount: 0 = empty, 50 = half, 100 = full circle. Drag up/down. */
function ChaosRing({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const R = 30;
  const C = 2 * Math.PI * R;
  const drag = useRef<null | { y: number; v: number }>(null);
  const pct = Math.round(value * 100);
  return (
    <div className="seqv-chaos" title={`Chaos ${pct}% - drag up/down`}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { y: e.clientY, v: value }; }}
      onPointerMove={(e) => { const d = drag.current; if (d) onChange(clamp(d.v + (d.y - e.clientY) / 150, 0, 1)); }}
      onPointerUp={(e) => { drag.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* released */ } }}
      onPointerCancel={() => { drag.current = null; }}
    >
      <div className="seqv-chaos-label">Chaos</div>
      <svg viewBox="0 0 80 80" width="84" height="84" aria-hidden="true">
        <defs>
          <linearGradient id="seqv-rainbow" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ff4d6d" /><stop offset="22%" stopColor="#ffb703" />
            <stop offset="44%" stopColor="#d9f99d" /><stop offset="66%" stopColor="#38bdf8" />
            <stop offset="84%" stopColor="#a78bfa" /><stop offset="100%" stopColor="#f472b6" />
          </linearGradient>
        </defs>
        <circle cx="40" cy="40" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="7" />
        <circle cx="40" cy="40" r={R} fill="none" stroke="url(#seqv-rainbow)" strokeWidth="7"
          strokeDasharray={`${value * C} ${C}`} transform="rotate(-90 40 40)" />
      </svg>
      <div className="seqv-chaos-value">{pct}%</div>
    </div>
  );
}

/** Dice under one arp knob. Drag = amount, click = switch the direction (-+ bipolar, + one-way). Knob dice are
 *  drawn per step, so there is nothing to re-roll. Same pointer pattern as the lane dice. */
function KnobDice({ color, label, amount, bipolar, onAmount, onBipolar }: {
  /** Layer colour, so a row's dice read as that row's (default: the lane colour). */
  color?: string; label: string; amount: number; bipolar: boolean; onAmount: (v: number) => void; onBipolar: (b: boolean) => void;
}) {
  const drag = useRef<null | { y: number; amt: number; moved: boolean }>(null);
  const [tip, setTip] = useState(false);
  const pct = Math.round(amount * 100);
  return (
    <div className="seqv-kdice" style={color ? ({ '--lc': color } as React.CSSProperties) : undefined}>
      <button type="button" className={`seqv-dice ${amount > 0 ? 'is-armed' : ''}`} style={{ opacity: 0.35 + 0.65 * amount, ...(color ? { color, borderColor: color } : {}) }}
        title={`${label} dice ${pct}% - drag up/down for amount`} aria-label={`${label} dice ${pct} percent`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, amt: amount, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dy = d.y - e.clientY;
          if (!d.moved && Math.abs(dy) < 3) return;
          d.moved = true;
          setTip(true);
          onAmount(clamp(Math.round((d.amt + dy / 150) * 100) / 100, 0, 1));
        }}
        onPointerUp={(e) => {
          // A plain click does nothing here; the direction button beside it switches -+ / +.
          drag.current = null;
          setTip(false);
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        }}
        onPointerCancel={() => { drag.current = null; setTip(false); }}
      >
        <Dice /><em>{pct}%</em>
        {tip && <span className="seqv-tip" role="tooltip">{pct}%</span>}
      </button>
      <button type="button" className="seqv-pol" style={color ? { color, borderColor: color } : undefined} onClick={() => onBipolar(!bipolar)}
        title={`Dice direction: ${bipolar ? '-+ both ways' : '+ one way'} - click to switch`}
        aria-label={`${label} dice direction ${bipolar ? '-+' : '+'}`}>
        {bipolar ? '-+' : '+'}
      </button>
    </div>
  );
}

/** Index of the Rate dice in `generation.knobDice` (the KnobDice enum's kDiceRate). */
const RATE_DICE = 0;
// Index into a row's knobDice (KNOB_DICE_KEYS: rate, octaves, swing, pattern, gate). Pattern is global, so it is not drawn per row.

interface RowKnobsProps {
  /** Layer colour (green row / blue row): tints the knobs and dice so it is clear which row they drive. */
  color: string;
  rate: ArpRate;
  octaves: number;
  /** This row's pattern selector: lowest = Up, highest = Walk. */
  pattern: ArpMode;
  gate: number;
  dice: number[];
  diceBipolar: number[];
  onRate: (p: Partial<ArpRate>) => void;
  onOctaves: (v: number) => void;
  onPattern: (m: ArpMode) => void;
  onGate: (v: number) => void;
  onDice: (k: number, p: { amount?: number; bipolar?: boolean }) => void;
  /** Octave and Gate dice are the step lanes’ own dice (same amount): read and written on the lane, shared by both rows. */
  octaveLane: { amount: number; polarity: DicePolarity };
  gateLane: { amount: number; polarity: DicePolarity };
  onLaneDice: (id: LaneId, p: { amount?: number; polarity?: DicePolarity }) => void;
}

/** One layer row's Rate / Oct / Swing / Gate knobs, each with its dice underneath. Both rows use this. */
function RowKnobs({ color, rate, octaves, pattern, gate, dice, diceBipolar, onRate, onOctaves, onPattern, onGate, onDice, octaveLane, gateLane, onLaneDice }: RowKnobsProps) {
  // Lane dice: amount plus a bipolar flag (both = -+, anything else = +). Mirrors the step lane’s own dice button.
  const laneDiceFor = (label: string, id: LaneId, l: { amount: number; polarity: DicePolarity }) => (
    <KnobDice color={color} label={label} amount={l.amount} bipolar={l.polarity === 'both'}
      onAmount={(v) => onLaneDice(id, { amount: v })} onBipolar={(b) => onLaneDice(id, { polarity: b ? 'both' : 'pos' })} />
  );
  const patternIdx = Math.max(0, ARP_MODES.indexOf(pattern));
  const patternShort = ARP_PATTERNS.find((p) => p.value === pattern)?.short ?? pattern;
  const diceFor = (label: string, k: number) => (
    <KnobDice color={color} label={label} amount={dice[k] ?? 0} bipolar={(diceBipolar[k] ?? 1) >= 0.5}
      onAmount={(v) => onDice(k, { amount: v })} onBipolar={(b) => onDice(k, { bipolar: b })} />
  );
  return (
    <div className="seqv-knobs">
      <div className="seqv-kcol">
        <Knob color={color} label="Rate" size="sm"
          value={rate.sync ? RATE_DIVS.indexOf(rate.div) : rate.hz}
          min={rate.sync ? 0 : 0.5} max={rate.sync ? RATE_DIVS.length - 1 : 20}
          format={(v) => (rate.sync ? RATE_DIVS[clamp(Math.round(v), 0, RATE_DIVS.length - 1)] : `${v.toFixed(1)} Hz`)}
          onChange={(v) => (rate.sync
            ? onRate({ div: RATE_DIVS[clamp(Math.round(v), 0, RATE_DIVS.length - 1)] })
            : onRate({ hz: clamp(v, 0.5, 20) }))} />
        {diceFor('Rate', RATE_DICE)}
      </div>
      <div className="seqv-kcol">
        <Knob color={color} label="Octaves" size="sm" value={octaves} min={1} max={4} format={(v) => `${Math.round(v)}`}
          onChange={(v) => onOctaves(Math.round(v))} />
        {laneDiceFor('Octaves', 'octave', octaveLane)}
      </div>
      <div className="seqv-kcol">
        {/* Pattern selector for this row. Walk is the top of the range, Up the bottom. No dice: the pattern is a discrete pick. */}
        <Knob color={color} label="Pattern" size="sm" value={patternIdx} min={0} max={ARP_MODES.length - 1}
          format={() => patternShort}
          onChange={(v) => onPattern(ARP_MODES[clamp(Math.round(v), 0, ARP_MODES.length - 1)])} />
      </div>
      <div className="seqv-kcol">
        <Knob color={color} label="Gate" size="sm" value={gate} min={0.05} max={4} format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => onGate(v)} />
        {laneDiceFor('Gate', 'gate', gateLane)}
      </div>
    </div>
  );
}

export function SeqEditor({ arp, onChange, onClose, onWeightsEditChange }: Props) {
  const { seq, generation, rate, scale } = arp;
  // The playhead and the dice overlay are NOT subscribed here: they change on
  // every step while the arp plays, and a root subscription re-rendered the
  // whole editor per step. Lanes and the overlay buttons subscribe themselves.
  const [viewState, setViewState] = useState<SeqViewState>(SEQ_DEFAULT);
  const editing = viewState === SEQ_SCALE_WEIGHTS_EDIT;
  const patternAreaRef = useRef<HTMLDivElement | null>(null);

  // Tell the parent so it can collapse the mod cards while the overlay is up.
  useEffect(() => { onWeightsEditChange?.(editing); }, [editing, onWeightsEditChange]);

  // Auto-hide: Enter, or a press outside the pattern area, completes the edit.
  // Releasing the mouse over the overlay also completes it (see the overlay below).
  useEffect(() => {
    if (!editing) return;
    const close = () => setViewState(SEQ_DEFAULT);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') close(); };
    const onDown = (e: PointerEvent) => { if (patternAreaRef.current && !patternAreaRef.current.contains(e.target as Node)) close(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [editing]);

  // Latest settings for drag handlers (pointer events fire faster than renders).
  const arpRef = useRef(arp);
  arpRef.current = arp;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const patchSeq = useCallback((p: Partial<ArpSettings['seq']>) => {
    const a = arpRef.current;
    const next = { ...a, seq: { ...a.seq, ...p } };
    arpRef.current = next;
    onChangeRef.current({ seq: next.seq });
  }, []);
  const patchLane = useCallback((id: LaneId, p: Partial<SeqLane>) => {
    const a = arpRef.current;
    patchSeq({ lanes: { ...a.seq.lanes, [id]: { ...a.seq.lanes[id], ...p } } });
  }, [patchSeq]);
  // Octave / Gate dice live on the step lanes; both rows read and write those lanes (one amount each).
  const laneDice = (id: LaneId, p: { amount?: number; polarity?: DicePolarity }) =>
    patchLane(id, { ...(p.amount !== undefined ? { amount: p.amount } : {}), ...(p.polarity !== undefined ? { dicePolarity: p.polarity } : {}) });
  const laneProps = {
    octaveLane: { amount: seq.lanes.octave.amount, polarity: seq.lanes.octave.dicePolarity },
    gateLane: { amount: seq.lanes.gate.amount, polarity: seq.lanes.gate.dicePolarity },
    onLaneDice: laneDice,
  };
  const patchGen = (p: Partial<ArpSettings['generation']>) => onChange({ generation: { ...generation, ...p } });
  // One knob's dice: its amount (0..1) and its direction (bipolar 1 / one-way 0), index-matched to the engine.
  const setKnobDice = (k: number, p: { amount?: number; bipolar?: boolean }) => {
    const knobDice = generation.knobDice.slice();
    const knobDiceBipolar = generation.knobDiceBipolar.slice();
    if (p.amount !== undefined) knobDice[k] = p.amount;
    if (p.bipolar !== undefined) knobDiceBipolar[k] = p.bipolar ? 1 : 0;
    patchGen({ knobDice, knobDiceBipolar });
  };
  const patchRate = (p: Partial<ArpSettings['rate']>) => onChange({ rate: { ...rate, ...p } });
  // Blue row: its own knobs live under arp.blue; the same shape as the green row's top-level fields.
  const blue = arp.blue;
  const patchBlue = (p: Partial<ArpBlueRow>) => onChange({ blue: { ...blue, ...p } });
  const patchBlueRate = (p: Partial<ArpRate>) => patchBlue({ rate: { ...blue.rate, ...p } });
  const setBlueDice = (k: number, p: { amount?: number; bipolar?: boolean }) => {
    const knobDice = blue.knobDice.slice();
    const knobDiceBipolar = blue.knobDiceBipolar.slice();
    if (p.amount !== undefined) knobDice[k] = p.amount;
    if (p.bipolar !== undefined) knobDiceBipolar[k] = p.bipolar ? 1 : 0;
    patchBlue({ knobDice, knobDiceBipolar });
  };
  // Arp extras (layers, tight release, humanize) moved here from the retired ARP detail view.
  const arpX = arp.arp;
  const patchX = (p: Partial<ArpSettings['arp']>) => onChange({ arp: { ...arpX, ...p } });
  const toggleChord = (i: number) => {
    const chord = arpX.layers.chord.slice();
    chord[i] = !chord[i];
    patchX({ layers: { ...arpX.layers, chord } });
  };
  const toggleArp = (row: number, i: number) => {
    const rows = arpX.layers.arp.map((a) => a.slice());
    rows[row][i] = !rows[row][i];
    // arp.on follows the layers: on while any ARP layer is lit, so the mini On button always matches what plays.
    const on = rows.some((r) => r.some(Boolean));
    onChange({ on, arp: { ...arpX, layers: { ...arpX.layers, arp: rows } } });
  };

  const regen = () => patchGen({ regenToken: generation.regenToken + 1 });
  const clearOverlay = () => patchGen({ clearToken: generation.clearToken + 1 });
  const apply = () => {
    const overlay = getArpOverlay();
    const lanes = { ...seq.lanes };
    for (const id of LANE_IDS) {
      const ov = overlay[id];
      if (!ov) continue;
      const base = lanes[id].base.map((b, i) => (typeof ov[i] === 'number' ? (ov[i] as number) : b));
      lanes[id] = { ...lanes[id], base };
    }
    onChange({ seq: { ...seq, lanes }, generation: { ...generation, clearToken: generation.clearToken + 1 } });
  };

  const setWeight = (i: number, w: number) => {
    const weights = scale.weights.slice();
    weights[i] = clamp(w, 0, 1);
    onChange({ scale: { ...scale, weights } });
  };

  return (
    <section className={`seqv seqv-state-${editing ? 'weights' : 'default'}`} aria-label="Sequencer" data-state={viewState}
      onContextMenu={(e) => e.preventDefault()}>
      <header className="seqv-head">
        <div className="seqv-title">
          <strong>Sequencer</strong>
        </div>
        {/* Control bar under the lanes (mockup row): regen, timing and feel, key. */}
        <div className="seqv-bar">
          <div className="seqv-bar-group seqv-bar-regen">
            <label className="seqv-field" title="Re-roll all dice lanes automatically, aligned to the bar">
              <span>Auto-Regen</span>
              <select value={generation.autoRegen} onChange={(e) => patchGen({ autoRegen: Number(e.target.value) })}>
                {REGEN_OPTS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
              </select>
            </label>
            <div className="seqv-switch" role="group" aria-label="Chaos mode"
              title="Frozen: the rolled overlay repeats. Live: a fresh draw every time a step plays.">
              <button type="button" className={generation.chaos === 'frozen' ? 'is-on' : ''} onClick={() => patchGen({ chaos: 'frozen' })}>Frozen</button>
              <button type="button" className={generation.chaos === 'live' ? 'is-on' : ''} onClick={() => patchGen({ chaos: 'live' })}>Live</button>
            </div>
            <button type="button" className="seqv-regen" title="Regenerate: roll every lane that has a dice amount" onClick={regen}>
              <Dice /><span>Regen</span>
            </button>
            <OverlayButtons onClear={clearOverlay} onApply={apply} />
          </div>

          <div className="seqv-bar-group seqv-bar-timing">
            <label className="seqv-field" title="Playback direction through the steps">
              <span>Direction</span>
              <select value={seq.direction} onChange={(e) => patchSeq({ direction: e.target.value as SeqDirection })}>
                {DIRECTIONS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
            </label>
            <label className="seqv-field seqv-field-num" title="Pattern length (steps)">
              <span>Length</span>
              <input type="number" min={1} max={SEQ_STEPS} value={seq.length}
                onChange={(e) => patchSeq({ length: clamp(Math.round(Number(e.target.value) || 1), 1, SEQ_STEPS) })} />
            </label>
            <button type="button" className={`seqv-btn ${seq.polymetry ? 'is-on' : ''}`} aria-pressed={seq.polymetry}
              title="Polymetry: every lane runs with its own length" onClick={() => patchSeq({ polymetry: !seq.polymetry })}>
              Polymetry
            </button>
            <label className="seqv-field seqv-field-num" title="Realign all lanes to step 1 every N global steps (0 = off)">
              <span>Reset after</span>
              <select value={seq.resetAfter} onChange={(e) => patchSeq({ resetAfter: Number(e.target.value) })}>
                <option value={0}>Off</option>
                {Array.from({ length: 32 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n} steps</option>)}
              </select>
            </label>
            <label className="seqv-field seqv-field-num" title="Swing 50..75 %">
              <span>Swing</span>
              <input type="number" min={50} max={75} step={1} value={Math.round(arp.swing)}
                onChange={(e) => onChange({ swing: clamp(Number(e.target.value) || 50, 50, 75) })} />
            </label>
            <div className="seqv-group" title="Tempo-synced rate or free Hz">
              <button type="button" className={`seqv-btn ${rate.sync ? 'is-on' : ''}`} aria-pressed={rate.sync}
                onClick={() => patchRate({ sync: !rate.sync })}>Sync</button>
              {rate.sync ? (
                <select aria-label="Rate division" value={rate.div} onChange={(e) => patchRate({ div: e.target.value as RateDiv })}>
                  {RATE_DIVS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              ) : (
                <label className="seqv-inline">
                  <input type="number" min={0.5} max={20} step={0.1} value={rate.hz}
                    onChange={(e) => patchRate({ hz: clamp(Number(e.target.value) || 8, 0.5, 20) })} />
                  <span>Hz</span>
                </label>
              )}
            </div>
          </div>

          <div className="seqv-bar-group seqv-bar-key">
            <select aria-label="Key root" value={arp.keyRoot} onChange={(e) => onChange({ keyRoot: parseInt(e.target.value, 10) })}>
              {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
            </select>
            <select aria-label="Key scale" value={arp.keyScale} onChange={(e) => onChange({ keyScale: e.target.value as ArpSettings['keyScale'] })}>
              {SCALES.map((sc) => <option key={sc.id} value={sc.id}>{sc.label}</option>)}
            </select>
            <button type="button" className={`seqv-btn ${arp.keySnap ? 'is-on' : ''}`} aria-pressed={arp.keySnap}
              title="Snap to scale: every arp / sequencer note is pulled to the nearest note in the key and scale chosen beside it"
              onClick={() => onChange({ keySnap: !arp.keySnap })}>Snap to scale</button>
          <button type="button" className="seqv-btn seqv-scale-weights" aria-expanded={editing}
              title="Edit how likely each scale note is when the Pitch dice rolls"
              onClick={() => setViewState(editing ? SEQ_DEFAULT : SEQ_SCALE_WEIGHTS_EDIT)}>
              Scale weights
            </button>
          </div>
        </div>

        <div className="seqv-head-extra">
          <label className="seqv-field seqv-field-num" title="Transpose the whole pattern (before scale snapping)">
            <span>Transpose</span>
            <input type="number" min={-24} max={24} step={1} value={seq.pitchTranspose}
              onChange={(e) => patchSeq({ pitchTranspose: clamp(Math.round(Number(e.target.value) || 0), -24, 24) })} />
          </label>
          <label className="seqv-field seqv-field-num" title="0 = incoming MIDI velocity only, 100 = step velocity only">
            <span>Vel %</span>
            <input type="number" min={0} max={100} step={5} value={Math.round(arp.velocityPct * 100)}
              onChange={(e) => onChange({ velocityPct: clamp((Number(e.target.value) || 0) / 100, 0, 1) })} />
          </label>
          <label className="seqv-field seqv-field-num" title="Humanize: random timing and velocity wobble (0..100 %)">
            <span>Humanize</span>
            <input type="number" min={0} max={100} step={5} value={Math.round(arpX.humanize * 100)}
              onChange={(e) => patchX({ humanize: clamp((Number(e.target.value) || 0) / 100, 0, 1) })} />
          </label>
        </div>
        <button type="button" className="seqv-btn seqv-close" title="Close sequencer view" onClick={onClose} aria-label="Close sequencer">{'×'}</button>
      </header>

      <div className="seqv-lanes">
        {LANES.map((cfg) => (
          <LaneRow
            key={cfg.id}
            cfg={cfg}
            lane={seq.lanes[cfg.id]}
            globalLength={seq.length}
            polymetry={seq.polymetry}
            patchLane={patchLane}
          />
        ))}
      </div>

      <div className="seqv-body">
        <div className="seqv-pattern-area" ref={patternAreaRef}>
          <div className="seqv-pattern-grid" role="radiogroup" aria-label="Arp pattern">
            {PATTERN_BLOCKS.map((block, b) => (
              <div key={b} className="seqv-pat-block">
                {block.map((p) => {
                  const on = arp.mode === p.value;
                  // Blue = the BLUE row’s pattern (arp.blue.pattern), so the grid shows what the blue row plays.
                  const isBlue = arp.blue.pattern === p.value;
                  const cls = ['seqv-pat', on && 'is-on', isBlue && 'is-blue', on && isBlue && 'is-both'].filter(Boolean).join(' ');
                  return (
                    <button key={p.value} type="button" role="radio" aria-checked={on}
                      className={cls}
                      title={`${p.label} - left-click: green (the pattern). Right-click: blue (a second pick). Both: psychedelic`}
                      onClick={() => onChange({ mode: p.value, on: true })}
                      onContextMenu={(e) => { e.preventDefault(); patchBlue({ pattern: p.value }); }}>
                      <PatternIcon pattern={p} active={on} />
                      <span>{p.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {editing && (
            <div className="seqv-weights-overlay" role="dialog" aria-label="Scale weights"
              onPointerUp={() => setViewState(SEQ_DEFAULT)}>
              <div className="seqv-weights-grid">
                {scale.weights.map((w, i) => (
                  <label key={i} className={`seqv-weight ${i === 0 ? 'is-root' : ''}`} title={`${NOTE_NAMES[(arp.keyRoot + i) % 12]} (${DEGREE_NAMES[i]})`}>
                    <output>{Math.round(w * 100)}</output>
                    <input type="range" min={0} max={1} step={0.01} value={w} disabled={i === 0}
                      onChange={(e) => setWeight(i, Number(e.target.value))} />
                    <span>{NOTE_NAMES[(arp.keyRoot + i) % 12]}</span>
                  </label>
                ))}
              </div>
              <div className="seqv-weights-side">
                <button type="button" className={`seqv-btn ${scale.snap ? 'is-on' : ''}`} aria-pressed={scale.snap}
                  title="Also quantise the final pitch to the key" onClick={() => onChange({ scale: { ...scale, snap: !scale.snap } })}>
                  Quantise
                </button>
                <button type="button" className="seqv-btn" title="Weight each note by whether it belongs to the key scale"
                  onClick={() => {
                    const sc = SCALES.find((s) => s.id === arp.keyScale);
                    const iv = sc ? sc.intervals : [0, 2, 4, 5, 7, 9, 11];
                    onChange({ scale: { ...scale, weights: Array.from({ length: 12 }, (_, i) => (iv.includes(i) ? 1 : 0.1)) } });
                  }}>From key</button>
                <button type="button" className="seqv-btn" onClick={() => onChange({ scale: { ...scale, weights: scale.weights.map(() => 1) } })}>All 100</button>
              </div>
            </div>
          )}
        </div>

        <aside className="seqv-side">
          {/* Green row (Arp row 1): the mini strip's Rate / Oct / Swing / Gate, and the global Chaos. */}
          <div className="seqv-side-top seqv-row seqv-row-green">
            <ChaosRing value={generation.chaosAmount} onChange={(v) => patchGen({ chaosAmount: v })} />
            <RowKnobs
              color="var(--lay-green)" {...laneProps}
              rate={rate} octaves={arp.octaves} pattern={arp.mode} gate={arp.gate}
              dice={generation.knobDice} diceBipolar={generation.knobDiceBipolar}
              onRate={patchRate}
              onOctaves={(v) => onChange({ octaves: Math.round(v) })}
              onPattern={(m) => onChange({ mode: m })}
              onGate={(v) => onChange({ gate: v })}
              onDice={setKnobDice} />
          </div>
          {/* Blue row (Arp row 2): its own Rate / Oct / Swing / Gate and Chaos. */}
          <div className="seqv-side-top seqv-row seqv-row-blue">
            <ChaosRing value={blue.chaosAmount} onChange={(v) => patchBlue({ chaosAmount: v })} />
            <RowKnobs
              color="var(--lay-blue)" {...laneProps}
              rate={blue.rate} octaves={blue.octaves} pattern={blue.pattern} gate={blue.gate}
              dice={blue.knobDice} diceBipolar={blue.knobDiceBipolar}
              onRate={patchBlueRate}
              onOctaves={(v) => patchBlue({ octaves: Math.round(v) })}
              onPattern={(m) => patchBlue({ pattern: m })}
              onGate={(v) => patchBlue({ gate: v })}
              onDice={setBlueDice} />
          </div>
          <div className="seqv-layer-grid" role="group" aria-label="Layers">
            
            {CHORD_OFFSETS.map((o, i) => (
              <button key={`c${o}`} data-layer="chord" type="button" className={`seqv-lbtn ${arpX.layers.chord[i] ? 'is-on' : ''}`}
                aria-pressed={!!arpX.layers.chord[i]} title={`Chord layer ${o > 0 ? '+' : ''}${o} oct`}
                onClick={() => toggleChord(i)}>{o > 0 ? `+${o}` : o}</button>
            ))}
            
            {CHORD_OFFSETS.map((o, i) => (
              <button key={`a0${o}`} data-layer="arp" data-row="1" type="button" className={`seqv-lbtn ${arpX.layers.arp[0]?.[i] ? 'is-on' : ''}`}
                aria-pressed={!!arpX.layers.arp[0]?.[i]} title={`Arp row 1, ${o > 0 ? '+' : ''}${o} oct`}
                onClick={() => toggleArp(0, i)}>{o > 0 ? `+${o}` : o}</button>
            ))}
            
            {CHORD_OFFSETS.map((o, i) => (
              <button key={`a1${o}`} data-layer="arp" data-row="2" type="button" className={`seqv-lbtn ${arpX.layers.arp[1]?.[i] ? 'is-on' : ''}`}
                aria-pressed={!!arpX.layers.arp[1]?.[i]} title={`Arp row 2, ${o > 0 ? '+' : ''}${o} oct`}
                onClick={() => toggleArp(1, i)}>{o > 0 ? `+${o}` : o}</button>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

/** Clear / Apply for the dice overlay. Subscribes to the overlay itself so the
 *  rest of the editor does not re-render when a live overlay changes. */
function OverlayButtons({ onClear, onApply }: { onClear: () => void; onApply: () => void }) {
  const overlay = useArpOverlay();
  const hasOverlay = LANE_IDS.some((id) => overlay[id]?.some((v) => typeof v === 'number'));
  return (
    <>
      <button type="button" className="seqv-btn seqv-icon" title="Clear the random overlay" onClick={onClear} aria-label="Clear overlay">{'✕'}</button>
      <button type="button" className={`seqv-btn seqv-icon ${hasOverlay ? 'is-hot' : ''}`} title="Apply: bake the random overlay into the drawn pattern"
        onClick={onApply} aria-label="Apply overlay">{'✓'}</button>
    </>
  );
}

interface RowProps {
  cfg: LaneCfg;
  lane: SeqLane;
  globalLength: number;
  polymetry: boolean;
  patchLane: (id: LaneId, p: Partial<SeqLane>) => void;
}

function LaneRow({ cfg, lane, globalLength, polymetry, patchLane }: RowProps) {
  // Subscribed here, not in SeqEditor: a playhead step re-renders this one lane.
  const playStep = useArpPlayhead().step;
  const overlay = useArpOverlay()[cfg.id];
  const len = polymetry ? lane.length : globalLength;
  const barsRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef(lane);
  laneRef.current = lane;

  // Which step of THIS lane is currently sounding (approximation: ignores rotation/direction).
  const playIdx = playStep >= 0 && len > 0 ? Math.floor(playStep / lane.div) % len : -1;

  /* ---- bar painting ---- */
  const drag = useRef<null | {
    shift: boolean; startY: number; orig: number[]; lastCol: number; toggleTo: number; h: number;
  }>(null);

  const pointerPos = (e: React.PointerEvent) => {
    const r = barsRef.current!.getBoundingClientRect();
    const col = clamp(Math.floor(((e.clientX - r.left) / r.width) * SEQ_STEPS), 0, SEQ_STEPS - 1);
    const t = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
    return { col, t, h: r.height };
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 2) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { col, t, h } = pointerPos(e);
    const base = laneRef.current.base.slice();
    // Right button = erase the step back to default.
    if (e.button === 2) {
      base[col] = cfg.def;
      patchLane(cfg.id, { base });
      drag.current = { shift: false, startY: e.clientY, orig: base, lastCol: col, toggleTo: cfg.def, h };
      return;
    }
    if (e.shiftKey && !cfg.toggle) {
      drag.current = { shift: true, startY: e.clientY, orig: base, lastCol: col, toggleTo: 0, h };
      return;
    }
    let v: number;
    let toggleTo = 0;
    if (cfg.toggle) {
      toggleTo = base[col] >= 0.5 ? 0 : 1;
      v = toggleTo;
    } else {
      v = valOf(cfg, t);
    }
    base[col] = v;
    patchLane(cfg.id, { base });
    drag.current = { shift: false, startY: e.clientY, orig: base, lastCol: col, toggleTo, h };
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.shift) {
      // Proportional: move every step by the same normalised delta.
      const dn = (d.startY - e.clientY) / Math.max(40, d.h);
      const base = d.orig.map((v) => valOf(cfg, posOf(cfg, v) + dn));
      patchLane(cfg.id, { base });
      return;
    }
    const { col, t } = pointerPos(e);
    const v = cfg.toggle ? d.toggleTo : valOf(cfg, t);
    const base = laneRef.current.base.slice();
    const a = Math.min(col, d.lastCol);
    const b = Math.max(col, d.lastCol);
    for (let i = a; i <= b; i++) base[i] = e.buttons & 2 ? cfg.def : v;
    d.lastCol = col;
    patchLane(cfg.id, { base });
  };

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };

  /* ---- dice: click = roll, drag = amount fader, right-click = roll. Direction (-, -+, +) is its own button. ---- */
  const diceDrag = useRef<null | { y: number; amt: number; moved: boolean }>(null);
  const [diceTip, setDiceTip] = useState(false);
  const onDiceDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    diceDrag.current = { y: e.clientY, amt: laneRef.current.amount, moved: false };
  };
  const onDiceMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = diceDrag.current;
    if (!d) return;
    const dy = d.y - e.clientY;
    if (!d.moved && Math.abs(dy) < 3) return;
    d.moved = true;
    setDiceTip(true);
    patchLane(cfg.id, { amount: clamp(Math.round((d.amt + dy / 150) * 100) / 100, 0, 1) });
  };
  const onDiceUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = diceDrag.current;
    diceDrag.current = null;
    setDiceTip(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (d && !d.moved) {
      // A click is a roll. At 0 % there is nothing to roll, so the click also arms the lane to 100 %.
      const a = laneRef.current;
      patchLane(cfg.id, { rollToken: a.rollToken + 1, ...(a.amount > 0 ? {} : { amount: 1 }) });
    }
  };
  const onDiceContext = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    patchLane(cfg.id, { rollToken: laneRef.current.rollToken + 1 });
  };
  const cyclePolarity = () => {
    const i = DICE_POLARITIES.indexOf(laneRef.current.dicePolarity);
    patchLane(cfg.id, { dicePolarity: DICE_POLARITIES[(i + 1) % DICE_POLARITIES.length] });
  };

  const rotate = (n: number) => {
    const l = Math.max(1, len);
    patchLane(cfg.id, { rotation: (((lane.rotation + n) % l) + l) % l });
  };

  const toggleLock = (i: number) => {
    const locked = lane.locked.slice();
    locked[i] = !locked[i];
    patchLane(cfg.id, { locked });
  };

  const pct = Math.round(lane.amount * 100);
  const sameAsDef = lane.base.every((v) => v === cfg.def);

  return (
    <div className={`seqv-lane seqv-lane-${cfg.id}`} data-lane={cfg.id}>
      <div className="seqv-lane-ctl">
        <div className="seqv-lane-name" title={cfg.hint}>{cfg.label}</div>
        <div className="seqv-lane-tools">
          <button
            type="button"
            className={`seqv-dice is-${lane.dicePolarity} ${lane.amount > 0 ? 'is-armed' : ''}`}
            style={{ opacity: 0.35 + 0.65 * lane.amount }}
            title={`Roll ${cfg.label} dice - click to roll. Drag up/down for amount (${pct}%). Right-click: roll too`}
            aria-label={`Roll ${cfg.label} dice, amount ${pct} percent`}
            onPointerDown={onDiceDown} onPointerMove={onDiceMove} onPointerUp={onDiceUp} onPointerCancel={onDiceUp}
            onContextMenu={onDiceContext}
          >
            <Dice /><em>{pct}%</em>
            {diceTip && <span className="seqv-tip" role="tooltip">{pct}%</span>}
          </button>
          <button type="button" className="seqv-pol" onClick={cyclePolarity}
            title={`Dice direction: ${POLARITY_GLYPH[lane.dicePolarity]} - click to switch between - / -+ / +`}
            aria-label={`Dice direction ${POLARITY_GLYPH[lane.dicePolarity]}`}>
            {POLARITY_GLYPH[lane.dicePolarity]}
          </button>
          <button type="button" className="seqv-mini" title="Reset this lane to its default" disabled={sameAsDef}
            onClick={() => patchLane(cfg.id, { base: lane.base.map(() => cfg.def), rotation: 0 })}>
            {'⌫'}
          </button>
        </div>
        <div className="seqv-lane-tools">
          <label className="seqv-lane-sel" title="Lane rate divider: advances once per N global steps">
            <span>{'÷'}</span>
            <select value={lane.div} onChange={(e) => patchLane(cfg.id, { div: Number(e.target.value) as SeqLane['div'] })}>
              {LANE_DIVS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <div className="seqv-rot" title={`Rotation ${lane.rotation}`}>
            <button type="button" onClick={() => rotate(-1)} aria-label="Rotate left">{'◀'}</button>
            <button type="button" onClick={() => rotate(1)} aria-label="Rotate right">{'▶'}</button>
          </div>
        </div>
      </div>

      <div className="seqv-lane-main">
        <div
          ref={barsRef}
          className={`seqv-bars ${cfg.bipolar ? 'is-bipolar' : ''} ${cfg.toggle ? 'is-toggle' : ''}`}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          {Array.from({ length: SEQ_STEPS }, (_, i) => {
            const ov = overlay?.[i];
            const hasOv = typeof ov === 'number' && !lane.locked[i];
            const eff = hasOv ? (ov as number) : lane.base[i];
            const baseN = posOf(cfg, lane.base[i]);
            const effN = posOf(cfg, eff);
            const mid = posOf(cfg, 0);
            const lo = cfg.bipolar ? Math.min(baseN, mid) : 0;
            const hi = cfg.bipolar ? Math.max(baseN, mid) : baseN;
            const off = i >= len;
            const cls = [
              'seqv-col',
              off ? 'is-off' : '',
              playIdx === i ? 'is-play' : '',
              i % 4 === 0 ? 'is-beat' : '',
              cfg.toggle && lane.base[i] < 0.5 ? 'is-rest' : '',
              lane.locked[i] ? 'is-locked' : '',
              hasOv ? 'has-ov' : '',
            ].filter(Boolean).join(' ');
            return (
              <div key={i} className={cls}>
                <div className="seqv-fill" style={{ bottom: `${lo * 100}%`, height: `${Math.max(cfg.toggle ? 0 : 0.8, (hi - lo) * 100)}%` }} />
                {hasOv && <div className="seqv-ghost" style={{ bottom: `${effN * 100}%` }} />}
              </div>
            );
          })}
          {polymetry && (
            <div
              className="seqv-lenhandle"
              style={{ left: `${(len / SEQ_STEPS) * 100}%` }}
              title="Drag to set this lane's length"
              onPointerDown={(e) => {
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!(e.buttons & 1)) return;
                const r = barsRef.current!.getBoundingClientRect();
                const n = clamp(Math.round(((e.clientX - r.left) / r.width) * SEQ_STEPS), 1, SEQ_STEPS);
                if (n !== laneRef.current.length) patchLane(cfg.id, { length: n });
              }}
              onPointerUp={(e) => { try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* released */ } }}
            />
          )}
        </div>

        <div className="seqv-vals">
          {Array.from({ length: SEQ_STEPS }, (_, i) => {
            const ov = overlay?.[i];
            const hasOv = typeof ov === 'number' && !lane.locked[i];
            return (
              <span key={i} className={`${i >= len ? 'is-off' : ''} ${hasOv ? 'has-ov' : ''}`}>
                {cfg.fmt(hasOv ? (ov as number) : lane.base[i])}
              </span>
            );
          })}
        </div>

        <div className="seqv-locks">
          {Array.from({ length: SEQ_STEPS }, (_, i) => (
            <button
              key={i}
              type="button"
              className={`${lane.locked[i] ? 'is-locked' : ''} ${i >= len ? 'is-off' : ''} ${playIdx === i ? 'is-play' : ''}`}
              aria-pressed={lane.locked[i]}
              title={lane.locked[i] ? `Step ${i + 1}: locked (dice ignores it)` : `Step ${i + 1}: click to lock against the dice`}
              onClick={() => toggleLock(i)}
            >
              <span>{i + 1}</span>
              {lane.locked[i] && <Lock on />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
