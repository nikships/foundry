/**
 * Foundry in-process MCP tools: registration shape, handler semantics, and
 * the typed-overload contract (args once, clean errors on bad input).
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFoundryMcpServer,
  FOUNDRY_MCP_SERVER_NAME,
  FOUNDRY_TOOL_IDS,
  FOUNDRY_TOOL_NAMES,
  type FoundryMcpContext,
} from '../src/main/droid/sdk/mcp-tools.js';
import type { Envelope } from '../src/main/engine/envelopes.js';
import { openDb, projectDbPath, projectRunsDir } from '../src/main/trace/db.js';
import { Tracer } from '../src/main/trace/tracer.js';
import type { PipelineDef } from '../src/shared/types.js';

const PIPELINE: PipelineDef = {
  id: 'mcp-test',
  name: 'mcp-test',
  description: 'mcp tools unit',
  acceptance: { kind: 'all_phases_pass' },
  phases: [],
};

interface ToolLike {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => unknown | Promise<unknown>;
}

interface ServerLike {
  name: string;
  tools: ToolLike[];
  start: () => Promise<{ type: string; name: string; url: string }>;
  close: () => Promise<void>;
  config: { url: string } | null;
}

function openTracer(): { tracer: Tracer; runId: string; phaseId: string } {
  const support = mkdtempSync(join(tmpdir(), 'foundry-mcp-'));
  const repo = mkdtempSync(join(tmpdir(), 'foundry-mcp-repo-'));
  const db = openDb(projectDbPath(support, repo));
  const tracer = new Tracer(db, projectRunsDir(support, repo));
  const runId = `run_mcp_${Date.now().toString(36)}`;
  tracer.startRun({
    runId,
    projectId: 'p',
    pipeline: PIPELINE,
    request: 'mcp',
    engineer: 'tester',
    worktreePath: null,
    branch: null,
    baseRef: 'main',
    mode: 'rpc',
  });
  const phaseId = tracer.openPhase({
    runId,
    seq: 0,
    name: 'scout',
    kind: 'agent',
    owner: 'scout',
    description: 'mcp unit',
  });
  return { tracer, runId, phaseId };
}

function context(
  tracer: Tracer,
  runId: string,
  envelopes: Map<string, Envelope> = new Map(),
  phaseId: string | null = null,
): FoundryMcpContext {
  return {
    runId,
    agentName: 'scout',
    phaseId: () => phaseId,
    envelopes: () => envelopes,
    tracer,
  };
}

const openServers: ServerLike[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server) await server.close().catch(() => undefined);
  }
});

function serverFor(ctx: FoundryMcpContext): ServerLike {
  const server = createFoundryMcpServer(ctx) as unknown as ServerLike;
  openServers.push(server);
  return server;
}

function toolNamed(server: ServerLike, name: string): ToolLike {
  const found = server.tools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe('foundry MCP registry', () => {
  it('registers exactly report_progress and read_phase_context under the foundry server', () => {
    const { tracer, runId, phaseId } = openTracer();
    const server = serverFor(context(tracer, runId, new Map(), phaseId));
    expect(server.name).toBe(FOUNDRY_MCP_SERVER_NAME);
    expect(server.tools.map((t) => t.name).sort()).toEqual([...FOUNDRY_TOOL_NAMES].sort());
    expect(FOUNDRY_TOOL_IDS).toEqual([
      'foundry___report_progress',
      'foundry___read_phase_context',
    ]);
  });

  it('uses the typed tool() overload — every tool carries an inputSchema', () => {
    const { tracer, runId, phaseId } = openTracer();
    const server = serverFor(context(tracer, runId, new Map(), phaseId));
    for (const t of server.tools) {
      expect(t.inputSchema, `${t.name} must use the typed overload`).toBeDefined();
      expect(typeof t.inputSchema).toBe('object');
    }
  });

  it('isolates the nested zod-3 import to sdk-zod.ts', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/main/droid/sdk/sdk-zod.ts'),
      'utf8',
    );
    expect(src).toMatch(/@factory\/droid-sdk\/node_modules\/zod/);
    const mcp = readFileSync(join(process.cwd(), 'src/main/droid/sdk/mcp-tools.ts'), 'utf8');
    expect(mcp).toMatch(/from '\.\/sdk-zod\.js'/);
    expect(mcp).not.toMatch(/node_modules\/zod/);
    // Schema-less three-arg tool() form is forbidden.
    expect(mcp).not.toMatch(/tool\(\s*['"][^'"]+['"]\s*,\s*['"][^'"]+['"]\s*,\s*(async\s*)?\(/);
  });

  it('contains no filesystem writes into the worktree', () => {
    const mcp = readFileSync(join(process.cwd(), 'src/main/droid/sdk/mcp-tools.ts'), 'utf8');
    expect(mcp).not.toMatch(/\b(writeFile|appendFile|createWriteStream|mkdirSync|writeFileSync)\b/);
    expect(mcp).not.toMatch(/\bfs\./);
  });
});

describe('report_progress', () => {
  it('writes a log event named "{agent}: progress" and returns recorded', async () => {
    const { tracer, runId, phaseId } = openTracer();
    const server = serverFor(context(tracer, runId, new Map(), phaseId));
    const result = await toolNamed(server, 'report_progress').handler({
      summary: 'skimmed the README',
    });
    expect(result).toBe('recorded');

    const events = tracer.eventsAfter(runId, 0, 1000).filter((e) => e.type === 'log');
    const progress = events.find((e) => e.name === 'scout: progress');
    expect(progress).toBeDefined();
    expect(progress?.payload).toMatchObject({
      message: 'skimmed the README',
      summary: 'skimmed the README',
    });
    expect(progress?.phaseId).toBe(phaseId);
  });

  it('delivers the model args exactly once (typed overload)', async () => {
    const { tracer, runId, phaseId } = openTracer();
    const calls: unknown[] = [];
    const base = context(tracer, runId, new Map(), phaseId);
    const wrapped: FoundryMcpContext = {
      ...base,
      tracer: {
        event: (input) => {
          calls.push(input.payload);
          return base.tracer.event(input);
        },
      },
    };
    const server = serverFor(wrapped);
    await toolNamed(server, 'report_progress').handler({ summary: 'once' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ summary: 'once' });
  });
});

describe('read_phase_context', () => {
  it('returns the validated envelope chain for this run as JSON', async () => {
    const { tracer, runId, phaseId } = openTracer();
    const envelopes = new Map<string, Envelope>([
      [
        'scout',
        {
          status: 'success',
          summary: 'repo has a test script',
          artifacts: ['README.md'],
          notes_for_next_agent: 'run the tests',
        },
      ],
      [
        'build',
        {
          status: 'success',
          summary: 'added a helper',
          artifacts: ['src/add.js'],
          notes_for_next_agent: '',
          changed_files: ['src/add.js'],
          commit_message: 'add helper',
        },
      ],
    ]);
    const server = serverFor(context(tracer, runId, envelopes, phaseId));
    const raw = await toolNamed(server, 'read_phase_context').handler({});
    expect(typeof raw).toBe('string');
    const chain = JSON.parse(raw as string) as Array<{ phase: string; envelope: Envelope }>;
    expect(chain).toHaveLength(2);
    expect(chain[0]).toEqual({
      phase: 'scout',
      envelope: envelopes.get('scout'),
    });
    expect(chain[1]?.envelope.summary).toBe('added a helper');
  });

  it('returns an empty array when no envelopes have been recorded yet', async () => {
    const { tracer, runId, phaseId } = openTracer();
    const server = serverFor(context(tracer, runId, new Map(), phaseId));
    const raw = await toolNamed(server, 'read_phase_context').handler({});
    expect(JSON.parse(raw as string)).toEqual([]);
  });
});

describe('malformed input', () => {
  it('rejects bad report_progress payloads without crashing, and a later valid call still works', async () => {
    const { tracer, runId, phaseId } = openTracer();
    const server = serverFor(context(tracer, runId, new Map(), phaseId));
    const report = toolNamed(server, 'report_progress');

    const bad: unknown[] = [
      {},
      { summary: 42 },
      { summary: null },
      { notSummary: 'x' },
    ];
    for (const payload of bad) {
      let threw: unknown;
      try {
        await report.handler(payload as Record<string, unknown>);
      } catch (e) {
        threw = e;
      }
      expect(threw, `expected schema error for ${JSON.stringify(payload)}`).toBeDefined();
      expect(String(threw)).toMatch(/invalid|expected|required|Zod/i);
    }

    // Follow-up valid call on the same server still succeeds.
    const ok = await report.handler({ summary: 'recovered' });
    expect(ok).toBe('recorded');
    const progress = tracer
      .eventsAfter(runId, 0, 1000)
      .find((e) => e.type === 'log' && e.name === 'scout: progress');
    expect(progress?.payload).toMatchObject({ summary: 'recovered' });
  });

  it('accepts empty input for read_phase_context and strips unexpected keys', async () => {
    const { tracer, runId, phaseId } = openTracer();
    const server = serverFor(context(tracer, runId, new Map(), phaseId));
    const read = toolNamed(server, 'read_phase_context');
    // Extra keys are stripped by zod object defaults — not a crash.
    const raw = await read.handler({ unexpected: true, junk: 1 } as Record<string, unknown>);
    expect(JSON.parse(raw as string)).toEqual([]);
  });
});

describe('MCP server lifecycle', () => {
  it('starts a loopback HTTP listener and closes it with the server', async () => {
    const { tracer, runId, phaseId } = openTracer();
    const server = serverFor(context(tracer, runId, new Map(), phaseId));
    const config = await server.start();
    expect(config.type).toBe('http');
    expect(config.name).toBe('foundry');
    expect(config.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(server.config?.url).toBe(config.url);

    await server.close();
    expect(server.config).toBeNull();
    // Second close is a no-op.
    await server.close();
  });
});
