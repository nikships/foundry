/**
 * Meta Spark accepts images on user turns, not inside tool output.
 *
 * Pi sees `input: ['text', 'image']` and encodes a `read` of a PNG as
 * `input_image` parts on `function_call_output`. The Model API then 400s
 * (`invalid_request_error` / "invalid parameters") on the next turn. OpenAI's
 * Responses API allows that encoding; Spark does not.
 *
 * Rewrite happens on the outgoing payload so Claude and GPT still see native
 * tool-result images, and the pixels stay in the Spark request as a user turn.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { DIRECT_PROVIDERS } from '@shared/direct-providers.js';

const TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);

/** Caption on the user turn that carries images Spark would not accept in tool output. */
export const SPARK_TOOL_IMAGE_NOTE = 'Image from the previous tool result.';

/** Installs the rewrite on every Foundry session type (run, one-shot, Smith). */
export function installSparkPayloadRewrite(pi: ExtensionAPI): void {
  pi.on('before_provider_request', (event) => {
    const next = rewriteSparkToolImages(event.payload);
    return next === event.payload ? undefined : next;
  });
}

/**
 * Returns a new payload when Spark tool output contains images, otherwise the
 * same reference so the extension hook can leave the request untouched.
 */
export function rewriteSparkToolImages(payload: unknown): unknown {
  if (!isSparkResponsesPayload(payload)) return payload;
  const input = liftToolImages(payload.input);
  return input === payload.input ? payload : { ...payload, input };
}

function isSparkResponsesPayload(
  payload: unknown,
): payload is Record<string, unknown> & { model: string; input: unknown[] } {
  return (
    isRecord(payload) &&
    typeof payload.model === 'string' &&
    Array.isArray(payload.input) &&
    isMetaSparkModel(payload.model)
  );
}

function isMetaSparkModel(modelId: string): boolean {
  return DIRECT_PROVIDERS.some(
    (provider) => provider.id === 'meta' && provider.models.some((model) => model.id === modelId),
  );
}

function liftToolImages(items: unknown[]): unknown[] {
  const out: unknown[] = [];
  let pending: Record<string, unknown>[] = [];
  let changed = false;

  const flush = (): void => {
    if (pending.length === 0) return;
    out.push({
      role: 'user',
      content: [{ type: 'input_text', text: SPARK_TOOL_IMAGE_NOTE }, ...pending],
    });
    pending = [];
  };

  for (const item of items) {
    const lifted = liftOneToolOutput(item);
    if (lifted) {
      changed = true;
      out.push(lifted.item);
      pending.push(...lifted.images);
      continue;
    }
    if (!isToolOutputItem(item)) flush();
    out.push(item);
  }
  flush();
  return changed ? out : items;
}

function liftOneToolOutput(
  item: unknown,
): { item: Record<string, unknown>; images: Record<string, unknown>[] } | null {
  if (!isToolOutputItem(item)) return null;
  const split = splitImageOutput(item.output);
  if (!split) return null;
  return { item: { ...item, output: split.text }, images: split.images };
}

function isToolOutputItem(
  item: unknown,
): item is Record<string, unknown> & { type: string; output: unknown } {
  return isRecord(item) && typeof item.type === 'string' && TOOL_OUTPUT_TYPES.has(item.type);
}

function splitImageOutput(
  output: unknown,
): { text: string; images: Record<string, unknown>[] } | null {
  if (!Array.isArray(output)) return null;
  const images: Record<string, unknown>[] = [];
  const texts: string[] = [];
  for (const part of output) {
    if (!isRecord(part)) continue;
    if (part.type === 'input_image') {
      images.push(part);
      continue;
    }
    if (part.type === 'input_text' && typeof part.text === 'string') texts.push(part.text);
  }
  if (images.length === 0) return null;
  return {
    text: texts.join('\n') || '(see attached image)',
    images,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
