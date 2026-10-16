// Phase 0 registry: canonical source list (todo.md §165-3 / L51).
// One list -> ModSourceId union, MOD_SOURCES, DSP array, manifest max.
// This file is the single source; everything else imports from it.

export interface ModSourceMeta {
  id: string;
  label: string;
  short: string;
  color: string;
  dspIndex: number;
  module?: boolean; // optional module (added via "+" tile)
}

export const MOD_REGISTRY: ModSourceMeta[] = [
  { id: 'env1', label: 'Envelope 1 · Amp', short: 'ENV 1', color: '#ffffff', dspIndex: 0 },
  { id: 'env2', label: 'Envelope 2 · Mod', short: 'ENV 2', color: '#facc15', dspIndex: 1, module: true },
  { id: 'env3', label: 'Envelope 3 · Mod', short: 'ENV 3', color: '#facc15', dspIndex: 2, module: true },
  { id: 'lfo1', label: 'LFO 1', short: 'LFO 1', color: '#a3e635', dspIndex: 3, module: true },
  { id: 'lfo2', label: 'LFO 2', short: 'LFO 2', color: '#a3e635', dspIndex: 4, module: true },
  { id: 'lfo3', label: 'LFO 3', short: 'LFO 3', color: '#a3e635', dspIndex: 5, module: true },
  { id: 'velocity', label: 'Velocity', short: 'Velo', color: '#fb923c', dspIndex: 6 },
  { id: 'keytrack', label: 'Keyboard', short: 'Key', color: '#d946ef', dspIndex: 7 },
  { id: 'macro1', label: 'Macro 1', short: 'M1', color: '#c4b5fd', dspIndex: 8 },
  { id: 'macro2', label: 'Macro 2', short: 'M2', color: '#a78bfa', dspIndex: 9 },
  { id: 'macro3', label: 'Macro 3', short: 'M3', color: '#8b5cf6', dspIndex: 10 },
  { id: 'macro4', label: 'Macro 4', short: 'M4', color: '#7c3aed', dspIndex: 11 },
  { id: 'macro5', label: 'Macro 5', short: 'M5', color: '#d8b4fe', dspIndex: 12 },
  { id: 'macro6', label: 'Macro 6', short: 'M6', color: '#c084fc', dspIndex: 13 },
  { id: 'macro7', label: 'Macro 7', short: 'M7', color: '#e879f9', dspIndex: 14 },
  { id: 'macro8', label: 'Macro 8', short: 'M8', color: '#f0abfc', dspIndex: 15 },
  { id: 'audiofollower', label: 'Audio Follower', short: 'AF', color: '#a855f7', dspIndex: 16, module: true },
  { id: 'env4', label: 'Envelope 4 · Mod', short: 'ENV 4', color: '#facc15', dspIndex: 17, module: true },
  { id: 'env5', label: 'Envelope 5 · Mod', short: 'ENV 5', color: '#facc15', dspIndex: 18, module: true },
  { id: 'lfo4', label: 'LFO 4', short: 'LFO 4', color: '#a3e635', dspIndex: 19, module: true },
  { id: 'lfo5', label: 'LFO 5', short: 'LFO 5', color: '#a3e635', dspIndex: 20, module: true },
  { id: 'lfo6', label: 'LFO 6', short: 'LFO 6', color: '#a3e635', dspIndex: 21, module: true },
];
