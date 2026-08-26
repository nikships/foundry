/**
 * The restore claims that live in components rather than in the view-model.
 *
 * `restore-view.test.ts` proves what the functions return; nothing there can
 * tell whether a component still calls them, in what order, or whether the
 * reason it computes actually reaches the screen. Each assertion here fails
 * against a specific regression that leaves the view-model suite green:
 * rendering the disabled reason only as a `title`, leaving the footer button
 * live while a confirmation is open, and calling the IPC seam before the
 * operator has answered.
 *
 * `environment: node`, so this renders to static markup and reads the
 * component source for the wiring a single render cannot observe.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RESTORE_REFUSAL_COPY } from '@shared/types.js';
import type { RestoreAvailability } from '@renderer/view-models/restore-view.js';

// `api.ts` reads `window` at module scope to build its bridge, and this suite
// runs under `environment: node`. The banner reaches it only through
// `useBrandedAsset`, which calls it inside an effect that static rendering
// never runs, so an empty stub is enough and keeps the preload out of a test
// about markup.
vi.mock('@renderer/api.js', () => ({ api: {}, menu: {} }));

const { RestoreAction } = await import('@renderer/components/run/OutcomeBanner.js');

const here = dirname(fileURLToPath(import.meta.url));
const sheetSrc = readFileSync(
  join(here, '../../src/renderer/components/run/RestoreSheet.tsx'),
  'utf8',
);
const screenSrc = readFileSync(
  join(here, '../../src/renderer/screens/RunDetailScreen.tsx'),
  'utf8',
);

function render(restore: RestoreAvailability | undefined, busy = false): string {
  return renderToStaticMarkup(createElement(RestoreAction, { restore, busy, onRestore: () => {} }));
}

describe('the Restore affordance in the outcome banner', () => {
  it('renders the disabled reason as text, not only as a tooltip', () => {
    const html = render({
      offered: true,
      enabled: false,
      reason: RESTORE_REFUSAL_COPY.no_checkpoints,
    });
    expect(html).toContain('data-testid="outcome-restore"');
    expect(html).toContain('disabled');
    // The reason must survive stripping every attribute: a `title`-only
    // version of this component passes any assertion that searches the raw
    // markup, because the tooltip text is in the markup too.
    const text = html.replace(/<[^>]*>/g, ' ');
    expect(text).toContain(RESTORE_REFUSAL_COPY.no_checkpoints);
    expect(html).toContain('data-testid="outcome-restore-reason"');
  });

  it('shows no reason when it is usable', () => {
    const html = render({ offered: true, enabled: true, reason: '' });
    expect(html).toContain('data-testid="outcome-restore"');
    expect(html).not.toContain('outcome-restore-reason');
    expect(html).not.toContain('disabled');
  });

  it('renders nothing at all when restore is not offered', () => {
    expect(render({ offered: false, enabled: false, reason: '' })).toBe('');
    expect(render(undefined)).toBe('');
  });

  it('disables while another worktree action holds the run', () => {
    const html = render({ offered: true, enabled: true, reason: '' }, true);
    expect(html).toContain('disabled');
  });
});

describe('the picker’s wiring', () => {
  it('routes the confirmation and the call through performRestore', () => {
    // The ordering claim is proven in restore-view.test.ts against injected
    // spies; what a component test can add is that the component actually
    // uses that function rather than sequencing the two awaits itself.
    expect(sheetSrc).toContain('performRestore');
    expect(sheetSrc).not.toContain('restoreRequest(');
    const askIndex = sheetSrc.indexOf('confirmManager.ask');
    const callIndex = sheetSrc.indexOf('api.runs.restoreCheckpoint');
    expect(askIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(-1);
    // Both are passed to performRestore as callbacks; neither is awaited in
    // the component, so the component cannot reorder them.
    expect(sheetSrc).not.toMatch(/await\s+confirmManager\.ask/);
    expect(sheetSrc).not.toMatch(/await\s+api\.runs\.restoreCheckpoint/);
  });

  it('marks itself busy before the confirmation is raised, not after', () => {
    const busyIndex = sheetSrc.indexOf('setBusy(true)');
    const performIndex = sheetSrc.indexOf('await performRestore');
    expect(busyIndex).toBeGreaterThan(-1);
    expect(performIndex).toBeGreaterThan(busyIndex);
  });

  it('drives the footer button from restoreActionState and disables the rows with it', () => {
    expect(sheetSrc).toContain(
      'restoreActionState({ busy, refreshing, hasSelection: !!selected })',
    );
    expect(sheetSrc).toContain('disabled={action.disabled}');
    expect(sheetSrc).toContain('disabled={busy || refreshing}');
  });

  it('holds every dismissal path while a restore is in flight', () => {
    // The result names the dropped shas and the paths left alone, and they
    // exist nowhere else in the UI; closing over it loses them.
    expect(sheetSrc).toContain('const closeIfIdle');
    expect(sheetSrc).toMatch(/if \(!busy\) onClose\(\);/);
    expect(sheetSrc).toContain('onClose={closeIfIdle}');
    expect(sheetSrc).toContain('data-testid="restore-close"');
  });

  it('does not assert the run recorded nothing when the read failed', () => {
    expect(sheetSrc).toContain('restoreEmptyCopy(list)');
    expect(sheetSrc).not.toContain('This run recorded no phase checkpoints.');
  });

  it('keys its reset on the run, not the list a restore’s own re-read nulls', () => {
    // Keyed on `list?.runId`, the post-restore refetch — which clears the list
    // first, so a stale commit count cannot be confirmed against — resets the
    // sheet and wipes the report of the restore that triggered it. Observed
    // live before this assertion existed.
    expect(sheetSrc).toContain('}, [open, runId]);');
    expect(sheetSrc).not.toMatch(/}, \[open, list\?\.runId\]\);/);
  });
});

describe('the screen’s checkpoint read', () => {
  it('re-reads the branch when the picker opens', () => {
    // commitsSince is measured against HEAD at read time, so a list read at
    // mount can be silent about commits made in the worktree since.
    expect(screenSrc).toContain('const openRestore');
    expect(screenSrc).toMatch(
      /setCheckpointsNonce\(\(n\) => n \+ 1\);\s*\n\s*setRestoreOpen\(true\)/,
    );
    expect(screenSrc).toContain('onRestore={openRestore}');
  });

  it('clears the stale list before refetching and tells the sheet it is refreshing', () => {
    expect(screenSrc).toMatch(
      /setCheckpoints\(null\);\s*\n\s*void api\.runs\s*\n?\s*\.restorableCheckpoints/,
    );
    expect(screenSrc).toContain('refreshing={checkpointsLoading}');
  });
});
