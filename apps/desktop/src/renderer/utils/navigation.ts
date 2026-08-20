/**
 * The renderer's navigation model, kept free of React so the shell, the sidebar,
 * the native menu map, the shortcut table, and the tests all read one source
 * instead of five hand-synced copies.
 *
 * Design is one view with three tabs rather than three sidebar entries: a
 * pipeline phase names an agent and an agent names an envelope, so authoring
 * one almost always means opening another.
 */

/** A sidebar destination. Settings is reached from its own pinned control. */
export type NavView = 'runs' | 'inspector' | 'design' | 'prs';

export type View = NavView | 'settings';

/**
 * Design's tabs, in dependency order: an envelope is a type, an agent declares
 * one as its default, and a pipeline phase is the call site.
 *
 * `agents` is the user-facing name for what the stores, IPC channels, and
 * `roster.json` still call the roster; only the label changed.
 */
export type DesignTab = 'pipelines' | 'agents' | 'envelopes';

export const NAV_ITEMS: { id: NavView; label: string; key: string }[] = [
  { id: 'runs', label: 'Runs', key: '1' },
  { id: 'inspector', label: 'Inspector', key: '2' },
  { id: 'design', label: 'Design', key: '3' },
  { id: 'prs', label: 'Pull Requests', key: '4' },
];

export const DESIGN_TABS: { id: DesignTab; label: string; blurb: string; key: string }[] = [
  {
    id: 'pipelines',
    label: 'Pipelines',
    blurb:
      'The order of work. Each phase picks an agent, adds this-run context, and decides when the run counts as accepted.',
    key: '1',
  },
  {
    id: 'agents',
    label: 'Agents',
    blurb:
      'Who does the work. Model, prompts, and what it may write. Each agent declares the envelope it returns by default.',
    key: '2',
  },
  {
    id: 'envelopes',
    label: 'Envelopes',
    blurb: 'The shape of an answer. The typed reply an agent must hand back, checked every turn.',
    key: '3',
  },
];

/** Native menu commands that select a view. */
export const MENU_VIEWS: Record<string, View> = {
  'menu:settings': 'settings',
  'menu:view-runs': 'runs',
  'menu:view-inspector': 'inspector',
  'menu:view-design': 'design',
  'menu:view-prs': 'prs',
};

/** Native menu commands that open Design on a specific tab. */
export const MENU_DESIGN_TABS: Record<string, DesignTab> = {
  'menu:design-pipelines': 'pipelines',
  'menu:design-agents': 'agents',
  'menu:design-envelopes': 'envelopes',
};

/**
 * The Design tab that edits a given entity kind. Smith approves a proposal by
 * kind, and every kind it can write now has a tab, so a deep link stays inside
 * Design instead of routing an envelope into Settings.
 */
export function designTabForEntity(kind: 'agent' | 'pipeline' | 'envelope'): DesignTab {
  if (kind === 'pipeline') return 'pipelines';
  if (kind === 'agent') return 'agents';
  return 'envelopes';
}
