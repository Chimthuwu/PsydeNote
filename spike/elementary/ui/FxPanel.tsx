// Master-bus FX (todo.md §79/§86/§89/§92/§113). Effects SIDE BY SIDE in a
// 2-wide grid (user: "cram like 8 audio fx into this space") — each effect is
// a "Sonic Material" physics canvas (<FxViz>) + a knob rack
// rack of the real OSC-card knobs. Occupies the OSC-panel slot.
//
// §113: the chain is now reorderable (`fx.chain`, an ordered slot-type
// list) rather than hardcoded delay-then-reverb — units render in chain
// order and each carries ◀/▶ buttons that swap it with its neighbour in
// that order. Only 2 real effect types exist yet ('off' fills the other 6
// slots), so today this lets Distortion/Reverb/Delay be reordered —
// but the mechanism generalizes to N effects without changing shape.
import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EqBand, EqFxSettings, FxSettings, FxChainSlotType } from '../../../src/shared/types';
import { Knob } from '../../../src/renderer/components/Knob';
import { FxViz } from './FxViz';
import { EqEditorPopout, EqEditorStage } from './EqEditor';

const DELAY_COLOR = '#7c9cff';
const REVERB_COLOR = '#4fd1c5';
const DISTORTION_COLOR = '#f59e0b';
const CHORUS_COLOR = '#e879f9';
const FLANGER_COLOR = '#facc15';
const COMPRESSOR_COLOR = '#ec4899';
const PHASER_COLOR = '#a78bfa';
const EQ_COLOR = '#f5f5f5';

interface Props {
  fx: FxSettings;
  onChange: (patch: { fx: FxSettings }) => void;
  /** 0..1 fallback level for the canvas (prefers the live post-FX scope). */
  level?: number;
  /** Bumped on every note-on — the canvas fires a reflection burst. */
  trigger?: number;
}

type RealFxType = Exclude<FxChainSlotType, 'off'> | 'chorus' | 'flanger' | 'phaser' | 'eq';

/** The drag-to-reorder plumbing `FxPanel` owns and hands to each `FxUnit`.
 *  Split out as an interface so `FxUnit` stays a presentational container and
 *  every gesture stays in one place (the component that owns `fx.chain`). */
interface FxUnitDrag {
  /** This unit is the one being dragged — dim it. */
  isDragging: (type: RealFxType) => boolean;
  /** A drop would land on this unit. */
  isDropTarget: (type: RealFxType) => boolean;
  onHeadPointerDown: (e: React.PointerEvent, type: RealFxType) => void;
  onHeadPointerMove: (e: React.PointerEvent) => void;
  onHeadPointerUp: (e: React.PointerEvent) => void;
  /** Swallows the click a completed drag's pointerup synthesises. */
  onHeadClick: (e: React.MouseEvent) => void;
}

/** The chain's real (non-'off') entries, in order — what actually renders. */
function realOrder(chain: FxChainSlotType[]): RealFxType[] {
  return chain.filter((t): t is RealFxType => t !== 'off');
}

/** Swap `order[i]` with its `dir` neighbour and rebuild a full NUM_FX_SLOTS
 *  chain from the result ('off' pads the rest — those slots carry no data
 *  worth preserving positionally). */
function reordered(chain: FxChainSlotType[], type: RealFxType, dir: -1 | 1): FxChainSlotType[] {
  const order = realOrder(chain);
  const i = order.indexOf(type);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return chain;
  [order[i], order[j]] = [order[j], order[i]];
  return Array.from({ length: chain.length }, (_, k) => order[k] ?? 'off');
}

/** Move `type` so it sits at position `toIndex` of the real (non-'off') order
 *  — what a drag-and-drop in the FX chain strip does. */
function movedTo(chain: FxChainSlotType[], type: RealFxType, toIndex: number): FxChainSlotType[] {
  const order = realOrder(chain);
  const from = order.indexOf(type);
  if (from < 0 || toIndex < 0 || toIndex >= order.length || from === toIndex) return chain;
  order.splice(from, 1);
  order.splice(toIndex, 0, type);
  return Array.from({ length: chain.length }, (_, k) => order[k] ?? 'off');
}

// ---------------------------------------------------------------------------
// "FX default mix on enable" (todo.md 2026-10-10 pending batch): 25 % for every
// effect, 20 % for the compressor — its upward boost is far louder than the dry
// path, so it needs less wet to be heard (see FxViz's mixWarnColor).
//
// Why this exists at all: EVERY effect's stored default is `mix: 0`
// (types.ts), and each `applyXSlot` in dsp/synth.js early-returns on
// `(mix ?? 0) <= 1e-4` — so the unit is not even built into the graph.
// Inserting an effect therefore produced NO audible change whatsoever until you
// found and raised its Mix knob. Inserting is an explicit "I want this effect"
// action, so it now arrives audible.
//
// Only applied when the effect has never been dialled in (mix still 0), so
// re-inserting an effect whose settings came back from an older patch keeps
// that patch's own mix instead of being stomped to 25 %.
const ENABLE_MIX_DEFAULT = 0.25;
const ENABLE_MIX: Partial<Record<RealFxType, number>> = { compressor: 0.2 };

/** The settings object an effect should have the moment it enters the chain. */
function enabledSlotSettings(fx: FxSettings, type: RealFxType): Record<string, unknown> {
  const cur = (fx[type] ?? {}) as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = { enabled: true };
  const mix = typeof cur.mix === 'number' ? cur.mix : 0;
  if (mix <= 1e-4) {
    patch.mix = ENABLE_MIX[type] ?? ENABLE_MIX_DEFAULT;
    // The compressor's requested enable state sets its envelope too: attack 0
    // (already the stored default) and an 880 ms release per band.
    if (type === 'compressor') {
      patch.lowAttackMs = 0; patch.midAttackMs = 0; patch.highAttackMs = 0;
      patch.lowReleaseMs = 880; patch.midReleaseMs = 880; patch.highReleaseMs = 880;
    }
  }
  return { ...cur, ...patch };
}

const T_MIN = 1;
const T_MAX = 2000;
const timeToPos = (ms: number) => Math.log(Math.max(T_MIN, Math.min(T_MAX, ms)) / T_MIN) / Math.log(T_MAX / T_MIN);
const posToTime = (p: number) => T_MIN * Math.pow(T_MAX / T_MIN, Math.max(0, Math.min(1, p)));
const fmtTime = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
const R_MIN = 0.05;
const R_MAX = 5;
const rateToPos = (v: number) => Math.log(Math.max(R_MIN, Math.min(R_MAX, v)) / R_MIN) / Math.log(R_MAX / R_MIN);
const posToRate = (p: number) => R_MIN * Math.pow(R_MAX / R_MIN, Math.max(0, Math.min(1, p)));

const LOW_MIN = 100;
const LOW_MAX = 800;
const lowToPos = (hzVal: number) => (Math.max(LOW_MIN, Math.min(LOW_MAX, hzVal)) - LOW_MIN) / (LOW_MAX - LOW_MIN);
const posToLow = (p: number) => LOW_MIN + Math.max(0, Math.min(1, p)) * (LOW_MAX - LOW_MIN);

const HIGH_MIN = 1000;
const HIGH_MAX = 10000;
const highToPos = (hzVal: number) => Math.log(Math.max(HIGH_MIN, Math.min(HIGH_MAX, hzVal)) / HIGH_MIN) / Math.log(HIGH_MAX / HIGH_MIN);
const posToHigh = (p: number) => HIGH_MIN * Math.pow(HIGH_MAX / HIGH_MIN, Math.max(0, Math.min(1, p)));

const ATTACK_MIN = 1;
const ATTACK_MAX = 100;
const attackToPos = (ms: number) => Math.log(Math.max(ATTACK_MIN, Math.min(ATTACK_MAX, ms)) / ATTACK_MIN) / Math.log(ATTACK_MAX / ATTACK_MIN);
const posToAttack = (p: number) => ATTACK_MIN * Math.pow(ATTACK_MAX / ATTACK_MIN, Math.max(0, Math.min(1, p)));

const REL_MIN = 20;
const REL_MAX = 1000;
const releaseToPos = (ms: number) => Math.log(Math.max(REL_MIN, Math.min(REL_MAX, ms)) / REL_MIN) / Math.log(REL_MAX / REL_MIN);
const posToRelease = (p: number) => REL_MIN * Math.pow(REL_MAX / REL_MIN, Math.max(0, Math.min(1, p)));

const pct = (v: number) => `${Math.round(v * 100)}`;
const hz = (v: number) => `${v.toFixed(2)}`;

export function FxPanel({ fx, onChange, level = 0, trigger = 0 }: Props) {
  const [eqPopoutOpen, setEqPopoutOpen] = useState(false);
  const [insertMenu, setInsertMenu] = useState<{ x: number; y: number } | null>(null);
  const setSlot = useCallback(
    (which: RealFxType, patch: Record<string, number | boolean | EqBand[]>) => {
      onChange({ fx: { ...fx, [which]: { ...fx[which], ...patch, enabled: patch.enabled !== undefined ? patch.enabled : true } } });
    },
    [fx, onChange],
  );
  const move = useCallback(
    (type: RealFxType, dir: -1 | 1) => onChange({ fx: { ...fx, chain: reordered(fx.chain, type, dir) } }),
    [fx, onChange],
  );

  const order = useMemo(() => realOrder(fx.chain), [fx.chain]);
  const availableTypes = useMemo(
    () => ALL_FX_TYPES.filter((type) => !order.includes(type)),
    [order],
  );

  // ---- Drag-to-reorder the units (todo.md 2026-10-10) --------------------
  // Deliberately the SAME interaction `FxChainStrip` already ships for its
  // rows, lifted onto the grid's cards rather than reinvented: both read the
  // one `fx.chain`, so a reorder here is a reorder there. Pointer events +
  // setPointerCapture, NOT HTML5 drag-and-drop — the cable drag, the knobs and
  // the EQ canvas are all pointer-based, and HTML5 DnD does not survive the
  // WebView2 reparenting the plugin does.
  //
  // The drag starts from the unit's HEADER, never the card: the body is a
  // canvas plus a knob rack, and a pointerdown there belongs to the control.
  // Inside the header, the controls keep their own pointer behaviour (the
  // enable dot, the MIX slider, the EQ popout, the reorder arrows) — only the
  // empty space and the name are drag handles.
  const [dragType, setDragType] = useState<RealFxType | null>(null);
  const [overType, setOverType] = useState<RealFxType | null>(null);
  const press = useRef<{ type: RealFxType; x: number; y: number; moved: boolean } | null>(null);
  // Swallow the click that follows a completed drag (same trick as the strip).
  // Cleared on the NEXT press rather than on consumption, so a gesture whose
  // click never arrives (pointer captured elsewhere, window lost focus) can't
  // leave a flag armed to eat a later, legitimate click.
  const suppressClick = useRef(false);
  /** Which unit is under the pointer, by hit-test — not by pointer capture,
   *  which keeps delivering moves to the element the drag started on. */
  const unitAt = (x: number, y: number): RealFxType | null => {
    const el = document.elementFromPoint(x, y)?.closest('[data-fx-unit]') as HTMLElement | null;
    const t = el?.dataset.fxUnit as RealFxType | undefined;
    return t && order.includes(t) ? t : null;
  };
  const onUnitHeadPointerDown = (e: React.PointerEvent, type: RealFxType) => {
    suppressClick.current = false;
    if (e.button !== 0 || !order.includes(type)) return;
    // Header controls keep their own clicks — never steal them into a drag.
    if ((e.target as HTMLElement).closest('button, input, .fx-unit-reorder')) return;
    press.current = { type, x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onUnitHeadPointerMove = (e: React.PointerEvent) => {
    const pr = press.current;
    if (!pr) return;
    if (!pr.moved && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) < 5) return;
    if (!pr.moved) { pr.moved = true; setDragType(pr.type); }
    setOverType(unitAt(e.clientX, e.clientY));
  };
  const onUnitHeadPointerUp = (e: React.PointerEvent) => {
    const pr = press.current;
    press.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (pr?.moved) {
      suppressClick.current = true; // swallow the click that follows a drag
      const target = unitAt(e.clientX, e.clientY);
      if (target && target !== pr.type) {
        onChange({ fx: { ...fx, chain: movedTo(fx.chain, pr.type, order.indexOf(target)) } });
      }
    }
    setDragType(null);
    setOverType(null);
  };
  const onUnitHeadClick = (e: React.MouseEvent) => {
    if (!suppressClick.current) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const unitDrag: FxUnitDrag = {
    isDragging: (type) => dragType === type,
    isDropTarget: (type) => dragType !== null && overType === type && dragType !== type,
    onHeadPointerDown: onUnitHeadPointerDown,
    onHeadPointerMove: onUnitHeadPointerMove,
    onHeadPointerUp: onUnitHeadPointerUp,
    onHeadClick: onUnitHeadClick,
  };
  const insertFx = useCallback((type: RealFxType) => {
    const slot = fx.chain.indexOf('off');
    if (slot < 0) return;
    const chain = fx.chain.slice();
    chain[slot] = type;
    // Inserting an effect is an explicit enable action, even if its settings
    // were previously bypassed from an older patch — and it arrives with an
    // audible mix (enabledSlotSettings).
    const nextFx = {
      ...fx,
      chain,
      [type]: enabledSlotSettings(fx, type),
    } as FxSettings;
    onChange({ fx: nextFx });
    setInsertMenu(null);
  }, [fx, onChange]);
  const openInsertMenuAt = useCallback((clientX: number, clientY: number) => {
    const menuWidth = 190;
    const menuHeight = 42 + availableTypes.length * 27;
    setInsertMenu({
      x: Math.min(clientX, Math.max(6, window.innerWidth - menuWidth - 6)),
      y: Math.min(clientY, Math.max(6, window.innerHeight - menuHeight - 6)),
    });
  }, [availableTypes.length]);
  const openInsertMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openInsertMenuAt(e.clientX, e.clientY);
  }, [openInsertMenuAt]);

  const units: Record<RealFxType, JSX.Element> = {
    delay: (
      <FxUnit
        key="delay"
        name="Delay"
        color={DELAY_COLOR}
        kind="delay"
        params={fx.delay}
        onChange={(p) => setSlot('delay', p)}
        level={level}
        trigger={trigger}
        canMoveLeft={order.indexOf('delay') > 0}
        canMoveRight={order.indexOf('delay') < order.length - 1}
        onMove={(dir) => move('delay', dir)}
      drag={unitDrag}
        knobs={[]}
        headerExtra={
          <div className="fx-header-mix-slider" title="Mix level (0-100%)">
            <span className="fx-header-mix-label">MIX</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={fx.delay.mix ?? 0}
              onChange={(e) => setSlot('delay', { mix: parseFloat(e.target.value) })}
            />
            <span className="fx-header-mix-val">{Math.round((fx.delay.mix ?? 0) * 100)}%</span>
          </div>
        }
      />
    ),
    reverb: (
      <FxUnit
        key="reverb"
        name="Reverb"
        color={REVERB_COLOR}
        kind="reverb"
        params={fx.reverb}
        onChange={(p) => setSlot('reverb', p)}
        level={level}
        trigger={trigger}
        canMoveLeft={order.indexOf('reverb') > 0}
        canMoveRight={order.indexOf('reverb') < order.length - 1}
        onMove={(dir) => move('reverb', dir)}
      drag={unitDrag}
        knobs={[]}
        headerExtra={
          <div className="fx-header-mix-slider" title="Mix level (0-100%)">
            <span className="fx-header-mix-label">MIX</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={fx.reverb.mix ?? 0}
              onChange={(e) => setSlot('reverb', { mix: parseFloat(e.target.value) })}
            />
            <span className="fx-header-mix-val">{Math.round((fx.reverb.mix ?? 0) * 100)}%</span>
          </div>
        }
      />
    ),
    distortion: (
      <FxUnit
        key="distortion"
        name="Distortion"
        color={DISTORTION_COLOR}
        kind="distortion"
        params={fx.distortion}
        onChange={(p) => setSlot('distortion', p)}
        level={level}
        trigger={trigger}
        canMoveLeft={order.indexOf('distortion') > 0}
        canMoveRight={order.indexOf('distortion') < order.length - 1}
        onMove={(dir) => move('distortion', dir)}
      drag={unitDrag}
        knobs={[]}
        headerExtra={
          <div className="fx-header-mix-slider" title="Mix level (0-100%)">
            <span className="fx-header-mix-label">MIX</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={fx.distortion.mix ?? 0}
              onChange={(e) => setSlot('distortion', { mix: parseFloat(e.target.value) })}
            />
            <span className="fx-header-mix-val">{Math.round((fx.distortion.mix ?? 0) * 100)}%</span>
          </div>
        }
      />
    ),
    chorus: (
      <FxUnit
        key="chorus"
        name="Chorus"
        color={CHORUS_COLOR}
        kind="chorus"
        params={fx.chorus}
        onChange={(p) => setSlot('chorus', p)}
        level={level}
        trigger={trigger}
        canMoveLeft={order.indexOf('chorus') > 0}
        canMoveRight={order.indexOf('chorus') < order.length - 1}
        onMove={(dir) => move('chorus', dir)}
      drag={unitDrag}
        knobs={[]}
        headerExtra={
          <div className="fx-header-mix-slider" title="Mix level (0-100%)">
            <span className="fx-header-mix-label">MIX</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={fx.chorus.mix ?? 0}
              onChange={(e) => setSlot('chorus', { mix: parseFloat(e.target.value) })}
            />
            <span className="fx-header-mix-val">{Math.round((fx.chorus.mix ?? 0) * 100)}%</span>
          </div>
        }
      />
    ),
    flanger: (
      <FxUnit
        key="flanger"
        name="Flanger"
        color={FLANGER_COLOR}
        kind="flanger"
        params={fx.flanger}
        onChange={(p) => setSlot('flanger', p)}
        level={level}
        trigger={trigger}
        canMoveLeft={order.indexOf('flanger') > 0}
        canMoveRight={order.indexOf('flanger') < order.length - 1}
        onMove={(dir) => move('flanger', dir)}
      drag={unitDrag}
        knobs={[]}
        headerExtra={
          <div className="fx-header-mix-slider" title="Mix level (0-100%)">
            <span className="fx-header-mix-label">MIX</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={fx.flanger.mix ?? 0}
              onChange={(e) => setSlot('flanger', { mix: parseFloat(e.target.value) })}
            />
            <span className="fx-header-mix-val">{Math.round((fx.flanger.mix ?? 0) * 100)}%</span>
          </div>
        }
      />
    ),
    compressor: (
      <CompressorUnit
        key="compressor"
        fx={fx}
        setSlot={setSlot}
        level={level}
        trigger={trigger}
        canMoveLeft={order.indexOf('compressor') > 0}
        canMoveRight={order.indexOf('compressor') < order.length - 1}
        move={move}
        drag={unitDrag}
      />
    ),
    phaser: (
      <FxUnit
        key="phaser"
        name="Phaser"
        color={PHASER_COLOR}
        kind="phaser"
        params={fx.phaser}
        onChange={(p) => setSlot('phaser', p)}
        level={level}
        trigger={trigger}
        canMoveLeft={order.indexOf('phaser') > 0}
        canMoveRight={order.indexOf('phaser') < order.length - 1}
        onMove={(dir) => move('phaser', dir)}
      drag={unitDrag}
        knobs={[]}
        headerExtra={
          <div className="fx-header-mix-slider" title="Mix level (0-100%)">
            <span className="fx-header-mix-label">MIX</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={fx.phaser.mix ?? 0}
              onChange={(e) => setSlot('phaser', { mix: parseFloat(e.target.value) })}
            />
            <span className="fx-header-mix-val">{Math.round((fx.phaser.mix ?? 0) * 100)}%</span>
          </div>
        }
      />
    ),
    // EQ has no knobs at all (todo.md — user: "the goal is not to have any
    // knobs at all, just let it be controllable in the graphic pane") — the
    // whole unit is `renderStage`'s graphic point editor, plus a "pop out"
    // header button opening the same editor larger (`EqEditorPopout`,
    // mirroring the LFO Function editor's modal in EnvelopePanel.tsx).
    eq: (
      <FxUnit
        key="eq"
        name="EQ"
        color={EQ_COLOR}
        kind="eq"
        params={fx.eq}
        onChange={(p) => setSlot('eq', p)}
        level={level}
        trigger={trigger}
        canMoveLeft={order.indexOf('eq') > 0}
        canMoveRight={order.indexOf('eq') < order.length - 1}
        onMove={(dir) => move('eq', dir)}
      drag={unitDrag}
        knobs={[]}
        renderStage={() => (
          <EqEditorStage bands={fx.eq.bands} onChange={(bands) => setSlot('eq', { bands })} color={EQ_COLOR} />
        )}
        headerExtra={
          <button type="button" className="fx-unit-popout" onClick={() => setEqPopoutOpen(true)}
            title="Open the EQ editor larger" aria-label="Open the EQ editor larger">⤢</button>
        }
      />
    ),
  };

  return (
    <>
      <section
        className={`op-panel fx-panel fx-density-${Math.min(8, Math.max(0, order.length))}`}
        aria-label="Master effects"
      >
        {order.map((type) => units[type])}
        {availableTypes.length > 0 && (
          <div
            className={`fx-insert-prompt ${order.length % 2 === 1 ? 'is-half' : ''}`}
            role="button"
            tabIndex={0}
            onContextMenu={openInsertMenu}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              openInsertMenuAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                openInsertMenuAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
              }
            }}
          >
            + Click to add FX
          </div>
        )}
      </section>
      {insertMenu && createPortal(
        <>
          <div
            className="faze-scope-menu-scrim"
            onPointerDown={() => setInsertMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setInsertMenu(null); }}
          />
          <ul className="fx-insert-menu" style={{ left: insertMenu.x, top: insertMenu.y }}>
            <li className="fx-insert-menu-head">Insert audio FX</li>
            {availableTypes.map((type) => {
              const meta = FX_TYPE_META[type];
              return (
                <li key={type}>
                  <button type="button" onClick={() => insertFx(type)}>
                    <span className="fx-insert-menu-dot" style={{ background: meta.color }} />
                    {meta.name}
                  </button>
                </li>
              );
            })}
          </ul>
        </>,
        document.body,
      )}
      {eqPopoutOpen && (
        <EqEditorPopout
          bands={fx.eq.bands}
          onChange={(bands) => setSlot('eq', { bands })}
          onClose={() => setEqPopoutOpen(false)}
          color={EQ_COLOR}
        />
      )}
    </>
  );
}

interface KnobSpec {
  label: string; value: number; max: number;
  onChange: (v: number) => void; format: (v: number) => string; color?: string;
}
const k = (
  label: string, value: number, max: number,
  onChange: (v: number) => void, format: (v: number) => string, color?: string,
): KnobSpec => ({ label, value, max, onChange, format, color });

/** Compressor container colour = a loudness warning. The wet path can be far
 *  louder than the dry (mix is effectively a volume boost), so the unit shows
 *  white at low mix and warms through yellow and orange to blood red at full
 *  mix, as a visual cue before it hurts. */
const MIX_WARN_STOPS: [number, [number, number, number]][] = [
  [0, [255, 255, 255]],     // white
  [0.3, [250, 204, 21]],    // yellow
  [0.6, [251, 146, 60]],    // orange
  [0.85, [239, 68, 68]],    // red
  [1, [153, 27, 27]],       // blood red
];
export function mixWarnColor(mix: number): string {
  const m = Math.max(0, Math.min(1, mix));
  for (let i = 0; i < MIX_WARN_STOPS.length - 1; i += 1) {
    const [a, ca] = MIX_WARN_STOPS[i];
    const [b, cb] = MIX_WARN_STOPS[i + 1];
    if (m <= b) {
      const t = (m - a) / (b - a || 1);
      return `rgb(${ca.map((c, k) => Math.round(c + (cb[k] - c) * t)).join(',')})`;
    }
  }
  return 'rgb(153,27,27)';
}

function CompressorUnit({
  fx,
  setSlot,
  level,
  trigger,
  canMoveLeft,
  canMoveRight,
  move,
  drag,
}: {
  fx: FxSettings;
  setSlot: (which: 'compressor', patch: Record<string, any>) => void;
  level: number;
  trigger: number;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  move: (type: RealFxType, dir: -1 | 1) => void;
  drag: FxUnitDrag;
}) {
  const comp = fx.compressor;

  // Global attack and release logic (mapping to all three bands)
  const attackVal = comp.lowAttackMs ?? 10;
  const releaseVal = comp.lowReleaseMs ?? 120;
  const handleAttackChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setSlot('compressor', { lowAttackMs: val, midAttackMs: val, highAttackMs: val });
  };
  const handleReleaseChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setSlot('compressor', { lowReleaseMs: val, midReleaseMs: val, highReleaseMs: val });
  };

  return (
    <FxUnit
      key="compressor"
      name="Compressor"
      color={mixWarnColor(comp.mix ?? 0)}
      kind="compressor"
      params={comp}
      onChange={(p) => setSlot('compressor', p)}
      level={level}
      trigger={trigger}
      canMoveLeft={canMoveLeft}
      canMoveRight={canMoveRight}
      onMove={(dir) => move('compressor', dir)}
      drag={drag}
      knobs={[]}
      headerExtra={
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Global Attack Slider */}
          <div className="fx-header-mix-slider" title="Global Attack (ms)">
            <span className="fx-header-mix-label">ATK</span>
            <input
              type="range"
              min={0}
              max={300}
              step={1}
              value={attackVal}
              onChange={handleAttackChange}
            />
            <span className="fx-header-mix-val">{Math.round(attackVal)}</span>
          </div>
          {/* Global Release Slider */}
          <div className="fx-header-mix-slider" title="Global Release (ms)">
            <span className="fx-header-mix-label">REL</span>
            <input
              type="range"
              min={5}
              max={2000}
              step={5}
              value={releaseVal}
              onChange={handleReleaseChange}
            />
            <span className="fx-header-mix-val">{Math.round(releaseVal)}</span>
          </div>
          {/* Mix Slider */}
          <div className="fx-header-mix-slider" title="Mix level (0-100%)">
            <span className="fx-header-mix-label">MIX</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={comp.mix ?? 0}
              onChange={(e) => setSlot('compressor', { mix: parseFloat(e.target.value) })}
            />
            <span className="fx-header-mix-val">{Math.round((comp.mix ?? 0) * 100)}%</span>
          </div>
        </div>
      }
    />
  );
}

function FxUnit({
  name, color, kind, params, onChange, level, trigger, knobs,
  canMoveLeft, canMoveRight, onMove, renderStage, headerExtra, drag,
}: {
  name: string;
  color: string;
  kind: RealFxType;
  params: FxSettings[RealFxType];
  onChange: (patch: Record<string, number | boolean | EqBand[]>) => void;
  level: number;
  trigger: number;
  knobs: KnobSpec[];
  /** Chain-order reorder controls (todo.md §113) — swap this unit with its
   *  neighbour in `fx.chain`'s real (non-'off') order. */
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onMove: (dir: -1 | 1) => void;
  /** Override the default `.fx-stage` content (the generic FxViz drag
   *  canvas) — EQ's graphic point editor has nothing in common with that
   *  and needs its own interaction entirely. */
  renderStage?: () => React.ReactNode;
  /** Extra header button(s) before the reorder controls — EQ's "pop out". */
  headerExtra?: React.ReactNode;
  /** Drag-to-reorder (todo.md 2026-10-10). Optional so the grid keeps working
   *  if a caller doesn't wire it, mirroring `headerExtra`'s treatment. */
  drag?: FxUnitDrag;
}) {
  const on = params.enabled !== false;
  const dragging = drag?.isDragging(kind) ?? false;
  const dropTarget = drag?.isDropTarget(kind) ?? false;
  return (
    <div
      className={`fx-unit ${on ? 'is-on' : ''}${dragging ? ' is-dragging' : ''}${dropTarget ? ' is-drop-target' : ''}`}
      style={{ '--fx-color': color } as React.CSSProperties}
      data-fx-unit={kind}
    >
      <header
        className="fx-unit-head"
        onPointerDown={drag ? (e) => drag.onHeadPointerDown(e, kind) : undefined}
        onPointerMove={drag?.onHeadPointerMove}
        onPointerUp={drag?.onHeadPointerUp}
        onPointerCancel={drag?.onHeadPointerUp}
        onClick={drag?.onHeadClick}
      >
        <button
          type="button"
          className="fx-unit-dot-toggle"
          data-active={on ? '1' : '0'}
          onClick={() => onChange({ enabled: !on })}
          aria-pressed={on}
          aria-label={`${name} ${on ? 'bypass' : 'enable'}`}
          title={on ? `Bypass ${name}` : `Enable ${name}`}
        >
          <span className="fx-unit-dot" aria-hidden="true" />
        </button>
        <span className="fx-unit-name">{name}</span>
        {headerExtra}
        <span className="fx-unit-reorder">
          <button type="button" disabled={!canMoveLeft} onClick={() => onMove(-1)}
            title="Move earlier in the chain" aria-label={`Move ${name} earlier in the chain`}>◀</button>
          <button type="button" disabled={!canMoveRight} onClick={() => onMove(1)}
            title="Move later in the chain" aria-label={`Move ${name} later in the chain`}>▶</button>
        </span>
      </header>
      <div className="fx-stage">
        {/* `renderStage` is always provided for kind==='eq' (FxPanel's
            `units.eq`) — EQ has its own graphic editor, not the generic
            FxViz drag canvas, so FxViz's types no longer know about it.
            The cast is safe precisely because that call site guarantees
            it, not because FxViz secretly still supports 'eq'. */}
        {renderStage ? renderStage() : (
          <FxViz
            kind={kind as Exclude<RealFxType, 'eq'>}
            params={params as Exclude<FxSettings[RealFxType], EqFxSettings>}
            onChange={onChange}
            level={level}
            trigger={trigger}
          />
        )}
      </div>
      {knobs.length > 0 && (
        <div className="fx-rack">
          {knobs.map((kn) => (
            <Knob
              key={kn.label}
              label={kn.label}
              value={kn.value}
              min={0}
              max={kn.max}
              color={kn.color ?? color}
              size="md"
              onChange={kn.onChange}
              format={kn.format}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const FX_TYPE_META: Record<RealFxType, { name: string; color: string }> = {
  distortion: { name: 'Distortion', color: DISTORTION_COLOR },
  chorus: { name: 'Chorus', color: CHORUS_COLOR },
  flanger: { name: 'Flanger', color: FLANGER_COLOR },
  phaser: { name: 'Phaser', color: PHASER_COLOR },
  eq: { name: 'EQ', color: EQ_COLOR },
  compressor: { name: 'Compressor', color: COMPRESSOR_COLOR },
  delay: { name: 'Delay', color: DELAY_COLOR },
  reverb: { name: 'Reverb', color: REVERB_COLOR },
};
/** Fixed row order for the strip below — independent of chain order, which
 *  is shown via the "N." prefix + reorder buttons instead (matches the
 *  user's own mockup, which names all 8 unconditionally). */
const ALL_FX_TYPES: RealFxType[] = ['distortion', 'chorus', 'flanger', 'phaser', 'eq', 'compressor', 'delay', 'reverb'];

/**
 * Compact "chain at a glance" strip (todo.md — user: "a fx chain module
 * that allows us to see the chain at a glance... [house it] in the empty
 * space on the right hand side of the filters... visible from both the
 * synth view and also the fx view" — reorders swap the actual FxPanel
 * grid's order too, same `fx.chain` both read). All 8 effect types are
 * always listed; the row itself is the on/off switch (click the dot to
 * add/remove it from the chain) — this list IS the "switchable" control
 * the user's own mockup shows, not just a read-only summary. Deeper editing
 * (the actual per-effect knobs) still needs the FX view.
 */
export function FxChainStrip({
  fx,
  onChange,
  view,
  onToggleView,
  anyFxWet,
}: {
  fx: FxSettings;
  onChange: (patch: { fx: FxSettings }) => void;
  /** Current OSC/FX view — drives the relocated toggle button's label
   *  (todo.md — user: "remove [the tab strip], and instead have a single
   *  button inside the FX chain thing on the bottom right. When we are in
   *  SYNTH mode it will say FX and when we in the FX mode it will say
   *  SYNTH"). Optional so this component still works if a caller doesn't
   *  wire view-switching (there's only ever the one, but keeps the props
   *  additive/non-breaking). */
  view?: 'osc' | 'fx';
  onToggleView?: () => void;
  /** Same "something's cooking" indicator the old tab strip's dot showed. */
  anyFxWet?: boolean;
}) {
  const order = realOrder(fx.chain);
  const move = (type: RealFxType, dir: -1 | 1) =>
    onChange({ fx: { ...fx, chain: reordered(fx.chain, type, dir) } });
  // Drag-to-reorder: press an ACTIVE row and drag it onto another active row;
  // it takes that row's place. A plain click (no movement) still toggles.
  const [dragType, setDragType] = useState<RealFxType | null>(null);
  const [overType, setOverType] = useState<RealFxType | null>(null);
  const press = useRef<{ type: RealFxType; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const rowAt = (x: number, y: number): RealFxType | null => {
    const el = document.elementFromPoint(x, y)?.closest('[data-fx-row]') as HTMLElement | null;
    const t = el?.dataset.fxRow as RealFxType | undefined;
    return t && order.includes(t) ? t : null;
  };
  const onRowPointerDown = (e: React.PointerEvent, type: RealFxType) => {
    if (e.button !== 0 || !order.includes(type)) return;
    if ((e.target as HTMLElement).closest('.fx-chain-reorder')) return; // arrow buttons keep working
    press.current = { type, x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onRowPointerMove = (e: React.PointerEvent) => {
    const pr = press.current;
    if (!pr) return;
    if (!pr.moved && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) < 5) return;
    if (!pr.moved) { pr.moved = true; setDragType(pr.type); }
    setOverType(rowAt(e.clientX, e.clientY));
  };
  const onRowPointerUp = (e: React.PointerEvent) => {
    const pr = press.current;
    press.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (pr?.moved) {
      suppressClick.current = true; // swallow the click that follows a drag
      const target = rowAt(e.clientX, e.clientY);
      if (target && target !== pr.type) onChange({ fx: { ...fx, chain: movedTo(fx.chain, pr.type, order.indexOf(target)) } });
    }
    setDragType(null);
    setOverType(null);
  };
  const toggle = (type: RealFxType) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    const isOn = order.includes(type);
    if (isOn) {
      onChange({ fx: { ...fx, chain: fx.chain.map((t) => (t === type ? 'off' : t)) } });
      return;
    }
    const idx = fx.chain.indexOf('off');
    if (idx < 0) return; // all 8 slots already full — shouldn't happen with exactly 8 types
    const chain = fx.chain.slice();
    chain[idx] = type;
    // Switching a type ON here used to touch ONLY the chain. Two bugs followed:
    // `enabled` stayed whatever it was (normalizeSynthSettings' `enabledFor`
    // only falls back to `chain.includes(type)` when `enabled` is not already a
    // boolean, so an effect turned off earlier came back still bypassed), and
    // the mix stayed 0, so the effect was inaudible. Same enable semantics as
    // FxPanel's insert menu now.
    onChange({ fx: { ...fx, chain, [type]: enabledSlotSettings(fx, type) } as FxSettings });
  };
  return (
    <div className="fx-chain-strip" aria-label="FX chain">
      <div className="fx-chain-strip-head">
        <span>FX Chain</span>
        {onToggleView && (
          <button
            type="button"
            className="fx-chain-view-toggle"
            onClick={onToggleView}
            title={view === 'fx' ? 'Back to the Synth view' : 'Open the FX view'}
          >
            {view === 'fx' ? 'Synth' : 'FX'}
            {anyFxWet && view !== 'fx' && <span className="fx-tab-dot" aria-hidden="true" />}
          </button>
        )}
      </div>
      {ALL_FX_TYPES.map((type) => {
        const meta = FX_TYPE_META[type];
        const posIndex = order.indexOf(type);
        const isOn = posIndex >= 0;
        return (
          <div
            key={type}
            className={`fx-chain-row ${isOn ? 'is-on' : ''}${dragType === type ? ' is-dragging' : ''}${dragType && overType === type && dragType !== type ? ' is-drop-target' : ''}`}
            style={{ '--fx-color': meta.color } as React.CSSProperties}
            data-fx-row={type}
            role="button"
            tabIndex={0}
            aria-pressed={isOn}
            title={isOn ? `${meta.name} — drag onto another active effect to reorder · click to remove` : `Add ${meta.name} to the chain`}
            onPointerDown={(e) => onRowPointerDown(e, type)}
            onPointerMove={onRowPointerMove}
            onPointerUp={onRowPointerUp}
            onPointerCancel={onRowPointerUp}
            onClick={() => toggle(type)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(type); } }}
          >
            <span className="fx-chain-toggle" aria-hidden="true">
              <span className="fx-chain-dot" aria-hidden="true" />
            </span>
            <span className="fx-chain-name">{isOn ? `${posIndex + 1}. ${meta.name}` : meta.name}</span>
            {isOn && (
              <span className="fx-chain-reorder">
                <button type="button" disabled={posIndex <= 0}
                  onClick={(e) => { e.stopPropagation(); move(type, -1); }}
                  title="Move earlier in the chain" aria-label={`Move ${meta.name} earlier`}>▲</button>
                <button type="button" disabled={posIndex >= order.length - 1}
                  onClick={(e) => { e.stopPropagation(); move(type, 1); }}
                  title="Move later in the chain" aria-label={`Move ${meta.name} later`}>▼</button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
