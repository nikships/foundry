/**
 * Design consolidated pipelines, agents, and envelopes into one view. The pieces
 * that had to agree afterwards live in four files — the nav table, the native
 * menu, the preload channel allowlist, and the screens themselves — so this
 * suite pins the seams rather than the markup.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DESIGN_TABS,
  MENU_DESIGN_TABS,
  MENU_VIEWS,
  NAV_ITEMS,
  designTabForEntity,
} from '@renderer/navigation.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, '..', rel), 'utf8');

const mainSrc = read('src/main/main.ts');
const bridgeSrc = read('src/preload/bridge.ts');
const settingsSrc = read('src/renderer/screens/SettingsScreen.tsx');
const designSrc = read('src/renderer/screens/DesignScreen.tsx');
const rosterSrc = read('src/renderer/screens/RosterScreen.tsx');
const phaseEditorSrc = read('src/renderer/components/PhaseEditor.tsx');
const envelopesSrc = read('src/renderer/components/EnvelopesEditor.tsx');
const appSrc = read('src/renderer/App.tsx');
const runsSrc = read('src/renderer/screens/RunsScreen.tsx');
const inspectorSrc = read('src/renderer/screens/InspectorScreen.tsx');
const prsSrc = read('src/renderer/screens/PullRequestsScreen.tsx');
const runDetailSrc = read('src/renderer/screens/RunDetailScreen.tsx');
const phaseDrawerSrc = read('src/renderer/components/PhaseDrawer.tsx');

describe('the sidebar', () => {
  it('exposes Runs, Inspector, Design, and Pull Requests, in that order', () => {
    expect(NAV_ITEMS.map((i) => i.id)).toEqual(['runs', 'inspector', 'design', 'prs']);
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(['Runs', 'Inspector', 'Design', 'Pull Requests']);
  });

  it('numbers the digits contiguously from 1, so no chord is dead', () => {
    expect(NAV_ITEMS.map((i) => i.key)).toEqual(['1', '2', '3', '4']);
  });

  it('reaches Settings without spending a nav digit on it', () => {
    expect(NAV_ITEMS.some((i) => i.id === 'design')).toBe(true);
    expect(NAV_ITEMS.some((i) => (i.id as string) === 'settings')).toBe(false);
    expect(MENU_VIEWS['menu:settings']).toBe('settings');
  });
});

describe('Design', () => {
  it('provides Pipelines, Agents, and Envelopes in dependency order', () => {
    expect(DESIGN_TABS.map((t) => t.id)).toEqual(['pipelines', 'agents', 'envelopes']);
    expect(DESIGN_TABS.map((t) => t.label)).toEqual(['Pipelines', 'Agents', 'Envelopes']);
  });

  it('gives every tab its own blurb, so the vocabulary is stated in the UI', () => {
    for (const tab of DESIGN_TABS) expect(tab.blurb.length).toBeGreaterThan(20);
    expect(new Set(DESIGN_TABS.map((t) => t.blurb)).size).toBe(DESIGN_TABS.length);
  });

  it('mounts all three editors', () => {
    expect(designSrc).toContain('<PipelinesScreen');
    expect(designSrc).toContain('<RosterScreen');
    expect(designSrc).toContain('<EnvelopesEditor');
  });

  it('renders one tab at a time, so a debounced draft flushes on unmount', () => {
    for (const tab of DESIGN_TABS) expect(designSrc).toContain(`tab === '${tab.id}'`);
  });
});

describe('Settings', () => {
  it('no longer treats Envelopes as a preference pane', () => {
    expect(settingsSrc).not.toContain("id: 'envelopes'");
    expect(settingsSrc).not.toContain('EnvelopesSettings');
    expect(settingsSrc).not.toContain('EnvelopesEditor');
    expect(settingsSrc).not.toContain('openEnvelope');
  });

  it('keeps the remaining preference panes', () => {
    for (const pane of ['general', 'clis', 'defaults', 'mcp', 'project', 'maintenance', 'about']) {
      expect(settingsSrc).toContain(`id: '${pane}'`);
    }
  });

  it('exposes a data-testid on every pane tab for CDP automation', () => {
    expect(settingsSrc).toContain('data-testid={`settings-tab-${p.id}`}');
  });
});

describe('cross-links', () => {
  it('stay inside Design instead of routing into Settings', () => {
    expect(rosterSrc).toContain("onOpenDesignTab('envelopes')");
    expect(phaseEditorSrc).toContain("onOpenDesignTab('envelopes')");
    expect(rosterSrc).not.toContain('onOpenSettings');
    expect(phaseEditorSrc).not.toContain('onOpenSettings');
  });

  it('still offer the link from both editors that pick an envelope', () => {
    expect(rosterSrc).toContain('Manage envelopes…');
    expect(phaseEditorSrc).toContain('Manage envelopes…');
  });

  it('send each Smith entity kind to the tab that edits it', () => {
    expect(designTabForEntity('pipeline')).toBe('pipelines');
    expect(designTabForEntity('agent')).toBe('agents');
    expect(designTabForEntity('envelope')).toBe('envelopes');
  });

  it('open Design for every approved proposal, envelopes included', () => {
    expect(appSrc).toContain('designTabForEntity(target.kind)');
    expect(appSrc).toContain("setView('design')");
    // The old envelope path detoured through a Settings pane.
    expect(appSrc).not.toContain("setSettingsPane('envelopes')");
  });
});

describe('the envelope editor', () => {
  it('keeps the behaviour that made it a designer, not a form', () => {
    for (const capability of [
      'useDebouncedSave',
      'api.envelopes.validate',
      'api.envelopes.duplicate',
      'api.envelopes.remove',
      'api.envelopes.usage',
      'api.envelopes.preview',
    ]) {
      expect(envelopesSrc, capability).toContain(capability);
    }
  });

  it('still honours a deep link by name and nonce', () => {
    expect(envelopesSrc).toContain('openEnvelope');
    expect(envelopesSrc).toContain('openNonce');
  });

  it('owns its stylesheet now that it left the Settings pane', () => {
    expect(envelopesSrc).toContain("from './EnvelopesEditor.module.css'");
    expect(envelopesSrc).not.toContain('SettingsScreen.module.css');
  });

  it('hides always-present base fields from the field list so the editor focuses on custom fields', () => {
    expect(envelopesSrc).not.toContain('BASE_FIELDS');
    expect(envelopesSrc).not.toContain('Base · always present');
  });
});

describe('the native menu', () => {
  it('offers the four views on Cmd+1..4', () => {
    for (const [index, item] of NAV_ITEMS.entries()) {
      expect(mainSrc).toContain(`accelerator: 'Cmd+${index + 1}'`);
      expect(mainSrc).toContain(`menu:view-${item.id}`);
    }
  });

  it('offers each Design tab on Cmd+Shift+1..3', () => {
    for (const [index, tab] of DESIGN_TABS.entries()) {
      expect(mainSrc).toContain(`accelerator: 'Cmd+Shift+${index + 1}'`);
      expect(mainSrc).toContain(`menu:design-${tab.id}`);
    }
  });

  it('no longer broadcasts the retired view commands', () => {
    expect(mainSrc).not.toContain('menu:view-pipelines');
    expect(mainSrc).not.toContain('menu:view-roster');
    expect(bridgeSrc).not.toContain('menu:view-pipelines');
    expect(bridgeSrc).not.toContain('menu:view-roster');
  });

  // A command the main process sends but the preload does not list is dropped
  // silently, so the menu item would simply do nothing.
  it('has a preload channel for every command the renderer maps', () => {
    for (const command of [...Object.keys(MENU_VIEWS), ...Object.keys(MENU_DESIGN_TABS)]) {
      expect(bridgeSrc, command).toContain(`'${command}'`);
    }
  });

  it('maps every command the preload forwards', () => {
    const forwarded = [...bridgeSrc.matchAll(/'(menu:[a-z-]+)'/g)].map((m) => m[1]);
    const handled = new Set([
      ...Object.keys(MENU_VIEWS),
      ...Object.keys(MENU_DESIGN_TABS),
      'menu:new-run',
      'menu:add-project',
    ]);
    for (const command of forwarded) expect(handled.has(command), command).toBe(true);
  });
});

describe('CDP automation hooks', () => {
  it('stamps the current view on main so a snapshot is not required to know where you are', () => {
    expect(appSrc).toContain('data-testid="app-view"');
    expect(appSrc).toContain('data-view=');
    expect(appSrc).toContain("data-view={openRunId && view === 'runs' ? 'run-detail' : view}");
    expect(appSrc).toContain('data-open-run={openRunId || undefined}');
    expect(appSrc).toContain("data-design-tab={view === 'design' ? designTab : undefined}");
    expect(appSrc).toContain("data-settings-pane={view === 'settings' ? settingsPane : undefined}");
    expect(appSrc).toContain('onPaneChange={setSettingsPane}');
    expect(settingsSrc).toContain('onPaneChange?.(next)');
  });

  it('lets a run row be clicked by id instead of concatenated snapshot text', () => {
    expect(runsSrc).toContain('data-testid={`run-row-${run.runId}`}');
    expect(runsSrc).toContain('data-run-id={run.runId}');
  });

  it('gives Inspector, PRs, and run-detail panes stable testids', () => {
    expect(inspectorSrc).toContain('data-testid="inspector-run"');
    expect(inspectorSrc).toContain('data-testid={`inspector-filter-${f.id}`}');
    expect(inspectorSrc).toContain('data-testid="inspector-raw-files"');
    expect(prsSrc).toContain('data-testid="prs-refresh"');
    expect(runDetailSrc).toContain('data-testid="run-cost"');
    expect(phaseDrawerSrc).toContain('data-testid={`phase-tab-${t.id}`}');
  });
});

describe('user-facing wording', () => {
  it('calls the roster "Agents" wherever the operator reads it', () => {
    expect(DESIGN_TABS.find((t) => t.id === 'agents')?.label).toBe('Agents');
    expect(mainSrc).toContain("label: 'Agents'");
    expect(mainSrc).not.toContain("label: 'Roster'");
  });

  it('keeps the internal roster identifiers, so stored data still resolves', async () => {
    // roster.json, the IPC domain, and the store API are untouched by a rename
    // that only ever concerned the label.
    const { IPC } = await import('@shared/ipc-contract.js');
    expect(IPC.rosterList).toBe('roster:list');
    expect(IPC.rosterSave).toBe('roster:save');
    expect(read('src/main/store/roster.ts')).toContain("'roster.json'");
    // The screen still calls the roster domain; only its heading changed.
    expect(rosterSrc).toContain('api.roster.');
  });

  it('never says "engineer phase" while the wire value stays `engineer`', () => {
    const derive = read('src/renderer/derive.ts');
    expect(derive).toContain("engineer: 'checkpoint'");
    expect(read('src/renderer/components/PipelineCanvas.tsx')).toContain("'engineer'");
    for (const src of [phaseEditorSrc, designSrc, rosterSrc]) {
      expect(src.toLowerCase()).not.toContain('engineer phase');
    }
  });
});
