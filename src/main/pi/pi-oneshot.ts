/**
 * `OneShotFactory` over a short-lived in-process Pi session.
 *
 * A one-shot is a session with no file behind it (`SessionManager.inMemory`) that is disposed the moment the
 * answer arrives, and the transcript is the same neutral event stream an agent
 * phase produces — so detection, setup, repair, and the readiness fix all show
 * the operator the same thing a run does.
 *
 * The two access modes differ by tool list rather than by setting. A read-only
 * session is handed the four read tools and nothing else, so there is no write
 * for a policy to have to refuse. A write-capable one gets the built-ins behind
 * a policy scoped to its own directory; what the agent then *claims* is still
 * not believed, because `engine/repair.ts` re-derives its verdict from git.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession as PiAgentSession,
} from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { pickModel, thinkingLevelFor } from './model.js';
import { evaluate } from './policy.js';
import { policyOnlyExtension } from './policy-extension.js';
import { modelRuntime } from './runtime.js';
import { BUILTIN_TOOLS, READ_ONLY_TOOLS } from './tools.js';
import { lastAssistantStop, VendorEventReader } from './vendor-events.js';
import type { OneShotOptions, OneShotResult, OneShotSession } from './oneshot.js';
import type { PermissionAsk, PermissionDecision } from './transport.js';

/** What every one-shot needs that only the composition root knows. */
export interface PiOneShotOptions extends OneShotOptions {
  /** Foundry's Application Support directory; pi state lives under it. */
  supportDir: string;
}

class PiOneShot implements OneShotSession {
  private session: PiAgentSession | null = null;
  private readonly events = new VendorEventReader();
  private aborted = false;

  constructor(private readonly opts: PiOneShotOptions) {}

  async send(prompt: string, timeoutMs: number): Promise<OneShotResult> {
    const session = await this.open();
    try {
      // An abort that landed while the session was still opening must not be
      // answered with a turn nobody is waiting for.
      if (this.aborted) return { text: '', usage: null, reason: 'aborted', interrupted: true };

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void session.abort();
      }, timeoutMs);
      try {
        await session.prompt(prompt, { expandPromptTemplates: false, source: 'extension' });
        // prompt() resolves when the agent loop exits; a retry or an auto
        // continuation can still be in flight behind it.
        await session.waitForIdle();
      } finally {
        clearTimeout(timer);
      }
      if (timedOut) throw new Error(`one-shot turn timed out after ${timeoutMs}ms`);

      const last = lastAssistantStop(session);
      if (last?.stopReason === 'error') {
        throw new Error(last.errorMessage || 'the model ended the turn with an error');
      }
      return {
        text: (session.getLastAssistantText() ?? '').trim(),
        usage: this.events.turnUsage,
        reason: last?.stopReason ?? 'stop',
        interrupted: last?.stopReason === 'aborted' || this.aborted,
      };
    } finally {
      // A one-shot owns its session for exactly one turn. Leaving one open
      // would hold a model connection for a click that has been answered.
      this.dispose();
    }
  }

  abort(): void {
    this.aborted = true;
    void this.session?.abort();
  }

  private async open(): Promise<PiAgentSession> {
    const runtime = await modelRuntime(this.opts.supportDir);
    const picked = pickModel(await runtime.getAvailable(), this.opts.model);
    if (picked.warning) this.opts.onWarning?.(picked.warning);

    const agentDir = join(this.opts.supportDir, 'pi');
    // Compaction off: a one-shot is a single bounded question, and a turn long
    // enough to need compacting has already lost the caller waiting on it.
    const settingsManager = SettingsManager.inMemory(
      { compaction: { enabled: false }, retry: { enabled: true } },
      { projectTrusted: true },
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.opts.cwd,
      // Same rule as a run: whatever the operator installed for their own pi
      // must not change what this app does on their behalf.
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        {
          name: 'foundry',
          factory: policyOnlyExtension((ask) => this.decide(ask)).factory,
          hidden: true,
        },
      ],
    });
    await resourceLoader.reload();

    const created = await createAgentSession({
      cwd: this.opts.cwd,
      agentDir,
      modelRuntime: runtime,
      ...(picked.model ? { model: picked.model } : {}),
      thinkingLevel: thinkingLevelFor(this.opts.reasoningEffort),
      // The list is the allowlist: a read-only session physically has no tool
      // that could write, rather than one the policy happens to refuse.
      tools: [...(this.opts.access === 'read' ? READ_ONLY_TOOLS : BUILTIN_TOOLS)],
      resourceLoader,
      // No file: this session is answered and thrown away, and a run's session
      // records belong to that run's own trace directory rather than beside it.
      sessionManager: SessionManager.inMemory(this.opts.cwd),
      settingsManager,
    });
    if (created.modelFallbackMessage) this.opts.onWarning?.(created.modelFallbackMessage);

    const session = created.session;
    this.session = session;
    // Unbound, the policy hook is registered but not live, and every call would
    // then run unruled.
    await session.bindExtensions({
      mode: 'print',
      onError: (err) =>
        this.opts.onWarning?.(`extension error (${err.extensionPath}): ${err.error}`),
    });
    session.subscribe((event) => this.events.absorb(event, (e) => this.opts.onEvent?.(e)));
    this.events.startTurn();
    return session;
  }

  /**
   * The boundary is the whole working directory: these sessions own theirs, and
   * the thing that must not happen is a write landing outside it. A read-only
   * session has no write tool to rule on, and `writes: []` is the belt to the
   * tool list's braces.
   */
  private decide(ask: PermissionAsk): PermissionDecision {
    const outcome = evaluate(ask, {
      worktree: this.opts.cwd,
      writes: this.opts.access === 'read' ? [] : null,
      protectedPaths: [],
    });
    this.opts.onDecision?.(ask, outcome.decision, outcome.reason);
    return outcome.decision;
  }

  private dispose(): void {
    const session = this.session;
    this.session = null;
    if (!session) return;
    try {
      session.dispose();
    } catch {
      // Disposal is best effort; the caller already has its answer.
    }
  }
}

/** The production factory, bound to the directory Foundry keeps pi state in. */
export function piOneShots(supportDir: string): (opts: OneShotOptions) => OneShotSession {
  return (opts) => new PiOneShot({ ...opts, supportDir });
}
