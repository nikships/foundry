/**
 * Phase iconography, shared by the ladder and the phase inspector so a kind
 * reads identically wherever it appears. Line glyphs on `currentColor`; the
 * caller owns the hue.
 */
import type { PhaseDef } from '@shared/types.js';

export function AgentGlyph({ size = 12 }: { size?: number } = {}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden
    >
      <rect x="2.5" y="4" width="9" height="7" rx="1.5" />
      <path d="M7 4V1.8" />
      <circle cx="7" cy="1.4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="5.2" cy="7.2" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="8.8" cy="7.2" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CommandGlyph({ size = 12 }: { size?: number } = {}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 3.5 6 6.5 3 9.5" />
      <path d="M7 10.5h4.5" />
    </svg>
  );
}

export function CheckpointGlyph({ size = 12 }: { size?: number } = {}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 12.5v-11" />
      <path d="M3 2.2c1.6-1 3.2 1 4.8 0s3-0.6 3.4-0.2v5.6c-0.4-0.4-1.8-0.8-3.4 0.2s-3.2 1-4.8 0" />
    </svg>
  );
}

export function EnvelopeGlyph({ size = 11 }: { size?: number } = {}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="1.5" y="3" width="11" height="8" rx="1.2" />
      <path d="M1.8 3.6 7 8l5.2-4.4" />
    </svg>
  );
}

/** The target an acceptance rule reads, marked on its rung. */
export function OutcomeGlyph({ size = 11 }: { size?: number } = {}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3.5 12.5v-11" />
      <path d="M3.5 2h7.2l-1.7 2.6L10.7 7.2H3.5" />
    </svg>
  );
}

export function PlusGlyph({ size = 11 }: { size?: number } = {}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 2v10M2 7h10" />
    </svg>
  );
}

export function ChevronDownGlyph({ size = 10 }: { size?: number } = {}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3.5 5.25 7 8.75l3.5-3.5" />
    </svg>
  );
}

export function PhaseGlyph({
  kind,
  size = 12,
}: {
  kind: PhaseDef['kind'];
  size?: number;
}): React.JSX.Element {
  if (kind === 'agent') return <AgentGlyph size={size} />;
  if (kind === 'code') return <CommandGlyph size={size} />;
  return <CheckpointGlyph size={size} />;
}
