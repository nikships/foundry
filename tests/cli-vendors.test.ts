/**
 * The CLI descriptors Settings and the doctor read.
 *
 * There is no argv or parse left to test: no code path spawns `droid exec`, so
 * the adapters describe an install rather than drive one. What still has to
 * hold is that every vendor the contract names has a descriptor, that an
 * unknown one cannot take the app down, and that the paths the doctor probes
 * are absolute — a relative one would be resolved against whatever directory
 * the app happened to launch from.
 */

import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapterFor, allAdapters } from '../src/main/cli/index.js';
import { CLI_VENDOR_IDS } from '../src/shared/types.js';

describe('the vendor registry', () => {
  it('has an adapter for every vendor the contract names', () => {
    for (const id of CLI_VENDOR_IDS) expect(adapterFor(id).id).toBe(id);
  });

  it('falls back to droid rather than crashing on an unknown vendor', () => {
    // A stored roster can name a vendor this build no longer has; that must
    // read as a wrong setting, not as an app that will not start.
    expect(adapterFor('not-a-cli' as never).id).toBe('droid');
  });

  it('claims RPC for droid alone, because it is the only one with a client', () => {
    expect(
      allAdapters()
        .filter((a) => a.supportsRpc)
        .map((a) => a.id),
    ).toEqual(['droid']);
  });

  it('names caveats only for vendors with runtime constraints', () => {
    expect(adapterFor('droid').caveats).toEqual([]);
  });

  it('probes absolute install and auth paths, so the lookup cannot follow cwd', () => {
    for (const id of CLI_VENDOR_IDS) {
      const adapter = adapterFor(id);
      for (const path of [...adapter.installPaths(), ...adapter.authPaths()]) {
        expect(isAbsolute(path)).toBe(true);
      }
    }
  });

  it('gives the doctor somewhere to send a broken install', () => {
    for (const id of CLI_VENDOR_IDS) {
      const adapter = adapterFor(id);
      expect(adapter.docsUrl).toMatch(/^https:\/\//);
      expect(adapter.authUrl).toMatch(/^https:\/\//);
      expect(adapter.versionArgs.length).toBeGreaterThan(0);
    }
  });
});
