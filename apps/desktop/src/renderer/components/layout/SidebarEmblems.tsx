/**
 * Collapsed-rail emblems, plus the marks Design's tab strip reuses. Lucide
 * placeholders shipped the 56px rail; these replace them with a single Foundry
 * set: currentColor linework, no baked background or shadow, optical size
 * matched to the old 18px glyphs.
 *
 * Provenance: src/renderer/assets/sidebar-emblems/PROVENANCE.md
 */

import type { ComponentType } from 'react';

export interface EmblemProps {
  size?: number;
  className?: string;
}

export type Emblem = ComponentType<EmblemProps>;

function EmblemSvg({
  size = 18,
  className,
  children,
}: EmblemProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {children}
    </svg>
  );
}

/** Runs — workcell ring with a start chevron. */
export function RunsEmblem(props: EmblemProps): React.JSX.Element {
  return (
    <EmblemSvg {...props}>
      <circle cx="12" cy="12" r="8.1" />
      <path d="M10.1 8.6v6.8L16.4 12z" />
    </EmblemSvg>
  );
}

/** Design — a drafting square over the rail it lays out. */
export function DesignEmblem(props: EmblemProps): React.JSX.Element {
  return (
    <EmblemSvg {...props}>
      <path d="M4.4 17.9 12 4.6l7.6 13.3z" />
      <path d="M8.2 17.9 12 11.3l3.8 6.6" />
    </EmblemSvg>
  );
}

/** Pipelines — three stations on a routed rail. */
export function PipelinesEmblem(props: EmblemProps): React.JSX.Element {
  return (
    <EmblemSvg {...props}>
      <circle cx="5.4" cy="15.6" r="1.7" />
      <circle cx="12" cy="6.8" r="1.7" />
      <circle cx="18.6" cy="15.6" r="1.7" />
      <path d="M6.8 14.4 10.4 8.6M13.6 8.6l3.6 5.8" />
    </EmblemSvg>
  );
}

/** Roster — a crew of three operators. */
export function RosterEmblem(props: EmblemProps): React.JSX.Element {
  return (
    <EmblemSvg {...props}>
      <circle cx="12" cy="6.8" r="2.05" />
      <path d="M7.7 17.4c.5-2.7 2.2-4.1 4.3-4.1s3.8 1.4 4.3 4.1" />
      <circle cx="6.1" cy="8.4" r="1.65" />
      <path d="M3.3 17.4c.3-2.1 1.5-3.2 3-3.2" />
      <circle cx="17.9" cy="8.4" r="1.65" />
      <path d="M20.7 17.4c-.3-2.1-1.5-3.2-3-3.2" />
    </EmblemSvg>
  );
}

/** Envelopes — a sealed handoff with its typed slot. */
export function EnvelopesEmblem(props: EmblemProps): React.JSX.Element {
  return (
    <EmblemSvg {...props}>
      <path d="M4.3 6.9h15.4v10.2H4.3z" />
      <path d="m4.3 7.6 7.7 5.2 7.7-5.2" />
    </EmblemSvg>
  );
}

/** Inspector — aperture with reticle ticks. */
export function InspectorEmblem(props: EmblemProps): React.JSX.Element {
  return (
    <EmblemSvg {...props}>
      <circle cx="12" cy="12" r="7.4" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4.6v2.1M12 17.3v2.1M4.6 12h2.1M17.3 12h2.1" />
    </EmblemSvg>
  );
}

/** Pull Requests — two heads merging onto one rail. */
export function PullRequestsEmblem(props: EmblemProps): React.JSX.Element {
  return (
    <EmblemSvg {...props}>
      <circle cx="7" cy="5.6" r="1.55" />
      <circle cx="17" cy="5.6" r="1.55" />
      <circle cx="17" cy="18.4" r="1.55" />
      <path d="M7 7.2v6.4c0 2.1 1.7 3.6 3.7 3.6H15.4" />
      <path d="M17 7.2v8.4" />
      <path d="M14.7 15.8 17 18.1l2.3-2.3" />
    </EmblemSvg>
  );
}

/** Smith — anvil and a single forge spark. */
export function SmithEmblem(props: EmblemProps): React.JSX.Element {
  return (
    <EmblemSvg {...props}>
      <path d="M5.2 12.2h13.6L17.4 15H6.6L5.2 12.2z" />
      <path d="M9.6 15v3.4h4.8V15" />
      <path d="M7.2 12.2V10H11V8.6H6.4c-1.1 0-1.8.8-1.8 1.8 0 .9.6 1.8 2.6 1.8" />
      <path d="M12 4.4v2.4M10.6 5.6 12 4.4l1.4 1.2" />
    </EmblemSvg>
  );
}

/** Project picker — tabbed work bin. */
export function ProjectEmblem(props: EmblemProps): React.JSX.Element {
  return (
    <EmblemSvg {...props}>
      <path d="M4.6 9.1h6l1.5 1.7h7.3v8.6H4.6V9.1z" />
      <path d="M4.6 12.6h14.8" />
    </EmblemSvg>
  );
}

/** Settings — hex nut, not a generic gear. */
export function SettingsEmblem(props: EmblemProps): React.JSX.Element {
  return (
    <EmblemSvg {...props}>
      <path d="M12 4.3 18.5 8v8L12 19.7 5.5 16V8L12 4.3z" />
      <circle cx="12" cy="12" r="2.55" />
    </EmblemSvg>
  );
}

/** Expand — rail spine with an opening chevron. */
export function ExpandEmblem(props: EmblemProps): React.JSX.Element {
  return (
    <EmblemSvg {...props}>
      <path d="M6.2 5v14" />
      <path d="M10.4 8.2 16 12l-5.6 3.8" />
    </EmblemSvg>
  );
}

/** Collapse — rail spine with a closing chevron. */
export function CollapseEmblem(props: EmblemProps): React.JSX.Element {
  return (
    <EmblemSvg {...props}>
      <path d="M6.2 5v14" />
      <path d="M16.4 8.2 10.8 12l5.6 3.8" />
    </EmblemSvg>
  );
}

export const NAV_EMBLEMS = {
  runs: RunsEmblem,
  inspector: InspectorEmblem,
  design: DesignEmblem,
  prs: PullRequestsEmblem,
} as const;

/**
 * Design's tab marks. `agents` draws the roster crew: only the user-facing name
 * changed, so the emblem did not.
 */
export const DESIGN_TAB_EMBLEMS = {
  pipelines: PipelinesEmblem,
  agents: RosterEmblem,
  envelopes: EnvelopesEmblem,
} as const;

export const CHROME_EMBLEMS = {
  smith: SmithEmblem,
  project: ProjectEmblem,
  settings: SettingsEmblem,
  expand: ExpandEmblem,
  collapse: CollapseEmblem,
} as const;

export const SIDEBAR_EMBLEMS = {
  ...NAV_EMBLEMS,
  ...DESIGN_TAB_EMBLEMS,
  ...CHROME_EMBLEMS,
} as const;

export type SidebarEmblemSlot = keyof typeof SIDEBAR_EMBLEMS;

export const SIDEBAR_EMBLEM_SLOTS = Object.keys(SIDEBAR_EMBLEMS) as SidebarEmblemSlot[];
