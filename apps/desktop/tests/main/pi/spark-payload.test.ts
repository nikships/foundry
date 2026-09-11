/**
 * Spark rejects images inside function_call_output. The rewrite lifts them
 * onto a following user turn so a `read` of a PNG does not 400 the next call.
 */

import { describe, expect, it } from 'vitest';
import {
  SPARK_TOOL_IMAGE_NOTE,
  rewriteSparkToolImages,
} from '../../../src/main/pi/spark-payload.js';
import { DIRECT_PROVIDERS } from '../../../src/shared/direct-providers.js';

const sparkId = DIRECT_PROVIDERS.find((provider) => provider.id === 'meta')?.models[0]?.id ?? '';

const png = {
  type: 'input_image',
  detail: 'auto',
  image_url: 'data:image/png;base64,aaa',
};

function sparkPayload(input: unknown[]) {
  return {
    model: sparkId,
    input,
    max_output_tokens: 943_718,
  };
}

describe('rewriteSparkToolImages', () => {
  it('leaves a non-Spark payload on the same reference', () => {
    const payload = {
      model: 'gpt-5',
      input: [
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: [{ type: 'input_text', text: 'shot' }, png],
        },
      ],
    };
    expect(rewriteSparkToolImages(payload)).toBe(payload);
  });

  it('leaves Spark text-only tool output untouched', () => {
    const payload = sparkPayload([
      { type: 'function_call_output', call_id: 'c1', output: 'Read image file [image/png]' },
    ]);
    expect(rewriteSparkToolImages(payload)).toBe(payload);
  });

  it('lifts images out of function_call_output onto a user turn', () => {
    const caption = 'Read image file [image/png]\n[Image: original 1080x2400]';
    const rewritten = rewriteSparkToolImages(
      sparkPayload([
        { type: 'function_call', call_id: 'c1', name: 'read' },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: [{ type: 'input_text', text: caption }, png],
        },
      ]),
    ) as { input: Record<string, unknown>[] };

    expect(rewritten.input).toEqual([
      { type: 'function_call', call_id: 'c1', name: 'read' },
      { type: 'function_call_output', call_id: 'c1', output: caption },
      {
        role: 'user',
        content: [{ type: 'input_text', text: SPARK_TOOL_IMAGE_NOTE }, png],
      },
    ]);
  });

  it('uses Pi’s placeholder when the tool result was image-only', () => {
    const rewritten = rewriteSparkToolImages(
      sparkPayload([{ type: 'function_call_output', call_id: 'c1', output: [png] }]),
    ) as { input: Record<string, unknown>[] };

    expect(rewritten.input[0]).toEqual({
      type: 'function_call_output',
      call_id: 'c1',
      output: '(see attached image)',
    });
    expect(rewritten.input[1]).toMatchObject({ role: 'user' });
  });

  it('does not insert a user turn between parallel tool outputs', () => {
    const pngB = { ...png, image_url: 'data:image/png;base64,bbb' };
    const rewritten = rewriteSparkToolImages(
      sparkPayload([
        { type: 'function_call', call_id: 'a' },
        { type: 'function_call', call_id: 'b' },
        {
          type: 'function_call_output',
          call_id: 'a',
          output: [{ type: 'input_text', text: 'A' }, png],
        },
        {
          type: 'function_call_output',
          call_id: 'b',
          output: [{ type: 'input_text', text: 'B' }, pngB],
        },
      ]),
    ) as { input: { type?: string; role?: string; output?: unknown; content?: unknown[] }[] };

    expect(rewritten.input.map((item) => item.type ?? item.role)).toEqual([
      'function_call',
      'function_call',
      'function_call_output',
      'function_call_output',
      'user',
    ]);
    expect(rewritten.input[2]?.output).toBe('A');
    expect(rewritten.input[3]?.output).toBe('B');
    expect(rewritten.input[4]?.content).toEqual([
      { type: 'input_text', text: SPARK_TOOL_IMAGE_NOTE },
      png,
      pngB,
    ]);
  });

  it('rewrites custom_tool_call_output the same way', () => {
    const rewritten = rewriteSparkToolImages(
      sparkPayload([
        {
          type: 'custom_tool_call_output',
          call_id: 'c1',
          output: [{ type: 'input_text', text: 'shot' }, png],
        },
      ]),
    ) as { input: { output?: unknown }[] };
    expect(rewritten.input[0]?.output).toBe('shot');
    expect(rewritten.input[1]).toMatchObject({ role: 'user' });
  });

  it('leaves images already on a user turn alone', () => {
    const payload = sparkPayload([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'look' }, png],
      },
    ]);
    expect(rewriteSparkToolImages(payload)).toBe(payload);
  });
});
