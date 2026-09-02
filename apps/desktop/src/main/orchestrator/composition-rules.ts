/** Phase-kind helpers plus the canonical composition prompt shared with Smith. */
import type { PhaseKind } from '@shared/types.js';
export { compositionRuleBullets } from './composition.js';

/** Shared PhaseKind universe. Engineer/question is not a phase kind. */
export const PHASE_KINDS = ['agent', 'code'] as const satisfies readonly PhaseKind[];

type SharedPhaseKind = (typeof PHASE_KINDS)[number];
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Fails typecheck if `PhaseKind` and `PHASE_KINDS` ever drift. */
const _phaseKindsArePhaseKind: Equal<PhaseKind, SharedPhaseKind> = true;
void _phaseKindsArePhaseKind;

export function isPhaseKind(value: string): value is PhaseKind {
  return (PHASE_KINDS as readonly string[]).includes(value);
}
