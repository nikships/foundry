/**
 * Discovery once a session can answer for itself: the model list layers droid's
 * own session models over the help scrape, and the tool list comes off a live
 * session instead of a `droid exec --list-tools` child.
 *
 * Two independent "no child" signals: the argv-logging shim (catches spawns of
 * the configured droid path) and `takeDiscoverySpawns()` (catches any child this
 * module shells out to, including a hard-coded binary).
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliVendor, PipelineDef, ToolInfo } from '../src/shared/types.js';
import { IPC } from '../src/shared/ipc-contract.js';
import { register as registerCatalogIpc } from '../src/main/ipc/catalog.js';
import {
  droidTools,
  invalidateCatalog,
  loadDroidCatalog,
  noteSessionModels,
  noteSessionTools,
  takeDiscoverySpawns,
} from '../src/main/droid/catalog.js';
import { AgentSession } from '../src/main/droid/agent.js';
import { openDb, projectDbPath, projectRunsDir } from '../src/main/trace/db.js';
import { Tracer } from '../src/main/trace/tracer.js';
import { writeFakeDroid } from './fake-droid.js';

let shim: string;
let argvLog: string;

/**
 * An executable that answers nothing and logs everything, so any discovery path
 * that still shells out leaves a trace even if it swallows the failure.
 */
function writeArgvShim(): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-argv-shim-'));
  const log = join(dir, 'argv.log');
  const bin = join(dir, 'droid');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

function shimInvocations(): string[] {
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
}

/** The `catalog:tools` handler as the renderer would reach it, no Electron. */
function toolsHandler(droidPath: string): (vendor: CliVendor) => Promise<ToolInfo[]> {
  const handlers = new Map<string, unknown>();
  const ctx = { settings: { get: () => ({ clis: { droid: { path: droidPath } } }) } };
  registerCatalogIpc(ctx as never, (channel, fn) => handlers.set(channel, fn));
  return handlers.get(IPC.catalogTools) as (vendor: CliVendor) => Promise<ToolInfo[]>;
}

beforeEach(() => {
  const written = writeArgvShim();
  shim = written.bin;
  argvLog = written.log;
  invalidateCatalog();
  takeDiscoverySpawns();
});

describe('a tools request before any session exists', () => {
  it('resolves to an empty list rather than rejecting', async () => {
    await expect(droidTools()).resolves.toEqual([]);
  });

  it('spawns nothing through the IPC channel the renderer still owns', async () => {
    const tools = await toolsHandler(shim)('droid');
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toEqual([]);
    expect(shimInvocations()).toEqual([]);
    expect(takeDiscoverySpawns()).toEqual([]);
  });
});

describe('a tools request once a session has reported', () => {
  const tool: ToolInfo = {
    id: 'Execute',
    llmId: 'Execute',
    displayName: 'Execute',
    description: 'run a command',
    category: 'execute',
    defaultAllowed: true,
  };

  it('answers with the session list and still spawns nothing', async () => {
    noteSessionTools([tool]);
    const tools = await toolsHandler(shim)('droid');
    expect(tools.map((t) => t.id)).toEqual(['Execute']);
    expect(shimInvocations()).toEqual([]);
    expect(takeDiscoverySpawns()).toEqual([]);
  });

  it('hands out a copy, so a caller cannot mutate what the next one reads', async () => {
    noteSessionTools([tool]);
    (await droidTools()).length = 0;
    expect((await droidTools()).map((t) => t.id)).toEqual(['Execute']);
  });
});

describe('the model catalog', () => {
  it('layers a session model over the help scrape without losing the scrape', async () => {
    noteSessionModels([
      {
        id: 'session-only-model',
        modelId: 'session-only-model',
        modelProvider: 'anthropic',
        displayName: 'Session Only',
        supportedReasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
      },
    ]);
    // The shim prints no model table, so the scrape is empty and the session
    // layer is the whole answer — which is exactly what must reach the picker.
    const models = await loadDroidCatalog(shim);
    expect(models.map((m) => m.id)).toContain('session-only-model');
  });

  it('forgets session models when the catalog is invalidated', async () => {
    noteSessionModels([
      {
        id: 'session-only-model',
        modelId: 'session-only-model',
        modelProvider: 'anthropic',
        displayName: 'Session Only',
        supportedReasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
      },
    ]);
    expect((await loadDroidCatalog(shim)).map((m) => m.id)).toContain('session-only-model');
    invalidateCatalog();
    expect((await loadDroidCatalog(shim)).map((m) => m.id)).not.toContain('session-only-model');
  });
});

describe('a live agent session', () => {
  let fakeDroid: string;
  let phaseId: string;
  const sessions: AgentSession[] = [];

  const pipeline: PipelineDef = {
    id: 'test',
    name: 'test',
    description: 'test pipeline',
    acceptance: { kind: 'all_phases_pass' },
    phases: [],
  };

  afterEach(async () => {
    while (sessions.length > 0) await sessions.pop()?.close();
  });

  function agentSession(): AgentSession {
    fakeDroid = writeFakeDroid();
    const support = mkdtempSync(join(tmpdir(), 'foundry-discovery-'));
    const tracer = new Tracer(
      openDb(projectDbPath(support, 'proj')),
      projectRunsDir(support, 'proj'),
    );
    const runId = 'run_catalog_discovery';
    tracer.startRun({
      runId,
      projectId: 'proj',
      pipeline,
      request: 'do it',
      engineer: 'tester',
      worktreePath: null,
      branch: null,
      baseRef: 'main',
      mode: 'rpc',
    });
    phaseId = tracer.openPhase({
      runId,
      seq: 0,
      name: 'build',
      kind: 'agent',
      owner: 'builder',
      description: 'd',
    });
    const session = new AgentSession(
      {
        name: 'builder',
        purpose: 'build things',
        model: 'fake-allowed',
        reasoningEffort: 'medium',
        systemPrompt: 'You build.',
        userPrompt: 'Build: {{request}}',
        writes: null,
        envelope: 'build',
        color: '#fff',
      },
      {
        cliPath: fakeDroid,
        runId,
        worktree: mkdtempSync(join(tmpdir(), 'foundry-discovery-wt-')),
        turnTimeoutMs: 20_000,
        tracer,
        policy: { protectedPaths: [] },
        // Unit tests force subprocess so they never touch DaemonManager.
        transport: 'subprocess',
      },
    );
    sessions.push(session);
    return session;
  }

  it('feeds its own models and tools to the catalog', async () => {
    const session = agentSession();
    await session.send('do the thing', { phaseId });

    const models = await loadDroidCatalog(shim);
    // The shim prints no model table, so anything here that is not a BYOK entry
    // from the real settings.json came off the session's own init response.
    expect(
      models
        .filter((m) => !m.isCustom)
        .map((m) => m.id)
        .sort(),
    ).toEqual(['fake-allowed', 'gpt-fake-default']);

    const tools = await toolsHandler(shim)('droid');
    // `ToolInfo.id` is the llmId the roster names, not the CLI's internal id.
    expect(tools.map((t) => t.id)).toEqual(['Execute']);
    // The model scrape is still a child; enumerating tools never is again.
    expect(shimInvocations()).toEqual(['exec --help']);
  });
});
