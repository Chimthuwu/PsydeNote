import type { OperatorId } from '../../shared/types';

/**
 * Fixed identity colours for the four operators — Bitwig Phase-4 style
 * (see PHASE4-SYNTH-REFERENCE.png: each operator gets one big colourful
 * scope, and that colour is the operator's identity everywhere else in the
 * UI — tabs, knobs, mod-matrix dots). Deliberately NOT theme tokens, same
 * reasoning as `MOD_SOURCES` in `lib/mod-sources.ts`: a modulated knob's
 * dot, its envelope graph and now an operator's own scope/tab/knobs should
 * all read as "the same colour" regardless of which of the six app themes
 * is active, because the identity is about *which operator*, not the
 * current skin.
 */
export const OPERATOR_COLORS: Record<OperatorId, string> = {
  osc1: '#2dd4c4', // cyan / teal
  osc2: '#e84fc0', // magenta / pink
  osc3: '#f5a623', // amber / orange
  osc4: '#5cd65c', // green
};

export const OPERATOR_LABELS: Record<OperatorId, string> = {
  osc1: 'Osc 1',
  osc2: 'Osc 2',
  osc3: 'Osc 3',
  osc4: 'Osc 4',
};
