/**
 * The Orchestrator's planning session: a thin ask-and-parse strategy on
 * PanelSession, modeled on detection and setup generation.
 *
 * Planning is not a run: no worktree, no pipeline yet, no trace rows. The
 * session opens read-only at the project checkout on the operator-chosen
 * model, asks for a plan, and pushes progress over `orchestrator-progress`.
 * A turn that does not submit a schema-valid result, or whose result fails the
 * store/preflight rails, goes back as a correction bounded by the same
 * `envelopeRetries` budget an envelope gets. A plan that cannot validate
 * within budget fails the session and never reaches the card.
 */

import type {
  AgentDef,
  EnvelopeDef,
  ModelInfo,
  PlanImageAttachment,
  ProjectCommand,
  ReasoningEffort,
  ValidationIssue,
} from '@shared/types.js';
import { FIXED_ENGINE_DEFAULTS } from '@shared/types.js';
import type { OrchestratorState } from '@shared/ipc-contract.js';
import { modelLabel } from '@shared/model-label.js';
import type { OneShotFactory, OneShotResult } from '../pi/oneshot.js';
import {
  PanelSession,
  createPanelRegistry,
  shortId,
  type PanelRegistry,
} from '../session/index.js';
import {
  ORCHESTRATOR_PROMPT,
  buildPlanPrompt,
  checkPlanRails,
  configuredCastModels,
  parsePlanReply,
  planOutputFormat,
  planCorrection,
  toGeneratedPlan,
  type ParsedPlanReply,
  type PlanPromptInputs,
} from './plan.js';

export type { OrchestratorState };

export interface PlanSessionDeps {
  projectId: string;
  projectPath: string;
  prompt: string;
  /** Model id, or `inherit` to let this install choose. */
  model: string;
  /** Settings → Agent Defaults model, snapshotted when planning starts. */
  defaultModel: string;
  reasoningEffort: ReasoningEffort;
  contextSummary: string;
  commands: ProjectCommand[];
  roster: AgentDef[];
  envelopeDefs: EnvelopeDef[];
  scaffold?: boolean;
  /** In-memory planning attachments. Never copied onto OrchestratorState. */
  images?: PlanImageAttachment[];
  /**
   * The models this install can reach, minus the operator's hidden ones. Read
   * in the background alongside gh, because building pi's runtime is the
   * expensive part of answering it and a click must not wait on either.
   */
  enabledModels?: () => Promise<ModelInfo[]>;
  /** Resolved in the background so opening the planning panel stays immediate. */
  ghAvailable?: () => Promise<boolean>;
  /** How each turn is opened. Injected so a test drives one with no model. */
  oneShot: OneShotFactory;
  onChange: (state: OrchestratorState) => void;
}

export type PlanStart = Omit<PlanSessionDeps, 'onChange' | 'oneShot'>;

export class PlanSession {
  // Kebab rather than the usual underscore id: the generated pipeline is
  // `generated-<planId>` and must pass the store's kebab-case id rail.
  readonly planId = `plan-${shortId()}`;
  private readonly panel: PanelSession<OrchestratorState>;

  constructor(private readonly deps: PlanSessionDeps) {
    this.panel = new PanelSession<OrchestratorState>(
      {
        planId: this.planId,
        projectId: deps.projectId,
        status: 'running',
        model: deps.model,
        reasoningEffort: deps.reasoningEffort,
        prompt: deps.prompt,
        entries: [],
        plan: null,
        rawReply: '',
        detail: 'starting',
        startedAt: Date.now(),
      },
      {
        onChange: deps.onChange,
        clone: (state) => ({ ...state, plan: state.plan ? structuredClone(state.plan) : null }),
        isTerminal: (state) => state.status === 'done' || state.status === 'failed',
        applyCancel: (state) => {
          state.status = 'cancelled';
          state.detail = 'cancelled';
        },
        applyFail: (state, message) => {
          state.status = 'failed';
          state.detail = message;
        },
      },
    );
  }

  snapshot(): OrchestratorState {
    return this.panel.snapshot();
  }

  cancel(): void {
    this.panel.cancel();
  }

  /** Never rejects: the caller is a click, so a failure becomes state. */
  async run(): Promise<void> {
    try {
      await this.ask();
    } catch (e) {
      this.panel.fail((e as Error).message);
    }
    this.panel.finish();
  }

  private async planningFacts(): Promise<{
    ghAvailable: boolean | undefined;
    enabledModels: ModelInfo[];
  }> {
    if (this.deps.ghAvailable) {
      this.panel.push({ kind: 'note', text: 'Checking whether this run can finish on GitHub…' });
    }
    if (this.deps.enabledModels) {
      this.panel.push({ kind: 'note', text: 'Reading the models this install can reach…' });
    }
    const [ghAvailable, enabledModels] = await Promise.all([
      this.deps.ghAvailable?.(),
      this.deps.enabledModels?.() ?? Promise.resolve([] as ModelInfo[]),
    ]);
    return { ghAvailable, enabledModels };
  }

  private async ask(): Promise<void> {
    const { model } = this.deps;
    const state = this.panel.state;
    const { ghAvailable, enabledModels } = await this.planningFacts();
    if (this.panel.cancelled) return;

    const castPool = configuredCastModels(enabledModels, {
      defaultModel: this.deps.defaultModel,
      orchestratorModel: model,
    });
    const allowedModelIds = castPool.models.map((candidate) => candidate.id);
    const promptInputs: PlanPromptInputs = {
      request: this.deps.prompt,
      contextSummary: this.deps.contextSummary,
      commands: this.deps.commands,
      roster: this.deps.roster,
      envelopeDefs: this.deps.envelopeDefs,
      models: castPool.models,
      preferredModelIds: castPool.preferredModelIds,
      ghAvailable,
      attachedImageCount: this.deps.images?.length ?? 0,
    };

    // One parse-or-correct budget covers both the JSON shape and the rails,
    // exactly as an envelope's parser and validator share one budget.
    const basePrompt = buildPlanPrompt(promptInputs);
    let ask = basePrompt;
    const attempts = 1 + FIXED_ENGINE_DEFAULTS.envelopeRetries;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.noteAttempt(attempt, attempts, model);
      const turn = await this.askTurn(ask, model);
      if (!turn) return;
      const structuredReply = turn.structuredOutput ? JSON.stringify(turn.structuredOutput) : null;
      state.rawReply = structuredReply ?? turn.text;
      const accepted = this.applyTurn(turn, {
        model,
        allowedModelIds,
        allowedModels: castPool.models,
        basePrompt,
        structuredReply,
        setAsk: (next) => {
          ask = next;
        },
      });
      if (accepted) return;
    }

    this.panel.fail(`the Orchestrator could not produce a valid plan within ${attempts} attempts`);
  }

  private noteAttempt(attempt: number, attempts: number, model: string): void {
    this.panel.push({
      kind: 'note',
      text:
        attempt === 1
          ? `Asking the Orchestrator${model === 'inherit' ? '' : ` (${modelLabel(model)})`}…`
          : `Sending the validation errors back (attempt ${attempt} of ${attempts})…`,
    });
  }

  private askTurn(prompt: string, model: string): Promise<OneShotResult | null> {
    // The Orchestrator reads the operator's own checkout, where nothing
    // would revert a write, so the session has no tool that could make one.
    return this.panel.ask({
      oneShot: this.deps.oneShot,
      cwd: this.deps.projectPath,
      access: 'read',
      model,
      reasoningEffort: this.deps.reasoningEffort,
      systemPrompt: ORCHESTRATOR_PROMPT,
      outputFormat: planOutputFormat(),
      prompt,
      ...(this.deps.images?.length ? { images: this.deps.images } : {}),
    });
  }

  private applyTurn(
    turn: OneShotResult,
    opts: {
      model: string;
      allowedModelIds: string[];
      allowedModels: ModelInfo[];
      basePrompt: string;
      structuredReply: string | null;
      setAsk: (next: string) => void;
    },
  ): boolean {
    const parsed = parsePlanReply(turn.structuredOutput, this.planId);
    const rails = parsed.ok
      ? checkPlanRails(parsed.reply, {
          roster: this.deps.roster,
          commandNames: this.deps.commands.map((c) => c.name),
          knownEnvelopes: this.deps.envelopeDefs.map((e) => e.name),
          allowedModelIds: opts.allowedModelIds,
          allowedModels: opts.allowedModels,
          scaffold: this.deps.scaffold,
          request: this.deps.prompt,
        })
      : null;
    if (parsed.ok && rails?.ok) {
      this.acceptPlan(parsed.reply, rails.warnings, opts.model);
      return true;
    }
    const issues = parsed.ok ? (rails && !rails.ok ? rails.issues : []) : parsed.issues;
    for (const issue of issues) {
      this.panel.push({ kind: 'note', text: `Rejected: ${issue.where}: ${issue.message}` });
    }
    // A one-shot owns exactly one turn, so the correction opens a fresh
    // session. Restate both the original context and the rejected reply;
    // otherwise that fresh session would see only errors from a plan it had
    // never seen and could not repair them coherently.
    opts.setAsk(
      correctionPrompt(
        opts.basePrompt,
        opts.structuredReply ?? `(submit_result was not called)\n${turn.text}`,
        issues,
      ),
    );
    return false;
  }

  private acceptPlan(reply: ParsedPlanReply, warnings: ValidationIssue[], model: string): void {
    const state = this.panel.state;
    state.plan = toGeneratedPlan({
      planId: this.planId,
      projectId: this.deps.projectId,
      prompt: this.deps.prompt,
      reply,
      warnings,
      model,
      reasoningEffort: this.deps.reasoningEffort,
    });
    state.status = 'done';
    state.detail = warnings.length
      ? `plan ready, with ${warnings.length} warning(s)`
      : 'plan ready';
  }
}

function correctionPrompt(basePrompt: string, previous: string, issues: ValidationIssue[]): string {
  return [
    basePrompt,
    '',
    '## Previous reply rejected by Foundry',
    previous,
    '',
    planCorrection(issues),
  ].join('\n');
}

export function createPlans(
  oneShot: OneShotFactory,
  onProgress: (state: OrchestratorState) => void,
): PanelRegistry<PlanStart, OrchestratorState> {
  return createPanelRegistry({
    create: (deps, onChange) => new PlanSession({ ...deps, oneShot, onChange }),
    idOf: (session) => session.planId,
    snapshot: (session) => session.snapshot(),
    isLive: (state) => state.status === 'running',
    run: (session) => session.run(),
    onProgress,
  });
}
