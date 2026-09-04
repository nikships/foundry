import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LinearIssueSnapshot } from '@shared/types.js';
import LinearIssueResults from '@renderer/components/run/LinearIssueResults.js';
import { LinearIssueDescription } from '@renderer/components/run/LinearSelectedIssue.js';

vi.mock('@renderer/api.js', () => ({
  api: { app: { openExternal: vi.fn() } },
}));

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

  it('renders representative Markdown in the expanded issue description', () => {
    const description = [
      '# Heading',
      '',
      'Plain line',
      'Second line with **bold**, *emphasis*, `code`, and [docs](https://example.com).',
      '',
      '- First item',
      '- Second item',
      '',
      '> Quoted text',
      '',
      '```ts',
      'const ready = true;',
      '```',
    ].join('\n');
    const markup = renderToStaticMarkup(createElement(LinearIssueDescription, { description }));

    expect(markup).toContain('role="heading" aria-level="1"');
    expect(markup).toContain('Plain line\nSecond line with ');
    expect(markup).toContain('<strong><span>bold</span></strong>');
    expect(markup).toContain('<em><span>emphasis</span></em>');
    expect(markup).toContain('<code');
    expect(markup).toContain('<a');
    expect(markup).toContain('href="https://example.com"');
    expect(markup).toContain('<ul');
    expect(markup).toContain('<blockquote');
    expect(markup).toContain('<pre');
    expect(markup).toContain('data-language="ts"');
    expect(markup).toContain('const ready = true;');
  });

  it('preserves the empty description message', () => {
    const markup = renderToStaticMarkup(createElement(LinearIssueDescription, { description: '' }));

    expect(markup).toContain('No description.');
  });

  it('renders unsafe HTML as inert text', () => {
    const markup = renderToStaticMarkup(
      createElement(LinearIssueDescription, {
        description: '<script>alert("xss")</script>\n\n<img src=x onerror="alert(1)">',
      }),
    );

    expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('<img');
  });

  it('keeps the issue description selectable, scrollable, and vertically resizable', () => {
    const component = read('src/renderer/components/run/LinearSelectedIssue.tsx');
    const styles = read('src/renderer/components/run/LinearComposer.module.css');

    expect(component).toContain('`${styles.issueDescription} selectable`');
    expect(styles).toMatch(
      /\.issueDescription \{[\s\S]*height: 132px;[\s\S]*max-height: min\(60vh, 640px\);[\s\S]*overflow-y: auto;[\s\S]*resize: vertical;/,
    );
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
