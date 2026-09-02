import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LinearIssueSnapshot } from '@shared/types.js';
import LinearIssueResults from '@renderer/components/run/LinearIssueResults.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, '../..', rel), 'utf8');

const issue: LinearIssueSnapshot = {
  id: 'issue-1',
  identifier: 'FOU-226',
  title: 'Fix the Linear issue picker',
  description: '',
  url: 'https://linear.app/foundry/issue/FOU-226',
  updatedAt: new Date().toISOString(),
  team: { id: 'team-1', name: 'Foundry' },
  state: { id: 'state-1', name: 'Todo', type: 'unstarted' },
};

describe('Linear run chrome', () => {
  it('exposes the active issue as a highlight, not a committed selection', () => {
    const markup = renderToStaticMarkup(
      createElement(LinearIssueResults, {
        issues: [issue],
        query: '',
        loading: false,
        error: '',
        activeIndex: 0,
        onActiveIndex: vi.fn(),
        onSelect: vi.fn(),
        onRetry: vi.fn(),
        onClearSearch: vi.fn(),
      }),
    );

    expect(markup).toContain('aria-selected="false"');
    expect(markup).toContain('data-active="true"');
    expect(markup).toContain('data-selected="false"');
    expect(markup).toContain('↑↓ highlight · ⏎ select');
  });

  it('shows why the primary action is blocked before an issue is selected', () => {
    const composer = read('src/renderer/components/run/LinearComposer.tsx');
    expect(composer).toContain("currentBlocked && !starting && orchestrator.stage === 'compose'");
    expect(composer).not.toContain('currentBlocked && issue && !starting');
  });

  it('renders full run ids and delegates constrained shortening to CSS ellipsis', () => {
    const screen = read('src/renderer/screens/RunDetailScreen.tsx');
    const styles = read('src/renderer/screens/RunDetailScreen.module.css');

    expect(screen).not.toContain('runId.slice(');
    expect(screen).toContain('<span className={styles.headId} title={runId}>');
    expect(screen).toContain('{runId}');
    expect(styles).toMatch(/\.headId \{[\s\S]*text-overflow: ellipsis;/);
  });
});
