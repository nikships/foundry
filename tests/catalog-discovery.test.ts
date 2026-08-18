/**
 * Discovery once a session can answer for itself: the model list layers droid's
 * own session models over the help scrape, and the tool list comes off a live
 * session instead of a `droid exec --list-tools` child.
 *
 * Two independent "no child" signals: the argv-logging shim (catches spawns of
 * the configured droid path) and `takeDiscoverySpawns()` (catches any child this
 * module shells out to, including a hard-coded binary).
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipelineDef, ToolInfo } from '../src/shared/types.js';
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
import { AgentSession } from '../src/main/pi/session.js';
import { openDb, projectDbPath, projectRunsDir } from '../src/main/trace/db.js';
import { Tracer } from '../src/main/trace/tracer.js';
import { ScriptedAgent } from './scripted-transport.js';

let shim: string;
let argvLog: string;

/**
 * An executable that answers nothing and logs everything, so any discovery path
 * that still shells out leaves a trace even if it swallows the failure.
 */
function writeArgvShim(): { bin: string; log: string } {
  const dir = tempDir('foundry-argv-shim-');
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

/** The channels the catalog router registers, no Electron. */
function catalogChannels(): string[] {
  const channels: string[] = [];
  registerCatalogIpc({ supportDir: tempDir('foundry-catalog-ipc-') }, (channel) =>
    channels.push(channel),
  );
  return channels;
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

  it('is not something the renderer can ask for at all', () => {
    // Tools are a property of the live session that reported them, not of a
    // CLI the renderer names, so there is no tools channel to spawn behind.
    const channels = catalogChannels();
    expect(channels).toContain(IPC.catalogAgentModels);
    expect(channels.some((channel) => channel.startsWith('catalog:tools'))).toBe(false);
    expect(channels.some((channel) => channel.startsWith('catalog:clis'))).toBe(false);
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
    expect((await droidTools()).map((t) => t.id)).toEqual(['Execute']);
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

  function agentSession(scripted: ScriptedAgent): AgentSession {
    const support = tempDir('foundry-discovery-');
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
      mode: 'pi',
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
        runId,
        worktree: tempDir('foundry-discovery-wt-'),
        turnTimeoutMs: 20_000,
        tracer,
        protectedPaths: [],
        transport: (req) => scripted.transport(req),
        onTools: (tools) =>
          noteSessionTools(
            tools.map(({ id, displayName, description, category, defaultAllowed }) => ({
              id,
              llmId: id,
              displayName,
              description,
              category,
              defaultAllowed,
            })),
          ),
      },
    );
    sessions.push(session);
    return session;
  }

  it('feeds its own tools to the catalog without spawning a child', async () => {
    const scripted = new ScriptedAgent(['done']);
    const session = agentSession(scripted);
    await session.send('do the thing', { phaseId });

    // `ToolInfo.id` is the name a roster's allowlist uses.
    expect((await droidTools()).map((t) => t.id)).toEqual(['bash']);
    // The list came off the live session rather than a discovery command.
    expect(scripted.wire).toContain('list_tools');
    // Enumerating tools is never a child, and neither is the agent runtime:
    // the whole point of the session-fed catalog is that nothing is spawned.
    expect(shimInvocations()).toEqual([]);
    expect(takeDiscoverySpawns()).toEqual([]);
  });
});
