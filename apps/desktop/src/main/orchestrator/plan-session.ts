/**
 * The Orchestrator's planning session: a thin ask-and-parse strategy on
 * PanelSession, modeled on detection and setup generation.
 *
 * Planning is not a run: no worktree, no pipeline yet, no trace rows. The
 * session opens read-only at the project checkout on the operator-chosen
 * model, asks for a plan, and pushes progress over `orchestrator-progress`.
 * A reply that fails the strict-JSON parse or the store/preflight rails goes
 * back as a correction, bounded by the same `envelopeRetries` budget an
 * envelope gets; a plan that cannot validate within budget fails the session
 * and never reaches the card.
 */

import type {
  AgentDef,
  EnvelopeDef,
  ModelInfo,
  ProjectCommand,
  ReasoningEffort,
} from '@shared/types.js';
import { FIXED_ENGINE_DEFAULTS } from '@shared/types.js';
import type { OrchestratorState } from '@shared/ipc-contract.js';
import { modelLabel } from '@shared/model-label.js';
import type { OneShotFactory } from '../pi/oneshot.js';
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
  parsePlanReply,
  planCorrection,
  toGeneratedPlan,
  type PlanPromptInputs,
} from './plan.js';

export type { OrchestratorState };

export interface PlanSessionDeps {
  projectId: string;
  projectPath: string;
  prompt: string;
  /** Model id, or `inherit` to let this install choose. */
  model: string;
  reasoningEffort: ReasoningEffort;
  contextSummary: string;
  commands: ProjectCommand[];
  roster: AgentDef[];
  envelopeDefs: EnvelopeDef[];
  scaffold?: boolean;
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

  private async ask(): Promise<void> {
    const { model } = this.deps;
    const state = this.panel.state;
    let ghAvailable: boolean | undefined;
    if (this.deps.ghAvailable) {
      this.panel.push({ kind: 'note', text: 'Checking whether this run can finish on GitHub…' });
      ghAvailable = await this.deps.ghAvailable();
      if (this.panel.cancelled) return;
    }
    let models: ModelInfo[] = [];
    if (this.deps.enabledModels) {
      this.panel.push({ kind: 'note', text: 'Reading the models this install can reach…' });
      models = await this.deps.enabledModels();
      if (this.panel.cancelled) return;
    }
    const enabledModelIds = models.map((m) => m.id);
    const promptInputs: PlanPromptInputs = {
      request: this.deps.prompt,
      contextSummary: this.deps.contextSummary,
      commands: this.deps.commands,
      roster: this.deps.roster,
      envelopeDefs: this.deps.envelopeDefs,
      models,
      ghAvailable,
    };

    // One parse-or-correct budget covers both the JSON shape and the rails,
    // exactly as an envelope's parser and validator share one budget.
    let ask = buildPlanPrompt(promptInputs);
    const attempts = 1 + FIXED_ENGINE_DEFAULTS.envelopeRetries;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.panel.push({
        kind: 'note',
        text:
          attempt === 1
            ? `Asking the Orchestrator${model === 'inherit' ? '' : ` (${modelLabel(model)})`}…`
            : `Sending the validation errors back (attempt ${attempt} of ${attempts})…`,
      });

      // The Orchestrator reads the operator's own checkout, where nothing
      // would revert a write, so the session has no tool that could make one.
      const turn = await this.panel.ask({
        oneShot: this.deps.oneShot,
        cwd: this.deps.projectPath,
        access: 'read',
        model,
        reasoningEffort: this.deps.reasoningEffort,
        systemPrompt: ORCHESTRATOR_PROMPT,
        prompt: ask,
      });
      if (!turn) return;
      state.rawReply = turn.text;

      const parsed = parsePlanReply(turn.text, this.planId);
      const rails = parsed.ok
        ? checkPlanRails(parsed.reply, {
            roster: this.deps.roster,
            commandNames: this.deps.commands.map((c) => c.name),
            knownEnvelopes: this.deps.envelopeDefs.map((e) => e.name),
            enabledModelIds,
            scaffold: this.deps.scaffold,
          })
        : null;

      if (parsed.ok && rails?.ok) {
        state.plan = toGeneratedPlan({
          planId: this.planId,
          projectId: this.deps.projectId,
          prompt: this.deps.prompt,
          reply: parsed.reply,
          warnings: rails.warnings,
          model,
          reasoningEffort: this.deps.reasoningEffort,
        });
        state.status = 'done';
        state.detail = rails.warnings.length
          ? `plan ready, with ${rails.warnings.length} warning(s)`
          : 'plan ready';
        return;
      }

      const issues = parsed.ok ? (rails && !rails.ok ? rails.issues : []) : parsed.issues;
      for (const issue of issues) {
        this.panel.push({ kind: 'note', text: `Rejected: ${issue.where}: ${issue.message}` });
      }
      // A one-shot owns exactly one turn, so the correction opens a fresh
      // session. Restate both the original context and the rejected reply;
      // otherwise that fresh session would see only errors from a plan it had
      // never seen and could not repair them coherently.
      ask = [
        buildPlanPrompt(promptInputs),
        '',
        '## Previous reply rejected by Foundry',
        turn.text,
        '',
        planCorrection(issues),
      ].join('\n');
    }

    this.panel.fail(`the Orchestrator could not produce a valid plan within ${attempts} attempts`);
  }
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
