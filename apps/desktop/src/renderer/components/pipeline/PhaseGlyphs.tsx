import type { PhaseKind } from '@shared/types.js';

export function AgentGlyph(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <rect x="2.5" y="4" width="9" height="7" rx="1.5" />
      <path d="M7 4V1.8" />
      <circle cx="7" cy="1.4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="5.2" cy="7.2" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="8.8" cy="7.2" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CommandGlyph(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 3.5 6 6.5 3 9.5" />
      <path d="M7 10.5h4.5" />
    </svg>
  );
}

export function CheckpointGlyph(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12.5v-11" />
      <path d="M3 2.2c1.6-1 3.2 1 4.8 0s3-0.6 3.4-0.2v5.6c-0.4-0.4-1.8-0.8-3.4 0.2s-3.2 1-4.8 0" />
    </svg>
  );
}

export function EnvelopeGlyph(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.5" y="3" width="11" height="8" rx="1.2" />
      <path d="M1.8 3.6 7 8l5.2-4.4" />
    </svg>
  );
}

export function PhaseGlyph({ kind }: { kind: PhaseKind }): React.JSX.Element {
  if (kind === 'agent') return <AgentGlyph />;
  if (kind === 'code') return <CommandGlyph />;
  return <CheckpointGlyph />;
}
