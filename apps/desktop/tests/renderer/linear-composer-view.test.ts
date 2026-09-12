import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  emptyLinearComposerSelection,
  linearComposerSelectionForProject,
} from '@renderer/view-models/linear-composer-view.js';

const here = dirname(fileURLToPath(import.meta.url));
const composer = readFileSync(
  join(here, '../../src/renderer/components/run/LinearComposer.tsx'),
  'utf8',
);

describe('linearComposerSelectionForProject', () => {
  it('leaves the draft alone when the project id is unchanged', () => {
    expect(linearComposerSelectionForProject('proj-a', 'proj-a')).toBeNull();
  });

  it('clears issue, mapping chrome, and query when the project changes', () => {
    expect(linearComposerSelectionForProject('proj-a', 'proj-b')).toEqual(
      emptyLinearComposerSelection(),
    );
    expect(emptyLinearComposerSelection()).toEqual({
      query: '',
      issues: [],
      activeIndex: 0,
      issue: null,
      mappingOpen: false,
      showMappingErrors: false,
      searching: false,
      evidenceLoading: false,
      searchError: '',
      startIssues: [],
      planStartIssues: [],
    });
  });

  it('is applied by the Linear composer on projectId change', () => {
    expect(composer).toContain('linearComposerSelectionForProject');
    expect(composer).toContain('composerProjectIdRef');
    expect(composer).toMatch(/linearComposerSelectionForProject\([\s\S]*projectId\)/);
    expect(composer).toMatch(/}, \[projectId\]\);/);
  });
});
