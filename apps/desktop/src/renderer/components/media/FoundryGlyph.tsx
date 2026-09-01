/**
 * Foundry's own mark: three interlocked rings. currentColor so it inherits
 * the chrome palette (light on the dark titlebar, not the black-on-orange
 * Dock icon).
 *
 * Kept out of BrandIcon so the titlebar and empty states do not pull the
 * provider-icon map (and @lobehub/icons) on first paint.
 */
import type { CSSProperties } from 'react';

export interface MarkProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

function FoundryMark({ size = 16, className, style }: MarkProps): React.JSX.Element {
  return (
    <svg
      className={className}
      fill="none"
      height={size}
      style={style}
      viewBox="0 0 64 64"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <g stroke="currentColor" strokeWidth="7.2">
        <circle cx="32" cy="22" r="13.2" />
        <circle cx="22.57" cy="38.2" r="13.2" />
        <circle cx="41.43" cy="38.2" r="13.2" />
      </g>
    </svg>
  );
}

/** Foundry mark for app chrome (titlebar, empty states, onboarding). */
export const FoundryGlyph = FoundryMark;
