import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeGetItem, safeSetItem } from '../src/renderer/local-store.js';

describe('local-store', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads and writes items', () => {
    safeSetItem('test.key', 'value123');
    expect(safeGetItem('test.key')).toBe('value123');
    expect(safeGetItem('missing.key')).toBeNull();
  });

  it('handles exceptions gracefully when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError: access denied');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });

    expect(safeGetItem('test.key')).toBeNull();
    expect(() => safeSetItem('test.key', 'val')).not.toThrow();
  });
});
