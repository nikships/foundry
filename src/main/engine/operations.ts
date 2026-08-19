/**
 * Run operations shared by the renderer's IPC seam and the companion host.
 * One implementation, two callers: the desktop window and a paired phone go
 * through the same start, page, and PR-create paths, so there is no second
 * engine to drift. Deps are narrow functions rather than `AppContext`, which
 * is also what lets a test drive these with real stores and a scripted
 * transport.
 */

import type {
  AgentDef,
  AppSettings,
  EnvelopeDef,
  PipelineDef,
  ProjectDef,
  StartRunInput,
  ValidationIssue,
} from '@shared/types.js';
import type { EventPage, PrAction, RunDetail } from '@shared/ipc-contract.js';
import { manualPrDraft, type ResolvedPrDraft } from '@shared/pr-draft.js';
import type { Tracer } from '../trace/tracer.js';
import type { OneShotFactory } from '../pi/oneshot.js';
import { DETECT_PROMPT, parseDetectReply } from './detect.js';
import { ensureMissingCommands, missingCommandRefs, preflightForRun } from './preflight.js';
import * as ghLib from '../system/gh.js';
import type { GhOptions } from '../system/gh.js';

/** Matches `DetectSession`: the same question deserves the same patience. */
const DETECT_FILL_TIMEOUT_MS = 300_000;

export interface StartRunOutcome {
  ok: boolean;
  runId?: string;
  issues: ValidationIssue[];
}

export interface StartRunDeps {
  projectById(id: string): ProjectDef | null;
  pipelineFor(projectId: string, pipelineId: string): PipelineDef | null;
  rosterFor(projectId: string): AgentDef[];
  envelopeDefs(): EnvelopeDef[];
  settings(): AppSettings;
  /** Persists the project and returns the row as it now reads. */
  saveProject(next: ProjectDef): ProjectDef;
  oneShot: OneShotFactory;
  registry: {
    start(input: {
      project: ProjectDef;
      pipeline: PipelineDef;
      agents: AgentDef[];
      envelopeDefs: EnvelopeDef[];
      request: string;
    }): string;
  };
}

const noIssues: ValidationIssue[] = [];

function startError(where: string, message: string): StartRunOutcome {
  return { ok: false, issues: [{ level: 'error', where, message }] };
}

export async function startRun(deps: StartRunDeps, input: StartRunInput): Promise<StartRunOutcome> {
  let project = deps.projectById(input.projectId);
  if (!project) return startError('project', 'project not found');
  const pipeline = deps.pipelineFor(input.projectId, input.pipelineId);
  if (!pipeline) return startError('pipeline', 'pipeline not found');
  if (!input.request.trim()) return startError('request', 'a run needs a request');
  const agents = deps.rosterFor(input.projectId);

  // Missing project commands are a deterministic fail mid-run. Fill them from
  // manifests (free), then the default CLI, before refusing to start.
  const missing = missingCommandRefs(pipeline, project);
  if (missing.length) {
    const projectPath = project.path;
    // A project Foundry created empty has nothing for an agent to find, so
    // asking one costs a turn to learn what is already known. Manifest
    // sniffing still runs: it is free, and it starts answering the moment a
    // run writes the first package.json.
    const scaffold = project.scaffold === true;
    const ensured = await ensureMissingCommands(project, missing, {
      useAgent: !scaffold,
      detectWithAgent: async () => {
        const settings = deps.settings();
        // Start-time fill honours the operator's detection model, so what
        // answers here is what the Project pane says will answer.
        const model = settings.detectModel || 'inherit';
        // Same read-only session detection itself opens: this runs against
        // the operator's checkout, and nothing would revert a write there.
        const session = deps.oneShot({
          cwd: projectPath,
          access: 'read',
          model,
          reasoningEffort: model === 'inherit' ? 'off' : settings.defaultReasoningEffort,
          systemPrompt: DETECT_PROMPT,
        });
        const turn = await session.send(
          'Inspect this repository and report the verification commands.',
          DETECT_FILL_TIMEOUT_MS,
        );
        return parseDetectReply(turn.text).commands;
      },
      save: (next) => {
        // Finding a command means the project has grown real code, so it is
        // no longer a scaffold: from here it gets the strict treatment, and a
        // later missing command is a misconfiguration again.
        const settled = next.scaffold ? { ...next, scaffold: false } : next;
        return deps.saveProject(settled);
      },
    });
    project = ensured.project;
  }

  const knownEnvelopes = deps.envelopeDefs().map((e) => e.name);
  const issues = preflightForRun(
    pipeline,
    agents,
    project.commands.map((c) => c.name),
    knownEnvelopes,
    { scaffold: project.scaffold === true },
  );
  if (issues.some((i) => i.level === 'error')) return { ok: false, issues };
  const runId = deps.registry.start({
    project,
    pipeline,
    agents,
    envelopeDefs: deps.envelopeDefs(),
    request: input.request,
  });
  return { ok: true, runId, issues: noIssues };
}

export const emptyRunDetail: RunDetail = {
  run: null,
  phases: [],
  envelopes: [],
  gates: [],
  sessions: [],
  live: false,
};

export function runDetail(tracer: Tracer, runId: string, live: boolean): RunDetail {
  return {
    run: tracer.run(runId),
    phases: tracer.phases(runId),
    envelopes: tracer.envelopes(runId),
    gates: tracer.gateResults(runId),
    sessions: tracer.agentSessions(runId),
    live,
  };
}

export function eventPage(tracer: Tracer, runId: string, afterChangeId: number): EventPage {
  const events = tracer.eventsAfter(runId, afterChangeId);
  // Rows arrive in creation order, so the next cursor is the max revision
  // served, not the last row's: a page boundary must not skip a row whose
  // update landed out of rowid order.
  const cursor = events.length
    ? Math.max(afterChangeId, ...events.map((e) => e.changeId))
    : afterChangeId;
  return { events, cursor };
}

export interface CreatePrDeps {
  project: ProjectDef;
  tracer: Tracer;
  notifyRuns(): void;
  /** Test seam: the fake gh script stands in for the real binary. */
  gh?: GhOptions;
}

/** The title/body `createRunPr` would send if the caller left them empty. */
export function runPrDraft(tracer: Tracer, runId: string): ResolvedPrDraft | null {
  const run = tracer.run(runId);
  if (!run) return null;
  return manualPrDraft(run, tracer.envelopes(runId), tracer.phases(runId));
}

export async function createRunPr(
  deps: CreatePrDeps,
  runId: string,
  title: string,
  body: string,
): Promise<PrAction> {
  const { project, tracer } = deps;
  const run = tracer.run(runId);
  if (!run?.branch) return { ok: false, detail: 'this run has no branch to open a PR from' };
  if (run.prUrl) {
    return {
      ok: true,
      detail: `a pull request already exists for this run: ${run.prUrl}`,
      number: run.prNumber ?? undefined,
      url: run.prUrl,
    };
  }

  const draft = runPrDraft(tracer, runId);
  const result = await ghLib.openPr(
    project.path,
    {
      branch: run.branch,
      baseRef: run.baseRef ?? project.baseRef,
      title: title.trim() || draft?.title || `${run.pipelineName}: ${run.request.slice(0, 72)}`,
      body: body.trim() !== '' ? body : (draft?.body ?? body),
    },
    deps.gh ?? {},
  );
  if (result.ok && result.number && result.url) tracer.setPr(runId, result.number, result.url);
  tracer.event({
    runId,
    type: 'log',
    name: 'pr create',
    payload: { detail: result.detail },
  });
  deps.notifyRuns();
  return result;
}
