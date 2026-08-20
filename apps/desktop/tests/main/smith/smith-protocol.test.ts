/**
 * The newline-delimited JSON framing the Smith socket speaks. `drainLines` must
 * split complete lines and hold a partial tail across chunk boundaries, so a
 * request that arrives in pieces still parses exactly once; `encodeLine` must
 * round-trip through it.
 */

import { describe, expect, it } from 'vitest';
import { drainLines, encodeLine } from '../../../src/main/smith/protocol.js';

describe('drainLines', () => {
  it('returns complete lines and keeps a partial tail', () => {
    const { lines, rest } = drainLines('{"a":1}\n{"b":2}\n{"c"');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('{"c"');
  });

  it('yields nothing until the first newline arrives', () => {
    const { lines, rest } = drainLines('{"a":1}');
    expect(lines).toEqual([]);
    expect(rest).toBe('{"a":1}');
  });

  it('drops empty lines so a trailing newline is not an empty request', () => {
    const { lines, rest } = drainLines('{"a":1}\n\n');
    expect(lines).toEqual(['{"a":1}']);
    expect(rest).toBe('');
  });

  it('reassembles a request split across two chunks', () => {
    let buffer = '';
    const seen: string[] = [];
    for (const chunk of ['{"op":"li', 'st","kind":"agent"}\n']) {
      buffer += chunk;
      const { lines, rest } = drainLines(buffer);
      buffer = rest;
      seen.push(...lines);
    }
    expect(seen).toEqual(['{"op":"list","kind":"agent"}']);
    expect(buffer).toBe('');
  });
});

describe('encodeLine', () => {
  it('appends exactly one newline and round-trips through drainLines', () => {
    const encoded = encodeLine({ ok: true, kind: 'agent', entities: [] });
    expect(encoded.endsWith('\n')).toBe(true);
    const { lines, rest } = drainLines(encoded);
    expect(rest).toBe('');
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true, kind: 'agent', entities: [] });
  });
});
