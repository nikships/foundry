/**
 * The settings search registry. One list of every section the Settings screen
 * renders, so the rail search box and the ⌘K palette read the same source
 * instead of two hand-synced copies.
 *
 * Section `id`s are derived from the section's label through `sectionId()`, and
 * `SettingsScreen`'s Section component stamps `data-sec={sectionId(label)}` on
 * the same label — so a jump target can only drift if a label is renamed, and
 * then the search title simply reads stale rather than jumping nowhere. Keep
 * the labels below in step with the `Section label="…"` call sites.
 */

import type React from 'react';

export type SettingsPaneId = 'models' | 'integrations' | 'project' | 'app';

/**
 * The section groupings this registry is written in, which predate the
 * current rail. `currentPane` folds them onto the panes that render today,
 * so a section can be re-homed without rewriting every entry below.
 */
type LegacySettingsPaneId =
  'general' | 'providers' | 'defaults' | 'integrations' | 'project' | 'maintenance' | 'about';

export interface SettingsPaneMeta {
  id: SettingsPaneId;
  label: string;
  /** Shown as the pane's subtitle in the palette's empty-query state. */
  hint: string;
  keywords: string;
}

/**
 * The rail's grouping: whose stuff a pane configures. `SettingsScreen` keeps
 * its own literal PANES list (tests pin the literals there), so this list's
 * ids are pinned to the same four by tests/settings-search.test.ts.
 */
export const SETTINGS_PANES: SettingsPaneMeta[] = [
  {
    id: 'models',
    label: 'Models & Providers',
    hint: 'Providers, API keys, models, agent defaults, and Smith',
    keywords:
      'anthropic openai google openrouter xai api key subscription models bridge connect oauth reasoning helper pr writer smith chat',
  },
  {
    id: 'integrations',
    label: 'Integrations',
    hint: 'Connect external issue trackers to orchestration',
    keywords: 'linear issue ticket api key workflow status orchestration source',
  },
  {
    id: 'project',
    label: 'Project',
    hint: 'Repo, readiness, git, commands, boundaries',
    keywords:
      'repository path git base ref merge policy protected paths setup script commands scope remove repository card refresh context',
  },
  {
    id: 'app',
    label: 'App',
    hint: 'Appearance, notifications, updates, phone, and maintenance',
    keywords:
      'theme appearance dark light midnight forest ember contrast sand mist palette color notify updates phone companion application quit relaunch retention history orphan version build replay intro',
  },
];

export interface SettingsSectionRef {
  pane: LegacySettingsPaneId;
  /** Exact `Section label` text in SettingsScreen. */
  label: string;
  /** Exact `Section note` text, surfaced as the result's second line. */
  note: string;
  keywords: string;
}

export const SETTINGS_SECTIONS: SettingsSectionRef[] = [
  // General
  {
    pane: 'general',
    label: 'Checks',
    note: 'What Foundry found on this machine at launch.',
    keywords: 'doctor environment diagnostics recheck',
  },
  {
    pane: 'general',
    label: 'Appearance',
    note: 'Choose the palette Foundry uses across the desktop.',
    keywords:
      'theme appearance dark light midnight forest ember contrast high contrast sand mist light theme dark mode palette color mode',
  },
  {
    pane: 'general',
    label: 'Notifications',
    note: 'Only the moments that need you.',
    keywords: 'notify accepted rejected failed waiting dock badge alerts',
  },
  {
    pane: 'general',
    label: 'Software updates',
    note: 'Foundry checks only when you ask it to.',
    keywords: 'version update download install restart check',
  },
  {
    pane: 'general',
    label: 'Phone',
    note: 'A paired phone can watch runs, start one, and open the PR.',
    keywords: 'companion qr pair android device unpair mobile',
  },
  {
    pane: 'general',
    label: 'Application',
    note: 'Quit or relaunch the desktop app.',
    keywords: 'relaunch quit restart',
  },
  // Providers
  {
    pane: 'providers',
    label: 'Providers',
    note: 'Where the models an agent phase runs on come from.',
    keywords: 'bridge start serving port localhost pi',
  },
  {
    pane: 'providers',
    label: 'Subscriptions',
    note: 'Sign in with a plan you already pay for.',
    keywords: 'anthropic openai connect account oauth sign in claude login disconnect',
  },
  {
    pane: 'providers',
    label: 'API keys',
    note: 'For a provider you hold a key for rather than a subscription.',
    keywords: 'key token secret google openrouter xai gemini grok paste store clear',
  },
  {
    pane: 'providers',
    label: 'Models',
    note: 'What every picker in the app will offer.',
    keywords: 'hide model catalog picker context window refresh reachable',
  },
  // Agent defaults
  {
    pane: 'defaults',
    label: 'Agent defaults',
    note: 'What an agent set to inherit gets.',
    keywords: 'inherit fallback per-agent',
  },
  {
    pane: 'defaults',
    label: 'Model',
    note: 'Every model a connected provider offers.',
    keywords: 'default model reasoning effort picker',
  },
  {
    pane: 'defaults',
    label: 'Helper tasks',
    note: 'Used for project detection and Agent Readiness.',
    keywords: 'detection readiness helper model reasoning effort',
  },
  {
    pane: 'defaults',
    label: 'Healing',
    note: 'Repairs a failed check before the failure escalates.',
    keywords: 'healing heal repair fix failed test lint format command model reasoning effort',
  },
  {
    pane: 'defaults',
    label: 'Smith',
    note: 'The model the in-app chat runs on.',
    keywords: 'smith chat default model picker provider',
  },
  {
    pane: 'defaults',
    label: 'Pull requests',
    note: 'Who drafts a PR when a pipeline asks for one.',
    keywords: 'pr writer draft roster agent',
  },
  {
    pane: 'defaults',
    label: 'Advanced',
    note: 'Stable engine policy and context limits.',
    keywords:
      'report retries check retries envelope gate compaction context rewind corrections run resilience no deadline model retry failover',
  },
  // Integrations
  {
    pane: 'integrations',
    label: 'Linear',
    note: 'Use an issue as the immutable source for a manual pipeline run.',
    keywords: 'linear api key ticket workflow state status mapping connect remove test',
  },
  // Project
  {
    pane: 'project',
    label: 'Project',
    note: 'Where Foundry runs, and what it may touch.',
    keywords: 'name path reveal finder rename remove',
  },
  {
    pane: 'project',
    label: 'Readiness',
    note: 'The marker file is truth. Cached app state never overrides it.',
    keywords: 'agent-ready marker report run check',
  },
  {
    pane: 'project',
    label: 'Checks',
    note: 'Run against this repository.',
    keywords: 'doctor repository diagnostics',
  },
  {
    pane: 'project',
    label: 'Git',
    note: 'Every run branches from the base ref. Update it from the remote here.',
    keywords: 'base ref branch merge policy remote sync fast-forward',
  },
  {
    pane: 'project',
    label: 'Commands',
    note: 'What a pipeline can run, and who detects it.',
    keywords: 'build test lint detect command',
  },
  {
    pane: 'project',
    label: 'Setup',
    note: 'Script that installs deps in every new worktree, so agents find their binaries.',
    keywords: 'install dependencies worktree script sh',
  },
  {
    pane: 'project',
    label: 'Repository card',
    note: 'Facts injected into every run agent so they do not rediscover the stack.',
    keywords: 'repository card refresh context stack layout conventions verification setup',
  },
  {
    pane: 'project',
    label: 'Boundaries',
    note: "Hard limits, whatever an agent's own boundary says.",
    keywords: 'protected paths permissions write patterns',
  },
  {
    pane: 'project',
    label: 'Scope',
    note: "Where this project's agents and pipelines are saved.",
    keywords: 'global project-local roster pipelines design',
  },
  // Maintenance
  {
    pane: 'maintenance',
    label: 'Retention',
    note: 'Nothing is deleted behind your back.',
    keywords: 'delete history days runs compact trace databases vacuum',
  },
  {
    pane: 'maintenance',
    label: 'Leftover worktrees',
    note: 'Left behind by a crashed or killed run.',
    keywords: 'orphan worktree cleanup remove branch uncommitted',
  },
  // About
  {
    pane: 'about',
    label: 'Foundry',
    note: 'A software factory you can watch.',
    keywords: 'about tagline',
  },
  {
    pane: 'about',
    label: 'Build',
    note: 'What this copy of Foundry is running.',
    keywords: 'version harness models projects facts',
  },
  {
    pane: 'about',
    label: 'Elsewhere',
    note: 'Providers and the cinematic intro.',
    keywords: 'replay intro onboarding manage providers',
  },
];

/** The boolean settings the palette can flip in place without opening a pane. */
export interface SettingsToggleDef {
  /** 'dockBadge' lives on the settings root; the rest under `notifications`. */
  id: 'accepted' | 'rejected' | 'failed' | 'dockBadge';
  /** Mirrors the row labels in the General → Notifications section. */
  title: string;
  keywords: string;
}

export const SETTINGS_TOGGLES: SettingsToggleDef[] = [
  { id: 'accepted', title: 'A run was accepted', keywords: 'notify notification success' },
  { id: 'rejected', title: 'A run was not accepted', keywords: 'notify notification decline' },
  { id: 'failed', title: 'A run failed', keywords: 'notify notification error' },
  {
    id: 'dockBadge',
    title: 'Show the number of live runs on the dock icon',
    keywords: 'dock badge count icon',
  },
];

/**
 * The DOM id a section carries (`data-sec`) and a jump targets. Derived from
 * the label alone, so the Settings screen and this registry can never disagree
 * about the id for a given label.
 */
export function sectionId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface SettingsHit {
  pane: SettingsPaneId;
  paneLabel: string;
  /** Null means the pane itself, not a section inside it. */
  sectionId: string | null;
  title: string;
  note: string;
}

function paneLabel(id: SettingsPaneId): string {
  return SETTINGS_PANES.find((p) => p.id === id)?.label ?? id;
}

function currentPane(id: LegacySettingsPaneId): SettingsPaneId {
  if (id === 'integrations') return 'integrations';
  if (id === 'project') return 'project';
  if (id === 'providers' || id === 'defaults') return 'models';
  return 'app';
}

/** Lower number sorts earlier; -1 means no match. */
function scoreSection(section: SettingsSectionRef, q: string): number {
  const title = section.label.toLowerCase();
  if (title === q) return 0;
  if (title.startsWith(q)) return 1;
  if (title.includes(q)) return 2;
  if (section.keywords.includes(q)) return 3;
  if (section.note.toLowerCase().includes(q)) return 4;
  return -1;
}

/**
 * Panes and sections matching `query`, best first, capped. Pane hits ride
 * along with section hits so "providers" lands on the pane even when several
 * of its sections also mention the word.
 */
export function searchSettings(query: string, cap = 12): SettingsHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { hit: SettingsHit; score: number }[] = [];
  for (const pane of SETTINGS_PANES) {
    const labelMatch = pane.label.toLowerCase().includes(q);
    // A keyword-only pane hit sorts after section title matches: "api key"
    // wants the API keys section, not the Providers pane that mentions keys.
    if (labelMatch || pane.keywords.includes(q)) {
      scored.push({
        hit: {
          pane: pane.id,
          paneLabel: pane.label,
          sectionId: null,
          title: pane.label,
          note: pane.hint,
        },
        score: labelMatch ? 1 : 3.5,
      });
    }
  }
  for (const section of SETTINGS_SECTIONS) {
    const score = scoreSection(section, q);
    if (score < 0) continue;
    const pane = currentPane(section.pane);
    scored.push({
      hit: {
        pane,
        paneLabel: paneLabel(pane),
        sectionId: sectionId(section.label),
        title: section.label,
        note: section.note,
      },
      score,
    });
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, cap)
    .map(({ hit }) => hit);
}

/** Does anything in (or about) this pane match the rail's search query? */
export function paneMatchesQuery(pane: SettingsPaneId, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const everything = SETTINGS_SECTIONS.length + SETTINGS_PANES.length;
  return searchSettings(q, everything).some((hit) => hit.pane === pane);
}

/** Wraps the first case-insensitive occurrence of `q` in a mark. */
export function Highlight({ text, q }: { text: string; q: string }): React.JSX.Element {
  const needle = q.trim().toLowerCase();
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="searchMark">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}
