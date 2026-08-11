/**
 * These reads run during the first render. In a sandboxed iframe or a browser
 * with site data blocked, touching `localStorage` throws instead of returning
 * null — unguarded, that is a blank window rather than a forgotten selection.
 * The node test environment has no `localStorage` at all, which is exactly the
 * throwing case.
 */
import { describe, expect, it } from 'vitest';
import { readLocal, writeLocal } from '../src/renderer/local-store.js';

describe('local storage access', () => {
  it('reads an empty string instead of throwing when storage is unavailable', () => {
    expect(readLocal('foundry.project')).toBe('');
  });

  it('swallows a failed write rather than taking the renderer down', () => {
    expect(() => writeLocal('foundry.project', 'proj_1')).not.toThrow();
  });

  it('round-trips through a working storage', () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    try {
      expect(readLocal('foundry.project')).toBe('');
      writeLocal('foundry.project', 'proj_1');
      expect(readLocal('foundry.project')).toBe('proj_1');
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
