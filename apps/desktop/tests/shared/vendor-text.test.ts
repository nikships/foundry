/**
 * Pins the vendor-echo filter: Gemini-style functionCall JSON and
 * `Ran \`tool\`.` narration must never reach the operator transcript.
 */

import { describe, expect, it } from 'vitest';
import {
  isHiddenVendorText,
  isIncompleteFunctionCallJson,
  isVendorFunctionCallPayload,
  stripVendorToolEcho,
} from '@shared/vendor-text.js';

const FUNCTION_CALL = `{
  "functionCall": {
    "name": "smith_readiness",
    "args": {
      "operation": "show"
    }
  }
}`;

describe('vendor-text', () => {
  it('recognizes a complete functionCall payload', () => {
    expect(isVendorFunctionCallPayload(FUNCTION_CALL)).toBe(true);
    expect(isVendorFunctionCallPayload('{"functionResponse":{"name":"x"}}')).toBe(true);
    expect(isVendorFunctionCallPayload('Got it.')).toBe(false);
    expect(isVendorFunctionCallPayload('{"ok":true}')).toBe(false);
  });

  it('holds incomplete functionCall JSON until it can parse', () => {
    expect(isIncompleteFunctionCallJson('{\n  "functionCall": {\n    "name":')).toBe(true);
    expect(isIncompleteFunctionCallJson(FUNCTION_CALL)).toBe(false);
    expect(isIncompleteFunctionCallJson('Got it.')).toBe(false);
  });

  it('strips a finished functionCall object and Ran-tool lines', () => {
    expect(stripVendorToolEcho(FUNCTION_CALL)).toBe('');
    expect(stripVendorToolEcho('Ran `smith_readiness`.')).toBe('');
    expect(stripVendorToolEcho('Got it.\nRan `smith_readiness`.')).toBe('Got it.');
    expect(stripVendorToolEcho(`Got it.\n${FUNCTION_CALL}`)).toBe('Got it.');
  });

  it('hides empty, incomplete, and finished vendor echoes', () => {
    expect(isHiddenVendorText('')).toBe(true);
    expect(isHiddenVendorText(FUNCTION_CALL)).toBe(true);
    expect(isHiddenVendorText('Ran `smith_readiness`.')).toBe(true);
    expect(isHiddenVendorText('{\n  "functionCall": {')).toBe(true);
    expect(isHiddenVendorText('Got it.')).toBe(false);
  });
});
