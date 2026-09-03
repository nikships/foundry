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
  DoctorCheck,
  EnvelopeDef,
  ModelInfo,
  PipelineDef,
  ProjectDef,
  RunRow,
  EventRow,
  PhaseRow,
  UpdateStatus,
  ReadinessInspectResult,
  ReadinessState,
  BaseSyncStatus,
  GeneratedRunPlan,
  LinearIssueSnapshot,
} from '@shared/types.js';
import type {
  EventPage,
  FoundryApi,
  RunDetail,
  SaveResult,
  SmithChatState,
} from '@shared/ipc-contract.js';
import { withoutHiddenModels } from '@shared/model-visibility.js';
import { BUILTIN_AGENTS } from '@shared/builtin-agents.js';
import { BUILTIN_PIPELINES } from '@shared/builtin-pipelines.js';

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const UNAVAILABLE = 'Not available in web preview.';
const NO_AGENT_CLI = 'no agent CLI in the web preview';
const WEB_PREVIEW = 'Web preview';
const PREVIEW_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function unavailable(detail = UNAVAILABLE): { ok: false; detail: string } {
  return { ok: false, detail };
}

function unavailableStart(message: string): {
  ok: false;
  issues: { level: 'error'; where: 'web-preview'; message: string }[];
} {
  return { ok: false, issues: [{ level: 'error', where: 'web-preview', message }] };
}

const ENVELOPE_EXAMPLE = {
  status: 'success',
  summary: 'one sentence on what you did',
  artifacts: ['relative/path/you/created.md'],
  notes_for_next_agent: 'what the next phase needs to know',
};

function envelopeExampleJson(extra?: Record<string, string>): string {
  return JSON.stringify({ ...ENVELOPE_EXAMPLE, ...extra }, null, 2);
}

function previewTry(durationMs = 42): {
  exitCode: number;
  passed: boolean;
  outputTail: string;
  durationMs: number;
} {
  return { exitCode: 0, passed: true, outputTail: '(web preview)', durationMs };
}

function mockBaseSync(projectId: string): BaseSyncStatus {
  return {
    projectId,
    baseRef: MOCK_PROJECTS[0]?.baseRef ?? 'main',
    remote: 'origin',
    localSha: PREVIEW_SHA,
    remoteSha: PREVIEW_SHA,
    ahead: 0,
    behind: 0,
    state: 'current',
    fetched: true,
    detail: 'main matches origin/main',
  };
}

const COMPANION_OFF = {
  running: false,
  origin: null,
  protocolVersion: 1,
  devices: [] as [],
};

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
    ownRoster: false,
    ownPipelines: false,
    addedAt: nowIso(-86_400_000),
  },
];

const MOCK_RUNS: RunRow[] = [
  {
    runId: 'run_demo_1',
    projectId: 'demo-project',
    pipelineId: 'build-pr',
    pipelineName: 'Plan → Build → Test → PR',
    request: 'Add a web preview mode so the UI can be explored without Electron (demo fixture).',
    status: 'accepted',
    engineer: 'web-preview',
    worktreePath: null,
    branch: 'foundry/run_demo_1',
    baseRef: 'main',
    branchPointSha: null,
    outcomeDetail: 'Accepted: all phases passed',
    prNumber: 12,
    prUrl: 'https://github.com/foundry-demo/demo/pull/12',
    issueNumber: null,
    issueUrl: null,
    source: null,
    sourceSyncError: null,
    merged: false,
    archived: false,
    mode: 'pi',
    orchestrated: false,
    amendments: 0,
    startedAt: nowIso(-3_600_000),
    endedAt: nowIso(-300_000),
    totalTokens: 41280,
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
    pipelineId: 'fix-pr',
    pipelineName: 'Diagnose → Fix → PR',
    request: 'SettingsScreen shows the wrong brand after a theme switch',
    status: 'running',
    engineer: 'web-preview',
    worktreePath: null,
    branch: 'foundry/run_demo_2',
    baseRef: 'main',
    branchPointSha: null,
    outcomeDetail: null,
    prNumber: null,
    prUrl: null,
    issueNumber: null,
    issueUrl: null,
    source: null,
    sourceSyncError: null,
    merged: false,
    archived: false,
    mode: 'pi',
    orchestrated: false,
    amendments: 0,
    startedAt: nowIso(-120_000),
    endedAt: null,
    totalTokens: 1800,
    phaseSummary: [{ name: 'diagnose', status: 'running', kind: 'agent' }],
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
      phaseId: 'ph_diagnose_2',
      runId: 'run_demo_2',
      seq: 0,
      name: 'diagnose',
      kind: 'agent',
      owner: 'scout',
      description: 'Locate the fault with evidence before anything changes',
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
    theme: 'dark',
    helperModel: 'inherit',
    helperReasoningEffort: 'high',
    engineerName: 'web-preview',
    prAgent: 'pr_writer',
    defaultModel: 'inherit',
    defaultReasoningEffort: 'medium',
    healingModel: 'inherit',
    healingReasoningEffort: 'medium',
    smithModel: 'inherit',
    smithReasoningEffort: 'medium',
    compactionThreshold: 0.8,
    notifications: { accepted: true, rejected: true, failed: true },
    dockBadge: true,
    retentionDays: null,
    onboarded: true,
    hiddenModelIds: [],
    linearStatusMapping: {
      started: 'linear-state-progress',
      completed: 'linear-state-done',
      failed: 'linear-state-failed',
    },
  };
}

let mockSettings = defaultMockSettings();
let onboardingDone = true;
let mockAgents: AgentDef[] = BUILTIN_AGENTS.map((a) => ({ ...a }));
let mockPipelines: PipelineDef[] = BUILTIN_PIPELINES.map((p) => ({ ...p }));

const MOCK_LINEAR_ISSUES: LinearIssueSnapshot[] = [
  {
    id: 'linear-demo-1',
    identifier: 'FOU-190',
    title: 'Add Linear ticket orchestration integration',
    description:
      'Let operators choose a Linear issue on the Runs screen and ask the Orchestrator to compose the right pipeline from its title and description.',
    url: 'https://linear.app/foundry/issue/FOU-190',
    updatedAt: nowIso(-600_000),
    team: { id: 'linear-team-demo', name: 'Foundry' },
    state: { id: 'linear-state-progress', name: 'In Progress', type: 'started' },
  },
  {
    id: 'linear-demo-2',
    identifier: 'FOU-184',
    title: 'Keep run drafts when navigating between screens',
    description: 'Preserve unfinished run input while the operator checks another Foundry screen.',
    url: 'https://linear.app/foundry/issue/FOU-184',
    updatedAt: nowIso(-3_600_000),
    team: { id: 'linear-team-demo', name: 'Foundry' },
    state: { id: 'linear-state-todo', name: 'Todo', type: 'unstarted' },
  },
  {
    id: 'linear-demo-3',
    identifier: 'DES-91',
    title: 'Tighten the run composer spacing',
    description: 'Make the composer compact without losing its hierarchy or keyboard flow.',
    url: 'https://linear.app/foundry/issue/DES-91',
    updatedAt: nowIso(-7_200_000),
    team: { id: 'linear-team-demo', name: 'Design systems' },
    state: { id: 'linear-state-review', name: 'In Review', type: 'started' },
  },
  {
    id: 'linear-demo-4',
    identifier: 'FOU-176',
    title: 'Show generated plan provenance in trace details',
    description: 'Retain issue provenance when an orchestrated plan starts the run.',
    url: 'https://linear.app/foundry/issue/FOU-176',
    updatedAt: nowIso(-86_400_000),
    team: { id: 'linear-team-demo', name: 'Foundry' },
    state: { id: 'linear-state-done', name: 'Done', type: 'completed' },
  },
  {
    id: 'linear-demo-5',
    identifier: 'PLAT-44',
    title: 'Improve stale response handling in remote pickers',
    description: 'Prevent slower search responses from replacing newer results.',
    url: 'https://linear.app/foundry/issue/PLAT-44',
    updatedAt: nowIso(-172_800_000),
    team: { id: 'linear-team-demo', name: 'Platform' },
    state: { id: 'linear-state-progress', name: 'In Progress', type: 'started' },
  },
  {
    id: 'linear-demo-6',
    identifier: 'FOU-163',
    title: 'Document run lifecycle status mapping',
    description: 'Explain how Foundry updates linked issues when runs start, complete, or fail.',
    url: 'https://linear.app/foundry/issue/FOU-163',
    updatedAt: nowIso(-432_000_000),
    team: { id: 'linear-team-demo', name: 'Foundry' },
    state: { id: 'linear-state-failed', name: 'Canceled', type: 'canceled' },
  },
];

export function createMockFoundryApi(): FoundryApi {
  const listeners = new Map<string, Set<(data?: unknown) => void>>();
  const smithStates = new Map<string, SmithChatState>();
  const orchestratorTimers = new Map<string, number[]>();
  let orchestratorSequence = 0;

  function on(channel: string, handler: (data?: unknown) => void): () => void {
    const set = listeners.get(channel) ?? new Set();
    set.add(handler);
    listeners.set(channel, set);
    return () => set.delete(handler);
  }

  const notify = (channel: string, data?: unknown): void => {
    listeners.get(channel)?.forEach((handler) => handler(data));
  };

  const smithKey = (projectId?: string): string => projectId ?? 'global';
  /** The global scope always exists; a named project must be one we know. */
  const smithScopeExists = (projectId?: string): boolean =>
    !projectId || MOCK_PROJECTS.some((project) => project.id === projectId);
  const smithSnapshot = (projectId?: string): SmithChatState => {
    const key = smithKey(projectId);
    const state =
      smithStates.get(key) ??
      ({
        ...(projectId ? { projectId } : {}),
        model: mockSettings.smithModel,
        activeModel: mockSettings.smithModel,
        reasoningEffort: mockSettings.smithReasoningEffort,
        activeReasoningEffort: mockSettings.smithReasoningEffort,
        running: false,
        error: null,
        transcript: [],
      } satisfies SmithChatState);
    smithStates.set(key, state);
    return { ...state, transcript: state.transcript.map((entry) => ({ ...entry })) };
  };

  const emitSmith = (projectId?: string): void => {
    notify('smith-progress', smithSnapshot(projectId));
  };

  /** Store a patched Smith state, push it, and hand back the fresh snapshot. */
  const putSmith = (
    projectId: string | undefined,
    patch: Partial<SmithChatState>,
  ): SmithChatState => {
    smithStates.set(smithKey(projectId), { ...smithSnapshot(projectId), ...patch });
    emitSmith(projectId);
    return smithSnapshot(projectId);
  };

  const api: FoundryApi = {
    settings: {
      get: async () => ({ ...mockSettings, onboarded: onboardingDone }),
      patch: async (patch): Promise<SaveResult<AppSettings>> => {
        mockSettings = { ...mockSettings, ...patch };
        if (patch.onboarded !== undefined) onboardingDone = !!patch.onboarded;
        notify('settings-changed');
        return { ok: true, issues: [], value: { ...mockSettings, onboarded: onboardingDone } };
      },
    },
    projects: {
      list: async () => [...MOCK_PROJECTS],
      add: async () => null,
      githubAccount: async () => ({
        available: false,
        detail: 'creating a repository needs the gh CLI, which the web preview cannot reach',
      }),
      chooseParentDir: async () => null,
      createGithub: async () => unavailable(),
      save: async (project): Promise<SaveResult<ProjectDef[]>> => {
        const idx = MOCK_PROJECTS.findIndex((p) => p.id === project.id);
        if (idx >= 0) MOCK_PROJECTS[idx] = project;
        return { ok: true, issues: [], value: [...MOCK_PROJECTS] };
      },
      remove: async () => [...MOCK_PROJECTS],
      export: async () => null,
      tryCommand: async () => previewTry(),
      sniffCommands: async () => ({ commands: [], via: 'none', detail: '(web preview)' }),
      askAgentCommands: async () => ({ error: NO_AGENT_CLI }),
      cancelDetection: async () => false,
      detection: async () => null,
      setupScriptGet: async () => '',
      setupScriptSave: async () => ({ ok: true, issues: [], value: [...MOCK_PROJECTS] }),
      setupScriptSniff: async () => ({ script: '', detail: '(web preview)', sources: [] }),
      setupScriptTry: async () => previewTry(0),
      setupScriptAskAgent: async () => ({ error: NO_AGENT_CLI }),
      setupProgress: async () => null,
      setupCancel: async () => false,
      check: async (): Promise<DoctorCheck[]> => [
        {
          id: 'project:git',
          label: 'Git repo',
          ok: true,
          detail: MOCK_PROJECTS[0]?.path ?? '/tmp',
        },
      ],
      reveal: async () => {},
      scopeCopies: async () => ({ roster: false, pipelines: false }),
      baseSyncInspect: async (id): Promise<BaseSyncStatus | null> => mockBaseSync(id),
      baseSync: async (id) => ({ ok: true, status: mockBaseSync(id) }),
      refreshContext: async (id): Promise<SaveResult<ProjectDef>> => {
        const project = MOCK_PROJECTS.find((p) => p.id === id);
        if (!project) return { ok: false, issues: [] };
        return { ok: true, issues: [], value: project };
      },
    },
    readiness: {
      inspect: async (projectId): Promise<ReadinessInspectResult | null> => ({
        projectId,
        markerValid: true,
        marker: {
          schemaVersion: 1,
          generatedAt: nowIso(-86_400_000),
          commit: 'abc1234',
          agent: { harness: 'pi', model: 'inherit', reasoningEffort: 'high' },
          verdict: 'ready',
          summary: 'Demo project is already agent-ready.',
          stack: { languages: ['typescript'], monorepo: false, packages: [] },
          criteria: [],
        },
        markerDetail: 'valid agent-ready marker',
        skipped: false,
        validatedCache: true,
        ready: true,
      }),
      evaluate: async () => ({ error: NO_AGENT_CLI }),
      makeReady: async () => ({ error: NO_AGENT_CLI }),
      cancel: async () => false,
      get: async (): Promise<ReadinessState | null> => null,
      skip: async () => null,
      retry: async () => ({ error: NO_AGENT_CLI }),
      confirmMerge: async () => null,
      dismiss: async () => false,
    },
    roster: {
      list: async () => [...mockAgents],
      staleBuiltins: async () => [],
      save: async (agent, _projectId): Promise<SaveResult<AgentDef[]>> => {
        const idx = mockAgents.findIndex((a) => a.name === agent.name);
        if (idx >= 0) mockAgents[idx] = agent;
        else mockAgents.push(agent);
        return { ok: true, issues: [], value: [...mockAgents] };
      },
      rename: async (from, to) => {
        mockAgents = mockAgents.map((a) => (a.name === from ? { ...a, name: to } : a));
        return { ok: true, issues: [], agents: [...mockAgents], forked: false };
      },
      remove: async (name) => {
        mockAgents = mockAgents.filter((a) => a.name !== name);
        return [...mockAgents];
      },
      duplicate: async (name) => {
        const found = mockAgents.find((a) => a.name === name) ?? null;
        if (!found) return null;
        const copy = { ...found, name: `${found.name}-copy` };
        mockAgents.push(copy);
        return copy;
      },
      validate: async () => [],
      preview: async (agent) =>
        envelopeExampleJson(
          Object.fromEntries(
            (agent.customFields ?? []).map((f) => [f.name, f.description || 'value']),
          ),
        ),
      reset: async (name) => {
        const shipped = BUILTIN_AGENTS.find((agent) => agent.name === name);
        if (shipped) {
          mockAgents = mockAgents.map((agent) =>
            agent.name === name ? structuredClone(shipped) : agent,
          );
        }
        return [...mockAgents];
      },
      uploadMark: async (bytesB64, mime) => {
        if (!mime.startsWith('image/')) {
          return { ok: false, error: 'Use a PNG, JPEG, WebP, GIF, or SVG image.' };
        }
        return {
          ok: true,
          emblem: `image:preview-${bytesB64.length}.${mime.split('/')[1] ?? 'png'}`,
        };
      },
      removeMark: async () => true,
    },
    envelopes: {
      list: async (): Promise<EnvelopeDef[]> => [],
      save: async (def): Promise<SaveResult<EnvelopeDef[]>> => ({
        ok: true,
        issues: [],
        value: [def],
      }),
      remove: async () => [],
      duplicate: async (name) => ({
        name: `${name}-copy`,
        description: '',
        fields: [],
      }),
      usage: async () => ({ agents: [], phases: [] }),
      validate: async () => ({
        issues: [],
        example: envelopeExampleJson(),
      }),
      preview: async () => envelopeExampleJson(),
    },
    pipelines: {
      list: async (): Promise<PipelineDef[]> => [...mockPipelines],
      staleBuiltins: async () => [],
      save: async (pipeline): Promise<SaveResult<PipelineDef[]>> => {
        const idx = mockPipelines.findIndex((p) => p.id === pipeline.id);
        if (idx >= 0) mockPipelines[idx] = pipeline;
        else mockPipelines.push(pipeline);
        return { ok: true, issues: [], value: [...mockPipelines] };
      },
      remove: async (id) => {
        mockPipelines = mockPipelines.filter((p) => p.id !== id);
        return [...mockPipelines];
      },
      duplicate: async (id) => {
        const p = mockPipelines.find((x) => x.id === id) ?? null;
        if (!p) return null;
        const copy: PipelineDef = {
          ...p,
          id: `${p.id}-copy`,
          name: `${p.name} (copy)`,
          builtin: false,
        };
        mockPipelines.push(copy);
        return copy;
      },
      validate: async () => [],
      dryRun: async () => [],
      reset: async (id) => {
        const shipped = BUILTIN_PIPELINES.find((pipeline) => pipeline.id === id);
        if (shipped) {
          mockPipelines = mockPipelines.map((pipeline) =>
            pipeline.id === id ? structuredClone(shipped) : pipeline,
          );
        }
        return [...mockPipelines];
      },
    },
    catalog: {
      gates: async () => [
        { id: 'artifacts_exist', description: 'Every declared artifact exists.' },
        { id: 'files_non_empty', description: 'Artifacts have content.' },
      ],
      templateVariables: async () => [
        { token: '{{request}}', description: 'The original request.' },
        { token: '{{run_id}}', description: 'Run id.' },
      ],
      agentModels: async (): Promise<ModelInfo[]> =>
        withoutHiddenModels(
          [
            {
              id: 'bridge-claude/claude-opus-5',
              displayName: 'Claude Opus 5',
              provider: 'claude',
              supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
              defaultReasoningEffort: 'medium',
              isCustom: true,
              deprecated: false,
              contextWindow: 1_000_000,
            },
          ],
          mockSettings.hiddenModelIds,
        ),
    },
    bridge: {
      // The web preview has no child process, so the Bridge reads as installed
      // and connected: the pane is explorable without pretending a login worked.
      state: async () => ({
        running: true,
        port: 37_717,
        pid: 4242,
        baseUrl: 'http://127.0.0.1:37717',
        providers: [
          {
            id: 'claude',
            label: 'Claude',
            icon: 'claude',
            authenticated: true,
            loginInFlight: false,
            accounts: [
              {
                id: 'claude-demo.json',
                provider: 'claude',
                label: 'demo@example.com',
                expired: false,
                disabled: false,
              },
            ],
          },
          {
            id: 'codex',
            label: 'ChatGPT (Codex)',
            icon: 'openai',
            authenticated: false,
            loginInFlight: false,
            accounts: [],
          },
        ],
      }),
      connect: async () => unavailable('Web preview cannot open a login.'),
      disconnect: async () => unavailable(WEB_PREVIEW),
      cancelLogin: async () => false,
      setApiKey: async () => unavailable(WEB_PREVIEW),
      clearApiKey: async () => unavailable(WEB_PREVIEW),
      storedKeys: async () => [{ providerId: 'anthropic', type: 'api_key' }],
    },
    linear: {
      state: async () => ({ keySet: true, detail: 'Web preview uses fixture Linear data.' }),
      setApiKey: async () => unavailable(WEB_PREVIEW),
      test: async () => ({ ok: true, detail: 'Connected to Linear (fixture).' }),
      clearApiKey: async () => unavailable(WEB_PREVIEW),
      issues: async (query) => {
        const needle = query.trim().toLowerCase();
        if (!needle) return [...MOCK_LINEAR_ISSUES];
        return MOCK_LINEAR_ISSUES.filter((issue) =>
          [issue.identifier, issue.title, issue.team.name, issue.state.name].some((value) =>
            value.toLowerCase().includes(needle),
          ),
        );
      },
      workflowStates: async () => [
        { id: 'linear-state-todo', name: 'Todo', type: 'unstarted' },
        { id: 'linear-state-progress', name: 'In Progress', type: 'started' },
        { id: 'linear-state-done', name: 'Done', type: 'completed' },
        { id: 'linear-state-failed', name: 'Canceled', type: 'canceled' },
      ],
      startRun: async () => unavailableStart(UNAVAILABLE),
    },
    runs: {
      start: async () =>
        unavailableStart(
          'Runs cannot be started in web preview. Use the Electron app (npm run dev).',
        ),
      resume: async () => unavailable(),
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
      contextBreakdown: async () => ({ breakdown: null, reason: 'not_live' as const }),
      promptFor: async () => '(web preview)',
      artifactsFor: async () => ({
        files: [
          {
            path: 'specs/web-preview-plan.md',
            content:
              '# Web preview plan\n\nThis is a fixture document. A real run reads the file its plan phase wrote in the run worktree.\n',
            bytes: 132,
            truncated: false,
          },
        ],
        missing: [],
      }),
      kill: async () => false,
      archive: async () => {},
      mergeWorktree: async () => unavailable(),
      fixMerge: async () => unavailable(),
      discardWorktree: async () => unavailable(),
      openWorktree: async () => {},
      revealFiles: async () => {},
      plan: async () => null,
      exportPlan: async () => unavailableStart(UNAVAILABLE),
      restorableCheckpoints: async (_projectId, runId) => ({
        runId,
        refusal: 'no_checkpoints' as const,
        detail: UNAVAILABLE,
        checkpoints: [],
      }),
      restoreCheckpoint: async () => ({
        ok: false,
        refusal: 'worktree_missing' as const,
        detail: UNAVAILABLE,
      }),
    },
    orchestrator: {
      plan: async (projectId, prompt, model, reasoningEffort) => {
        const planId = `web-plan-${++orchestratorSequence}`;
        const pipeline = mockPipelines[0]!;
        const plan: GeneratedRunPlan = {
          planId,
          projectId,
          prompt,
          refinedRequest: `${prompt}\n\nPreserve the linked Linear issue context and include focused verification evidence.`,
          rationale:
            'The issue spans implementation and verification, so the Orchestrator selected the standard build pipeline.',
          pipeline,
          agents: [],
          warnings: [],
          model,
          reasoningEffort,
        };
        const startedAt = Date.now();
        const emit = (status: 'running' | 'done', detail: string): void => {
          notify('orchestrator-progress', {
            planId,
            projectId,
            status,
            model,
            reasoningEffort,
            prompt,
            entries: [],
            plan: status === 'done' ? plan : null,
            rawReply: '',
            detail,
            startedAt,
            ...(status === 'done' ? { endedAt: Date.now() } : {}),
          });
        };
        const timers = [
          window.setTimeout(() => emit('running', 'Reading the issue and choosing phases…'), 40),
          window.setTimeout(() => emit('done', 'Plan ready.'), 500),
        ];
        orchestratorTimers.set(planId, timers);
        return { planId };
      },
      cancel: async (planId) => {
        const timers = orchestratorTimers.get(planId);
        if (!timers) return false;
        timers.forEach((timer) => window.clearTimeout(timer));
        orchestratorTimers.delete(planId);
        return true;
      },
    },
    prs: {
      status: async () => ({
        available: true,
        detail: 'web preview — fixture data',
        repo: 'foundry-demo/demo',
      }),
      list: async () => ({
        ok: true,
        detail: '2 open',
        prs: [
          {
            number: 12,
            title: 'Add a web preview mode so the UI can be explored without Electron',
            url: 'https://github.com/foundry-demo/demo/pull/12',
            author: 'foundry-bot',
            headRefName: 'foundry/run_demo_1',
            baseRefName: 'main',
            createdAt: nowIso(-1_800_000),
            additions: 412,
            deletions: 37,
            isDraft: false,
            checks: 'passing' as const,
            mergeable: 'mergeable' as const,
            reviewDecision: 'APPROVED',
          },
          {
            number: 9,
            title: 'Sketch: retention sweeps for orphaned worktrees',
            url: 'https://github.com/foundry-demo/demo/pull/9',
            author: 'nikships',
            headRefName: 'retention-sweeps',
            baseRefName: 'main',
            createdAt: nowIso(-86_400_000 * 2),
            additions: 128,
            deletions: 12,
            isDraft: true,
            checks: 'pending' as const,
            mergeable: 'unknown' as const,
            reviewDecision: '',
          },
        ],
      }),
      create: async () => unavailable(),
      merge: async () => unavailable(),
      fixConflicts: async () => unavailable(),
    },
    smith: {
      send: async (projectId, text) => {
        if (!smithScopeExists(projectId)) return null;
        const at = Date.now();
        const asked = putSmith(projectId, {
          running: true,
          error: null,
          transcript: [
            ...smithSnapshot(projectId).transcript,
            { id: `operator-${at}`, kind: 'text', text, source: 'operator', at },
          ],
        });
        // A canned turn that exercises the chat's visual language: a folded
        // tool row, a readiness sub-agent block, and a text answer.
        return putSmith(projectId, {
          running: false,
          transcript: [
            ...asked.transcript,
            {
              id: `smith-tool-${at}`,
              kind: 'tool',
              text: 'read AGENTS.md',
              toolKind: 'read',
              done: true,
              source: 'smith',
              at,
            },
            {
              id: `readiness-${at}`,
              kind: 'note',
              text: 'Readiness agent: checklist evaluated, 9 of 11 criteria pass.',
              source: 'readiness',
              at,
            },
            {
              id: `smith-${at}`,
              kind: 'text',
              text: 'Web preview: Smith is ready to help with this project.',
              source: 'smith',
              at,
            },
          ],
        });
      },
      cancel: async (projectId) => putSmith(projectId, { running: false }),
      newChat: async (projectId) =>
        smithScopeExists(projectId)
          ? putSmith(projectId, { running: false, error: null, transcript: [] })
          : null,
      state: async (projectId) => (smithScopeExists(projectId) ? smithSnapshot(projectId) : null),
      setModel: async (projectId, model) =>
        smithScopeExists(projectId) ? putSmith(projectId, { model, activeModel: model }) : null,
      setReasoningEffort: async (projectId, effort) =>
        smithScopeExists(projectId)
          ? putSmith(projectId, { reasoningEffort: effort, activeReasoningEffort: effort })
          : null,
      proposalsList: async () => [],
      answerProposal: async () => ({ ok: false, error: 'proposal not found' }),
    },
    companion: {
      // The web preview has no network host to bind; the pane renders "off".
      state: async () => ({ ...COMPANION_OFF, detail: UNAVAILABLE }),
      start: async () => ({ ...COMPANION_OFF, detail: UNAVAILABLE }),
      stop: async () => ({ ...COMPANION_OFF }),
      pairingPayload: async () => null,
      unpair: async () => false,
    },
    doctor: {
      run: async (): Promise<DoctorCheck[]> => [
        {
          id: 'bridge',
          label: 'Provider bridge',
          ok: true,
          detail: 'serving on http://127.0.0.1:37717',
        },
        {
          id: 'agent-models',
          label: 'Usable models',
          ok: true,
          detail: '1 model available, including Claude Opus 5',
          blocking: true,
        },
        {
          id: 'provider:claude',
          label: 'Claude account',
          ok: true,
          detail: 'signed in',
        },
        {
          id: 'toolchain-path',
          label: 'Toolchain PATH',
          ok: true,
          detail:
            'resolved from your login shell; found node, npm, pnpm, bun, cargo, go, uv, swift',
        },
        {
          id: 'git',
          label: 'git',
          ok: true,
          detail: 'git version 2.55.0',
          blocking: true,
        },
        {
          id: 'gh',
          label: 'GitHub CLI',
          ok: true,
          detail: 'gh version 2.97.0 (2025-07-31)',
        },
        {
          id: 'gh:auth',
          label: 'GitHub CLI authentication',
          ok: true,
          detail: 'signed in',
        },
        {
          id: 'macos',
          label: 'macOS 26 or newer',
          ok: true,
          detail: 'darwin 27.0.0',
        },
      ],
    },
    maintenance: {
      orphanWorktrees: async () => [],
      removeWorktree: async () => unavailable(WEB_PREVIEW),
      removeAllWorktrees: async () => unavailable(WEB_PREVIEW),
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
  if (window.foundry || window.__foundryWebMockInstalled) return;
  window.__foundryWebMockInstalled = true;
  // Import-time side effects in mockFoundry must not synchronously import api.ts
  // again. This function is called from api.ts; keep the install synchronous.
  window.foundry = createMockFoundryApi();
  if (!window.foundryMenu) {
    window.foundryMenu = {
      on() {
        return () => {};
      },
    };
  }
  if (!document.title.includes('web')) document.title = `${document.title} — web preview`;
  console.warn('[web] renderer running with mocked foundry API');
}
