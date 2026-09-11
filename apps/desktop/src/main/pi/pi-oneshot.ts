/**
 * `OneShotFactory` over a short-lived in-process Pi session.
 *
 * A one-shot is a session with no file behind it (`SessionManager.inMemory`) that is disposed the moment the
 * answer arrives, and the transcript is the same neutral event stream an agent
 * phase produces — so detection, setup, repair, and the readiness fix all show
 * the operator the same thing a run does.
 *
 * The two access modes differ by tool list rather than by setting. A read-only
 * session is handed the four read tools and, when requested, the in-memory
 * `submit_result` answer channel, so there is no filesystem write for policy
 * to refuse. A write-capable one gets the built-ins behind a policy scoped to
 * its own directory; claims are still independently validated by the caller.
 *
 * Every one-shot resolves the operator's bundled/optional pi packages (for
 * example the Tavily web-search extension) on the same footing a run phase
 * or Smith's chat gets them — unconditionally, never a per-caller opt-in. A
 * `read` turn still takes only the extensions marked safe for a read-only
 * profile, same as a reviewer phase; a `write` turn takes all of them. This
 * is what makes it "all or nothing": once the operator enables a package in
 * Settings, every AI turn in Foundry can reach for it, with no call site
 * deciding case by case whether it is allowed to.
 */

import {
  SessionManager,
  type AgentSession as PiAgentSession,
  type PromptOptions,
} from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { modelKey, pickModel, thinkingLevelFor } from './model.js';
import { continueWithModelFailover } from './model-failover.js';
import type { EnabledModelsSource } from './enabled-models.js';
import {
  foundryResourceLoader,
  foundrySettings,
  lastAssistantText,
  openFoundrySession,
  promptUntilIdle,
} from './open-session.js';
import { resolveBundledPackages } from './packages.js';
import { evaluate } from './policy.js';
import { policyOnlyExtension } from './policy-extension.js';
import { modelRuntime } from './runtime.js';
import { FOUNDRY_ONESHOT_HARNESS } from './system-prompt.js';
import { BUILTIN_TOOLS, ONESHOT_OUTPUT_TOOL_NAME, READ_ONLY_TOOLS } from './tool-names.js';
import { submitResultTool, type SubmissionTool } from './tools.js';
import { subscribeSessionEvents, VendorEventReader } from './vendor-events.js';
import type {
  OneShotFactory,
  OneShotImage,
  OneShotOptions,
  OneShotResult,
  OneShotSession,
} from './oneshot.js';
import type { PermissionAsk, PermissionDecision } from './transport.js';

/** What every one-shot needs that only the composition root knows. */
export interface PiOneShotOptions extends OneShotOptions {
  /** Foundry's Application Support directory; pi state lives under it. */
  supportDir: string;
  /**
   * What this install may run on or fail over onto, in pi's shape. The
   * composition root filters the catalog — a model the operator hid in
   * Settings is already gone — and this session never sees one to skip.
   */
  enabledModels: EnabledModelsSource;
  /** Settings `defaultModel`. First failover hop prefers this id when enabled. */
  defaultModel?: () => string;
}

class PiOneShot implements OneShotSession {
  private session: PiAgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly events = new VendorEventReader();
  private readonly outputTool: SubmissionTool | null;
  private readonly extension: ReturnType<typeof policyOnlyExtension>;
  private aborted = false;
  /** Package tools this turn actually admitted, read back for the policy. */
  private loadedPackageTools: string[] = [];

  constructor(private readonly opts: PiOneShotOptions) {
    this.outputTool = opts.outputFormat ? submitResultTool(opts.outputFormat.schema) : null;
    this.extension = policyOnlyExtension((ask) => this.decide(ask), this.outputTool ?? undefined);
  }

  async send(prompt: string, images?: readonly OneShotImage[]): Promise<OneShotResult> {
    const session = await this.open();
    try {
      // An abort that landed while the session was still opening must not be
      // answered with a turn nobody is waiting for.
      if (this.aborted) {
        return {
          text: '',
          usage: null,
          reason: 'aborted',
          interrupted: true,
          structuredOutput: null,
        };
      }

      const hasImages = Boolean(images?.length);
      if (hasImages && !session.model?.input.includes('image')) {
        const selected = session.model
          ? modelKey(session.model)
          : 'The selected Orchestrator model';
        throw new Error(
          `${selected} does not support image input. Choose an image-capable Orchestrator model.`,
        );
      }

      this.extension.useSystemPrompt(this.opts.systemPrompt ?? null);
      this.events.startTurn();

      const last = await promptUntilIdle(
        session,
        prompt,
        async () =>
          continueWithModelFailover({
            session,
            events: this.events,
            // Live per turn: a model hidden between turns is gone from the
            // catalog failover appoints from.
            availableModels: await this.opts.enabledModels(),
            preferredModelId: this.opts.defaultModel?.(),
            requireImageInput: hasImages,
            onWarning: (warning) => this.opts.onWarning?.(warning),
          }),
        images?.length ? toPiImages(images) : undefined,
      );

      return {
        text: lastAssistantText(session),
        usage: this.events.turnUsage,
        reason: last?.stopReason ?? 'stop',
        interrupted: last?.stopReason === 'aborted' || this.aborted,
        structuredOutput: this.outputTool?.submitted() ?? null,
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
    const available = await this.opts.enabledModels();
    const picked = pickModel(available, this.opts.model);
    if (picked.warning) this.opts.onWarning?.(picked.warning);

    const agentDir = join(this.opts.supportDir, 'pi');
    const settingsManager = foundrySettings();
    // Unconditional, same as a run phase and Smith's chat: a `read` turn
    // takes only the packages marked safe for a read-only profile, a `write`
    // turn takes all of them. Nothing here decides per caller whether the
    // operator's enabled packages apply — enabling one in Settings is the
    // only switch.
    const packageResources = await resolveBundledPackages({
      supportDir: this.opts.supportDir,
      skillsOnly: this.opts.access === 'read',
      onWarning: (message) => this.opts.onWarning?.(message),
    });
    const resourceLoader = foundryResourceLoader({
      cwd: this.opts.cwd,
      agentDir,
      settingsManager,
      harness: FOUNDRY_ONESHOT_HARNESS,
      extensionFactory: this.extension.factory,
      packageResources,
    });
    const opened = await openFoundrySession({
      cwd: this.opts.cwd,
      agentDir,
      modelRuntime: runtime,
      model: picked.model,
      thinkingLevel: thinkingLevelFor(this.opts.reasoningEffort),
      // The list is the allowlist: a read-only session physically has no tool
      // that could write, rather than one the policy happens to refuse.
      tools: [
        ...(this.opts.access === 'read' ? READ_ONLY_TOOLS : BUILTIN_TOOLS),
        ...(this.outputTool ? [ONESHOT_OUTPUT_TOOL_NAME] : []),
      ],
      resourceLoader,
      settingsManager,
      // No file: this session is answered and thrown away.
      sessionManager: SessionManager.inMemory(this.opts.cwd),
      onExtensionError: (message) => this.opts.onWarning?.(message),
    });
    if (opened.modelFallbackMessage) this.opts.onWarning?.(opened.modelFallbackMessage);

    this.loadedPackageTools = opened.packageTools;
    const session = opened.session;
    this.session = session;
    this.unsubscribe = subscribeSessionEvents(session, this.events, this.opts.onEvent);
    return session;
  }

  /**
   * The boundary is the whole working directory: these sessions own theirs, and
   * the thing that must not happen is a write landing outside it. A read-only
   * session has no write tool to rule on, and `writes: []` is the belt to the
   * tool list's braces.
   */
  private decide(ask: PermissionAsk): PermissionDecision {
    const outcome = evaluate(
      ask,
      {
        worktree: this.opts.cwd,
        writes: this.opts.access === 'read' ? [] : null,
        protectedPaths: [],
      },
      this.outputTool ? [ONESHOT_OUTPUT_TOOL_NAME] : [],
      // Read off what this turn actually loaded, exactly as a run session does:
      // the names only exist once packages have been resolved and loaded.
      this.loadedPackageTools,
    );
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

function toPiImages(images: readonly OneShotImage[]): NonNullable<PromptOptions['images']> {
  return images.map((image) => ({
    type: 'image' as const,
    data: image.data,
    mimeType: image.mediaType,
  }));
}

/** The production factory, bound to the directory Foundry keeps pi state in. */
export function piOneShots(
  supportDir: string,
  enabledModels: EnabledModelsSource,
  defaultModel?: () => string,
): OneShotFactory {
  return (opts) => new PiOneShot({ ...opts, supportDir, enabledModels, defaultModel });
}
