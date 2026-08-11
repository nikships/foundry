/**
 * The argument for each direction, as data.
 *
 * Kept out of the component so the claims can be read, edited and reviewed on
 * their own — and so a capability can't quietly disappear from the comparison
 * table while the screens still implement it.
 */
export type OptionId = 'a' | 'b';

export interface OptionMove {
  label: string;
  text: string;
}

export interface OptionMeta {
  id: OptionId;
  label: string;
  name: string;
  tagline: string;
  model: string;
  moves: OptionMove[];
  strengths: string[];
  tradeoffs: string[];
  bestFor: string;
}

export const OPTIONS: Record<OptionId, OptionMeta> = {
  a: {
    id: 'a',
    label: 'Option A',
    name: 'Ladder',
    tagline: 'A vertical ladder with a flow gutter, and a docked phase inspector.',
    model:
      'Pipelines switch from a slim command bar, which leaves the page to the pipeline itself. Phases are rungs on a vertical ladder in execution order, and the gutter beside them draws the relationships a list cannot state: a rail for the run, kind-coloured anchors, and dashed arcs for repair loops. Selecting a rung fills a permanently docked inspector on the right.',
    moves: [
      { label: 'Organising idea', text: 'Sequence, and what repeats when something fails.' },
      { label: 'Editing', text: 'Master/detail — the ladder drives a docked pane.' },
      { label: 'Reordering', text: 'Up and down on the rung itself.' },
      { label: 'Keyboard', text: 'A vertical tablist: Up/Down move, selection follows focus.' },
    ],
    strengths: [
      'Execution order is unambiguous — one column, numbered top to bottom.',
      'Repair loops are visible as geometry, which no previous Foundry surface showed at all.',
      'The inspector never moves or covers anything, so long edits stay oriented.',
      'Scales down well: one column plus a pane collapses cleanly to a phone width.',
    ],
    tradeoffs: [
      'A long pipeline scrolls; you cannot see twenty phases at once.',
      'The docked pane permanently spends ~460px of width.',
      'Approval structure is legible but secondary — checkpoints are just another rung.',
    ],
    bestFor:
      'Operators tuning one sequential pipeline closely, who care most about order and retries.',
  },
  b: {
    id: 'b',
    label: 'Option B',
    name: 'Stage board',
    tagline: 'A full-width board of gate-delimited stages, and a slide-over editor.',
    model:
      'Pipelines switch from a pill bar at the top, and the full width becomes a board. Each column is a stage — the run of phases that execute unattended — and the element between two columns is the checkpoint that ends the earlier one. That grouping is derived from the phases, never stored, so dragging a card across a gate really does move the phase past the checkpoint. Deep editing opens in a slide-over so the canvas stays whole.',
    moves: [
      {
        label: 'Organising idea',
        text: 'Approval structure: where the run stops, and who answers.',
      },
      { label: 'Editing', text: 'Canvas plus slide-over — depth on demand.' },
      { label: 'Reordering', text: 'Up/down within a stage, left/right across a gate.' },
      { label: 'Keyboard', text: 'A horizontal pill tablist; Escape closes the slide-over.' },
    ],
    strengths: [
      'Makes gating structure the first thing you see — the thing that decides whether a run is safe to leave alone.',
      'Full width holds far more phases on screen than a single column.',
      'Composing is a first-class per-stage action rather than one global button.',
      'Adding a gate is a visible, one-click way to split a long run into reviewable stages.',
    ],
    tradeoffs: [
      'Global execution order is a read across columns, not a single list.',
      'The slide-over covers part of the board while you edit.',
      'A pipeline with no checkpoints is a single wide column until one is added.',
    ],
    bestFor:
      'Teams shaping many pipelines, where how work is gated matters more than its exact order.',
  },
};

export interface Capability {
  label: string;
  a: string;
  b: string;
}

/** Every capability the old page had, and where each option puts it. */
export const CAPABILITIES: Capability[] = [
  { label: 'Select pipeline', a: 'Command-bar switcher', b: 'Pill tablist' },
  { label: 'Create pipeline', a: 'Command-bar action', b: 'Dashed “+” pill' },
  { label: 'Duplicate / delete', a: 'Command-bar actions', b: 'Top-bar actions' },
  { label: 'Name & description', a: 'Inline, above the ladder', b: 'Inline title block' },
  { label: 'Add phase', a: 'Add-phase menu under the ladder', b: 'Per-stage composer' },
  { label: 'Edit phase', a: 'Docked inspector', b: 'Slide-over' },
  { label: 'Remove phase', a: 'Rung controls', b: 'Card controls' },
  { label: 'Reorder phases', a: 'Up / down on the rung', b: 'Up / down, and across gates' },
  {
    label: 'Agent / command / checkpoint',
    a: 'All three, same editor',
    b: 'All three, same editor',
  },
  { label: 'Repair loops', a: 'Dashed arcs in the gutter', b: 'Badge on the card' },
  { label: 'Acceptance rule', a: 'Outcome section, in prose', b: 'Footer, in prose' },
  { label: 'Acceptance target', a: 'Marked on the rung', b: 'Marked on the card' },
  { label: 'Isolated worktree', a: 'Outcome section', b: 'Footer' },
  { label: 'Live validation', a: 'Status bar + rung dots', b: 'Footer + card dots' },
  { label: 'Jump to a failing phase', a: 'Click the issue', b: 'Click the issue' },
  { label: 'Dry run', a: 'Command bar → sheet', b: 'Top bar → sheet' },
  { label: 'Automatic save', a: 'Status bar note', b: 'Footer note' },
  { label: 'Empty states', a: 'No pipelines / no phases', b: 'No pipelines / empty stage' },
];
