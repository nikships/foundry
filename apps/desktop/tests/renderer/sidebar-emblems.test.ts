/**
 * Collapsed-rail emblems have to stay a complete, tintable set. A missing slot
 * or a baked fill would only show up on the 56px rail, so the suite renders
 * every mark to markup and reads the Sidebar source for the wiring contract.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CHROME_EMBLEMS,
  DESIGN_TAB_EMBLEMS,
  NAV_EMBLEMS,
  SIDEBAR_EMBLEM_SLOTS,
  SIDEBAR_EMBLEMS,
  type Emblem,
  type SidebarEmblemSlot,
} from '@renderer/components/layout/SidebarEmblems.js';

const here = dirname(fileURLToPath(import.meta.url));
const sidebarSrc = readFileSync(
  join(here, '../../src/renderer/components/layout/Sidebar.tsx'),
  'utf8',
);
const provenance = readFileSync(
  join(here, '../../src/renderer/assets/sidebar-emblems/PROVENANCE.md'),
  'utf8',
);

const REQUIRED_SLOTS: SidebarEmblemSlot[] = [
  'runs',
  'inspector',
  'design',
  'prs',
  'pipelines',
  'agents',
  'envelopes',
  'smith',
  'project',
  'settings',
  'expand',
  'collapse',
];

function markup(Emblem: Emblem): string {
  return renderToStaticMarkup(createElement(Emblem, { size: 18, className: 'probe' }));
}

describe('collapsed-rail emblem catalog', () => {
  it('covers every navigation and chrome slot, including Smith', () => {
    expect([...SIDEBAR_EMBLEM_SLOTS].sort()).toEqual([...REQUIRED_SLOTS].sort());
    expect(Object.keys(NAV_EMBLEMS).sort()).toEqual(['design', 'inspector', 'prs', 'runs']);
    // Pipelines and Roster left the rail for Design's tab strip; the marks stay
    // in the same set so the tabs cannot drift from the sidebar's linework.
    expect(Object.keys(DESIGN_TAB_EMBLEMS).sort()).toEqual(['agents', 'envelopes', 'pipelines']);
    expect(Object.keys(CHROME_EMBLEMS).sort()).toEqual([
      'collapse',
      'expand',
      'project',
      'settings',
      'smith',
    ]);
  });

  it('records provenance for the set', () => {
    expect(provenance).toContain('currentColor');
    expect(provenance).toContain('SidebarEmblems.tsx');
    for (const slot of REQUIRED_SLOTS) {
      expect(provenance.toLowerCase()).toContain(slot === 'prs' ? 'pull requests' : slot);
    }
  });
});

describe('each emblem', () => {
  it.each(REQUIRED_SLOTS)('%s is a transparent currentColor svg with no baked backdrop', (slot) => {
    const html = markup(SIDEBAR_EMBLEMS[slot]);
    expect(html.startsWith('<svg')).toBe(true);
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('fill="none"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('class="probe"');
    expect(html).toContain('width="18"');
    expect(html).toContain('height="18"');
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).not.toMatch(/fill="#[0-9a-fA-F]/);
    expect(html).not.toMatch(/fill="rgb/);
    expect(html).not.toContain('filter=');
    expect(html).not.toContain('<rect');
  });
});

describe('Sidebar wiring', () => {
  it('no longer uses lucide placeholders on the rail', () => {
    expect(sidebarSrc).not.toMatch(/from ['"]lucide-react['"]/);
    expect(sidebarSrc).toContain("from './SidebarEmblems.js'");
  });

  it('keeps Activity hidden when the rail is collapsed', () => {
    expect(sidebarSrc).toMatch(/!collapsed && pipelineRuns\.length > 0/);
  });

  it('scopes Activity to the selected project and never switches projects on click', () => {
    expect(sidebarSrc).not.toContain('useAllProjectRuns');
    expect(sidebarSrc).toContain('useActivityRuns(projectId)');
    expect(sidebarSrc).not.toContain('selectProject(run.projectId)');
  });

  it('still names every collapsed control', () => {
    expect(sidebarSrc).toContain(
      'aria-label={collapsed ? `${item.label} ⌘${item.key}` : undefined}',
    );
    expect(sidebarSrc).toContain('aria-label="Smith"');
    // The project picker names itself after the active project, so assert the
    // binding and its no-project fallback rather than a literal attribute.
    expect(sidebarSrc).toContain('aria-label={projectAriaLabel}');
    expect(sidebarSrc).toMatch(/projectAriaLabel = .*: 'Project';/);
    expect(sidebarSrc).toContain("aria-label={collapsed ? 'Settings ⌘,' : undefined}");
    expect(sidebarSrc).toContain("aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}");
  });
});
