import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AdsrEnvelope, FilterSettings, FunctionPoint, FunctionShape, LfoSettings, LfoWave, ModMap, ModSourceId, ModTargetId, ModuleId, ModuleSet, SynthSettings } from '../../shared/types';
import { DEFAULT_AUDIO_FOLLOWER, DEFAULT_MODULE_ENV, EXTRA_ENV_IDS, EXTRA_LFO_IDS, AF_MODULE_IDS, MAX_ADDED_MODULES, defaultModuleLfo, defaultFunctionShape, evaluateFunctionShape, MAX_FUNCTION_POINTS, WAVE_MORPH_SHAPES } from '../../shared/types';
import { ALL_SOURCES, MOD_SOURCES, modGlowFor, moduleSourceId, routedSources } from '../lib/mod-sources';
import { ModBadge, ModPopover } from './ModPopover';
import { useThemeVersion } from '../lib/useThemeVersion';
import { FilterPanel } from './FilterPanel';
import { AddModulatorTile, AudioFollowerCard } from './ModuleCards';

/**
 * Modulator strip — the modulation system's control surface. Lives BELOW
 * the oscillator engine now, full width (todo.md §58 — it used to be a
 * narrow right-hand sidebar, which was both why the synth read as too wide
 * and why the modulator cards had room for a full knob row under every
 * graph). Three columns of stacked pairs — ENV 1/ENV 2, LFO 1/LFO 2,
 * Sample&hold/Keyboard — plus the filter on the far right, sized to match
 * two stacked cards (todo.md §59: "the filter's placement is bad… scale it
 * to the height of two modulator modules stacked").
 *
 * Every card is "hidden by default, only the visualizer visible" (§58): no
 * knob rows. The graph itself IS the control surface —
 *   - ENV 1/2: the four ADSR dots (already existed, Vital-style — drag ↔
 *     time, ↕ curve/level).
 *   - LFO 1/2: drag anywhere on the graph (↕) to morph the shape
 *     continuously sine→triangle→saw→square; the small Hz readout in the
 *     bottom-left corner IS the rate control (drag ↕, double-click to type).
 *   - Sample & hold: same corner rate control, no shape (it's stepped
 *     random, not part of the continuous morph).
 *
 * Each card draws in the source's identity colour so the graph, the mod
 * popover rows and the knob indicator dots all match.
 */
interface Props {
  ampEnv: AdsrEnvelope;
  modEnv: AdsrEnvelope;
  modEnv3: AdsrEnvelope;
  lfo1: LfoSettings;
  lfo2: LfoSettings;
  lfo3: LfoSettings;
  velCurve: number;
  keyCurve: number;
  filterA: FilterSettings;
  filterB: FilterSettings;
  mod: ModMap;
  /** Optional modulators added with the "+" tile (absent key = not added). */
  modules?: ModuleSet;
  /** Live level 0..1 of a scope tap by name (plugin: the Audio Follower meters). */
  afLevel?: (scopeName: string) => number;
  onChange: (patch: Partial<SynthSettings>) => void;
  /** Pigments-style cable routing: pointer-down on an ENV/LFO source dot.
   *  The parent owns the cable overlay + drop hit-testing. Also doubles as
   *  the entry point for click-to-assign — see `useCableDrag` — since a
   *  plain click (no drag) on the same dot is what arms it. */
  onSourceDragStart: (source: ModSourceId, point: { x: number; y: number }) => void;
  /** Which source, if any, is currently armed for click-to-assign (todo.md
   *  §91/92) — lets every dot for that source (overview row + its own card)
   *  show the same "armed" glow. */
  armedSource: ModSourceId | null;
  /** Right-click a source dot -> its active-routes list (todo.md §91/92).
   *  The parent (`PluginApp`) owns the popover itself, alongside the
   *  mod-source overview row in the header — both need this same handler. */
  onSourceContext: (source: ModSourceId, anchor: HTMLElement) => void;
  /** Renders the FX-chain-at-a-glance strip into the space beside Filter A/B
   *  (todo.md — user: "house it in the empty space on the right hand side
   *  of the filters... visible from both the synth view and the fx view").
   *  A render prop (same pattern as `OscillatorPanel`'s `renderVisualizer`)
   *  so this shared component doesn't need to import the plugin-only
   *  FxChainStrip/FxSettings itself. Falls back to a plain placeholder
   *  when omitted (e.g. the Electron path, which has no FX chain concept). */
  renderFxChain?: () => React.ReactNode;
  /** Collapse to headers while another view needs the room (the sequencer's Scale Weights overlay). */
  forceCollapsed?: boolean;
}

/** localStorage key for the collapsed-modulator-section state ('1' = headers only). */
const MOD_COLLAPSED_KEY = 'faze.modCollapsed';

/** Graph x-axis ceiling for the ADSR curve. */
const GRAPH_TIME_MAX = 5;

/** Curve → power exponent. KEEP IN SYNC with synth.ts `curvePower`. */
function curvePower(curve: number): number {
  return Math.pow(2, Math.max(-1, Math.min(1, curve)) * 4);
}
/** Value of one curved segment at normalised time t (0..1), from → to. */
function segmentValue(from: number, to: number, t: number, curve: number): number {
  const p = curvePower(curve);
  return from + (to - from) * Math.pow(Math.max(0, Math.min(1, t)), p);
}
const clampSec = (v: number) => Math.max(0, Math.min(GRAPH_TIME_MAX, v));
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clampCurve = (v: number) => Math.max(-1, Math.min(1, v));

/** One floating modulator window. Drag it by the header; click anywhere in it to bring it to the front. */
function ModPopoutWindow({ title, x, y, z, onMove, onFocus, onClose, children }: {
  title: string; x: number; y: number; z: number;
  onMove: (x: number, y: number) => void; onFocus: () => void; onClose: () => void; children: React.ReactNode;
}) {
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  return (
    <div className="mod-popout" role="dialog" aria-label={`${title} popout`}
      style={{ left: x, top: y, zIndex: z }} onPointerDown={onFocus}>
      <header className="mod-popout-head"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          e.preventDefault(); // POLICY: a drag never starts a text selection (see ui-selection test)
          drag.current = { dx: e.clientX - x, dy: e.clientY - y };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) onMove(Math.max(0, e.clientX - d.dx), Math.max(0, e.clientY - d.dy));
        }}
        onPointerUp={(e) => {
          drag.current = null;
          try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
        }}>
        <span>{title}</span>
        <button type="button" onClick={onClose} aria-label="Close popout" title="Close (Esc)">×</button>
      </header>
      <div className="mod-popout-body">{children}</div>
    </div>
  );
}

export function EnvelopePanel({
  ampEnv,
  modEnv,
  modEnv3,
  lfo1,
  lfo2,
  lfo3,
  velCurve,
  keyCurve,
  filterA,
  filterB,
  mod,
  modules,
  afLevel,
  onChange,
  onSourceDragStart,
  armedSource,
  onSourceContext,
  renderFxChain,
  forceCollapsed = false,
}: Props) {
  const mods: ModuleSet = modules ?? {};
  const cardsRef = useRef<HTMLDivElement | null>(null);
  // Double-clicking a card header while the modulators are minimised opens that card in a floating popout window.
  // Several can be open at once; each can be dragged by its header and brought to the front by clicking it.
  const [popouts, setPopouts] = useState<{ id: string; x: number; y: number; z: number }[]>([]);
  const zTop = useRef(1000);
  const openPopout = (id: string) => setPopouts((prev) => {
    zTop.current += 1;
    if (prev.some((p) => p.id === id)) return prev.map((p) => (p.id === id ? { ...p, z: zTop.current } : p));
    const n = prev.length;
    return [...prev, { id, x: 140 + 28 * (n % 6), y: 110 + 28 * (n % 6), z: zTop.current }];
  });
  const focusPopout = (id: string) => setPopouts((prev) => {
    zTop.current += 1;
    return prev.map((p) => (p.id === id ? { ...p, z: zTop.current } : p));
  });
  const movePopout = (id: string, x: number, y: number) => setPopouts((prev) => prev.map((p) => (p.id === id ? { ...p, x, y } : p)));
  const closePopout = (id: string) => setPopouts((prev) => prev.filter((p) => p.id !== id));
  // Escape closes the front-most popout.
  useEffect(() => {
    if (popouts.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const top = popouts.reduce((a, b) => (b.z > a.z ? b : a));
      closePopout(top.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popouts]);
  const justAdded = useRef<string | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(MOD_COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed((c) => {
    const next = !c;
    try { localStorage.setItem(MOD_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* storage blocked */ }
    return next;
  });
  const routed = routedSources(mod);
  /** A module card shows when it was added OR a route still reads from it
   *  (old patches keep working: their routed ENV/LFO cards reappear). */
  const has = (id: ModuleId) => !!mods[id] || routed.has(moduleSourceId(id));
  /** Add/remove a module. Removing also drops every route fed by it. */
  const setModule = (id: ModuleId, value: ModuleSet[ModuleId] | undefined) => {
    const next: ModuleSet = { ...mods };
    if (value === undefined) {
      delete next[id];
      const src = moduleSourceId(id);
      const cleaned: ModMap = {};
      for (const [target, routes] of Object.entries(mod ?? {})) {
        const kept = (routes ?? []).filter((r) => r.source !== src);
        if (kept.length) cleaned[target as ModTargetId] = kept;
      }
      onChange({ modules: next, mod: cleaned });
    } else {
      if (!(next as Record<string, unknown>)[id]) justAdded.current = id;   // a NEW card: bring it into view
      (next as Record<string, unknown>)[id] = value;
      onChange({ modules: next });
    }
  };
  const remove = (id: ModuleId) => () => setModule(id, undefined);
  const lfoCard = (id: LfoSourceId, title: string, lfo: LfoSettings, set: (l: LfoSettings) => void, rm: () => void) => (
    <LfoEditor title={title} source={id} lfo={lfo} color={MOD_SOURCES[id].color} mod={mod}
      armed={armedSource === id}
      onChange={set} onRemove={rm}
      onModChange={(m) => onChange({ mod: m })}
      onSourceDragStart={onSourceDragStart} onSourceContext={onSourceContext} />
  );
  const envCard = (id: ModSourceId, title: string, env: AdsrEnvelope, set: (e: AdsrEnvelope) => void, rm: () => void) => (
    <EnvelopeEditor title={title} source={id} env={env}
      color={MOD_SOURCES[id].color} armed={armedSource === id}
      onChange={set} onRemove={rm}
      onSourceDragStart={onSourceDragStart} onSourceContext={onSourceContext} />
  );
  // Cards: ENV 1 (permanent), then every ENV instance, Audio Followers, then
  // every LFO instance (the LFO group starts a fresh row). Each type can be
  // added repeatedly up to MODULE_CAPS; the card area scrolls past two rows.
  type Card = { id: string; group: 'env' | 'lfo'; node: React.ReactNode };
  const cards: Card[] = [{
    id: 'env1', group: 'env', node: (
      <EnvelopeEditor title="ENV 1 · Amp" source="env1" env={ampEnv}
        color={MOD_SOURCES.env1.color} armed={armedSource === 'env1'}
        onChange={(e) => onChange({ ampEnv: e })} onSourceDragStart={onSourceDragStart}
        onSourceContext={onSourceContext} />
    ),
  }];
  if (has('env2')) cards.push({ id: 'env2', group: 'env', node: envCard('env2', 'ENV 2 · Mod', modEnv, (e) => onChange({ modEnv: e }), remove('env2')) });
  if (has('env3')) cards.push({ id: 'env3', group: 'env', node: envCard('env3', 'ENV 3 · Mod', modEnv3, (e) => onChange({ modEnv3: e }), remove('env3')) });
  for (const id of EXTRA_ENV_IDS) {
    const e = mods[id];
    if (e) cards.push({ id, group: 'env', node: envCard(id, `ENV ${id.slice(3)} · Mod`, e, (v) => setModule(id, v), remove(id)) });
  }
  for (const id of AF_MODULE_IDS) {
    const af = mods[id];
    if (!af) continue;
    const src = moduleSourceId(id);
    const scope = `af_${src}`;
    cards.push({
      id, group: 'env', node: (
        <AudioFollowerCard af={af} source={src} title={id === 'audioFollower' ? 'Audio Follower' : `Audio Follower ${id.slice(13)}`}
          armed={armedSource === src}
          getLevel={() => afLevel?.(scope) ?? 0}
          onChange={(a) => setModule(id, a)} onRemove={remove(id)}
          onSourceDragStart={onSourceDragStart} onSourceContext={onSourceContext} />
      ),
    });
  }
  if (has('lfo1')) cards.push({ id: 'lfo1', group: 'lfo', node: lfoCard('lfo1', 'LFO 1', lfo1, (l) => onChange({ lfo1: l }), remove('lfo1')) });
  if (has('lfo2')) cards.push({ id: 'lfo2', group: 'lfo', node: lfoCard('lfo2', 'LFO 2', lfo2, (l) => onChange({ lfo2: l }), remove('lfo2')) });
  if (has('lfo3')) cards.push({ id: 'lfo3', group: 'lfo', node: lfoCard('lfo3', 'LFO 3', lfo3, (l) => onChange({ lfo3: l }), remove('lfo3')) });
  for (const id of EXTRA_LFO_IDS) {
    const l = mods[id];
    if (l) cards.push({ id, group: 'lfo', node: lfoCard(id, `LFO ${id.slice(3)}`, l, (v) => setModule(id, v), remove(id)) });
  }
  // "+" menu: one entry per TYPE; it adds the lowest free instance of that type.
  // There is no per-type limit — only a TOTAL of MAX_ADDED_MODULES (the grid has
  // 12 cells: ENV 1 + 10 modulators + this tile), in any mix.
  const freeId = (ids: readonly ModuleId[]) => ids.find((i) => !cards.some((c) => c.id === i));
  const envFree = freeId(['env2', 'env3', ...EXTRA_ENV_IDS]);
  const lfoFree = freeId(['lfo1', 'lfo2', 'lfo3', ...EXTRA_LFO_IDS]);
  const afFree = freeId(AF_MODULE_IDS);
  const added = cards.length - 1;                       // ENV 1 is permanent, not "added"
  const full = added >= MAX_ADDED_MODULES;
  const count = (pfx: string) => cards.filter((c) => c.id.startsWith(pfx)).length;
  const makeFor = (id: ModuleId): ModuleSet[ModuleId] =>
    id === 'env2' || id === 'env3' || id === 'lfo1' || id === 'lfo2' || id === 'lfo3' ? true
      : (AF_MODULE_IDS as readonly string[]).includes(id) ? DEFAULT_AUDIO_FOLLOWER
        : (EXTRA_ENV_IDS as readonly string[]).includes(id) ? DEFAULT_MODULE_ENV
          : defaultModuleLfo(id as (typeof EXTRA_LFO_IDS)[number]);
  const tileOptions = [
    { id: 'env', label: 'Envelope', sub: `${count('env')}`, color: MOD_SOURCES.env2.color, disabled: full || !envFree, target: envFree },
    { id: 'lfo', label: 'LFO', sub: `${count('lfo')}`, color: MOD_SOURCES.lfo1.color, disabled: full || !lfoFree, target: lfoFree },
    { id: 'af', label: 'Audio Follower', sub: `${count('audioFollower')}`, color: MOD_SOURCES.audiofollower.color, disabled: full || !afFree, target: afFree },
  ];
  const menuTitle = `Add modulator · ${added}/${MAX_ADDED_MODULES}`;
  const showTile = tileOptions.some((o) => !o.disabled);
  useEffect(() => {
    const id = justAdded.current;
    if (!id) return;
    justAdded.current = null;
    cardsRef.current?.querySelector(`[data-card="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  const cardTitle = (id: string) => (/^env(d+)$/.test(id) ? 'ENV ' + id.slice(3) : /^lfo(d+)$/.test(id) ? 'LFO ' + id.slice(3) : id.toUpperCase());
  // Cards simply pack left-to-right in a fixed two-row area (12 cells), no forced row breaks.
  // Collapsed: only each card's header row stays (modstrip.css); the freed height goes to the OSC panel.
  return (
    <section className={`env-panel${collapsed || forceCollapsed ? ' is-collapsed' : ''}`} aria-label="Modulators">
      {/* Visible section title, matching "OSCILLATOR ENGINE" above (todo.md
          §99, user mockup: "Has to say 'Modulators' here" — this section
          already had the aria-label but no visible on-screen title). */}
      <header className="op-section-title">Modulators</header>
      {popouts.map((po) => {
        const c = cards.find((x) => x.id === po.id);
        if (!c) return null;
        return createPortal(
          <ModPopoutWindow key={po.id} title={cardTitle(po.id)} x={po.x} y={po.y} z={po.z}
            onMove={(x, y) => movePopout(po.id, x, y)} onFocus={() => focusPopout(po.id)} onClose={() => closePopout(po.id)}>
            {c.node}
          </ModPopoutWindow>,
          document.body,
        );
      })}
      <div className="mod-strip-bar">
        <button
          type="button"
          className="mod-collapse-btn"
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand the modulator section' : 'Collapse the modulators to their headers (more room for the oscillators)'}
          onClick={toggleCollapsed}
        >
          <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span>Mods</span>
        </button>
      </div>
      {/* 3-wide grid, every cell the same box. 9 cards (todo.md §88.A —
          S&H + Random retired): ENV 1/2/3, LFO 1/2/3, Keyboard, Filter A/B. */}
      <div className="env-grid">
        <div className="env-cards" ref={cardsRef}>
          {cards.map((c) => (
            <div key={c.id} data-card={c.id} className="env-extra"
              onDoubleClick={collapsed || forceCollapsed ? () => openPopout(c.id) : undefined}
              title={collapsed || forceCollapsed ? 'Double-click to open this modulator in a popout' : undefined}>{c.node}</div>
          ))}
          {showTile && (
            <div className="env-extra">
              <AddModulatorTile title={menuTitle} options={tileOptions}
                onAdd={(opt) => { const t = tileOptions.find((o) => o.id === opt)?.target; if (t) setModule(t, makeFor(t)); }} />
            </div>
          )}
        </div>
        <div className="env-row-bottom">
          <PerfEditor
            velCurve={velCurve}
            keyCurve={keyCurve}
            onChange={onChange}
            onSourceDragStart={onSourceDragStart}
            armedSource={armedSource}
            onSourceContext={onSourceContext}
          />
          <FilterPanel filterA={filterA} filterB={filterB} mod={mod} onChange={onChange} />
          {renderFxChain ? renderFxChain() : <div className="fx-macro-area" aria-hidden="true" title="FX Chain / Macro Area" />}
        </div>
      </div>
    </section>
  );
}

/** LFO waveform at phase θ (any real; the graph's phase is a free-running
 *  accumulator that wraps at 8π, not 2π), range -1..1 — the 4 periodic
 *  shapes plus sample-hold. sin/asin/square are naturally periodic; the
 *  sawtooth is linear in phase, so it MUST wrap θ into one period itself or
 *  it runs off to ±∞ and drags the trace out of the card (todo.md §65). */
function waveValue(wave: (typeof WAVE_MORPH_SHAPES)[number] | 'sample-hold', phase: number): number {
  const TAU = Math.PI * 2;
  switch (wave) {
    case 'sine':
      return Math.sin(phase);
    case 'triangle':
      return (2 / Math.PI) * Math.asin(Math.sin(phase));
    case 'sawtooth': {
      const wrapped = ((phase % TAU) + TAU) % TAU; // 0..2π regardless of θ
      return (wrapped / Math.PI) - 1; // -1..1
    }
    case 'square':
      return Math.sin(phase) >= 0 ? 1 : -1;
    case 'sample-hold': {
      // Stepped pseudo-random: hold one value per 1/4 cycle of phase so the
      // trace reads as a staircase. The hash is the classic sin-based GLSL
      // noise — deterministic per step, so the scroll animation is stable.
      const step = Math.floor(phase / (Math.PI / 2));
      const h = Math.sin(step * 127.1) * 43758.5453;
      return (h - Math.floor(h)) * 2 - 1;
    }
  }
}

/** LFO rate — log-scaled 0..1 drag position ↔ Hz (0.01–20000, same idea as
 *  the filter's cutoff knob: a linear drag over three-plus decades would be
 *  unusable). Replaces the old Hz/kHz toggle — one continuous control that
 *  auto-formats past 1 kHz instead. */
const LFO_RATE_MIN = 0.01;
const LFO_RATE_MAX = 20000;
function lfoRateToPos(hz: number): number {
  return Math.log(Math.max(LFO_RATE_MIN, Math.min(LFO_RATE_MAX, hz)) / LFO_RATE_MIN) / Math.log(LFO_RATE_MAX / LFO_RATE_MIN);
}
function posToLfoRate(pos: number): number {
  return LFO_RATE_MIN * Math.pow(LFO_RATE_MAX / LFO_RATE_MIN, Math.max(0, Math.min(1, pos)));
}
function formatLfoRate(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)}k` : hz >= 10 ? hz.toFixed(1) : hz.toFixed(2);
}

/**
 * Live LFO diagram — scrolls the waveform at the LFO's actual rate so you
 * can SEE how fast it runs (faster rate = faster scroll). Two cycles are
 * drawn; the phase advances by 2π·rateHz per second via requestAnimationFrame.
 *
 * The graph IS the control surface (todo.md §58 — "modulator controls hidden
 * by default, only their visualizer visible"): a dot sits at dead centre,
 * like a traditional LFO's rate knob — drag it (or anywhere on the canvas)
 * horizontally to change speed. Every LFO is a Function now (there's no more
 * discrete-shape toggle, todo.md — "all LFOs are functions"), so
 * double-clicking opens the Function editor for the shape itself; the one
 * exception is sample-hold, which has no editable shape.
 */
function LfoGraph({
  wave,
  color,
  rateHz,
  rateModTarget,
  functionShape,
  onRateChange,
  onFunctionOpen,
}: {
  wave: LfoWave;
  color: string;
  rateHz: number;
  /** Cable-drop target id for the rate corner (LFO cards only). */
  rateModTarget?: string;
  functionShape?: FunctionShape;
  onRateChange: (hz: number) => void;
  onFunctionOpen?: () => void;
}) {
  const themeVersion = useThemeVersion();
  const ref = useRef<HTMLCanvasElement | null>(null);
  const phaseRef = useRef(0);
  const lastRef = useRef<number | null>(null);
  const rateDragRef = useRef<{ startX: number; startRatePos: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const cvs = ref.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    let raf = 0;
    const draw = (now: number) => {
      const last = lastRef.current ?? now;
      lastRef.current = now;
      const dt = (now - last) / 1000;
      // Advance phase by the LFO's live rate. Wrap at a multiple of 2π so
      // the periodic shapes loop seamlessly (saw/square reset at their own
      // natural discontinuity).
      phaseRef.current = (phaseRef.current + dt * rateHz * Math.PI * 2) % (Math.PI * 8);

      const rect = cvs.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      if (w <= 0 || h <= 0) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const W = Math.max(1, Math.floor(w * dpr));
      const H = Math.max(1, Math.floor(h * dpr));
      if (cvs.width !== W || cvs.height !== H) {
        cvs.width = W;
        cvs.height = H;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Read theme tokens off `document.body` (always carries `theme-${theme}`,
      // todo.md §100/§101), not the canvas itself — matches Scope.tsx's fix
      // for the same class of "canvas background stuck on a hardcoded
      // fallback regardless of theme" bug.
      const cs = getComputedStyle(document.body);
      const bg = cs.getPropertyValue('--bg-surface-elevated').trim() || '#0c1133';
      const grid = cs.getPropertyValue('--grid-minor').trim() || 'rgba(120,150,255,0.1)';
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Centre line.
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      const cy = h / 2;
      const amp = h * 0.42;
      const cycles = 2;
      const steps = 96;
      const N = steps * cycles;

      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const x = (i / N) * w;
        const phase = phaseRef.current + (i / steps) * Math.PI * 2;
        const v = wave === 'sample-hold'
          ? waveValue('sample-hold', phase)
          : evaluateFunctionShape(functionShape ?? defaultFunctionShape(), phase / (Math.PI * 2));
        const y = cy - v * amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'round';
      ctx.shadowColor = color;
      ctx.shadowBlur = 4;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Centre-dot rate handle — fixed at dead centre (not tracking the
      // moving trace); brighter while grabbed. Always shown: dragging always
      // changes rate now (shape has its own editor, opened by double-click).
      {
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, dragging ? 4.5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = dragging ? 7 : 3;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // `themeVersion`: this canvas reads the theme's CSS custom properties at
    // paint time, so a theme switch has to force a repaint — see useThemeVersion.
  }, [wave, functionShape, color, rateHz, dragging, themeVersion]);

  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    rateDragRef.current = { startX: e.clientX, startRatePos: lfoRateToPos(rateHz) };
    setDragging(true);
  };
  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = rateDragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    onRateChange(posToLfoRate(d.startRatePos + dx / 260));
  };
  const onCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (rateDragRef.current) {
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
      rateDragRef.current = null;
      setDragging(false);
    }
  };

  return (
    <>
      <canvas
        ref={ref}
        className="lfo-graph-canvas"
        data-allow-2d=""
        style={{ cursor: dragging ? 'grabbing' : 'grab' }}
        title={onFunctionOpen ? 'Drag ↔ to change speed · double-click to edit shape' : 'Drag ↔ to change speed'}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerUp}
        onDoubleClick={(e) => {
          if (onFunctionOpen) { e.preventDefault(); e.stopPropagation(); onFunctionOpen(); }
        }}
      />
      <LfoRateCorner rateHz={rateHz} onChange={onRateChange} modTarget={rateModTarget} />
    </>
  );
}

/** The small draggable/type-in Hz readout in a graph's bottom-left corner —
 *  replaces the old dedicated Rate knob row. */
function LfoRateCorner({ rateHz, onChange, modTarget }: { rateHz: number; onChange: (hz: number) => void; modTarget?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const drag = useRef<{ startY: number; startPos: number } | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (editing || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startPos: lfoRateToPos(rateHz) };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const pos = Math.max(0, Math.min(1, d.startPos + (d.startY - e.clientY) / 160));
    onChange(posToLfoRate(pos));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag.current) {
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
      drag.current = null;
    }
  };
  const openEditor = () => {
    setDraft(rateHz.toFixed(3));
    setEditing(true);
  };
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n)) onChange(Math.max(LFO_RATE_MIN, Math.min(LFO_RATE_MAX, n)));
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="lfo-rate-corner lfo-rate-input"
        type="number"
        step="any"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setEditing(false);
        }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        autoFocus
      />
    );
  }
  return (
    <span
      className="lfo-rate-corner"
      data-mod-target={modTarget}
      title="Rate — drag ↕, Ctrl+double-click to type. Drop an ENV/LFO here to modulate it."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => { if (e.ctrlKey) openEditor(); }}
    >
      {formatLfoRate(rateHz)}
    </span>
  );
}

type LfoSourceId = 'lfo1' | 'lfo2' | 'lfo3' | (typeof EXTRA_LFO_IDS)[number];
function LfoEditor({
  title,
  source,
  lfo,
  color,
  mod,
  armed,
  onChange,
  onModChange,
  onSourceDragStart,
  onSourceContext,
  onRemove,
}: {
  title: string;
  source: LfoSourceId;
  /** Present on optional ("+") modules: shows a × that removes the card. */
  onRemove?: () => void;
  lfo: LfoSettings;
  color: string;
  mod: ModMap;
  armed: boolean;
  onChange: (l: LfoSettings) => void;
  onModChange: (mod: ModMap) => void;
  onSourceDragStart: (source: ModSourceId, point: { x: number; y: number }) => void;
  onSourceContext: (source: ModSourceId, anchor: HTMLElement) => void;
}) {
  const [functionOpen, setFunctionOpen] = useState(false);
  // Every LFO is a Function by default now (todo.md — "all LFOs are
  // functions", no more dedicated toggle button) — S&H is the only other
  // mode, so this just flips between the two.
  const toggleSampleHold = () =>
    onChange({
      ...lfo,
      wave: lfo.wave === 'sample-hold' ? 'function' : 'sample-hold',
      functionShape: lfo.functionShape ?? defaultFunctionShape(),
      perNote: false, // RND only lives in S&H mode — clear it on the way out
    });

  // Rate is itself modulatable (todo.md §66). Self-contained popover state,
  // same pattern as FilterSection.
  // LFO 4/5 (the "+" modules) have no rate mod target yet.
  const canModRate = source === 'lfo1' || source === 'lfo2' || source === 'lfo3';
  const rateTarget = `${source}Rate` as ModTargetId;
  const [modOpen, setModOpen] = useState<ModTargetId | null>(null);
  const anchorRefs = useRef<Partial<Record<ModTargetId, HTMLElement | null>>>({});
  const bindMod = (targetId: ModTargetId) => ({
    targetId,
    routes: mod?.[targetId] ?? [],
  });
  const openMod = (targetId: ModTargetId) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    anchorRefs.current[targetId] = e.currentTarget as HTMLElement;
    setModOpen(targetId);
  };

  return (
    <div className="env-block lfo-block mod-card" style={{ '--src': color } as React.CSSProperties}>
      <div className="env-head">
        <span className="env-title">
          <SourceDot source={source} armed={armed} onSourceDragStart={onSourceDragStart} onSourceContext={onSourceContext} />
          {title}
        </span>
        <span className="lfo-head-mods">
          {/* Just the ∿ badges — the "Rate"/"Shape" text labels were pure
              clutter at this card width (todo.md §88.D). */}
          {canModRate && (
            <span title="Modulate this LFO's rate — drop an ENV/LFO/etc. here">
              <ModBadge {...bindMod(rateTarget)} />
            </span>
          )}
          {/* Open the Function editor from the card header (user: a wrench
              button "on top of the LFOs"). Double-clicking the graph still
              works; this just makes it discoverable. Hidden in S&H mode, which
              has no shape to edit — same guard as `onFunctionOpen` below. */}
          {lfo.wave !== 'sample-hold' && (
            <button
              type="button"
              className="lfo-sh-toggle lfo-edit-btn"
              title="Open the Function editor"
              aria-label="Open the Function editor"
              onClick={() => setFunctionOpen(true)}
            >
              <WrenchIcon />
            </button>
          )}
          <button
            type="button"
            className={`lfo-sh-toggle ${lfo.wave === 'sample-hold' ? 'is-on' : ''}`}
            aria-pressed={lfo.wave === 'sample-hold'}
            title={lfo.wave === 'sample-hold' ? 'Back to a Function' : 'Sample & hold (stepped random)'}
            onClick={toggleSampleHold}
          >
            S&H
          </button>
          {/* Polarity toggle, on the card itself (todo.md — user: "we need
              the polarity control on the LFO outside panel aswell so we can
              toggle it"), not just inside the Function editor's own toolbar. */}
          {lfo.wave !== 'sample-hold' && (
            <button
              type="button"
              className={`lfo-sh-toggle ${lfo.functionShape?.bipolar !== false ? 'is-on' : ''}`}
              aria-pressed={lfo.functionShape?.bipolar !== false}
              title={lfo.functionShape?.bipolar !== false ? 'Bipolar (-1..1) — click for unipolar' : 'Unipolar (0..1) — click for bipolar'}
              onClick={() => {
                const base = lfo.functionShape ?? defaultFunctionShape();
                onChange({ ...lfo, functionShape: { ...base, bipolar: base.bipolar === false } });
              }}
            >
              {lfo.functionShape?.bipolar !== false ? '±' : '+'}
            </button>
          )}
          {/* RND (one value per note) only makes sense in S&H mode and takes
              the Sync slot there — Sync is meaningless for per-note random
              (todo.md §88.D, user). */}
          {lfo.wave === 'sample-hold' ? (
            <button
              type="button"
              className={`lfo-sh-toggle ${lfo.perNote ? 'is-on' : ''}`}
              aria-pressed={lfo.perNote}
              title={lfo.perNote ? 'Rate-clocked S&H' : 'One new random value per note (was the Random source)'}
              onClick={() => onChange({ ...lfo, perNote: !lfo.perNote })}
            >
              RND
            </button>
          ) : (
            <button
              type="button"
              className={`lfo-sh-toggle ${lfo.sync ? 'is-on' : ''}`}
              aria-pressed={lfo.sync}
              title={lfo.sync ? 'Free rate (Hz)' : 'Sync rate to host tempo'}
              onClick={() => onChange({ ...lfo, sync: !lfo.sync })}
            >
              ♪
            </button>
          )}
          {onRemove && (
            <button type="button" className="mod-remove" title="Remove this modulator (also removes its routes)" onClick={onRemove}>×</button>
          )}
        </span>
      </div>

      <div
        className="lfo-graph"
        data-mod-target={canModRate ? rateTarget : undefined}
        onContextMenu={canModRate ? openMod(rateTarget) : undefined}
        style={
          canModRate
            ? ({
                '--mod-glow': modGlowFor(rateTarget, mod?.[rateTarget] ?? [])?.color ?? 'transparent',
                '--mod-glow-amt': modGlowFor(rateTarget, mod?.[rateTarget] ?? [])?.amount ?? 0,
              } as React.CSSProperties)
            : undefined
        }
      >
        <LfoGraph
          wave={lfo.wave}
          color={color}
          rateHz={lfo.rateHz}
          rateModTarget={canModRate ? rateTarget : undefined}
          functionShape={lfo.functionShape}
          onRateChange={(rateHz) => onChange({ ...lfo, rateHz })}
          onFunctionOpen={lfo.wave !== 'sample-hold' ? () => setFunctionOpen(true) : undefined}
        />
      </div>

      {functionOpen && lfo.wave !== 'sample-hold' && (
        <FunctionEditor
          shape={lfo.functionShape ?? defaultFunctionShape()}
          color={color}
          onChange={(functionShape) => onChange({ ...lfo, functionShape })}
          onClose={() => setFunctionOpen(false)}
        />
      )}

      {modOpen && (
        <ModPopover
          targetId={modOpen}
          routes={mod?.[modOpen] ?? []}
          anchorEl={anchorRefs.current[modOpen] ?? null}
          onChange={(routes) => onModChange({ ...(mod ?? {}), [modOpen]: routes })}
          onClose={() => setModOpen(null)}
        />
      )}
    </div>
  );
}

/** Wrench glyph for the "open this modulator's detailed editor" button (user,
 *  2026-10-10: "put a button on top of the LFOs ... like a wrench icon ... this
 *  will enter the LFO editor"). Inline SVG rather than an emoji so it inherits
 *  `currentColor` and stays crisp at the 11px the card header gives it. */
function WrenchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
      <path
        d="M10.6 1.4a4.2 4.2 0 0 0-4 6.9l-4.7 4.7a1.2 1.2 0 0 0 1.7 1.7l4.7-4.7a4.2 4.2 0 0 0 5.2-5.5l-2 2-1.9-.5-.5-1.9 2-2a4.2 4.2 0 0 0-.5-.7z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Which modifier keys are held determines the paint gesture (todo.md — user:
 *  "holding CTRL to enter a step editing mode… perhaps ALT do the same but
 *  for ramp down… shift alt for ramp up… CTRL+ALT paint steps but half as
 *  long"). Checked in this order so Ctrl+Alt (fast steps) doesn't fall
 *  through to plain Alt (ramp down). `null` means no paint gesture — the
 *  normal point/curve edit tools apply instead. */
/** Cursor radius (px) the erase sweep removes points inside. A little wider
 *  than `pointAt`'s 14px click target — a sweep is a coarse gesture. */
const ERASE_RADIUS = 16;

type PaintMode = 'step' | 'rampDown' | 'rampUp';
function paintModeFor(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): PaintMode | null {
  if (e.ctrlKey) return 'step'; // includes Ctrl+Alt — same flat-step shape, just double the columns (see onDown)
  if (e.altKey) return e.shiftKey ? 'rampUp' : 'rampDown';
  return null;
}

/** Replace ONLY column `col`'s span with a fresh step/ramp segment — every
 *  other point stays exactly as it was (todo.md — user: "I just wanted em
 *  to act as modifier keys so we can paint in those shapes, not turn the
 *  whole pattern like that"; the first version sampled+rebuilt the ENTIRE
 *  curve into columns the instant a paint gesture started, converting
 *  everything under Ctrl/Alt on touch alone). Drops any existing points
 *  whose time falls in [t0, t1) — whatever was drawn there, freeform or
 *  from an earlier paint stroke — and inserts two points a hair short of
 *  the next column's start (`EPS`), which is what makes 'step' read as a
 *  flat plateau with a near-vertical edge, rather than the linear ramp a
 *  plain two-point segment would draw — same colocated-time trick
 *  `functionShapeForLegacyWave('square')` uses. No terminal point at time 1
 *  is needed: `evaluateFunctionShape`/dsp's `functionSignal` both hold the
 *  last segment's value out to the wrap, same as every other shape here. */
function paintColumn(points: FunctionPoint[], col: number, cols: number, mode: PaintMode, level: number): FunctionPoint[] {
  const t0 = col / cols;
  const t1 = (col + 1) / cols;
  const eps = Math.min(0.001, 0.25 / cols);
  const floor = -1; // bottom of the internal -1..1 storage range — see functionShapeForLegacyWave
  const kept = points.filter((p) => p.time < t0 || p.time >= t1);
  const a: FunctionPoint = mode === 'rampUp' ? { time: t0, level: floor, curve: 0 } : { time: t0, level, curve: 0 };
  const b: FunctionPoint = mode === 'rampDown' ? { time: t1 - eps, level: floor, curve: 0 } : { time: t1 - eps, level, curve: 0 };
  return [...kept, a, b].sort((x, y) => x.time - y.time);
}

/** Grid X/Y count control — drag ↕ or scroll, no typing (todo.md — user:
 *  "shouldn't have to type"). Same drag-↕/scroll idiom as the mod-amount
 *  rows elsewhere in this file (`ModPopover`'s "drag ↕ or scroll to set the
 *  amount") and `LfoRateCorner` above. No `preventDefault` on wheel — the
 *  plugin UI never scrolls (no-scrollbars rule), so a passive listener is
 *  fine, same precedent as those rows. */
function GridStepper({
  label, value, onChange, title,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  title: string;
}) {
  const drag = useRef<{ startY: number; startVal: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (v: number) => Math.max(1, Math.min(32, Math.round(v)));

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startVal: value };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // ~6px per step — enough range to sweep 1..32 without a huge drag.
    onChange(clamp(d.startVal + (d.startY - e.clientY) / 6));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag.current) {
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
      drag.current = null;
      setDragging(false);
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    onChange(clamp(value + (e.deltaY < 0 ? 1 : -1)));
  };

  return (
    <span
      className={`function-editor-grid-field ${dragging ? 'is-dragging' : ''}`}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      {label} {value}
    </span>
  );
}

/**
 * Pigments-style Function editor. The graph is intentionally a fixed overlay:
 * it can never add a page scrollbar to the synth/plugin surface. Point clicks
 * add breakpoints, right-click deletes (endpoints are protected), point drags
 * edit time/level, and the midpoint handle edits segment tension. Holding
 * Ctrl/Alt/Shift+Alt switches to painting flat steps / decay stabs / rising
 * stabs snapped to the grid instead (todo.md — see `paintModeFor`).
 */
function FunctionEditor({
  shape,
  color,
  onChange,
  onClose,
}: {
  shape: FunctionShape;
  color: string;
  onChange: (shape: FunctionShape) => void;
  onClose: () => void;
}) {
  const themeVersion = useThemeVersion();
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [tool, setTool] = useState<NonNullable<FunctionShape['drawMode']>>(shape.drawMode ?? 'edit');
  const [bipolar, setBipolar] = useState(shape.bipolar !== false);
  const drag = useRef<{ kind: 'point' | 'curve'; index: number; x: number; y: number; shape: FunctionShape } | null>(null);
  // Own working copy of `points`, seeded once at pointerdown and mutated in
  // place per column touched — mirrors `drag`'s snapshot-and-mutate pattern
  // above rather than reading the live `points` prop mid-gesture.
  const paint = useRef<{ mode: PaintMode; cols: number; points: FunctionPoint[]; lastCol: number | null } | null>(null);
  // Modifier + right-drag ERASE (user, 2026-10-10: "if we hold modifier key
  // while dragging holding right click we can quickly remove the points").
  // A plain right-click already deletes the one point under the cursor
  // (`onContext`); this sweeps them away continuously, which is what clearing
  // a densely painted shape actually needs. Working copy seeded at pointerdown
  // and mutated per move, exactly like `paint` above — reading the live
  // `points` prop mid-gesture would lag a fast sweep by a render.
  const erase = useRef<{ points: FunctionPoint[] } | null>(null);
  // Windows fires `contextmenu` on right-button mouse-UP, i.e. AFTER the sweep
  // has already ended and cleared `erase`. Without this flag `onContext` would
  // then delete one more point under the cursor as a parting gift.
  const eraseJustRan = useRef(false);
  // Cursor feedback for the curve/tension handle (todo.md — user: hovering
  // it should show the same up-down cursor as the grid X/Y steppers).
  const [hoverKind, setHoverKind] = useState<'point' | 'curve' | null>(null);
  const points = shape.points;
  const gridX = shape.gridX ?? 8;
  const gridY = shape.gridY ?? 8;
  const geometry = (w: number, h: number) => ({
    x: (t: number) => 12 + t * (w - 24),
    y: (v: number) => 12 + (1 - ((v + 1) / 2)) * (h - 24),
  });

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { x, y } = geometry(rect.width, rect.height);
    const cs = getComputedStyle(document.body);
    ctx.fillStyle = cs.getPropertyValue('--bg-surface-elevated').trim() || '#0c1133';
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.strokeStyle = cs.getPropertyValue('--grid-minor').trim() || 'rgba(120,150,255,0.14)';
    ctx.lineWidth = 1;
    // Adjustable grid (todo.md — user: "see where the beats are hitting…
    // users should be able to determine how many grid lines", capped at 32
    // both axes, default 8x8) — replaces the old fixed 4-row-only grid.
    // While a paint gesture is active, show the grid at ITS actual column
    // resolution instead of the static gridX (todo.md — user: Ctrl+Alt
    // "fast steps" felt "inverted or weird, hard to describe" — the
    // likely cause: Ctrl+Alt paints at double gridX's resolution, but the
    // visible grid never reflected that, so precisely aiming at a fast
    // step's actual (invisible, half-width) column boundary was guesswork —
    // easy to paint the NEIGHBOURING column by mistake and read the result
    // as "backwards"). paint.current is a ref, not a dependency; reading it
    // here is safe because this effect re-runs on every paint step anyway
    // (points changes each time).
    const vCols = paint.current?.cols ?? gridX;
    for (let i = 1; i < vCols; i += 1) {
      const gx = x(i / vCols);
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, rect.height); ctx.stroke();
    }
    for (let i = 1; i < gridY; i += 1) {
      const gy = y(-1 + (2 * i) / gridY);
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(rect.width, gy); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(x(0), y(0)); ctx.lineTo(x(1), y(0)); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x(points[0].time), y(points[0].level));
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]; const b = points[i + 1];
      const curve = Math.max(-1, Math.min(1, a.curve));
      const power = Math.pow(2, curve * 4);
      for (let j = 1; j <= 24; j += 1) {
        const t = j / 24;
        const shaped = Math.pow(t, power);
        ctx.lineTo(x(a.time + (b.time - a.time) * t), y(a.level + (b.level - a.level) * shaped));
      }
      ctx.strokeStyle = color; ctx.lineWidth = 1.7; ctx.shadowColor = color; ctx.shadowBlur = 6; ctx.stroke(); ctx.shadowBlur = 0;
      if (i < points.length - 2) { ctx.beginPath(); ctx.moveTo(x(b.time), y(b.level)); }
    }
    // Redraw the complete trace in one path for joins between segments.
    ctx.beginPath(); ctx.moveTo(x(points[0].time), y(points[0].level));
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]; const b = points[i + 1];
      const power = Math.pow(2, Math.max(-1, Math.min(1, a.curve)) * 4);
      for (let j = 1; j <= 24; j += 1) { const t = j / 24; const q = Math.pow(t, power); ctx.lineTo(x(a.time + (b.time - a.time) * t), y(a.level + (b.level - a.level) * q)); }
    }
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.shadowColor = color; ctx.shadowBlur = 7; ctx.stroke(); ctx.shadowBlur = 0;
    points.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(x(p.time), y(p.level), 5, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = i === 0 || i === points.length - 1 ? 1.5 : 1; ctx.stroke();
      if (i < points.length - 1) {
        const m = (p.time + points[i + 1].time) / 2;
        const power = Math.pow(2, Math.max(-1, Math.min(1, p.curve)) * 4);
        const level = p.level + (points[i + 1].level - p.level) * Math.pow(0.5, power);
        ctx.beginPath(); ctx.moveTo(x(m) - 4, y(level) - 3); ctx.lineTo(x(m), y(level) + 3); ctx.lineTo(x(m) + 4, y(level) - 3); ctx.strokeStyle = color; ctx.stroke();
      }
    });
  }, [points, color, gridX, gridY, themeVersion]);

  const pointAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const { x, y } = geometry(r.width, r.height);
    const px = e.clientX - r.left; const py = e.clientY - r.top;
    let best = -1; let distance = 14;
    points.forEach((p, i) => { const d = Math.hypot(x(p.time) - px, y(p.level) - py); if (d < distance) { distance = d; best = i; } });
    if (best >= 0) return { kind: 'point' as const, index: best };
    let curveIndex = -1; let curveDistance = 12;
    points.slice(0, -1).forEach((p, i) => {
      const n = points[i + 1]; const mx = x((p.time + n.time) / 2); const power = Math.pow(2, Math.max(-1, Math.min(1, p.curve)) * 4); const my = y(p.level + (n.level - p.level) * Math.pow(0.5, power));
      const d = Math.hypot(mx - px, my - py); if (d < curveDistance) { curveDistance = d; curveIndex = i; }
    });
    return curveIndex >= 0 ? { kind: 'curve' as const, index: curveIndex } : null;
  };
  /** Paints (or repaints) whatever column the pointer is over right now, and
   *  every column between it and the last one touched this gesture — a
   *  fast mouse move shouldn't leave gaps, same as a piano-roll paint tool.
   *  Only those columns' points change; everything else in `p.points`
   *  (seeded once at pointerdown, see `onDown`) is left exactly as drawn. */
  const paintAt = (e: React.PointerEvent<HTMLCanvasElement>, r: DOMRect) => {
    const p = paint.current;
    if (!p) return;
    const t = Math.max(0, Math.min(0.9999, (e.clientX - r.left - 12) / Math.max(1, r.width - 24)));
    const col = Math.max(0, Math.min(p.cols - 1, Math.floor(t * p.cols)));
    const level = Math.max(-1, Math.min(1, 1 - ((e.clientY - r.top - 12) / Math.max(1, r.height - 24)) * 2));
    const from = p.lastCol == null ? col : Math.min(p.lastCol, col);
    const to = p.lastCol == null ? col : Math.max(p.lastCol, col);
    for (let c = from; c <= to; c += 1) p.points = paintColumn(p.points, c, p.cols, p.mode, level);
    p.lastCol = col;
    onChange({ ...shape, points: p.points, bipolar });
  };
  /** Remove every INTERIOR point within `ERASE_RADIUS` of the cursor. The two
   *  endpoints are never removed — they define the shape's bounds, and
   *  `functionSignal` needs at least two points to evaluate at all. */
  const eraseAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = erase.current;
    if (!g) return;
    const r = e.currentTarget.getBoundingClientRect();
    const { x, y } = geometry(r.width, r.height);
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const last = g.points.length - 1;
    const keep = g.points.filter((pt, i) =>
      i === 0 || i === last || Math.hypot(x(pt.time) - px, y(pt.level) - py) >= ERASE_RADIUS);
    if (keep.length === g.points.length || keep.length < 2) return;
    g.points = keep;
    onChange({ ...shape, points: keep, bipolar });
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Right button + any of Shift/Ctrl/Alt starts the erase sweep. Any of the
    // three, because on the RIGHT button none of them means anything else
    // (Ctrl/Alt/Shift+Alt are LEFT-button paint modes, see `paintModeFor`), so
    // whichever one the user reaches for works. A bare right-click falls
    // through to `onContext`'s single-point delete.
    if (e.button === 2) {
      if (!(e.shiftKey || e.ctrlKey || e.altKey)) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      erase.current = { points: points.map((pt) => ({ ...pt })) };
      eraseAt(e);
      return;
    }
    if (e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    // Modifier-key paint gestures (todo.md — see `paintModeFor`) take
    // priority over the normal point/curve hit-test: holding Ctrl/Alt is an
    // explicit request to paint, regardless of what's under the cursor.
    // Ctrl+Alt doubles the column count ("half as long… much faster steps")
    // — capped so cols*2 points never exceeds MAX_FUNCTION_POINTS.
    const mode = paintModeFor(e);
    if (mode) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const cols = Math.max(1, Math.min(MAX_FUNCTION_POINTS / 2, e.ctrlKey && e.altKey ? gridX * 2 : gridX));
      paint.current = { mode, cols, points: points.map((pt) => ({ ...pt })), lastCol: null };
      paintAt(e, r);
      return;
    }
    const hit = pointAt(e);
    const { x, y } = geometry(r.width, r.height);
    const px = e.clientX - r.left; const py = e.clientY - r.top;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (hit) {
      drag.current = { ...hit, x: e.clientX, y: e.clientY, shape: { ...shape, points: points.map((p) => ({ ...p })) } };
      setHoverKind(hit.kind);
      return;
    }
    if (tool === 'edit' && points.length < MAX_FUNCTION_POINTS) {
      const time = Math.max(0, Math.min(1, (px - 12) / Math.max(1, r.width - 24)));
      const level = Math.max(-1, Math.min(1, 1 - (py - 12) / Math.max(1, r.height - 24)) * 2 - 1);
      const next = [...points, { time, level, curve: 0 } as FunctionPoint].sort((a, b) => a.time - b.time);
      onChange({ ...shape, points: next, bipolar });
    }
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (erase.current) {
      eraseAt(e);
      return;
    }
    if (paint.current) {
      paintAt(e, e.currentTarget.getBoundingClientRect());
      return;
    }
    const d = drag.current;
    if (!d) {
      // Not dragging — just update hover feedback (todo.md — user: the
      // curve/tension handle should show the same ↕ cursor as the grid
      // X/Y steppers when hovered).
      const hit = pointAt(e);
      setHoverKind(hit?.kind ?? null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const index = d.index;
    const next = d.shape.points.map((p) => ({ ...p }));
    if (d.kind === 'point') {
      const time = Math.max(index === 0 ? 0 : next[index - 1].time + 0.005, Math.min(index === next.length - 1 ? 1 : next[index + 1].time - 0.005, (e.clientX - r.left - 12) / Math.max(1, r.width - 24)));
      const level = Math.max(-1, Math.min(1, 1 - (e.clientY - r.top - 12) / Math.max(1, r.height - 24) * 2));
      next[index] = { ...next[index], time, level };
    } else {
      // The tension handle is DIRECTLY MANIPULATED: solve for the `curve`
      // whose rendered midpoint sits exactly under the cursor, instead of
      // nudging `curve` by a fixed px-per-unit rate.
      //
      // (user, 2026-10-10, with screenshots: "the bend isn't quite happening
      // in the centre".) The handle was drawn correctly — at the segment's
      // time midpoint, on the curve — but dragging it accumulated
      // `curve += dy/120`, and `curve` maps to the midpoint's level through
      // `0.5^(2^(curve·4))`, which is steeply nonlinear. So the handle crawled
      // under the cursor near the middle of its range and bolted near the
      // ends: you placed the handle in one spot and the bend appeared with a
      // different depth somewhere else. The previous fix in this spot (the
      // ascending/descending sign flip) was treating a symptom of the same
      // thing — inverting a rate does not make it track.
      //
      // Inverting the render math instead:
      //     mid = a + (b-a)·0.5^power      (what the canvas draws)
      //  => 0.5^power = (mid-a)/(b-a) = ratio
      //  => power     = ln(ratio)/ln(0.5)
      //  => curve     = log2(power)/4      (power = 2^(curve·4))
      // The sign question disappears: `ratio` is computed against this
      // segment's own direction, so ascending and descending both just work.
      const a = next[index];
      const b = next[index + 1];
      const span = b.level - a.level;
      if (Math.abs(span) < 1e-6) {
        // A flat segment has no bend to solve for — `a + 0·anything` is `a`
        // whatever `curve` is. Keep the old relative nudge so the stored
        // value still moves (it takes effect the moment an endpoint does).
        const delta = (e.clientY - d.y) / 120;
        next[index] = { ...a, curve: Math.max(-1, Math.min(1, a.curve + delta)) };
      } else {
        const midLevel = Math.max(-1, Math.min(1, 1 - (e.clientY - r.top - 12) / Math.max(1, r.height - 24) * 2));
        // Clamped off 0 and 1: ratio 0 or 1 is an infinite power.
        const ratio = Math.max(1e-3, Math.min(1 - 1e-3, (midLevel - a.level) / span));
        const power = Math.log(ratio) / Math.log(0.5);
        const curve = Math.log2(Math.max(1e-6, power)) / 4;
        next[index] = { ...a, curve: Math.max(-1, Math.min(1, curve)) };
      }
    }
    onChange({ ...d.shape, points: next, bipolar });
  };
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (erase.current) {
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      erase.current = null;
      eraseJustRan.current = true;
      return;
    }
    if (paint.current) {
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      paint.current = null;
      return;
    }
    if (drag.current) { try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ } drag.current = null; }
  };
  const onLeave = () => setHoverKind(null);
  const onContext = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.stopPropagation(); // right-clicking a breakpoint must never also fall through to a menu behind the modal
    // The sweep already removed what it was over; don't take a bonus point.
    if (erase.current || eraseJustRan.current) { eraseJustRan.current = false; return; }
    const hit = pointAt(e as unknown as React.PointerEvent<HTMLCanvasElement>);
    if (hit?.kind === 'point' && hit.index > 0 && hit.index < points.length - 1) onChange({ ...shape, points: points.filter((_, i) => i !== hit.index), bipolar });
  };
  const applyTool = (nextTool: NonNullable<FunctionShape['drawMode']>) => {
    setTool(nextTool);
    if (nextTool === 'line') onChange({ ...shape, drawMode: nextTool, points: points.map((p) => ({ ...p, curve: 0 })), bipolar });
    if (nextTool === 'ramp') onChange({ ...shape, drawMode: nextTool, points: [{ time: 0, level: -1, curve: 0 }, { time: 1, level: 1, curve: 0 }], bipolar });
    if (nextTool === 'saw') onChange({ ...shape, drawMode: nextTool, points: [{ time: 0, level: -1, curve: 0 }, { time: 0.5, level: 1, curve: 0 }, { time: 1, level: -1, curve: 0 }], bipolar });
  };
  return createPortal(
    <div
      className="function-editor-backdrop"
      role="dialog"
      aria-label="Function generator editor"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <div className="function-editor">
        <header><strong>Function</strong><button type="button" onClick={onClose} aria-label="Close Function editor">×</button></header>
        <canvas
          ref={ref}
          className="function-editor-graph"
          data-allow-2d=""
          style={{ cursor: hoverKind === 'curve' ? 'ns-resize' : hoverKind === 'point' ? 'grab' : 'crosshair' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={onLeave}
          onContextMenu={onContext}
        />
        <div className="function-editor-toolbar">
          {(['edit', 'line', 'ramp', 'saw'] as const).map((name) => <button key={name} type="button" className={tool === name ? 'is-on' : ''} onClick={() => applyTool(name)}>{name}</button>)}
          <button type="button" className={bipolar ? 'is-on' : ''} onClick={() => { const next = !bipolar; setBipolar(next); onChange({ ...shape, bipolar: next }); }}>{bipolar ? 'Bipolar' : 'Unipolar'}</button>
          {/* Grid line counts (todo.md — user: "cap at 32… default 8x8"),
              time (X) and level (Y) independent since a user drawing beat
              divisions doesn't necessarily want the same count vertically.
              Drag ↕ or scroll to change — no typing (user: "shouldn't have
              to type"). */}
          <GridStepper label="X" value={gridX} title="Grid columns (time divisions) — drag ↕ or scroll, 1-32"
            onChange={(v) => onChange({ ...shape, gridX: v, bipolar })} />
          <GridStepper label="Y" value={gridY} title="Grid rows (level divisions) — drag ↕ or scroll, 1-32"
            onChange={(v) => onChange({ ...shape, gridY: v, bipolar })} />
          <span className="function-editor-help">
            click add · drag points · drag arrows · right-click delete · Shift+right-drag erase · Ctrl paint steps · Alt ramp down · Shift+Alt ramp up · Ctrl+Alt fast steps
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ConstSourceDot({
  source,
  label,
  armed,
  onSourceDragStart,
  onSourceContext,
}: {
  source: ModSourceId;
  label: string;
  armed: boolean;
  onSourceDragStart: (source: ModSourceId, point: { x: number; y: number }) => void;
  onSourceContext: (source: ModSourceId, anchor: HTMLElement) => void;
}) {
  return (
    <span
      className="env-title const-source"
      style={{ '--src': MOD_SOURCES[source].color } as React.CSSProperties}
    >
      <SourceDot source={source} armed={armed} onSourceDragStart={onSourceDragStart} onSourceContext={onSourceContext} />
      {label}
    </span>
  );
}

/**
 * Velocity + Keyboard sources with a transfer-curve editor (todo.md §88.E,
 * Vital-style VELO / NOTE). A VELO|NOTE tab picks which curve the canvas
 * edits; drag ↕ on the canvas bends the power curve (`2^(c*2)` exponent,
 * −1 log … +1 exp). The identity-colour source dots stay as cable handles.
 */
function PerfEditor({
  velCurve,
  keyCurve,
  onChange,
  onSourceDragStart,
  armedSource,
  onSourceContext,
}: {
  velCurve: number;
  keyCurve: number;
  onChange: (patch: Partial<SynthSettings>) => void;
  onSourceDragStart: (source: ModSourceId, point: { x: number; y: number }) => void;
  armedSource: ModSourceId | null;
  onSourceContext: (source: ModSourceId, anchor: HTMLElement) => void;
}) {
  const [which, setWhich] = useState<'vel' | 'key'>('vel');
  const curve = which === 'vel' ? velCurve : keyCurve;
  const set = (c: number) => onChange(which === 'vel' ? { velCurve: c } : { keyCurve: c });
  const color = MOD_SOURCES[which === 'vel' ? 'velocity' : 'keytrack'].color;

  return (
    <div className="env-block mod-card perf-card" style={{ '--src': color } as React.CSSProperties}>
      <div className="env-head perf-head">
        <span className="const-row perf-dots">
          <ConstSourceDot source="velocity" label="Velo" armed={armedSource === 'velocity'}
            onSourceDragStart={onSourceDragStart} onSourceContext={onSourceContext} />
          <ConstSourceDot source="keytrack" label="Key" armed={armedSource === 'keytrack'}
            onSourceDragStart={onSourceDragStart} onSourceContext={onSourceContext} />
        </span>
        <span className="perf-tabs">
          <button type="button" className={which === 'vel' ? 'is-on' : ''} onClick={() => setWhich('vel')}>Velo</button>
          <button type="button" className={which === 'key' ? 'is-on' : ''} onClick={() => setWhich('key')}>Note</button>
        </span>
      </div>
      <div className="env-graph perf-graph">
        <CurveGraph curve={curve} color={color} onChange={set} />
      </div>
    </div>
  );
}

/** Static transfer-curve canvas: y = x^(2^(c*2)); drag ↕ to bend. */
function CurveGraph({ curve, color, onChange }: { curve: number; color: string; onChange: (c: number) => void }) {
  const themeVersion = useThemeVersion();
  const ref = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{ startY: number; start: number } | null>(null);

  useEffect(() => {
    const cvs = ref.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = cvs.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w <= 0 || h <= 0) return;
    cvs.width = Math.floor(w * dpr);
    cvs.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // See the fix note above — reads off document.body, not the canvas.
    const cs = getComputedStyle(document.body);
    ctx.fillStyle = cs.getPropertyValue('--bg-surface-elevated').trim() || '#0c1133';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = cs.getPropertyValue('--grid-minor').trim() || 'rgba(120,150,255,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h); ctx.lineTo(w, 0); ctx.stroke(); // linear reference

    const p = Math.pow(2, Math.max(-1, Math.min(1, curve)) * 2);
    ctx.beginPath();
    for (let i = 0; i <= 48; i += 1) {
      const x = i / 48;
      const y = Math.pow(x, p);
      const px = x * w;
      const py = h - y * h;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 5;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }, [curve, color, themeVersion]);

  return (
    <canvas
      ref={ref}
      className="env-graph-canvas"
      data-allow-2d=""
      title="Drag ↕ to bend the response curve (log ↔ exp)"
      style={{ cursor: 'ns-resize' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { startY: e.clientY, start: curve };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        // Bug (todo.md — user: "adjusting the tension on the velocity and
        // key tracking modulator... bend it upwards it goes down"). This
        // curve always runs 0..1 ascending (y=x^p); per the same math as
        // the Function editor's tension-handle fix, an ascending segment's
        // rendered bulge moves OPPOSITE to `curve`, so the old `startY -
        // clientY` sign (curve UP when dragging up) bulged it down.
        onChange(Math.max(-1, Math.min(1, d.start + (e.clientY - d.startY) / 120)));
      }}
      onPointerUp={(e) => {
        if (drag.current) { try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ } drag.current = null; }
      }}
    />
  );
}

/**
 * One modulation source's cable handle — shared by every card's own header
 * dot AND the mod-source overview row (todo.md §91/92 Pigments overhaul).
 * Pointer-down hands straight to `onSourceDragStart`: `useCableDrag` itself
 * decides, at release, whether that gesture was a drag (route the dragged
 * knob) or a plain click (arm click-to-assign — see its own doc comment).
 * Right-click opens this source's active-routes list instead.
 */
export function SourceDot({
  source,
  armed,
  onSourceDragStart,
  onSourceContext,
}: {
  source: ModSourceId;
  armed: boolean;
  onSourceDragStart: (source: ModSourceId, point: { x: number; y: number }) => void;
  onSourceContext: (source: ModSourceId, anchor: HTMLElement) => void;
}) {
  return (
    <span
      className={`env-source-dot${armed ? ' is-armed' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${MOD_SOURCES[source].label} — drag to a knob, or click it then click a knob`}
      title="Drag onto a knob to route it, or click then click a knob · right-click to see its routes"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        onSourceDragStart(source, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSourceContext(source, e.currentTarget as HTMLElement);
      }}
    />
  );
}

/**
 * The mod-source overview row (todo.md §91/92) — every source's dot in one
 * slim strip in the plugin header, so assigning doesn't require hunting
 * across 6+ modulator cards for the one you want. Dots only (no text
 * labels) — the header has to fit the window's raised MINIMUM size (todo.md
 * §77/§92, currently 760px of logical width), and 8 short labels wouldn't;
 * each dot keeps a `title`/`aria-label` so the source is still identifiable.
 *
 * `MOD_SOURCES` gives env2/env3 the identical colour, and the same for
 * lfo1/2/3 (a deliberate "one colour per family" choice — see that file's
 * doc comment) — harmless everywhere else because a card's own title
 * ("ENV 2 · Mod") disambiguates, but with no label here those dots are
 * genuinely indistinguishable at a glance. A small numeral badge (extracted
 * from `MOD_SOURCES[source].short`, e.g. "ENV 2" -> "2") fixes it without
 * touching the shared colours or spending the width a full label would.
 */
const SOURCE_NUM = (short: string) => /(\d+)$/.exec(short)?.[1];

export function ModSourceOverview({
  armedSource,
  onSourceDragStart,
  onSourceContext,
  sources = ALL_SOURCES,
}: {
  armedSource: ModSourceId | null;
  onSourceDragStart: (source: ModSourceId, point: { x: number; y: number }) => void;
  onSourceContext: (source: ModSourceId, anchor: HTMLElement) => void;
  /** Override the source list (default: every source). The header's Macro
   *  knobs (todo.md §111) render their own dots, so the plugin passes the
   *  non-macro subset here to avoid double-listing them. */
  sources?: ModSourceId[];
}) {
  return (
    <div className="mod-overview-row" role="list" aria-label="Modulation sources">
      {sources.map((source) => (
        <span
          key={source}
          className="mod-overview-item"
          role="listitem"
          style={{ '--src': MOD_SOURCES[source].color } as React.CSSProperties}
        >
          <SourceDot
            source={source}
            armed={armedSource === source}
            onSourceDragStart={onSourceDragStart}
            onSourceContext={onSourceContext}
          />
          {SOURCE_NUM(MOD_SOURCES[source].short) && (
            <span className="mod-overview-num" aria-hidden="true">
              {SOURCE_NUM(MOD_SOURCES[source].short)}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

function EnvelopeEditor({
  title,
  source,
  env,
  color,
  armed,
  onChange,
  onSourceDragStart,
  onSourceContext,
  onRemove,
}: {
  title: string;
  source: ModSourceId;
  env: AdsrEnvelope;
  /** Present on optional ("+") modules: shows a × that removes the card. */
  onRemove?: () => void;
  color: string;
  armed: boolean;
  onChange: (e: AdsrEnvelope) => void;
  onSourceDragStart: (source: ModSourceId, point: { x: number; y: number }) => void;
  onSourceContext: (source: ModSourceId, anchor: HTMLElement) => void;
}) {
  const [shapeOpen, setShapeOpen] = useState(false);
  const isMulti = env.mode === 'multi' && (env.shape?.points?.length ?? 0) >= 2;
  return (
    <div className="env-block mod-card" style={{ '--src': color } as React.CSSProperties}>
      <div className="env-head">
        <span className="env-title">
          <SourceDot source={source} armed={armed} onSourceDragStart={onSourceDragStart} onSourceContext={onSourceContext} />
          {title}
        </span>
        {onRemove && (
          <button type="button" className="mod-remove" title="Remove this modulator (also removes its routes)" onClick={onRemove}>×</button>
        )}
      </div>

      {/* No knob row any more (todo.md §58 — "hidden by default, only the
          visualizer display visible"): the graph's four dots ARE the
          attack/decay/sustain/release editors (drag ↔ time, ↕ curve or
          level), so a separate knob row was purely duplicate UI. */}
      <div className="env-graph">
        <EnvGraph env={env} color={color} onChange={onChange} />
      </div>
    </div>
  );
}

// ----- Interactive ADSR graph --------------------------------------------------

type HandleKind = 'attack' | 'decay' | 'sustain' | 'release';

/** Screen-space geometry for the ADSR curve + its draggable handles. */
function envGeom(env: AdsrEnvelope, w: number, h: number) {
  const a = Math.max(env.attackSec, 0.001);
  const d = Math.max(env.decaySec, 0.001);
  const r = Math.max(env.releaseSec, 0.001);
  const hold = Math.max(a, d, r) * 0.4;
  const total = a + d + hold + r;
  const pad = 7;
  const px = (t: number) => pad + (t / total) * (w - pad * 2);
  const py = (v: number) => pad + (1 - v) * (h - pad * 2);
  const handles: Record<HandleKind, { x: number; y: number }> = {
    attack: { x: px(a), y: py(1) },
    decay: { x: px(a + d / 2), y: py(segmentValue(1, env.sustainLevel, 0.5, env.decayCurve)) },
    sustain: { x: px(a + d), y: py(env.sustainLevel) },
    release: { x: px(total), y: py(0) },
  };
  return { a, d, r, hold, total, px, py, handles };
}

const HANDLE_HINT: Record<HandleKind, string> = {
  attack: 'Attack — drag ↔ time · ↕ curve',
  decay: 'Decay — drag ↕ curve',
  sustain: 'Decay ↔ time · Sustain ↕ level',
  release: 'Release — drag ↔ time · ↕ curve',
};

/**
 * The ADSR curve with four draggable dots (Vital-style). Horizontal drag =
 * time, vertical drag = curve (or sustain level). This replaces the old
 * curve knobs — the dots are the curve controls now.
 */
function EnvGraph({
  env,
  color,
  onChange,
}: {
  env: AdsrEnvelope;
  color: string;
  onChange: (e: AdsrEnvelope) => void;
}) {
  const themeVersion = useThemeVersion();
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [active, setActive] = useState<HandleKind | null>(null);
  const dragRef = useRef<{
    kind: HandleKind;
    startX: number;
    startY: number;
    env0: AdsrEnvelope;
    w: number;
    h: number;
  } | null>(null);

  useEffect(() => {
    const cvs = ref.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = cvs.getBoundingClientRect();
    const W = Math.max(1, Math.floor(rect.width * dpr));
    const H = Math.max(1, Math.floor(rect.height * dpr));
    cvs.width = W;
    cvs.height = H;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // See the fix note above — reads off document.body, not the canvas.
    const cs = getComputedStyle(document.body);
    const bg = cs.getPropertyValue('--bg-surface-elevated').trim() || '#0c1133';
    const grid = cs.getPropertyValue('--grid-minor').trim() || 'rgba(120,150,255,0.1)';

    const w = rect.width;
    const h = rect.height;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Grid lines.
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    const g = envGeom(env, w, h);

    // Curve: attack → decay → sustain hold → release.
    const trace = (t0: number, t1: number, from: number, to: number, curve: number, steps = 24) => {
      const p = curvePower(curve);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const v = from + (to - from) * Math.pow(t, p);
        ctx.lineTo(g.px(t0 + (t1 - t0) * t), g.py(v));
      }
    };

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 5;
    ctx.beginPath();
    ctx.moveTo(g.px(0), g.py(0));
    trace(0, g.a, 0, 1, env.attackCurve);
    trace(g.a, g.a + g.d, 1, env.sustainLevel, env.decayCurve);
    ctx.lineTo(g.px(g.a + g.d + g.hold), g.py(env.sustainLevel));
    trace(g.a + g.d + g.hold, g.total, env.sustainLevel, 0, env.releaseCurve);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Handles.
    for (const kind of Object.keys(g.handles) as HandleKind[]) {
      const p = g.handles[kind];
      const isActive = active === kind;
      const isCurveBend = kind === 'decay';
      const radius = isActive ? 6 : isCurveBend ? 4 : 5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      if (isCurveBend) {
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = isActive ? 8 : 4;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.stroke();
      }
    }
  }, [env, color, active, themeVersion]);

  const hitTest = (clientX: number, clientY: number): HandleKind | null => {
    const cvs = ref.current;
    if (!cvs) return null;
    const rect = cvs.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const g = envGeom(env, rect.width, rect.height);
    let best: HandleKind | null = null;
    let bestDist = 12;
    for (const kind of Object.keys(g.handles) as HandleKind[]) {
      const p = g.handles[kind];
      const dist = Math.hypot(p.x - x, p.y - y);
      if (dist < bestDist) {
        bestDist = dist;
        best = kind;
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const cvs = ref.current;
    if (!cvs) return;
    const kind = hitTest(e.clientX, e.clientY);
    if (!kind) return;
    const rect = cvs.getBoundingClientRect();
    e.preventDefault();
    cvs.setPointerCapture(e.pointerId);
    dragRef.current = {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      env0: { ...env },
      w: rect.width,
      h: rect.height,
    };
    setActive(kind);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const secPerPx = (d.env0.attackSec + d.env0.decaySec + d.env0.releaseSec + Math.max(d.env0.attackSec, d.env0.decaySec, d.env0.releaseSec) * 0.4) / Math.max(1, d.w - 14);
    const curvePerPx = 2 / Math.max(1, d.h - 14);
    const levelPerPx = 1 / Math.max(1, d.h - 14);
    const e0 = d.env0;
    const next: AdsrEnvelope = { ...e0 };
    switch (d.kind) {
      case 'attack':
        next.attackSec = clampSec(e0.attackSec + dx * secPerPx);
        // + not - here (unlike decay/release below): attack is the one
        // ASCENDING segment (0 up to the peak) — segmentValue's bulge
        // moves opposite to `curve` on an ascending segment (same math as
        // the Function editor's tension-handle fix), so it needs the
        // opposite sign from decay/release's descending segments to keep
        // "drag up" bulging up either way. Not visible on the attack dot
        // itself (pinned to the peak corner, todo.md's own envGeom), but
        // audible/visible in the curve shape it draws.
        next.attackCurve = clampCurve(e0.attackCurve + dy * curvePerPx);
        break;
      case 'decay':
        next.decayCurve = clampCurve(e0.decayCurve - dy * curvePerPx);
        break;
      case 'sustain':
        next.decaySec = clampSec(e0.decaySec + dx * secPerPx);
        next.sustainLevel = clamp01(e0.sustainLevel - dy * levelPerPx);
        break;
      case 'release':
        next.releaseSec = clampSec(e0.releaseSec + dx * secPerPx);
        next.releaseCurve = clampCurve(e0.releaseCurve - dy * curvePerPx);
        break;
    }
    onChange(next);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      try { (e.currentTarget as HTMLCanvasElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
      dragRef.current = null;
      setActive(null);
    }
  };

  return (
    <canvas
      ref={ref}
      className="env-graph-canvas"
      data-allow-2d=""
      title={active ? HANDLE_HINT[active] : 'Drag the dots to shape the envelope (↔ time · ↕ curve)'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
