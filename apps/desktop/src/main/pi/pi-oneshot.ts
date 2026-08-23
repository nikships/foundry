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
  SessionManager,
  type AgentSession as PiAgentSession,
} from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { pickModel, thinkingLevelFor } from './model.js';
import { continueWithModelFailover } from './model-failover.js';
import { foundryResourceLoader, foundrySettings, openFoundrySession } from './open-session.js';
import { evaluate } from './policy.js';
import { policyOnlyExtension } from './policy-extension.js';
import { modelRuntime } from './runtime.js';
import { FOUNDRY_ONESHOT_HARNESS } from './system-prompt.js';
import { BUILTIN_TOOLS, READ_ONLY_TOOLS } from './tools.js';
import { lastAssistantStop, VendorEventReader } from './vendor-events.js';
import type { OneShotFactory, OneShotOptions, OneShotResult, OneShotSession } from './oneshot.js';
import type { PermissionAsk, PermissionDecision } from './transport.js';

/** What every one-shot needs that only the composition root knows. */
export interface PiOneShotOptions extends OneShotOptions {
  /** Foundry's Application Support directory; pi state lives under it. */
  supportDir: string;
}

class PiOneShot implements OneShotSession {
  private session: PiAgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly events = new VendorEventReader();
  private readonly extension = policyOnlyExtension((ask) => this.decide(ask));
  private aborted = false;
  private availableModelCount = 0;

  constructor(private readonly opts: PiOneShotOptions) {}

  async send(prompt: string, timeoutMs?: number): Promise<OneShotResult> {
    const session = await this.open();
    try {
      // An abort that landed while the session was still opening must not be
      // answered with a turn nobody is waiting for.
      if (this.aborted) return { text: '', usage: null, reason: 'aborted', interrupted: true };

      this.extension.useSystemPrompt(this.opts.systemPrompt ?? null);
      this.events.startTurn();

      let timedOut = false;
      const timer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            void session.abort();
          }, timeoutMs)
        : null;
      try {
        await session.prompt(prompt, { expandPromptTemplates: false, source: 'extension' });
        // prompt() already waits through retries. waitForIdle() is the settle API.
        await session.waitForIdle();
        await continueWithModelFailover({
          session,
          events: this.events,
          availableModelCount: this.availableModelCount,
          onWarning: (warning) => this.opts.onWarning?.(warning),
        });
      } finally {
        if (timer) clearTimeout(timer);
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
    const available = await runtime.getAvailable();
    this.availableModelCount = available.length;
    const picked = pickModel(available, this.opts.model);
    if (picked.warning) this.opts.onWarning?.(picked.warning);

    const agentDir = join(this.opts.supportDir, 'pi');
    const settingsManager = foundrySettings();
    const resourceLoader = foundryResourceLoader({
      cwd: this.opts.cwd,
      agentDir,
      settingsManager,
      harness: FOUNDRY_ONESHOT_HARNESS,
      extensionFactory: this.extension.factory,
    });
    const opened = await openFoundrySession({
      cwd: this.opts.cwd,
      agentDir,
      modelRuntime: runtime,
      model: picked.model,
      thinkingLevel: thinkingLevelFor(this.opts.reasoningEffort),
      // The list is the allowlist: a read-only session physically has no tool
      // that could write, rather than one the policy happens to refuse.
      tools: [...(this.opts.access === 'read' ? READ_ONLY_TOOLS : BUILTIN_TOOLS)],
      resourceLoader,
      settingsManager,
      // No file: this session is answered and thrown away.
      sessionManager: SessionManager.inMemory(this.opts.cwd),
      onExtensionError: (message) => this.opts.onWarning?.(message),
    });
    if (opened.modelFallbackMessage) this.opts.onWarning?.(opened.modelFallbackMessage);

    const session = opened.session;
    this.session = session;
    this.unsubscribe = session.subscribe((event) =>
      this.events.absorb(event, (e) => this.opts.onEvent?.(e)),
    );
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
    this.unsubscribe?.();
    this.unsubscribe = null;
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
export function piOneShots(supportDir: string): OneShotFactory {
  return (opts) => new PiOneShot({ ...opts, supportDir });
}
