/**
 * Some providers (Gemini especially) echo a tool invocation as assistant
 * text — a JSON object whose only key is `functionCall` / `functionResponse`,
 * or a one-line `Ran \`tool\`.` narration. The real work already has a tool
 * row. These helpers keep that echo out of the operator-facing transcript.
 */

const RAN_TOOL = /^Ran\s+`[^`]+`\.?\s*$/i;
const FUNCTION_CALL_START = /^\s*\{\s*"(?:functionCall|functionResponse)"(\s|:|$)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isVendorFunctionPayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === 'functionCall' || keys[0] === 'functionResponse');
}

function parseObject(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** True when `text` is a complete vendor function-call / function-response JSON object. */
export function isVendorFunctionCallPayload(text: string): boolean {
  return isVendorFunctionPayload(parseObject(text.trim()));
}

/** True while a function-call JSON object is still streaming in. */
export function isIncompleteFunctionCallJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || isVendorFunctionCallPayload(trimmed)) return false;
  if (parseObject(trimmed) !== undefined) return false;
  return FUNCTION_CALL_START.test(trimmed);
}

function isRanToolLine(line: string): boolean {
  return RAN_TOOL.test(line.trim());
}

/**
 * Drops complete vendor echoes. Incomplete JSON is left in place so later
 * deltas can finish the object and then be stripped.
 */
export function stripVendorToolEcho(text: string): string {
  const withoutRan = text
    .split('\n')
    .filter((line) => !isRanToolLine(line))
    .join('\n');
  const trimmed = withoutRan.trim();
  if (!trimmed) return '';
  if (isVendorFunctionCallPayload(trimmed)) return '';
  const start = withoutRan.search(/\s*\{\s*"(?:functionCall|functionResponse)"\s*:/);
  if (start >= 0 && isVendorFunctionCallPayload(withoutRan.slice(start))) {
    return withoutRan.slice(0, start).trimEnd();
  }
  return withoutRan;
}

/** True when a transcript text row should not be shown to the operator. */
export function isHiddenVendorText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (isIncompleteFunctionCallJson(trimmed)) return true;
  return stripVendorToolEcho(text).trim() === '';
}
