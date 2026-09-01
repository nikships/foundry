/**
 * A scripted one-shot behind the neutral `OneShotFactory` seam.
 *
 * The five one-shot call sites — detection, setup generation, the run-start
 * command fill, the rebase repair, the readiness fix — each need a real agent
 * turn to do their job, which a unit test cannot have: it would need a
 * credential, a network, and a model. This implements the seam instead, so the
 * production session objects, the production transcript folding, and the
 * production parsers all run, and only the model is scripted.
 *
 * Deliberately imports no vendor package and nothing from `pi-oneshot.ts`. That
 * is the point of the seam: if these call sites can be tested without naming an
 * agent runtime, swapping the runtime cannot silently break them.
 *
 * A script says what one turn does — the events it emits, the disk it touches,
 * the text it ends with — which is enough to cover the two things that matter
 * here: what reaches the live transcript, and what the caller does with the
 * final answer.
 */

import type { OneShotOptions, OneShotResult, OneShotSession } from '../../src/main/pi/oneshot.js';
import type { TransportEvent } from '../../src/main/pi/transport.js';

/** What one scripted turn does, in the order written. */
export interface ScriptedTurn {
  /** Emitted before the answer, exactly as a real session would emit them. */
  events?: TransportEvent[];
  /** Real side effects, so a git-verified caller has something to verify. */
  work?: (opts: OneShotOptions) => void;
  /** The final assistant text the caller parses. */
  text?: string;
  /** Captured schema-bound submission, when the caller requested one. */
  structuredOutput?: Record<string, unknown>;
  /** Thrown instead of answering, for failure paths. */
  throws?: string;
  /** Ends the turn as interrupted rather than complete. */
  interrupted?: boolean;
  reason?: string;
  /** A model substitution or extension warning, reported before the turn. */
  warning?: string;
  /**
   * Held open until `abort()` lands, so a test can drive cancellation without
   * a timer. The turn then answers interrupted, as a real abort does.
   */
  hangUntilAbort?: boolean;
}

export interface ScriptedOneShots {
  /** What every call site was handed, in call order. Asserted on. */
  readonly calls: OneShotOptions[];
  /** User prompts sent through each opened one-shot, in call order. */
  readonly prompts: string[];
  /** The factory to inject. */
  readonly factory: (opts: OneShotOptions) => OneShotSession;
}

/**
 * Builds the factory. One script per turn, in order; a call past the end of the
 * list answers with empty text rather than throwing, because a test that opens
 * an extra session should fail on its own assertion rather than on the fixture.
 */
export function scriptedOneShots(turns: ScriptedTurn[]): ScriptedOneShots {
  const calls: OneShotOptions[] = [];
  const prompts: string[] = [];
  let index = 0;

  const factory = (opts: OneShotOptions): OneShotSession => {
    calls.push(opts);
    const script: ScriptedTurn = turns[index++] ?? {};
    let aborted = false;

    return {
      abort(): void {
        aborted = true;
      },
      async send(prompt: string): Promise<OneShotResult> {
        prompts.push(prompt);
        if (script.warning) opts.onWarning?.(script.warning);
        for (const event of script.events ?? []) opts.onEvent?.(event);
        script.work?.(opts);

        if (script.hangUntilAbort) {
          while (!aborted) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return {
            text: '',
            usage: null,
            reason: 'aborted',
            interrupted: true,
            structuredOutput: null,
          };
        }

        if (script.throws) throw new Error(script.throws);
        return {
          text: script.text ?? '',
          usage: null,
          reason: script.reason ?? (script.interrupted ? 'aborted' : 'stop'),
          interrupted: !!script.interrupted || aborted,
          structuredOutput: script.structuredOutput ?? null,
        };
      },
    };
  };

  return { calls, prompts, factory };
}

/** The event pair one completed tool call produces, which is what a panel folds. */
export function toolCall(input: {
  callId: string;
  tool: string;
  args?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}): TransportEvent[] {
  return [
    { type: 'tool_call', callId: input.callId, tool: input.tool, input: input.args ?? {} },
    {
      type: 'tool_result',
      callId: input.callId,
      content: input.result ?? '',
      isError: !!input.isError,
    },
  ];
}

/** One assistant text block, delta then end, as a real session streams it. */
export function say(text: string, messageId = 'm1'): TransportEvent[] {
  return [
    { type: 'text_delta', messageId, blockIndex: 0, delta: text },
    { type: 'text_end', messageId, blockIndex: 0 },
  ];
}
