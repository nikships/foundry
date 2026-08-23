/**
 * Readiness onboarding state machine. Not a run: no tracer, no pipeline, no
 * zero-interrupt policy. Progress is pushed like a detection session.
 *
 * The transcript ring, cancel flag, and snapshot clone live on PanelSession.
 * Git, worktree, PR, and marker steps stay here — they are not a one-shot.
 */

import type {
  AppSettings,
  ProjectDef,
  ReadinessEntry,
  ReadinessEvaluation,
  ReadinessPhase,
  ReadinessState,
  ReasoningEffort,
} from '@shared/types.js';
import type { PrAction } from '@shared/ipc-contract.js';
import { currentBranch, fastForwardBase, headSha, preferredRemote } from '../engine/git.js';
import { PanelSession, shortId } from '../session/panel-session.js';
import { evaluateRepo } from './evaluate.js';
import { ensureMarkerIgnored } from './ignore.js';
import {
  AGENT_READY_PATH,
  markerFromEvaluation,
  readMarkerAtBaseRef,
  writeMarker,
  type MarkerRead,
} from './marker.js';
import { mergeCheckFromView, pollPrMerged, type MergeCheck, type PrMergeView } from './merge.js';
import { resolveReadinessModel } from './remediator.js';
import {
  commitReadinessWork,
  createReadinessWorktree,
  discardReadinessWorktree,
  type ReadinessWorktree,
} from './worktree.js';

export interface ReadinessRemediator {
  run(job: {
    cwd: string;
    evaluation: ReadinessEvaluation;
    model: string;
    reasoningEffort: ReasoningEffort;
    /** Same isolated worktree as a previous remediator turn. */
    continuation?: boolean;
    /** 1-based remediator attempt on this session. */
    attempt?: number;
    /** Recent transcript notes so a fresh one-shot does not redo passing work. */
    priorSummary?: string;
    /** Returns the live entry so stream absorption can patch text and tool status. */
    onEntry: (entry: Omit<ReadinessEntry, 'id' | 'at'>) => ReadinessEntry;
    /** Re-emit after an in-place patch (text delta, tool result). */
    flush: () => void;
    signal: { cancelled: boolean };
  }): Promise<{ ok: boolean; detail: string }>;
}

export interface ReadinessIo {
  remediator?: ReadinessRemediator;
  openPr?: (
    repo: string,
    input: { branch: string; baseRef: string; title: string; body: string },
  ) => Promise<PrAction>;
  viewPrMerge?: (repo: string, ref: string | number) => Promise<PrMergeView | null>;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  now?: () => number;
}

export interface ReadinessSessionDeps {
  project: ProjectDef;
  settings: AppSettings;
  persist: (project: ProjectDef) => void;
  onChange: (state: ReadinessState) => void;
  io?: ReadinessIo;
}

export class ReadinessSession {
  readonly sessionId = shortId();
  private readonly panel: PanelSession<ReadinessState>;
  private readonly cancelSignal = { cancelled: false };
  private worktree: ReadinessWorktree | null = null;
  private busy = false;
  private remediateAttempt = 0;
  private pollRunning = false;

  constructor(private readonly deps: ReadinessSessionDeps) {
    const resolved = resolveReadinessModel(deps.settings);
    this.panel = new PanelSession<ReadinessState>(
      {
        sessionId: this.sessionId,
        projectId: deps.project.id,
        phase: 'idle',
        model: resolved.model,
        reasoningEffort: resolved.reasoningEffort,
        marker: null,
        markerValid: false,
        markerDetail: '',
        evaluation: null,
        entries: [],
        pr: null,
        mergeDetail: '',
        skipDetail: '',
        detail: '',
        startedAt: (deps.io?.now ?? Date.now)(),
      },
      {
        now: deps.io?.now,
        onChange: deps.onChange,
        clone: cloneReadinessState,
        isTerminal: (state) => state.phase === 'complete' || state.phase === 'failed',
        applyCancel: (state) => {
          if (state.phase !== 'failed') state.failedPhase = state.phase;
          state.phase = 'failed';
          state.detail = 'cancelled';
        },
        applyFail: (state, message) => {
          if (state.phase !== 'failed') state.failedPhase = state.phase;
          state.phase = 'failed';
          state.detail = message;
        },
      },
    );
  }

  private get state(): ReadinessState {
    return this.panel.state;
  }

  get projectId(): string {
    return this.deps.project.id;
  }

  snapshot(): ReadinessState {
    return this.panel.snapshot();
  }

  configure(opts: { model?: string; reasoningEffort?: ReasoningEffort }): void {
    if (opts.model) this.state.model = opts.model;
    if (opts.reasoningEffort) this.state.reasoningEffort = opts.reasoningEffort;
    this.emit();
  }

  private emit(): void {
    this.panel.emit();
  }

  private setPhase(requested: ReadinessPhase, requestedDetail: string): void {
    let phase = requested;
    let detail = requestedDetail;
    if (phase === 'failed') {
      // An isolated branch is recoverable work. Never settle `failed` while it
      // still exists — park on Continue so a connection drop, a verify miss,
      // or a gh hiccup cannot throw the paid turn away.
      if (this.worktree) {
        this.state.failedPhase ??= this.state.phase;
        phase = 'needs_continue';
        detail = withResumeHint(this.state.failedPhase, detail);
      } else if (this.state.phase !== 'failed') {
        this.state.failedPhase = this.state.phase;
      }
    }
    this.state.phase = phase;
    this.state.detail = detail;
    if (SETTLED_PHASES.has(phase)) this.state.endedAt = this.panel.now();
    this.emit();
  }

  private push(entry: Omit<ReadinessEntry, 'id' | 'at'>): ReadinessEntry {
    return this.panel.push(entry);
  }

  private flush(): void {
    this.panel.emit();
  }

  private persist(patch: Partial<ProjectDef>): void {
    const next = { ...this.deps.project, ...patch };
    this.deps.project.readinessValidated = next.readinessValidated;
    this.deps.project.readinessSkipped = next.readinessSkipped;
    this.deps.persist(next);
  }

  /** The marker as committed on the base ref: the same check `inspectProject` runs. */
  private async readAuthoritativeMarker(): Promise<MarkerRead> {
    return readMarkerAtBaseRef(this.deps.project.path, this.deps.project.baseRef);
  }

  private applyMarker(read: MarkerRead): void {
    this.state.marker = read.marker;
    this.state.markerValid = read.ok;
    this.state.markerDetail = read.detail;
  }

  private fail(message: string): void {
    this.setPhase('failed', message);
    this.push({ kind: 'error', text: message });
  }

  async inspect(): Promise<ReadinessState> {
    this.setPhase('inspecting', `Checking ${AGENT_READY_PATH} on ${this.deps.project.baseRef}`);
    const read = await this.readAuthoritativeMarker();
    this.applyMarker(read);
    if (read.ok && read.marker) {
      this.persist({ readinessValidated: true, readinessSkipped: false });
      this.setPhase('complete', 'Repository is already agent-ready.');
      this.push({ kind: 'note', text: read.marker.summary });
      return this.snapshot();
    }
    this.persist({ readinessValidated: false });
    this.setPhase('confirming', read.detail);
    return this.snapshot();
  }

  async evaluate(): Promise<ReadinessState> {
    if (this.cancelSignal.cancelled) return this.snapshot();
    // A parked continue still owns the isolated worktree. Re-evaluating the
    // base checkout would hide Continue and feed the next turn a stale list.
    if (
      this.busy ||
      isReadinessMakeReadyLive(this.state.phase) ||
      this.state.phase === 'needs_continue'
    ) {
      return this.snapshot();
    }
    this.setPhase('evaluating', 'Evaluating repository readiness');
    this.push({
      kind: 'note',
      text: 'Inspecting the repository against the agent-ready checklist…',
    });
    try {
      const evaluation = evaluateRepo(this.deps.project.path);
      this.state.evaluation = evaluation;
      if (!evaluation.ready) {
        this.push({ kind: 'note', text: evaluation.summary });
        this.setPhase('not_ready', evaluation.summary);
        return this.snapshot();
      }
      // A green checklist plus a committed marker is already the finished
      // state; asking for "Make it ready" again would be busywork.
      const read = await this.readAuthoritativeMarker();
      if (read.ok && read.marker) {
        this.applyMarker(read);
        this.persist({ readinessValidated: true, readinessSkipped: false });
        this.push({ kind: 'note', text: evaluation.summary });
        this.setPhase('complete', 'Repository is already agent-ready.');
        return this.snapshot();
      }
      this.push({ kind: 'note', text: evaluation.summary });
      this.setPhase(
        'not_ready',
        `Every check passes, but ${AGENT_READY_PATH} is not committed on ${this.deps.project.baseRef} yet (${read.detail}). Make it ready commits the proof so runs branching from that ref can see it.`,
      );
    } catch (e) {
      this.fail((e as Error).message);
    }
    return this.snapshot();
  }

  async makeReady(): Promise<ReadinessState> {
    if (this.busy || isReadinessMakeReadyLive(this.state.phase)) return this.snapshot();
    this.cancelSignal.cancelled = false;
    this.panel.clearCancelled();
    if (this.state.phase === 'needs_continue' && this.state.failedPhase === 'finalizing') {
      this.busy = true;
      this.state.endedAt = undefined;
      try {
        await this.finalize(this.state.mergeDetail || this.state.detail);
      } catch (e) {
        this.fail((e as Error).message);
      } finally {
        this.busy = false;
      }
      return this.snapshot();
    }
    if (!this.state.evaluation) await this.evaluate();
    if (this.state.phase === 'failed' || this.state.phase === 'complete') return this.snapshot();

    // The marker can land on the base ref between evaluation and this click
    // (the operator pulls in another terminal). Remediating then would open a
    // second readiness PR against a repo that is already ready.
    const already = await this.readAuthoritativeMarker();
    if (already.ok && already.marker) {
      this.applyMarker(already);
      this.persist({ readinessValidated: true, readinessSkipped: false });
      this.setPhase('complete', 'Repository is already agent-ready.');
      return this.snapshot();
    }

    this.busy = true;
    this.state.endedAt = undefined;
    this.state.failedPhase = undefined;
    const project = this.deps.project;
    const continuing = !!this.worktree;
    try {
      if (this.worktree) {
        this.push({
          kind: 'note',
          text: `Continuing on ${this.worktree.branch}. Previous changes are kept.`,
        });
      } else {
        this.setPhase('remediating', 'Creating an isolated branch');
        this.worktree = await createReadinessWorktree({
          repo: project.path,
          sessionId: this.sessionId,
          baseRef: project.baseRef || (await currentBranch(project.path)) || 'main',
        });
        this.push({ kind: 'note', text: `Isolated on ${this.worktree.branch}` });
      }

      const evaluation = this.state.evaluation;
      this.setPhase(
        'remediating',
        evaluation?.ready
          ? 'Writing the marker on the isolated branch'
          : continuing
            ? 'Sending the remaining failures back to the agent on the same branch'
            : 'The agent is fixing the repository on an isolated branch',
      );

      const remediator = this.deps.io?.remediator;
      if (!evaluation?.ready) {
        if (!remediator) {
          this.setPhase('failed', 'No remediator is configured to make this repository ready.');
          return this.snapshot();
        }
        if (evaluation && !(await this.remediate(remediator, evaluation, continuing))) {
          return this.snapshot();
        }
      }

      await this.verifyAndOpenPr();
    } catch (e) {
      this.fail((e as Error).message);
    } finally {
      this.busy = false;
    }
    return this.snapshot();
  }

  /** One remediator turn. False means the session already parked with a reason. */
  private async remediate(
    remediator: ReadinessRemediator,
    evaluation: ReadinessEvaluation,
    continuing: boolean,
  ): Promise<boolean> {
    if (!this.worktree) throw new Error('no readiness worktree');
    this.remediateAttempt += 1;
    const result = await remediator.run({
      cwd: this.worktree.path,
      evaluation,
      model: this.state.model,
      reasoningEffort: this.state.reasoningEffort,
      continuation: continuing,
      attempt: this.remediateAttempt,
      priorSummary: this.priorSummary(),
      onEntry: (entry) => this.push(entry),
      flush: () => this.flush(),
      signal: this.cancelSignal,
    });
    if (result.ok && !this.cancelSignal.cancelled) return true;
    const detail = this.cancelSignal.cancelled && result.ok ? 'Paused.' : result.detail;
    this.push({ kind: 'error', text: detail });
    this.setPhase('failed', detail);
    return false;
  }

  private async verifyAndOpenPr(): Promise<void> {
    if (!this.worktree) throw new Error('no readiness worktree');
    this.setPhase('verifying', 'Re-running the checklist before writing the marker');
    this.push({ kind: 'note', text: 'Re-running the checklist in the isolated worktree…' });
    const evaluation = evaluateRepo(this.worktree.path);
    this.state.evaluation = evaluation;
    if (!evaluation.ready) {
      const failed = evaluation.criteria.filter((c) => c.status === 'fail').map((c) => c.id);
      this.state.failedPhase = 'verifying';
      this.push({ kind: 'error', text: evaluation.summary });
      this.setPhase(
        'needs_continue',
        `Verification still failing: ${failed.join(', ')}. Continue sends those remaining failures back to the agent — the work already done stays on this branch.`,
      );
      return;
    }

    const ignored = ensureMarkerIgnored(this.worktree.path);
    if (ignored.length) {
      this.push({
        kind: 'note',
        text: `Exempting the marker from ${ignored.join(', ')} so CI gates stay green`,
      });
    }
    const alreadyMarked = await readMarkerAtBaseRef(this.worktree.path, 'HEAD');
    if (alreadyMarked.ok && alreadyMarked.marker) {
      this.applyMarker(alreadyMarked);
    } else {
      this.push({ kind: 'note', text: 'Writing .agents/agent-ready.json last…' });
      const marker = markerFromEvaluation(evaluation, {
        commit: (await headSha(this.worktree.path)) || 'HEAD',
        generatedAt: new Date((this.deps.io?.now ?? Date.now)()).toISOString(),
        model: this.state.model,
        reasoningEffort: this.state.reasoningEffort,
      });
      writeMarker(this.worktree.path, marker);
      await commitReadinessWork(this.worktree.path, 'chore: mark repository agent-ready');

      // The PR is only proof if the marker is actually in the commit it carries.
      const committed = await readMarkerAtBaseRef(this.worktree.path, 'HEAD');
      this.applyMarker(committed);
      if (!committed.ok) {
        this.fail(`The marker did not survive the commit: ${committed.detail}`);
        return;
      }
    }

    this.setPhase('pr_ready', 'Opening a pull request with the readiness proof');
    this.push({ kind: 'note', text: 'Opening the readiness pull request…' });
    const openPr = this.deps.io?.openPr;
    if (!openPr) {
      this.setPhase('failed', 'Cannot open a pull request: no GitHub helper is configured.');
      return;
    }
    const pr = await openPr(this.deps.project.path, {
      branch: this.worktree.branch,
      baseRef: this.worktree.baseRef,
      title: '[readiness] Make repository agent-ready',
      body: prBody(evaluation),
    });
    if (!pr.ok || !pr.number || !pr.url) {
      this.setPhase('failed', pr.detail || 'gh could not open a pull request');
      this.push({ kind: 'error', text: pr.detail });
      return;
    }
    this.state.pr = { number: pr.number, url: pr.url, merged: false };
    this.push({ kind: 'note', text: `The PR is ready: ${pr.url}` });
    this.setPhase(
      'awaiting_merge',
      'Merge the pull request, then confirm. Foundry will also poll while this flow is open.',
    );
    void this.pollMerge();
  }

  private applyMergeCheck(check: MergeCheck): void {
    this.state.mergeDetail = check.detail;
    if (check.pr) {
      this.state.pr = { number: check.pr.number, url: check.pr.url, merged: check.pr.merged };
    }
  }

  private async pollMerge(): Promise<void> {
    if (this.pollRunning || !this.state.pr) return;
    const view = this.deps.io?.viewPrMerge;
    if (!view) return;
    const intervalMs = this.deps.io?.pollIntervalMs ?? 5_000;
    if (intervalMs <= 0) return;
    this.pollRunning = true;
    const prNumber = this.state.pr.number;
    const check = await pollPrMerged({
      view: () => view(this.deps.project.path, prNumber),
      isCancelled: () =>
        this.cancelSignal.cancelled ||
        this.state.phase === 'complete' ||
        this.state.phase === 'failed',
      sleep: this.deps.io?.sleep,
      intervalMs,
      onTick: (next) => {
        this.applyMergeCheck(next);
        this.emit();
      },
    });
    this.pollRunning = false;
    if (check.merged && !this.cancelSignal.cancelled) await this.finalize(check.detail);
  }

  async confirmMerge(): Promise<ReadinessState> {
    if (!this.state.pr) {
      this.state.mergeDetail = 'There is no pull request to confirm.';
      this.emit();
      return this.snapshot();
    }
    this.setPhase('confirming_merge', 'Verifying the pull request actually merged');
    const view = this.deps.io?.viewPrMerge;
    if (!view) {
      this.state.mergeDetail = 'Cannot verify merge status without gh.';
      this.setPhase('awaiting_merge', this.state.mergeDetail);
      return this.snapshot();
    }
    const check = mergeCheckFromView(await view(this.deps.project.path, this.state.pr.number));
    this.applyMergeCheck(check);
    if (!check.merged) {
      this.setPhase('awaiting_merge', check.detail);
      this.push({ kind: 'note', text: check.detail });
      return this.snapshot();
    }
    await this.finalize(check.detail);
    return this.snapshot();
  }

  /**
   * A merged PR is not proof on its own: the completion verdict comes from
   * re-reading the marker on the base ref after the fast-forward, which is the
   * exact check `inspectProject()` runs for the Runs banner. Anything short of
   * a valid marker there stays `failed` with the reason, so the session and the
   * Runs page can never disagree.
   */
  private async finalize(detail: string): Promise<void> {
    this.setPhase('finalizing', 'Updating the local base branch');
    let ffDetail = '';
    try {
      const remote = await preferredRemote(this.deps.project.path);
      if (remote) {
        const ff = await fastForwardBase(this.deps.project.path, remote, this.deps.project.baseRef);
        ffDetail = ff.ok ? '' : ff.stdout.trim() || 'could not fast-forward';
        this.push({
          kind: 'note',
          text: ff.ok ? `${this.deps.project.baseRef} fast-forwarded` : ffDetail,
        });
      }
    } catch (e) {
      ffDetail = (e as Error).message;
      this.push({ kind: 'note', text: ffDetail });
    }

    const read = await this.readAuthoritativeMarker();
    this.applyMarker(read);
    if (!read.ok) {
      this.persist({ readinessValidated: false });
      this.fail(
        ffDetail
          ? `${read.detail} (${ffDetail})`
          : `${read.detail}. Pull ${this.deps.project.baseRef}, then continue — runs branch from that ref, so the marker has to be committed there.`,
      );
      return;
    }

    if (this.worktree) {
      await discardReadinessWorktree(this.deps.project.path, this.worktree);
      this.worktree = null;
    }
    this.persist({ readinessValidated: true, readinessSkipped: false });
    this.setPhase('complete', detail || 'Repository is agent-ready.');
    this.push({ kind: 'note', text: this.state.marker?.summary || 'Ready.' });
  }

  skip(): ReadinessState {
    this.cancelSignal.cancelled = true;
    this.panel.noteCancelled();
    this.persist({ readinessSkipped: true });
    this.state.skipDetail =
      'The Agent Readiness process can be run again anytime from project settings.';
    this.setPhase('skipped', this.state.skipDetail);
    this.push({ kind: 'note', text: this.state.skipDetail });
    void this.cleanupWorktree();
    return this.snapshot();
  }

  async retry(): Promise<ReadinessState> {
    this.cancelSignal.cancelled = false;
    this.panel.clearCancelled();
    this.busy = false;
    this.remediateAttempt = 0;
    this.state.endedAt = undefined;
    this.state.failedPhase = undefined;
    this.state.skipDetail = '';
    this.state.mergeDetail = '';
    this.state.pr = null;
    this.persist({ readinessSkipped: false });
    await this.cleanupWorktree();
    // evaluate() no-ops on needs_continue so a banner re-check cannot
    // clobber a parked branch. Leave that phase before starting over.
    this.setPhase('idle', 'Starting over from the project checkout.');
    this.push({
      kind: 'note',
      text: 'Starting over from the project checkout. Isolated work was discarded.',
    });
    return this.evaluate();
  }

  cancel(): void {
    if (this.panel.isTerminal()) return;
    this.cancelSignal.cancelled = true;
    if (this.worktree) {
      // Abort the in-flight turn but keep the branch. makeReady parks when
      // the remediator returns; if nothing is running, park now.
      this.panel.noteCancelled();
      if (!this.busy) this.setPhase('failed', 'Paused.');
      return;
    }
    this.panel.cancel();
    void this.cleanupWorktree();
  }

  dismiss(): void {
    if (this.state.phase === 'complete' && this.state.markerValid) {
      this.persist({ readinessValidated: true, readinessSkipped: false });
    }
  }

  private priorSummary(): string {
    const joined = this.state.entries
      .filter((entry) => entry.kind === 'note' || entry.kind === 'text')
      .map((entry) => entry.text.trim())
      .filter(Boolean)
      .slice(-16)
      .join('\n');
    return joined.slice(-2_000);
  }

  private async cleanupWorktree(): Promise<void> {
    if (!this.worktree) return;
    try {
      await discardReadinessWorktree(this.deps.project.path, this.worktree);
    } catch {
      // Best-effort: leftover trees show under Maintenance if discard fails.
    }
    this.worktree = null;
  }
}

function cloneReadinessState(state: ReadinessState): ReadinessState {
  return {
    ...state,
    evaluation: state.evaluation
      ? {
          ...state.evaluation,
          criteria: state.evaluation.criteria.map((c) => ({ ...c })),
          stack: {
            ...state.evaluation.stack,
            languages: [...state.evaluation.stack.languages],
            packages: [...state.evaluation.stack.packages],
          },
        }
      : null,
    marker: state.marker ? { ...state.marker } : null,
    pr: state.pr ? { ...state.pr } : null,
  };
}

function withResumeHint(phase: ReadinessPhase | undefined, detail: string): string {
  const text = detail.trim() || 'Something went wrong.';
  if (/continue|isolated branch|same branch|open pr again|check merge/i.test(text)) return text;
  if (phase === 'pr_ready') {
    return `${text} The readiness branch is still here — Open PR again retries GitHub.`;
  }
  if (phase === 'finalizing') {
    return `${text} Continue checks the base branch again. Isolated work was not discarded.`;
  }
  return `${text} The isolated branch is still here — Continue resumes without starting over.`;
}

/** Phases that stamp `endedAt`: `needs_continue` is parked, but it has stopped. */
const SETTLED_PHASES = new Set<ReadinessPhase>(['complete', 'skipped', 'failed', 'needs_continue']);

/** Phases where "Make it ready" is already mid-flight and must not be re-entered. */
const MAKE_READY_LIVE_PHASES = new Set<ReadinessPhase>([
  'remediating',
  'verifying',
  'pr_ready',
  'confirming_merge',
  'finalizing',
]);

function isReadinessMakeReadyLive(phase: ReadinessPhase): boolean {
  return MAKE_READY_LIVE_PHASES.has(phase);
}

function prBody(evaluation: ReadinessEvaluation): string {
  const rows = evaluation.criteria
    .map((c) => `- **${c.id}**: ${c.status}${c.notes ? ` — ${c.notes}` : ''}`)
    .join('\n');
  return `${evaluation.summary}\n\n## Checklist\n\n${rows}\n\nOpened by Foundry Agent Readiness Check.\n`;
}
