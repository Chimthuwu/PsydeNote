/**
 * ARCHIVED (MEGA ARP, 2026-10-15). The standalone ARP detail view was merged into the
 * sequencer (components/SeqEditor.tsx). Kept for reference only: nothing imports it.
 * Its layers, humanize and tight-release controls now live in the sequencer's pattern header.
 */
import { useRef, useState } from 'react';
import type { ArpExtras, ArpGeneration, ArpSettings, ModMap, ModTargetId } from '../../shared/types';
import { useMemo } from 'react';
import { arpModeToPos, arpPosToMode, KNOB_DICE_COUNT, KNOB_DICE_KEYS, LANE_DICE_COUNT, type KnobDiceKey } from '../../shared/types';
import { useArpPlayhead } from '../lib/arpStore';
import { ARP_PATTERNS, ArpKnobField, FEELS, PatternIcon, RATE_DIVS, type KnobModBind } from '../components/ArpPanel';
import { ModPopover } from '../components/ModPopover';
import { ModBadge } from './ModPopover';

interface Props {
  arp: ArpSettings;
  onChange: (patch: Partial<ArpSettings>) => void;
  onClose: () => void;
  /** Optional, same pair ArpPanel takes — lets the knobs here be cable-drop
   *  targets and open the per-knob mod popover. Absent = knobs are plain. */
  mod?: ModMap;
  onModChange?: (mod: ModMap) => void;
}

/** One hue per dice, keyed by knob. Fixed values, NOT derived from `--accent`:
 *  a dice is identified by its colour, so it must read the same in neutral
 *  Graphite as in the Aurora themes. Spaced far apart on the wheel so no two
 *  adjacent dice look related. */
const DICE_HUE: Record<KnobDiceKey, string> = {
  rate: 'hsl(150 85% 60%)',
  octaves: 'hsl(190 85% 60%)',
  swing: 'hsl(265 80% 70%)',
  pattern: 'hsl(330 85% 68%)',
  gate: 'hsl(35 90% 62%)',
};
/** Chaos gets the RAINBOW: it is the master every dice obeys, so it must not
 *  read as one more peer knob. Rendered as a conic hue sweep rather than a
 *  flat colour, which no other control on the panel uses. */
const CHAOS_HUE = 'conic-gradient(from 0deg, #ff5d6c, #ffcc66, #7fffaf, #6df0ff, #a58bff, #ff5d6c)';

/** The dice "pips". A real die's face, not a knob: a rounded square with a
 *  fixed pip pattern whose OPAACITY scales with the amount. Drawn as an SVG so
 *  the pips stay crisp at any size and the face can rotate slightly on hover —
 *  the shape alone is what makes it read as a die rather than another dial. */
function DiceFace({ amount, hue, bipolar }: { amount: number; hue: string; bipolar: boolean }) {
  const pips = useMemo(() => {
    // 5-pip layout (four corners + centre); the count shown rises with the
    // amount so the die reads as "more randomness" at a glance, and the face
    // border shows the bipolar state.
    const on = Math.max(1, Math.min(5, Math.ceil(amount * 5)));
    const pts: [number, number][] = [[22, 22], [78, 22], [50, 50], [22, 78], [78, 78]];
    return pts.map(([x, y], i) => ({ x, y, on: i < on }));
  }, [amount]);
  const dim = amount <= 0.001;
  return (
    <span className={`arpv-die ${dim ? 'is-off' : ''} ${bipolar ? 'is-bipolar' : 'is-unipolar'}`}
      style={{ '--die-hue': hue } as React.CSSProperties}>
      <svg viewBox="0 0 100 100" className="arpv-die-face" aria-hidden="true">
        <rect x="4" y="4" width="92" height="92" rx="16" className="arpv-die-shell" />
        {pips.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="11" className={`arpv-die-pip ${p.on ? 'is-on' : ''}`} />
        ))}
      </svg>
    </span>
  );
}

interface DiceSpec {
  key: KnobDiceKey;
  amount: number;
  /** 1 = both directions, 0 = one-way. */
  bipolar: number;
  onAmount: (v: number) => void;
  onBipolar: (v: number) => void;
}

interface TcKnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  bind?: KnobModBind;
  dice?: DiceSpec;
  /** Chaos: rainbow sweep + its own ring treatment, and no dice of its own. */
  chaos?: boolean;
  /** Which side a ONE-WAY dice moves toward when only one direction is lit.
   *  '-' (the default) means shorter/lower; '+' means longer/higher. */
  negativeSide?: boolean;
  title?: string;
}

/**
 * One Timing &amp; Feel control: the knob, and DIRECTLY beneath it the dice that
 * randomises it (amount arc + a real die face + a bipolar/one-way toggle).
 *
 * The die and the bipolar toggle used to live in a separate strip below the
 * whole row, which put RATE's dice under SWING and meant the relationship
 * between a knob and its randomness had to be inferred from matching labels.
 * Nesting them is both the clearer arrangement and the shorter one.
 */
function TcKnob({ label, value, min, max, onChange, format, bind, dice, chaos, title, negativeSide = true }: TcKnobProps) {
  const knobProps = { label, value, min, max, onChange, format, size: 'lg' as const, bind, title };
  return (
    <div className={`arpv-tc-col ${chaos ? 'is-chaos' : ''}`}>
      {chaos
        ? <ChaosKnob {...knobProps} />
        : <ArpKnobField {...knobProps} />}
      {dice && (() => {
        // Both directions lit = bipolar; one lit = the dice only moves that way.
        const activeSides: ('-' | '+')[] = dice.bipolar ? ['-', '+'] : [negativeSide ? '-' : '+'];
        return (
        <div className="arpv-tc-dice" title={`${label} dice — randomises ${label.toLowerCase()} once per step`}>
          <label className="arpv-die-amount" title={`${label} randomness amount`}>
            <DiceFace amount={dice.amount} hue={DICE_HUE[dice.key]} bipolar={!!dice.bipolar} />
            <input
              type="range" min={0} max={1} step={0.01} value={dice.amount}
              aria-label={`${label} dice amount`}
              onChange={(e) => dice.onAmount(Math.round(Number(e.target.value) * 100) / 100)}
            />
            <span className="arpv-die-val">{Math.round(dice.amount * 100)}%</span>
          </label>
          {/* Bipolar by default: with both directions the dice may go either
              way, which is the musical reading of "randomise this". Clicking a
              direction removes it and the die's border changes to show the
              dice is now one-way. */}
          <div className="arpv-die-dir" role="group" aria-label={`${label} dice direction`}>
            {(['-', '+'] as const).map((side) => (
              <button
                key={side} type="button"
                className={`arpv-die-dir-btn ${activeSides.includes(side) ? 'is-on' : ''}`}
                aria-pressed={activeSides.includes(side)}
                title={activeSides.length === 2
                  ? 'Bipolar — click a side to make the dice one-way'
                  : `Only ${side === '-' ? 'shorter / lower' : 'longer / higher'} — click ${activeSides[0] === '-' ? '+' : '-'} to make it bipolar`}
                onClick={() => dice.onBipolar(activeSides.length === 2 ? (side === '-' ? 0 : 1) : 1)}
              >
                {side === '-' ? '−' : '+'}
              </button>
            ))}
          </div>
        </div>
        );
      })()}
    </div>
  );
}

/** Chaos: the SAME knob geometry as its neighbours (so it still reads as part
 *  of the row) but a rainbow hue and a glowing ring, because it is the MASTER
 *  every dice obeys rather than a peer of the four it scales. The rainbow is
 *  passed as the Knob's `color` — a CSS-only override loses to the inline
 *  custom property the Knob sets, exactly as the dice hues do. */
function ChaosKnob({ label, value, min, max, onChange, format, bind, title }: {
  label: string; value: number; min: number; max: number;
  onChange: (v: number) => void; format: (v: number) => string;
  bind?: KnobModBind; title?: string;
}) {
  return (
    <div className="arpv-chaos-wrap" title={title}>
      <ArpKnobField
        label={label} size="lg" value={value} min={min} max={max}
        onChange={onChange} format={format} bind={bind}
        color="var(--arpv-chaos-hue)"
      />
    </div>
  );
}

const OFFSETS = [-2, -1, 0, 1, 2];
const offLabel = (o: number) => (o > 0 ? `+${o}` : String(o));
const AUTO_REGEN: { v: number; label: string }[] = [
  { v: 0, label: 'Off' }, { v: 0.0625, label: '1/16 bar' }, { v: 0.125, label: '1/8 bar' }, { v: 0.25, label: '1/4 bar' },
  { v: 0.5, label: '1/2 bar' }, { v: 1, label: '1 bar' }, { v: 2, label: '2 bars' }, { v: 4, label: '4 bars' }, { v: 8, label: '8 bars' },
];

/**
 * Docked full-width ARPEGGIATOR detail view: pattern grid, rate/swing/shape/
 * humanize/gate, the Bitwig-style chord + arp layer buttons, per-step
 * transpose / gate lanes and the dice section.
 */
export function ArpDetail({ arp, onChange, onClose, mod, onModChange }: Props) {
  const ex = arp.arp;
  const { step } = useArpPlayhead();
  const patchEx = (p: Partial<ArpExtras>) => onChange({ arp: { ...ex, ...p } });
  const r = arp.rate;
  const divIdx = Math.max(0, RATE_DIVS.indexOf(r.div));
  const feelSuffix = r.feel === 'triplet' ? 'T' : r.feel === 'dotted' ? '.' : '';
  const head = step >= 0 ? step % 16 : -1;

  const toggleChord = (i: number) => {
    const chord = ex.layers.chord.slice();
    chord[i] = !chord[i];
    patchEx({ layers: { ...ex.layers, chord } });
  };
  const toggleArp = (row: number, i: number) => {
    const rows = ex.layers.arp.map((a) => a.slice());
    rows[row][i] = !rows[row][i];
    patchEx({ layers: { ...ex.layers, arp: rows } });
  };

  const gen = arp.generation;
  const patchGen = (p: Partial<ArpGeneration>) => onChange({ generation: { ...gen, ...p } });

  // Per-knob dice. `knobDice` is normalized to the full width by
  // `normalizeArpSettings`, but read defensively: a patch loaded from disk by an
  // OLD build (or hand-edited JSON) can still be short, and the engine indexes
  // this by a constant — `?? 0` keeps a missing entry meaning "off" instead of
  // rendering a blank knob. Writes always rebuild the full array.
  const knobDice = gen.knobDice ?? [];
  const knobDiceBipolar = gen.knobDiceBipolar ?? [];
  const setKnobDice = (i: number, v: number) => {
    const next = Array.from({ length: KNOB_DICE_COUNT }, (_, k) => knobDice[k] ?? 0);
    next[i] = v;
    patchGen({ knobDice: next });
  };
  const setKnobDiceBipolar = (i: number, v: number) => {
    const next = Array.from({ length: KNOB_DICE_COUNT }, (_, k) => knobDiceBipolar[k] ?? 1);
    next[i] = v;
    patchGen({ knobDiceBipolar: next });
  };
  /** One ready-made DiceSpec per key, so each TcKnob just says which key it is
   *  rather than re-deriving the index and both setters at every call site. */
  const diceFor = (key: KnobDiceKey): DiceSpec => {
    const i = KNOB_DICE_KEYS.indexOf(key);
    return {
      key,
      amount: knobDice[i] ?? 0,
      bipolar: knobDiceBipolar[i] ?? 1,
      onAmount: (v) => setKnobDice(i, v),
      onBipolar: (v) => setKnobDiceBipolar(i, v),
    };
  };
  const DICE = {
    rate: diceFor('rate'),
    octaves: diceFor('octaves'),
    swing: diceFor('swing'),
    gate: diceFor('gate'),
    pattern: diceFor('pattern'),
  } as const;

  // ---- step-lane dice (separate from the per-knob dice: a lane already IS a
  // 16-step sequence, so its randomness rides the existing lane overlay rather
  // than a live per-step draw) ----
  const laneDice = ex.laneDice ?? [];
  const laneDiceBipolar = ex.laneDiceBipolar ?? [];
  const setLaneDice = (i: number, v: number) => {
    const next = Array.from({ length: LANE_DICE_COUNT }, (_, k) => laneDice[k] ?? 0);
    next[i] = v;
    patchEx({ laneDice: next });
  };
  const setLaneDiceBipolar = (i: number, v: number) => {
    const next = Array.from({ length: LANE_DICE_COUNT }, (_, k) => laneDiceBipolar[k] ?? 1);
    next[i] = v;
    patchEx({ laneDiceBipolar: next });
  };
  const laneDiceFor = (i: number) => ({
    amount: laneDice[i] ?? 0,
    // Stored as 0/1 flags (the engine reads them as floats); the UI wants a
    // boolean, so convert HERE rather than at each call site.
    bipolar: (laneDiceBipolar[i] ?? 1) >= 0.5,
    onAmount: (v: number) => setLaneDice(i, v),
    onBipolar: (v: number) => setLaneDiceBipolar(i, v),
  });

  // ---- transpose lane: snap every step to the held key + scale ----
  const snapTransposeToScale = () => {
    // `arp.scale.weights` are RELATIVE to the key root, so the absolute pitch
    // classes that are in the scale are `root + pc` for each weighted pc.
    const weights = arp.scale?.weights ?? [];
    const root = ((arp.keyRoot ?? 0) % 12 + 12) % 12;
    const on = new Set<number>();
    for (let pc = 0; pc < 12; pc += 1) {
      if ((weights[pc] ?? 0) > 0.001) on.add((root + pc) % 12);
    }
    if (on.size === 0) return;                       // no scale set — do nothing
    const nearestInScale = (semi: number) => {
      let best = 0;
      let bestD = Infinity;
      for (const pc of on) {
        // Distance in semitones, folded so +11 and -1 are 1 apart, not 12.
        const raw = pc - semi;
        const d = Math.min(Math.abs(raw), 12 - Math.abs(raw));
        if (d < bestD) { bestD = d; best = pc; }
      }
      return best;
    };
    patchEx({
      stepTranspose: ex.stepTranspose.map((v) => {
        if (v === 0) return 0;                        // untouched step stays put
        const absolute = ((v + root) % 12 + 12) % 12;
        // Back into the lane's root-relative -12..12 space, choosing the
        // octave nearest the original so snapping never jumps the octave.
        let snapped = nearestInScale(absolute) - root;
        while (snapped - v > 6) snapped -= 12;
        while (v - snapped > 6) snapped += 12;
        return snapped;
      }),
    });
  };

  // Per-knob modulation, same shape as ArpPanel's bindFor.
  const [modOpen, setModOpen] = useState<ModTargetId | null>(null);
  const anchorRefs = useRef<Partial<Record<ModTargetId, HTMLElement | null>>>({});
  const bindFor = (id: string) => {
    if (!mod || !onModChange) return undefined;
    const targetId = id as ModTargetId;
    return {
      targetId,
      routes: mod[targetId] ?? [],
      onModContext: (el: HTMLElement) => { anchorRefs.current[targetId] = el; setModOpen(targetId); },
    };
  };

  return (
    <section className="arpv arp-metal arp-m-arp" aria-label="Arpeggiator detail">
      <header className="arpv-head">
        <span className="arpv-title">Arpeggiator</span>
        {/* One button cycling OFF -> ARP -> SEQ. Two separate controls (an On
            toggle plus a separate ARP/SEQ choice) meant three states spread over
            two widgets, and the common case — switch it off for a moment — cost
            two clicks. One cycle covers all three in order. */}
        <button type="button" className={`arpv-toggle arpv-mode-btn mode-${arp.on ? (arp.seq.enabled ? 'seq' : 'arp') : 'off'}`}
          onClick={() => {
            if (!arp.on) onChange({ on: true, seq: { ...arp.seq, enabled: false } });
            else if (!arp.seq.enabled) onChange({ seq: { ...arp.seq, enabled: true } });
            else onChange({ on: false, seq: { ...arp.seq, enabled: false } });
          }}
          title={arp.on ? (arp.seq.enabled ? 'Sequencer mode — click to turn the arp off' : 'Arp mode — click for step-sequencer mode') : 'Off — click to start the arp'}>
          {arp.on ? (arp.seq.enabled ? 'Seq' : 'Arp') : 'Off'}
        </button>
        <button type="button" className={`arpv-toggle ${arp.hold ? 'is-on' : ''}`}
          onClick={() => onChange({ hold: !arp.hold })} title="Hold — keep arpeggiating after releasing the keys">
          Hold
        </button>
        <button type="button" className={`arpv-toggle ${ex.tightRelease ? 'is-on' : ''}`}
          onClick={() => patchEx({ tightRelease: !ex.tightRelease })}
          title="Tight release — when the arp cuts a note at the end of its gate, the voice's amp release is shortened too so Gate is audible">
          Tight release
        </button>
        <span className="arpv-spacer" />
        <button type="button" className="arpv-close" onClick={onClose} title="Close detail view" aria-label="Close arpeggiator detail">
          {'×'}
        </button>
      </header>

      <div className="arpv-body">
        {/* Everything EXCEPT the step lanes lives in `.arpv-top`, and the lanes
            are a SIBLING of it rather than the last card in it. The lanes are
            the one control here with no equivalent in the compact strip, and as
            the last item of a scrolling grid they were the first thing cut: at
            1272x984 the body scrolled 367 px and the transpose/gate lanes sat
            352 px BELOW the fold — "not accessible unless we scroll". Pinning
            them to the bottom of the panel means they are visible at every
            window height; `.arpv-top` takes whatever is left and scrolls itself,
            which keeps the panel itself static. */}
        <div className="arpv-top">
        {/* ---------- patterns ---------- */}
        <div className="arpv-card arpv-patterns">
          <div className="arpv-card-title">Pattern</div>
          <div className="arpv-pat-grid" role="radiogroup" aria-label="Arp pattern">
            {ARP_PATTERNS.map((p) => {
              const on = arp.mode === p.value;
              return (
                <button key={p.value} type="button" role="radio" aria-checked={on}
                  className={`arpv-pat ${on ? 'is-on' : ''}`} title={p.label}
                  onClick={() => onChange({ mode: p.value, on: true })}>
                  <PatternIcon pattern={p} active={on} />
                  <span>{p.label}</span>
                </button>
              );
            })}
          </div>
          {/* The same choice as a continuous 0..100 % selector. It is NOT a second
              setting: both this and the grid write `mode`, and the engine derives
              the pattern from the `arp_pattern` host param that `mode` maps to
              (ArpEngine::effMode). So the slider follows a tile click, a tile
              lights up when the slider passes it, and host automation or a
              seqPattern mod route sweeps through the patterns. */}
          {/* `seqPattern` already existed as a mod target but this slider was a
              bare <input>, so it had no `data-mod-target` and no badge — a cable
              dropped on it did nothing and there was no per-knob popover. It is
              now a real modulation target, same as every other control here. */}
          <div className="arpv-pat-slider" data-mod-target="seqPattern"
            ref={bindFor('seqPattern') ? (el) => { anchorRefs.current.seqPattern = el; } : undefined}
            onContextMenu={bindFor('seqPattern') ? (e) => {
              e.preventDefault();
              anchorRefs.current.seqPattern = e.currentTarget as HTMLElement;
              setModOpen('seqPattern');
            } : undefined}
            title="Pattern selector — sweep, automate, or drop a modulator on it">
            <span className="arpv-pat-slider-label">Select</span>
            <input
              type="range" min={0} max={1} step={0.001}
              value={arpModeToPos(arp.mode)}
              aria-label="Pattern selector"
              onChange={(e) => onChange({ mode: arpPosToMode(Number(e.target.value)), on: true })}
            />
            <span className="arpv-pat-slider-val">{Math.round(arpModeToPos(arp.mode) * 100)}%</span>
            {mod && <ModBadge targetId="seqPattern" routes={mod.seqPattern ?? []} />}
            {/* The pattern's own dice. It lives HERE rather than in Timing &
                Feel because it dice the PATTERN, not the timing — but it shares
                the same `knobDice` array, so one normalizer and one engine read
                cover all five. No -/+ toggle: pattern is a discrete index, not an
                ordered axis, so "only positive" has no meaning for it. */}
            <div className="arpv-pat-dice" title="Pattern dice — picks a different pattern on some steps">
              <DiceFace amount={DICE.pattern.amount} hue={DICE_HUE.pattern} bipolar={DICE.pattern.bipolar} />
              <input
                type="range" min={0} max={1} step={0.01} value={DICE.pattern.amount}
                aria-label="Pattern dice amount"
                onChange={(e) => DICE.pattern.onAmount(Math.round(Number(e.target.value) * 100) / 100)}
              />
              <span className="arpv-die-val">{Math.round(DICE.pattern.amount * 100)}%</span>
            </div>
          </div>
        </div>

        {/* ---------- timing knobs ----------
            Each knob and ITS OWN dice live in one `.arpv-tc-col`, so a dice is
            always directly under the knob it randomises. They used to be a
            separate strip below the row, which put RATE's dice under SWING and
            cost ~60 px of extra panel height for nothing (measured: the pattern
            card had 109 px of dead space and the dice card 64 px below their
            last child, while the dice strip still wanted a row of its own). */}
        <div className="arpv-card arpv-controls">
          <div className="arpv-card-title">
            Timing &amp; feel
            <span className="arpv-sub">each dice randomises its own knob once per step · scaled by Chaos</span>
          </div>
          <div className="arpv-rate-row">
            <button type="button" className={`arpv-toggle ${r.sync ? 'is-on' : ''}`}
              onClick={() => onChange({ rate: { ...r, sync: !r.sync } })}
              title={r.sync ? 'Tempo-synced — click for free Hz' : 'Free Hz — click to sync to tempo'}>
              Sync
            </button>
            <select className="arpv-select" value={r.feel} disabled={!r.sync}
              onChange={(e) => onChange({ rate: { ...r, feel: e.target.value as typeof r.feel } })} title="Feel">
              {FEELS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          <div className="arpv-knobs arpv-tc-row">
            <TcKnob
              label="Rate" bind={bindFor('seqRate')} dice={DICE.rate}
              value={r.sync ? divIdx : r.hz}
              min={r.sync ? 0 : 0.5} max={r.sync ? RATE_DIVS.length - 1 : 20}
              onChange={(v) => {
                if (r.sync) onChange({ rate: { ...r, div: RATE_DIVS[Math.max(0, Math.min(RATE_DIVS.length - 1, Math.round(v)))] } });
                else onChange({ rate: { ...r, hz: Math.round(v * 10) / 10 } });
              }}
              format={(v) => (r.sync ? `${RATE_DIVS[Math.max(0, Math.min(RATE_DIVS.length - 1, Math.round(v)))]}${feelSuffix}` : `${v.toFixed(1)} Hz`)}
            />
            <TcKnob
              label="Octaves" bind={bindFor('seqOctaves')} dice={DICE.octaves}
              value={arp.octaves} min={1} max={4}
              onChange={(v) => onChange({ octaves: Math.round(v) })} format={(v) => String(Math.round(v))}
              title="Octaves the pattern spans"
            />
            <TcKnob
              label="Swing" bind={bindFor('seqSwing')} dice={DICE.swing}
              value={arp.swing} min={50} max={75}
              onChange={(v) => onChange({ swing: Math.round(v) })} format={(v) => `${Math.round(v)}%`}
            />
            <TcKnob
              label="Gate" bind={bindFor('seqGate')} dice={DICE.gate}
              value={arp.gate} min={0.05} max={4}
              onChange={(v) => onChange({ gate: Math.round(v * 100) / 100 })}
              format={(v) => `${Math.round(v * 100)}%`}
              title={ex.useStepLanes ? 'Global gate (the step gate lane is active instead)' : 'Note length as % of a step (up to 400%)'}
            />
            {/* Chaos is LAST and visually separated by a divider: it scales
                every dice in this panel, so it is a master, not a peer of the
                four it governs. */}
            <div className="arpv-tc-divider" role="separator" aria-orientation="vertical" />
            <TcKnob
              label="Chaos" chaos
              value={gen.chaosAmount} min={0} max={1}
              onChange={(v) => patchGen({ chaosAmount: Math.round(v * 100) / 100 })}
              format={(v) => `${Math.round(v * 100)}%`}
              bind={bindFor('seqChaos')}
              title="Chaos — scales EVERY dice amount on this panel. 0 % disables all of them."
            />
          </div>
        </div>

        {/* ---------- layers ---------- */}
        <div className="arpv-card arpv-layers">
          <div className="arpv-card-title">Layers <span className="arpv-sub">octave offsets</span></div>
          <div className="arpv-layer-grid">
            <div className="arpv-layer-tag">Arp</div>
            {[0, 1].map((row) => (
              <div key={row} className="arpv-layer-row arpv-layer-small">
                {OFFSETS.map((o, i) => (
                  <button key={o} type="button" className={`arpv-lbtn ${ex.layers.arp[row]?.[i] ? 'is-on' : ''}`}
                    aria-pressed={!!ex.layers.arp[row]?.[i]} onClick={() => toggleArp(row, i)}
                    title={`Arpeggiate the held chord ${offLabel(o)} octave${Math.abs(o) === 1 ? '' : 's'} (row ${row + 1})`}>
                    {offLabel(o)}
                  </button>
                ))}
              </div>
            ))}
            <div className="arpv-layer-tag">Chord</div>
            <div className="arpv-layer-row arpv-layer-big">
              {OFFSETS.map((o, i) => (
                <button key={o} type="button" className={`arpv-lbtn ${ex.layers.chord[i] ? 'is-on' : ''}`}
                  aria-pressed={!!ex.layers.chord[i]} onClick={() => toggleChord(i)}
                  title={`Play the held chord as-is ${offLabel(o)} octave${Math.abs(o) === 1 ? '' : 's'}`}>
                  {offLabel(o)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ---------- dice ---------- */}
        <div className="arpv-card arpv-dice">
          <div className="arpv-card-title">Dice <span className="arpv-sub">sequencer lane randomness</span></div>
          <div className="arpv-dice-row">
            <button type="button" className="arpv-btn"
              onClick={() => onChange({ generation: { ...gen, regenToken: gen.regenToken + 1 } })}
              title="Roll every lane that has Random Amount above zero">
              {'⚄'} Regen
            </button>
            <button type="button" className="arpv-btn"
              onClick={() => onChange({ generation: { ...gen, clearToken: gen.clearToken + 1 } })}
              title="Clear all dice overlays">
              Clear
            </button>
            <label className="arpv-inline">
              <span>Auto</span>
              <select className="arpv-select" value={gen.autoRegen}
                onChange={(e) => onChange({ generation: { ...gen, autoRegen: parseFloat(e.target.value) } })}>
                {AUTO_REGEN.map((a) => <option key={a.v} value={a.v}>{a.label}</option>)}
              </select>
            </label>
            <div className="arpv-seg" role="radiogroup" aria-label="Chaos">
              {(['frozen', 'live'] as const).map((c) => (
                <button key={c} type="button" role="radio" aria-checked={gen.chaos === c}
                  className={`arpv-seg-btn ${gen.chaos === c ? 'is-on' : ''}`}
                  title={c === 'frozen' ? 'Frozen — the rolled overlay repeats' : 'Live — fresh draw every time a step plays'}
                  onClick={() => onChange({ generation: { ...gen, chaos: c } })}>
                  {c === 'frozen' ? 'Frozen' : 'Live'}
                </button>
              ))}
            </div>
          </div>
          <div className="arpv-hint">Amounts are set per lane in the step sequencer view.</div>
        </div>
        </div>{/* /.arpv-top — the lanes below are its sibling, not its last child */}

        {/* ---------- step lanes ---------- */}
        {/* No Active/Off toggle (user: "if the values are all at 0 its not
            active, we dont need the extra active button"). The lanes carry their
            own randomness now, so an all-zero lane is obviously inert just by
            looking at it; the switch was a third control to keep in sync with
            the two that actually change anything. */}
        <div className="arpv-card arpv-lanes">
          <div className="arpv-card-title">
            Step lanes <span className="arpv-sub">per-step randomness · the die sets how much</span>
          </div>
          <div className="arpv-lane-scroll">
          <Lane label="Transpose" unit="st" values={ex.stepTranspose} head={head}
            min={-12} max={12} bipolar def={0} integer
            format={(v) => (v > 0 ? `+${v}` : String(v))}
            onChange={(v) => patchEx({ stepTranspose: v })}
            dice={<LaneDice {...laneDiceFor(0)} hue={DICE_HUE.rate} />}
            headerExtra={
              <button type="button" className="arpv-lane-key"
                onClick={snapTransposeToScale}
                title="Snap every step to the current key + scale (steps outside the scale are cleared)"
                aria-label="Snap transpose lane to key and scale">&#127929; Snap</button>
            } />
          {/* GATE lane is a SHORTEN axis, bottom-up (user): 0 at the bottom plays
                        at the Gate KNOB's length; turning it UP makes the note shorter and
                        shorter, so 100 % is half and 400 % is near-staccato. That is the
                        axis you reach for when writing a sequence — "make THIS step
                        staccato" — rather than the old per-step LENGTH, which duplicated
                        the knob above it and fought it.

                        `stepShorten` is stored 0..4 and drawn with the lane's own
                        `reverse` flag, so the bar and its number agree. The length side of
                        the job belongs to the Gate knob, which still goes to 400 %. */}
                    <Lane label="Gate" unit="short" values={ex.stepShorten} head={head}
                      min={0} max={4} def={0} reverse
                      format={(v) => (v === 0 ? 'off' : `${Math.round(v * 100)}`)}
                      onChange={(v) => patchEx({ stepShorten: v })}
                      dice={<LaneDice {...laneDiceFor(1)} hue={DICE_HUE.gate} />} />
                    {/* VELOCITY lane. 1 = the held note's own velocity, so an untouched lane
                        is a strict no-op and an old patch sounds exactly as it did; the
                        lane only ever pulls a step DOWN, which is the direction that reads
                        as an accent pattern. */}
                    <Lane label="Vel" unit="%" values={ex.stepVel} head={head}
                      min={0} max={1} def={1}
                      format={(v) => `${Math.round(v * 100)}`}
                      onChange={(v) => patchEx({ stepVel: v })} />
                    {/* SLIDE lane — portamento into each step, in ms. The per-step
                        counterpart to the sequencer view's Slide lane. */}
                    <Lane label="Slide" unit="ms" values={ex.stepSlide} head={head}
                      min={0} max={1000} def={0}
                      format={(v) => `${Math.round(v)}`}
                      onChange={(v) => patchEx({ stepSlide: v })} />
                  </div>
        </div>
      </div>

      {modOpen && mod && onModChange && (
        <ModPopover
          targetId={modOpen}
          routes={mod[modOpen] ?? []}
          anchorEl={anchorRefs.current[modOpen] ?? null}
          onChange={(routes) => onModChange({ ...mod, [modOpen]: routes })}
          onClose={() => setModOpen(null)}
        />
      )}
    </section>
  );
}

/** A step lane's own dice: the same die face as the Timing row, plus a -/+
 *  toggle. Sits in the lane's label column so it lines up with the lane it
 *  randomises rather than floating in a strip of its own. */
function LaneDice({ amount, hue, bipolar, onAmount, onBipolar }: {
  amount: number; hue: string; bipolar: boolean;
  onAmount: (v: number) => void; onBipolar: (v: number) => void;
}) {
  return (
    <div className="arpv-lane-dice">
      <DiceFace amount={amount} hue={hue} bipolar={bipolar} />
      <input
        type="range" min={0} max={1} step={0.01} value={amount}
        aria-label="Lane randomness amount"
        onChange={(e) => onAmount(Math.round(Number(e.target.value) * 100) / 100)}
      />
      <div className="arpv-die-dir" role="group" aria-label="Lane randomness direction">
        {([1, 0] as const).map((b) => (
          <button key={b} type="button"
            className={`arpv-die-dir-btn ${(bipolar ? 1 : 0) === b ? 'is-on' : ''}`}
            aria-pressed={(bipolar ? 1 : 0) === b}
            title={b === 1 ? 'Bipolar — may move either way' : 'One-way — only moves toward this side'}
            onClick={() => onBipolar(b)}>
            {b === 1 ? '±' : '−'}
          </button>
        ))}
      </div>
    </div>
  );
}

interface LaneProps {
  label: string;
  unit: string;
  values: number[];
  head: number;
  min: number;
  max: number;
  def: number;
  bipolar?: boolean;
  integer?: boolean;
  /** Invert the AXIS so a HIGHER drawn position is a LOWER stored value, while
   *  the STORED value keeps its meaning (patches unaffected). The gate lane
   *  uses this: stored gate stays 0.05..4 (higher = longer note), but the lane
   *  reads top = LONG, bottom = SHORT, which is how gate reads everywhere in
   *  music — 100 % is a staccato tick at the BOTTOM of the lane, and you push
   *  UP for a longer, ringing note (user: "it actually goes, the gate gets like
   *  a shorter decay time").
   *
   *  This replaces the old `reverse` flag, which inverted the pointer mapping
   *  but left the BAR growing DOWN from the top — so the default 0.6 sat as a
   *  nearly-full-height bar pinned to the ceiling and every edit fought the
   *  axis. Inverting only the axis (draw position) and not the storage is what
   *  makes both the bar and its number agree. */
  reverse?: boolean;
  format: (v: number) => string;
  onChange: (v: number[]) => void;
  /** This lane's dice, rendered in the label column. */
  dice?: React.ReactNode;
  /** Extra control in the label column (the transpose lane's scale snap). */
  headerExtra?: React.ReactNode;
}

/** 16-step paint-drag bar lane. Right-click / Alt-click resets a step. */
function Lane({ label, unit, values, head, min, max, def, bipolar, integer, reverse, format, onChange, dice, headerExtra }: LaneProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const vals = Array.from({ length: 16 }, (_, i) => (typeof values[i] === 'number' ? values[i] : def));

  const apply = (e: React.PointerEvent, reset: boolean) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const i = Math.max(0, Math.min(15, Math.floor(((e.clientX - rect.left) / rect.width) * 16)));
    // `reverse` flips where the pointer maps to, so painting near the TOP of a
    // reversed lane gives the value the user reads as HIGH at the top. The
    // stored value is still the underlying one.
    const raw = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const fy = reverse ? 1 - raw : raw;
    let v = reset ? def : min + fy * (max - min);
    if (!reset) {
      if (integer) v = Math.round(v);
      else v = Math.round(v * 20) / 20;
      v = Math.max(min, Math.min(max, v));
    }
    if (vals[i] === v) return;
    const next = vals.slice();
    next[i] = v;
    onChange(next);
  };

  return (
    <div className="arpv-lane">
      <div className="arpv-lane-label">
        <span className="arpv-lane-name">{label}<em>{unit}</em></span>
        {dice}
        {headerExtra}
      </div>
      <div ref={ref} className={`arpv-lane-bars ${bipolar ? 'is-bipolar' : ''}`}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = true;
          apply(e, e.altKey || e.button === 2);
        }}
        onPointerMove={(e) => { if (drag.current) apply(e, e.altKey); }}
        onPointerUp={(e) => { drag.current = false; try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* not captured */ } }}
        onPointerCancel={() => { drag.current = false; }}
        onContextMenu={(e) => e.preventDefault()}>
        {vals.map((v, i) => {
          const frac = (v - min) / (max - min);
          // Bars grow from the BOTTOM, always — including on a reversed lane.
          //
          // The old `reverse` handling grew the bar DOWNWARD from the top, which
          // is why the gate lane "defaulted at the top of the thing": its bar
          // filled the whole column from the ceiling regardless of value, so the
          // lane read as pinned-high at 60 % and any edit fought the axis. A
          // reversed lane now uses the INVERSE fraction for its height, so the
          // bottom of the lane is 0 % (a staccato tick, drawn 2 px) and the top
          // is 400 % (a long ringing note, drawn full height) — with `format`
          // inverting the number to match, so bar and number always agree.
          const draw = reverse ? 1 - frac : frac;
          const style: React.CSSProperties = bipolar
            ? (v >= 0
              ? { bottom: '50%', height: `${Math.max(0, (v / max) * 50)}%` }
              : { top: '50%', height: `${Math.max(0, (v / min) * 50)}%` })
            : { bottom: 0, height: `${Math.max(2, draw * 100)}%` };
          return (
            <div key={i} className={`arpv-step ${i === head ? 'is-head' : ''} ${i % 4 === 0 ? 'is-beat' : ''}`}>
              <div className="arpv-bar" style={style} />
              <span className="arpv-step-val">{format(v)}</span>
            </div>
          );
        })}
        {bipolar && <div className="arpv-zero" aria-hidden="true" />}
      </div>
    </div>
  );
}
