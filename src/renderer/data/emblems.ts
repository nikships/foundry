/**
 * The pre-baked agent emblem library.
 *
 * Same construction rules as the sidebar marks (`SidebarEmblems.tsx`): a 24×24
 * grid, currentColor linework at 1.75, no baked fill, background or shadow —
 * so one mark works at 16px in a run lane and at 44px in the editor.
 */

export const EMBLEM_GROUPS = [
  'Craft',
  'Inspect',
  'Author',
  'Flow',
  'Guard',
  'Signal',
  'Matter',
] as const;

export type EmblemGroup = (typeof EMBLEM_GROUPS)[number];

export interface EmblemDef {
  id: string;
  name: string;
  group: EmblemGroup;
  paths?: string[];
  circles?: { cx: number; cy: number; r: number }[];
}

export const EMBLEMS: EmblemDef[] = [
  {
    id: 'anvil',
    name: 'Anvil',
    group: 'Craft',
    paths: [
      'M5.2 12.2h13.6L17.4 15H6.6L5.2 12.2z',
      'M9.6 15v3.4h4.8V15',
      'M7.2 12.2V10H11V8.6H6.4c-1.1 0-1.8.8-1.8 1.8 0 .9.6 1.8 2.6 1.8',
    ],
  },
  {
    id: 'hammer',
    name: 'Hammer',
    group: 'Craft',
    paths: [
      'M4.8 19.2 12.6 11.4',
      'M11.2 9.9 14.4 6.7l1.6 1.6 2.4-2.4 2.4 2.4-2.4 2.4 1.6 1.6-3.2 3.2z',
    ],
  },
  {
    id: 'wrench',
    name: 'Wrench',
    group: 'Craft',
    paths: [
      'M18.4 5.2a3.9 3.9 0 0 1-4.9 5L6.8 16.9a1.7 1.7 0 1 1-2.4-2.4l6.7-6.7a3.9 3.9 0 0 1 4.9-5l-2.5 2.5.9 2.5 2.5.9z',
    ],
  },
  {
    id: 'hexnut',
    name: 'Hex nut',
    group: 'Craft',
    paths: ['M12 4.3 18.5 8v8L12 19.7 5.5 16V8L12 4.3z'],
    circles: [{ cx: 12, cy: 12, r: 2.55 }],
  },
  {
    id: 'crucible',
    name: 'Crucible',
    group: 'Craft',
    paths: ['M6.2 8.4h11.6l-2 8.2H8.2z', 'M4.8 8.4h14.4', 'M12 19.6v-3'],
  },
  {
    id: 'aperture',
    name: 'Aperture',
    group: 'Inspect',
    paths: ['M12 4.6v2.1M12 17.3v2.1M4.6 12h2.1M17.3 12h2.1'],
    circles: [
      { cx: 12, cy: 12, r: 7.4 },
      { cx: 12, cy: 12, r: 3 },
    ],
  },
  {
    id: 'loupe',
    name: 'Loupe',
    group: 'Inspect',
    paths: ['M14.9 14.9 19.5 19.5'],
    circles: [{ cx: 10.6, cy: 10.6, r: 5.7 }],
  },
  {
    id: 'waveform',
    name: 'Waveform',
    group: 'Inspect',
    paths: ['M3.6 12h2.7l2-5.6 3 11.4 2.1-8 1.5 2.2h5.5'],
  },
  {
    id: 'gauge',
    name: 'Gauge',
    group: 'Inspect',
    paths: ['M4.6 16.6a7.4 7.4 0 1 1 14.8 0', 'M12 16.6l3.7-4.8'],
    circles: [{ cx: 12, cy: 16.6, r: 0.9 }],
  },
  {
    id: 'bars',
    name: 'Bars',
    group: 'Inspect',
    paths: ['M5 19V11M9.7 19V6.4M14.4 19v-5M19 19V8.6'],
  },
  {
    id: 'balance',
    name: 'Balance',
    group: 'Inspect',
    paths: [
      'M12 5.2v13.6',
      'M6.8 18.8h10.4',
      'M4.4 8.6h15.2',
      'M4.4 8.6 6.9 14h-5z',
      'M19.6 8.6 17.1 14h5z',
    ],
  },
  {
    id: 'quill',
    name: 'Quill',
    group: 'Author',
    paths: [
      'M19.4 4.6C12.9 5.3 8.6 8.5 7 13.5c-.5 1.6-.6 3-.6 4',
      'M6.4 17.5 4.6 19.4',
      'M8.6 15.2c3.2.4 6.6-1.3 8.3-4.2',
    ],
  },
  {
    id: 'document',
    name: 'Document',
    group: 'Author',
    paths: ['M6.4 4.6h7.2l4 4v10.8H6.4z', 'M13.6 4.6v4h4', 'M9 13.2h6M9 16.2h4'],
  },
  {
    id: 'terminal',
    name: 'Terminal',
    group: 'Author',
    paths: ['M4.4 5.6h15.2v12.8H4.4z', 'm8 10 2.6 2.4L8 14.8', 'M12.8 15.2h3.6'],
  },
  {
    id: 'brackets',
    name: 'Brackets',
    group: 'Author',
    paths: ['M9.4 5.2H6.6v13.6h2.8', 'M14.6 5.2h2.8v13.6h-2.8', 'M12 9.6v4.8'],
  },
  {
    id: 'pen',
    name: 'Pen',
    group: 'Author',
    paths: ['M4.6 19.4l.9-3.7L15.8 5.4l2.8 2.8L8.3 18.5z', 'M14 7.2l2.8 2.8'],
  },
  {
    id: 'stamp',
    name: 'Stamp',
    group: 'Author',
    paths: ['M8.2 4.8h7.6l-1.4 6.4h4.2v3.6H5.4v-3.6h4.2z', 'M5.8 17.4h12.4v1.8H5.8z'],
  },
  {
    id: 'stations',
    name: 'Stations',
    group: 'Flow',
    paths: ['M6.8 14.4 10.4 8.6M13.6 8.6l3.6 5.8'],
    circles: [
      { cx: 5.4, cy: 15.6, r: 1.7 },
      { cx: 12, cy: 6.8, r: 1.7 },
      { cx: 18.6, cy: 15.6, r: 1.7 },
    ],
  },
  {
    id: 'branch',
    name: 'Branch',
    group: 'Flow',
    paths: ['M6.6 7.3v9.4', 'M17.4 7.3v2c0 2.7-2.1 4.8-4.8 4.8H6.6'],
    circles: [
      { cx: 6.6, cy: 5.6, r: 1.65 },
      { cx: 17.4, cy: 5.6, r: 1.65 },
      { cx: 6.6, cy: 18.4, r: 1.65 },
    ],
  },
  {
    id: 'merge',
    name: 'Merge',
    group: 'Flow',
    paths: ['M7 7.2v6.4c0 2.1 1.7 3.6 3.7 3.6H15.4', 'M17 7.2v8.4', 'M14.7 15.8 17 18.1l2.3-2.3'],
    circles: [
      { cx: 7, cy: 5.6, r: 1.55 },
      { cx: 17, cy: 5.6, r: 1.55 },
      { cx: 17, cy: 18.4, r: 1.55 },
    ],
  },
  {
    id: 'cycle',
    name: 'Cycle',
    group: 'Flow',
    paths: [
      'M5.9 9.6A6.7 6.7 0 0 1 18.5 11.4',
      'M18.1 14.4A6.7 6.7 0 0 1 5.5 12.6',
      'M5.4 5.8v3.8h3.8',
      'M18.6 18.2v-3.8h-3.8',
    ],
  },
  {
    id: 'switch',
    name: 'Switch',
    group: 'Flow',
    paths: [
      'M4.6 12h4.2l3-4.4h7.4',
      'M11.8 16.4h7.4',
      'M17 5.2 19.4 7.6 17 10',
      'M17 13.9l2.4 2.5-2.4 2.4',
    ],
  },
  {
    id: 'handoff',
    name: 'Handoff',
    group: 'Flow',
    paths: ['M4.3 6.9h15.4v10.2H4.3z', 'm4.3 7.6 7.7 5.2 7.7-5.2'],
  },
  {
    id: 'shield',
    name: 'Shield',
    group: 'Guard',
    paths: ['M12 4.4l6.4 2.4v5.4c0 3.6-2.6 6.2-6.4 7.4-3.8-1.2-6.4-3.8-6.4-7.4V6.8z'],
  },
  {
    id: 'shield-check',
    name: 'Shield check',
    group: 'Guard',
    paths: [
      'M12 4.4l6.4 2.4v5.4c0 3.6-2.6 6.2-6.4 7.4-3.8-1.2-6.4-3.8-6.4-7.4V6.8z',
      'm9.2 11.9 2.1 2.1 3.5-3.9',
    ],
  },
  {
    id: 'lock',
    name: 'Lock',
    group: 'Guard',
    paths: ['M7.4 10.6h9.2v8.2H7.4z', 'M9.4 10.6V8.4a2.6 2.6 0 0 1 5.2 0v2.2', 'M12 13.6v2.2'],
  },
  {
    id: 'gate',
    name: 'Gate',
    group: 'Guard',
    paths: ['M4.6 5.4h14.8', 'M4.6 8.8h14.8', 'M7 8.8v9.8', 'M17 8.8v9.8', 'M12 8.8v9.8'],
  },
  {
    id: 'flag',
    name: 'Flag',
    group: 'Guard',
    paths: ['M6.4 19.4V4.8', 'M6.4 6.1h10.4l-1.8 3.2 1.8 3.2H6.4'],
  },
  {
    id: 'bell',
    name: 'Bell',
    group: 'Signal',
    paths: [
      'M7.4 16.4h9.2c0-1.1-.4-2.4-1.1-3.3-.6-.8-.9-1.7-.9-2.8 0-2.2-1.7-4-3.6-4s-3.6 1.8-3.6 4c0 1.1-.3 2-.9 2.8-.7.9-1.1 2.2-1.1 3.3z',
      'M8.2 16.4c.9 1.5 2.4 2.3 3.8 2.3s2.9-.8 3.8-2.3',
      'M12 5.1V4.2',
    ],
  },
  {
    id: 'spark',
    name: 'Spark',
    group: 'Signal',
    paths: [
      'M12 3.8v3.6M12 16.6v3.6M4.2 12h3.6M16.2 12h3.6',
      'M6.7 6.7 9.2 9.2M14.8 14.8l2.5 2.5M17.3 6.7l-2.5 2.5M9.2 14.8l-2.5 2.5',
    ],
  },
  {
    id: 'bolt',
    name: 'Bolt',
    group: 'Signal',
    paths: ['M13.4 3.8 6.6 13.4h4.6L10.6 20.2l6.8-9.6h-4.6z'],
  },
  {
    id: 'beacon',
    name: 'Beacon',
    group: 'Signal',
    paths: ['M8.6 13.4a4.8 4.8 0 0 1 6.8 0', 'M6.2 10.8a8.2 8.2 0 0 1 11.6 0'],
    circles: [{ cx: 12, cy: 16.8, r: 1.8 }],
  },
  {
    id: 'target',
    name: 'Target',
    group: 'Signal',
    circles: [
      { cx: 12, cy: 12, r: 7.6 },
      { cx: 12, cy: 12, r: 4.2 },
      { cx: 12, cy: 12, r: 1.2 },
    ],
  },
  {
    id: 'compass',
    name: 'Compass',
    group: 'Signal',
    paths: ['m9.3 14.7 1.7-4 4-1.7-1.7 4z'],
    circles: [{ cx: 12, cy: 12, r: 7.8 }],
  },
  {
    id: 'operator',
    name: 'Operator',
    group: 'Matter',
    paths: ['M6.6 18.4c.6-3.2 2.7-4.9 5.4-4.9s4.8 1.7 5.4 4.9'],
    circles: [{ cx: 12, cy: 8, r: 2.6 }],
  },
  {
    id: 'crew',
    name: 'Crew',
    group: 'Matter',
    paths: [
      'M7.7 17.4c.5-2.7 2.2-4.1 4.3-4.1s3.8 1.4 4.3 4.1',
      'M3.3 17.4c.3-2.1 1.5-3.2 3-3.2',
      'M20.7 17.4c-.3-2.1-1.5-3.2-3-3.2',
    ],
    circles: [
      { cx: 12, cy: 6.8, r: 2.05 },
      { cx: 6.1, cy: 8.4, r: 1.65 },
      { cx: 17.9, cy: 8.4, r: 1.65 },
    ],
  },
  {
    id: 'cube',
    name: 'Cube',
    group: 'Matter',
    paths: [
      'M12 4.4 19.4 8.6v6.8L12 19.6 4.6 15.4V8.6z',
      'M4.6 8.6 12 12.8l7.4-4.2',
      'M12 12.8v6.8',
    ],
  },
  {
    id: 'store',
    name: 'Store',
    group: 'Matter',
    paths: [
      'M5.6 7.2c0-1.5 2.9-2.6 6.4-2.6s6.4 1.1 6.4 2.6-2.9 2.6-6.4 2.6S5.6 8.7 5.6 7.2z',
      'M5.6 7.2v9.6c0 1.5 2.9 2.6 6.4 2.6s6.4-1.1 6.4-2.6V7.2',
      'M18.4 12c0 1.5-2.9 2.6-6.4 2.6S5.6 13.5 5.6 12',
    ],
  },
  {
    id: 'bin',
    name: 'Work bin',
    group: 'Matter',
    paths: ['M4.6 9.1h6l1.5 1.7h7.3v8.6H4.6V9.1z', 'M4.6 12.6h14.8'],
  },
];

export const EMBLEM_BY_ID: Record<string, EmblemDef> = Object.fromEntries(
  EMBLEMS.map((e) => [e.id, e]),
);

/**
 * A first guess from the agent's own name, so the common case is one click
 * instead of a scan through forty marks.
 */
const KEYWORD_HINTS: { match: RegExp; ids: string[] }[] = [
  { match: /review|critic|audit|qa/i, ids: ['loupe', 'balance', 'shield-check', 'gauge'] },
  { match: /test|verify|check/i, ids: ['shield-check', 'target', 'gauge', 'aperture'] },
  { match: /plan|architect|design/i, ids: ['stations', 'compass', 'cube', 'switch'] },
  { match: /write|doc|scribe|author|summar/i, ids: ['quill', 'document', 'pen', 'stamp'] },
  {
    match: /build|implement|code|dev|forge|smith/i,
    ids: ['anvil', 'hammer', 'terminal', 'brackets'],
  },
  { match: /research|explore|scout|search/i, ids: ['loupe', 'compass', 'beacon', 'aperture'] },
  { match: /triage|route|dispatch/i, ids: ['switch', 'branch', 'handoff', 'merge'] },
  { match: /security|guard|policy|gate/i, ids: ['shield', 'lock', 'gate', 'flag'] },
  { match: /data|index|store|migrat/i, ids: ['store', 'cube', 'bars', 'bin'] },
  { match: /release|deploy|ship|merge/i, ids: ['merge', 'bolt', 'flag', 'cycle'] },
];

export function suggestedEmblemIds(agentName: string): string[] {
  const hit = KEYWORD_HINTS.find((h) => h.match.test(agentName));
  return hit ? hit.ids : ['operator', 'anvil', 'stations', 'spark'];
}

/** Forces the initial-letter avatar, even when a painted portrait exists. */
export const MONOGRAM_EMBLEM = 'monogram';

/** `emblem` values that point at a user upload stored under the support dir. */
export const IMAGE_EMBLEM_PREFIX = 'image:';

export type AgentMarkKind = 'monogram' | 'emblem' | 'image' | 'portrait';

export interface ResolvedAgentMark {
  kind: AgentMarkKind;
  emblemId?: string;
  imagePath?: string;
}

/**
 * How `AgentDef.emblem` is drawn. Absent or `monogram` is the initial letter.
 * A library id is stroke linework. `image:<file>` is a user upload.
 * Any other safe token is the painted portrait at `agents/<token>.png`
 * (what the shipped roster already stored as `emblem: 'refiner'`).
 */
export function resolveAgentMark(emblem: string | undefined): ResolvedAgentMark {
  if (!emblem || emblem === MONOGRAM_EMBLEM) return { kind: 'monogram' };
  if (emblem.startsWith(IMAGE_EMBLEM_PREFIX)) {
    const file = emblem.slice(IMAGE_EMBLEM_PREFIX.length);
    if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
      return { kind: 'monogram' };
    }
    return { kind: 'image', imagePath: `agent-marks/${file}` };
  }
  if (EMBLEM_BY_ID[emblem]) return { kind: 'emblem', emblemId: emblem };
  if (/^[a-z][a-z0-9_-]*$/.test(emblem)) {
    return { kind: 'portrait', imagePath: `agents/${emblem}.png` };
  }
  return { kind: 'monogram' };
}

export function markLabel(emblem: string | undefined): string {
  const mark = resolveAgentMark(emblem);
  if (mark.kind === 'image') return 'Custom image';
  if (mark.kind === 'emblem' && mark.emblemId) {
    return `Emblem · ${EMBLEM_BY_ID[mark.emblemId]?.name ?? mark.emblemId}`;
  }
  if (mark.kind === 'portrait') return 'Portrait';
  return 'Initial';
}

/** The mark a Reset returns to: painted portrait for shipped agents, else initial. */
export function defaultEmblemFor(agent: { name: string; builtin?: boolean }): string | undefined {
  return agent.builtin ? agent.name : undefined;
}

export function isDefaultMark(agent: {
  name: string;
  emblem?: string;
  builtin?: boolean;
}): boolean {
  if (agent.builtin) return resolveAgentMark(agent.emblem).kind === 'portrait';
  return resolveAgentMark(agent.emblem).kind === 'monogram';
}
