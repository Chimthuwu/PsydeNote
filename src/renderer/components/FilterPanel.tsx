import { useRef, useState } from 'react';
import type { FilterSettings, FilterSlope, FilterType, ModMap, ModTargetId } from '../../shared/types';
import { modGlowFor } from '../lib/mod-sources';
import { ModPopover } from './ModPopover';
import { Knob } from './Knob';

/**
 * BOTH voice filters in ONE card (todo.md §88.B) — Filter A and Filter B were
 * each their own bordered `mod-card` in the modulator grid, aesthetically
 * poor and a waste of space (user). Now a single card, spanning two grid
 * columns, with A and B as two compact rows sharing the header. Every
 * operator crossfades between them via its own `filterMix` knob
 * (OscillatorPanel); there's no dedicated filter envelope — route ENV 2/3 (or
 * an LFO, velocity…) onto a Cutoff ∿ badge, same as every other knob.
 */
interface Props {
  filterA: FilterSettings;
  filterB: FilterSettings;
  mod: ModMap;
  onChange: (patch: { filterA: FilterSettings } | { filterB: FilterSettings } | { mod: ModMap }) => void;
}

const TYPES: { value: FilterType; label: string }[] = [
  { value: 'lowpass', label: 'LP' },
  { value: 'highpass', label: 'HP' },
  { value: 'bandpass', label: 'BP' },
];
const SLOPES: FilterSlope[] = ['12', '24'];
const CUT_MIN = 20;
const CUT_MAX = 20000;
const hzToPos = (hz: number) =>
  Math.log(Math.max(CUT_MIN, Math.min(CUT_MAX, hz)) / CUT_MIN) / Math.log(CUT_MAX / CUT_MIN);
const posToHz = (p: number) => CUT_MIN * Math.pow(CUT_MAX / CUT_MIN, Math.max(0, Math.min(1, p)));
const fmtHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}`);

export function FilterPanel({ filterA, filterB, mod, onChange }: Props) {
  const [modOpen, setModOpen] = useState<ModTargetId | null>(null);
  const anchorRefs = useRef<Partial<Record<ModTargetId, HTMLElement | null>>>({});
  const onModContext = (targetId: ModTargetId) => (el: HTMLElement) => {
    anchorRefs.current[targetId] = el;
    setModOpen(targetId);
  };

  return (
    <section className="filter-panel mod-card filter-merged" aria-label="Voice filters">
      <div className="filter-merged-body">
        <FilterRow which="A" filter={filterA} mod={mod} onModContext={onModContext}
          onChange={(f) => onChange({ filterA: f })} color="var(--accent)" />
        <FilterRow which="B" filter={filterB} mod={mod} onModContext={onModContext}
          onChange={(f) => onChange({ filterB: f })} color="var(--danger, #ff6b8a)" />
      </div>

      {modOpen && (
        <ModPopover
          targetId={modOpen}
          routes={mod?.[modOpen] ?? []}
          anchorEl={anchorRefs.current[modOpen] ?? null}
          onChange={(routes) => onChange({ mod: { ...(mod ?? {}), [modOpen]: routes } })}
          onClose={() => setModOpen(null)}
        />
      )}
    </section>
  );
}

function FilterRow({
  which, filter, mod, onModContext, onChange, color,
}: {
  which: 'A' | 'B';
  filter: FilterSettings;
  mod: ModMap;
  onModContext: (t: ModTargetId) => (el: HTMLElement) => void;
  onChange: (f: FilterSettings) => void;
  color: string;
}) {
  const set = (patch: Partial<FilterSettings>) => onChange({ ...filter, ...patch });
  const cutTarget: ModTargetId = which === 'A' ? 'filterACutoff' : 'filterBCutoff';
  const resTarget: ModTargetId = which === 'A' ? 'filterAResonance' : 'filterBResonance';

  return (
    <div className="filter-row" style={{ '--src': color } as React.CSSProperties}>
      <span className="filter-row-tag">{which}</span>
      <div className="filter-seg-stack">
        <div className="filter-seg" role="radiogroup" aria-label={`Filter ${which} type`}>
          {TYPES.map((t) => (
            <button key={t.value} type="button" role="radio" aria-checked={filter.type === t.value}
              className={filter.type === t.value ? 'is-on' : ''} onClick={() => set({ type: t.value })}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="filter-seg" role="radiogroup" aria-label={`Filter ${which} slope`}>
          {SLOPES.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={filter.slope === s}
              className={filter.slope === s ? 'is-on' : ''} onClick={() => set({ slope: s })}>
              {s}
            </button>
          ))}
        </div>
      </div>
      <div className="knob-field filter-knob">
        <Knob label="Cutoff" value={hzToPos(filter.cutoffHz)} min={0} max={1} size="lg" color={color}
          onChange={(p) => set({ cutoffHz: posToHz(p) })} format={(p) => fmtHz(posToHz(p))}
          modTarget={cutTarget} modGlow={modGlowFor(cutTarget, mod?.[cutTarget] ?? [])}
          onModContext={onModContext(cutTarget)} />
      </div>
      <div className="knob-field filter-knob">
        <Knob label="Reso" value={filter.resonance} min={0.0001} max={24} size="lg" color={color}
          onChange={(v) => set({ resonance: v })} format={(v) => v.toFixed(1)}
          modTarget={resTarget} modGlow={modGlowFor(resTarget, mod?.[resTarget] ?? [])}
          onModContext={onModContext(resTarget)} />
      </div>
    </div>
  );
}
