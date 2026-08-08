/* Temporary onboarding preview harness. Not part of the app; delete when done. */
const settings = {
  onboarded: false,
  brand: 'prism',
  defaultCli: 'droid',
  engineerName: 'Nik',
};

const projects = [
  { id: 'p1', name: 'software-factory', path: '/Users/nik/repos/software-factory' },
  { id: 'p2', name: 'orca', path: '/Users/nik/repos/orca' },
];

const clis = [
  { id: 'droid', label: 'Droid', installed: true, version: '0.9.1', bin: 'droid' },
  { id: 'claude', label: 'Claude Code', installed: true, version: '1.2.0', bin: 'claude' },
  { id: 'codex', label: 'Codex', installed: false, version: '', bin: 'codex' },
  { id: 'junie', label: 'Junie', installed: true, version: '0.4.2', bin: 'junie' },
  { id: 'grok', label: 'Grok', installed: false, version: '', bin: 'grok' },
];

const checks = [
  { id: 'git', label: 'git', ok: true, blocking: true, detail: 'git version 2.48.1' },
  {
    id: 'git-user',
    label: 'git identity',
    ok: true,
    blocking: true,
    detail: 'Nik <nik@example.com>',
  },
  { id: 'node', label: 'node', ok: true, blocking: true, detail: 'v22.14.0' },
  { id: 'droid', label: 'droid CLI', ok: true, blocking: true, detail: '0.9.1' },
  { id: 'disk', label: 'disk space', ok: true, blocking: false, detail: '412 GB free' },
  {
    id: 'worktrees',
    label: 'worktree root',
    ok: true,
    blocking: false,
    detail: '~/.foundry/worktrees',
  },
];

window.foundry = {
  settings: {
    get: async () => settings,
    patch: async () => ({ ok: true, value: settings, issues: [] }),
  },
  projects: {
    list: async () => projects,
    add: async () => projects[0],
    remove: async () => undefined,
    save: async () => ({ ok: true, issues: [] }),
  },
  roster: { list: async () => [] },
  pipelines: { list: async () => [] },
  interrupts: { list: async () => [] },
  doctor: { run: async () => checks },
  catalog: { clis: async () => clis },
  app: { assetUrl: async () => '' },
  on: () => () => undefined,
} as unknown as Window['foundry'];

window.foundryMenu = { on: () => () => undefined };
