/**
 * Browser mock for window.foundry — lets `vite --config vite.web.config.ts`
 * run the renderer without Electron. No Node, no git, no disk — just enough
 * fixture data to explore the UI.
 *
 * Activated by `api.ts` when `window.foundry` is absent (i.e. in a browser).
 */
import type {
  AgentDef,
  AppSettings,
  CliDescriptor,
  DoctorCheck,
  ModelInfo,
  PipelineDef,
  ProjectDef,
  RunRow,
  EventRow,
  PhaseRow,
  UpdateStatus,
  PendingInterrupt,
} from '@shared/types.js';
import type { FoundryApi, SaveResult, EventPage, RunDetail } from '@shared/ipc-contract.js';
import { BUILTIN_AGENTS } from '../main/store/builtin-agents.js';
import { BUILTIN_PIPELINES } from '../main/store/builtin-pipelines.js';

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const MOCK_PROJECTS: ProjectDef[] = [
  {
    id: 'demo-project',
    name: 'Demo project (web preview)',
    path: '/tmp/foundry-demo',
    baseRef: 'main',
    isolation: true,
    mergePolicy: 'ask',
    commands: [{ name: 'test', argv: ['npm', 'test'] }],
    protectedPaths: [],
    allowedCommands: [],
    ownRoster: false,
    ownPipelines: false,
    addedAt: nowIso(-86_400_000),
  },
];

const MOCK_RUNS: RunRow[] = [
  {
    runId: 'run_demo_1',
    projectId: 'demo-project',
    pipelineId: 'plan-build-test',
    pipelineName: 'Plan → Build → Test',
    request: 'Add a web preview mode so the UI can be explored without Electron (demo fixture).',
    status: 'accepted',
    engineer: 'web-preview',
    worktreePath: null,
    branch: 'foundry/run_demo_1',
    baseRef: 'main',
    branchPointSha: null,
    outcomeDetail: 'Accepted: all phases passed',
    merged: false,
    archived: false,
    mode: 'oneshot',
    startedAt: nowIso(-3_600_000),
    endedAt: nowIso(-300_000),
    totalTokens: 41280,
    totalCost: 0,
    phaseSummary: [
      { name: 'plan', status: 'success', kind: 'agent' },
      { name: 'commit_plan', status: 'success', kind: 'code' },
      { name: 'build', status: 'success', kind: 'agent' },
      { name: 'test', status: 'success', kind: 'code' },
      { name: 'commit_build', status: 'success', kind: 'code' },
    ],
  },
  {
    runId: 'run_demo_2',
    projectId: 'demo-project',
    pipelineId: 'scout',
    pipelineName: 'Scout',
    request: 'Where does SettingsScreen read the brand?',
    status: 'running',
    engineer: 'web-preview',
    worktreePath: null,
    branch: 'foundry/run_demo_2',
    baseRef: 'main',
    branchPointSha: null,
    outcomeDetail: null,
    merged: false,
    archived: false,
    mode: 'oneshot',
    startedAt: nowIso(-120_000),
    endedAt: null,
    totalTokens: 1800,
    totalCost: 0,
    phaseSummary: [{ name: 'scout', status: 'running', kind: 'agent' }],
  },
];

const MOCK_PHASES: Record<string, PhaseRow[]> = {
  run_demo_1: [
    {
      phaseId: 'ph_plan_1',
      runId: 'run_demo_1',
      seq: 0,
      name: 'plan',
      kind: 'agent',
      owner: 'planner',
      description: 'Turn the request into a plan',
      status: 'success',
      attempt: 1,
      error: null,
      startedAt: nowIso(-3_500_000),
      endedAt: nowIso(-3_000_000),
    },
    {
      phaseId: 'ph_build_1',
      runId: 'run_demo_1',
      seq: 2,
      name: 'build',
      kind: 'agent',
      owner: 'builder',
      description: 'Implement the plan',
      status: 'success',
      attempt: 1,
      error: null,
      startedAt: nowIso(-2_900_000),
      endedAt: nowIso(-800_000),
    },
  ],
  run_demo_2: [
    {
      phaseId: 'ph_scout_2',
      runId: 'run_demo_2',
      seq: 0,
      name: 'scout',
      kind: 'agent',
      owner: 'scout',
      description: 'Investigate the question with evidence',
      status: 'running',
      attempt: 1,
      error: null,
      startedAt: nowIso(-110_000),
      endedAt: null,
    },
  ],
};

function defaultMockSettings(): AppSettings {
  return {
    clis: {
      droid: { path: 'droid', extraArgs: [] },
      claude: { path: 'claude', extraArgs: [] },
      codex: { path: 'codex', extraArgs: [] },
      junie: { path: 'junie', extraArgs: [] },
      grok: { path: 'grok', extraArgs: [] },
    },
    defaultCli: 'droid',
    detectCli: 'default',
    detectModel: 'inherit',
    engineerName: 'web-preview',
    defaultAutonomy: 'medium',
    defaultModel: 'claude-opus-5',
    defaultReasoningEffort: 'medium',
    pollCadenceMs: 500,
    turnTimeoutMs: 20 * 60_000,
    envelopeRetries: 3,
    gateRetries: 2,
    notifications: { accepted: true, rejected: true, failed: true, needsInput: true },
    dockBadge: true,
    appearance: 'system',
    retentionDays: null,
    onboarded: true,
  };
}

let mockSettings = defaultMockSettings();
let onboardingDone = true;

const CLIS: CliDescriptor[] = [
  {
    id: 'droid',
    label: 'Droid',
    binary: 'droid',
    docsUrl: 'https://docs.factory.ai/droid-exec/overview',
    authEnvVars: ['FACTORY_API_KEY'],
    supportsRpc: true,
    caveats: [],
  },
  {
    id: 'claude',
    label: 'Claude Code',
    binary: 'claude',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    authEnvVars: ['ANTHROPIC_API_KEY'],
    supportsRpc: false,
    caveats: ['No mid-turn tool visibility in this harness.'],
  },
  {
    id: 'codex',
    label: 'Muse',
    binary: 'codex',
    docsUrl: 'https://developers.openai.com/codex/cli',
    authEnvVars: ['OPENAI_API_KEY'],
    supportsRpc: false,
    caveats: ['Tool output is buffered until the turn ends.'],
  },
  {
    id: 'junie',
    label: 'Junie',
    binary: 'junie',
    docsUrl: 'https://www.jetbrains.com/junie/',
    authEnvVars: ['JETBRAINS_API_KEY'],
    supportsRpc: false,
    caveats: ['No headless flag is published; availability checked via filesystem.'],
  },
  {
    id: 'grok',
    label: 'Grok Code',
    binary: 'grok',
    docsUrl: 'https://docs.x.ai/docs/code',
    authEnvVars: ['XAI_API_KEY'],
    supportsRpc: false,
    caveats: [],
  },
];

export function createMockFoundryApi(): FoundryApi {
  const listeners = new Map<string, Set<(data?: unknown) => void>>();

  function on(channel: string, handler: (data?: unknown) => void): () => void {
    const set = listeners.get(channel) ?? new Set();
    set.add(handler);
    listeners.set(channel, set);
    return () => set.delete(handler);
  }

  const api: FoundryApi = {
    settings: {
      get: async () => ({ ...mockSettings, onboarded: onboardingDone }),
      patch: async (patch): Promise<SaveResult<AppSettings>> => {
        mockSettings = { ...mockSettings, ...patch };
        if (patch.onboarded !== undefined) onboardingDone = !!patch.onboarded;
        // Notify listeners (app.tsx refreshAll)
        listeners.get('settings-changed')?.forEach((h) => h(undefined));
        return { ok: true, issues: [], value: { ...mockSettings, onboarded: onboardingDone } };
      },
    },
    projects: {
      list: async () => [...MOCK_PROJECTS],
      add: async () => null,
      save: async (project): Promise<SaveResult<ProjectDef[]>> => {
        const idx = MOCK_PROJECTS.findIndex((p) => p.id === project.id);
        if (idx >= 0) MOCK_PROJECTS[idx] = project;
        return { ok: true, issues: [], value: [...MOCK_PROJECTS] };
      },
      remove: async () => [...MOCK_PROJECTS],
      export: async () => null,
      tryCommand: async () => ({
        exitCode: 0,
        passed: true,
        outputTail: '(web preview)',
        durationMs: 42,
      }),
      sniffCommands: async () => ({ commands: [], via: 'none', detail: '(web preview)' }),
      askAgentCommands: async () => ({ error: 'no agent CLI in the web preview' }),
      cancelDetection: async () => false,
      detection: async () => null,
      check: async (): Promise<DoctorCheck[]> => [
        {
          id: 'project:git',
          label: 'Git repo',
          ok: true,
          detail: MOCK_PROJECTS[0]?.path ?? '/tmp',
        },
      ],
      reveal: async () => {},
    },
    roster: {
      list: async () => [...BUILTIN_AGENTS],
      save: async (agent, _projectId): Promise<SaveResult<AgentDef[]>> => ({
        ok: true,
        issues: [],
        value: BUILTIN_AGENTS.map((a) => (a.name === agent.name ? agent : a)),
      }),
      remove: async (name) => BUILTIN_AGENTS.filter((a) => a.name !== name),
      duplicate: async (name) => {
        const found = BUILTIN_AGENTS.find((a) => a.name === name) ?? null;
        return found ? { ...found, name: `${found.name}-copy` } : null;
      },
      validate: async () => [],
      reset: async () => [...BUILTIN_AGENTS],
    },
    pipelines: {
      list: async (): Promise<PipelineDef[]> => [...BUILTIN_PIPELINES],
      save: async (pipeline): Promise<SaveResult<PipelineDef[]>> => ({
        ok: true,
        issues: [],
        value: BUILTIN_PIPELINES.map((p) => (p.id === pipeline.id ? pipeline : p)),
      }),
      remove: async (id) => BUILTIN_PIPELINES.filter((p) => p.id !== id),
      duplicate: async (id) => {
        const p = BUILTIN_PIPELINES.find((x) => x.id === id) ?? null;
        return p ? { ...p, id: `${p.id}-copy` } : null;
      },
      validate: async () => [],
      dryRun: async () => [],
      reset: async () => [...BUILTIN_PIPELINES],
    },
    catalog: {
      models: async (): Promise<ModelInfo[]> => [
        {
          id: 'claude-opus-5',
          displayName: 'Claude Opus 5',
          provider: 'anthropic',
          supportedReasoningEfforts: ['off', 'low', 'medium', 'high'],
          defaultReasoningEffort: 'high',
          isCustom: false,
          deprecated: false,
          contextWindow: 200_000,
        },
      ],
      tools: async () => [],
      clis: async () => [...CLIS],
      gates: async () => [
        { id: 'artifacts_exist', description: 'Every declared artifact exists.' },
        { id: 'files_non_empty', description: 'Artifacts have content.' },
        { id: 'diff_matches_claims', description: 'Claims match git diff.' },
      ],
      templateVariables: async () => [
        { token: '{{request}}', description: 'The original request.' },
        { token: '{{run_id}}', description: 'Run id.' },
      ],
    },
    runs: {
      start: async () => ({
        ok: false as const,
        issues: [
          {
            level: 'error' as const,
            where: 'web-preview',
            message: 'Runs cannot be started in web preview. Use the Electron app (npm run dev).',
          },
        ],
      }),
      list: async () => [...MOCK_RUNS],
      detail: async (_projectId, runId): Promise<RunDetail> => {
        const run = MOCK_RUNS.find((r) => r.runId === runId) ?? null;
        return {
          run,
          phases: run ? (MOCK_PHASES[run.runId] ?? []) : [],
          envelopes: [],
          gates: [],
          sessions: [],
          live: run?.status === 'running',
        };
      },
      events: async (_projectId, _runId, _after): Promise<EventPage> => {
        const events: EventRow[] = [
          {
            rowid: 1,
            changeId: 1,
            eventId: 'evt_web_1',
            runId: _runId,
            phaseId: MOCK_PHASES[_runId]?.[0]?.phaseId ?? null,
            parentId: null,
            type: 'log',
            name: 'web preview',
            payload: {
              line: 'This is a fixture event. Live traces stream from the Electron backend.',
            },
            tokens: 0,
            startedAt: nowIso(-60_000),
            endedAt: nowIso(-60_000),
          },
        ];
        return { events: _after < 1 ? events : [], cursor: 1 };
      },
      liveTail: async () => '(web preview — no live process)',
      promptFor: async () => '(web preview)',
      kill: async () => false,
      archive: async () => {},
      mergeWorktree: async () => ({ ok: false, detail: 'Not available in web preview.' }),
      discardWorktree: async () => ({ ok: false, detail: 'Not available in web preview.' }),
      openWorktree: async () => {},
      revealFiles: async () => {},
    },
    interrupts: {
      list: async (): Promise<PendingInterrupt[]> => [],
      answer: async () => true,
    },
    doctor: {
      run: async (): Promise<DoctorCheck[]> => [
        {
          id: 'web-preview',
          label: 'Web preview',
          ok: true,
          detail: 'UI is running without Electron. Reads and writes are mocked.',
        },
      ],
    },
    maintenance: {
      orphanWorktrees: async () => [],
      removeWorktree: async () => ({ ok: false, detail: 'Web preview' }),
      applyRetention: async () => ({ runsDeleted: 0, bytesReclaimed: 0, worktreesRemoved: 0 }),
      compact: async () => {},
    },
    app: {
      openExternal: async () => {},
      assetUrl: async (relPath) => {
        const p = relPath.replace(/^\/+/, '');
        // In web, Vite serves from /assets if present; fall back to string so img can 404 visibly.
        return `/assets/${p}`;
      },
      version: async () => '0.1.1-web',
      quit: async () => {},
      relaunch: async () => {},
    },
    updater: {
      check: async (): Promise<UpdateStatus> => ({ stage: 'idle' }),
      download: async (): Promise<UpdateStatus> => ({ stage: 'idle' }),
      quitAndInstall: async () => {},
      getStatus: async (): Promise<UpdateStatus> => ({ stage: 'idle' }),
    },
    on: on as FoundryApi['on'],
  };

  return api;
}

export function installMockFoundryIfNeeded(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.foundry || w.__foundryWebMockInstalled) return;
  w.__foundryWebMockInstalled = true;
  // Import-time side effects in mockFoundry must not synchronously import api.ts
  // again. This function is called from api.ts; keep the install synchronous.
  const mock = createMockFoundryApi();
  w.foundry = mock as unknown as never;
  if (!w.foundryMenu) {
    w.foundryMenu = {
      on() {
        return () => {};
      },
    } as never;
  }
  if (!document.title.includes('web')) document.title = `${document.title} — web preview`;
  // eslint-disable-next-line no-console
  console.info('[web] renderer running with mocked foundry API');
}
