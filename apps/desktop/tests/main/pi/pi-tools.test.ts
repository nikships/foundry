/**
 * Foundry's own tools, called the way the runtime calls them.
 *
 * These replaced an in-process MCP server, so the properties that mattered
 * there still matter: the tools trace and read, they never touch the worktree,
 * and `submit_envelope` carries the phase's own schema so a conforming call
 * cannot drift from what the parse accepts.
 *
 * The load-bearing detail is that `submit_envelope` is rebuilt per phase. The
 * runtime caches compiled validators against the schema object's identity, so a
 * phase-specific schema has to arrive as a new definition rather than a mutated
 * one — a captured submission from the wrong schema would be a phase answering
 * with another phase's envelope.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import {
  FOUNDRY_TOOL_NAMES,
  readPhaseContextTool,
  reportProgressTool,
  submitEnvelopeTool,
  type PhaseContextEntry,
} from '../../../src/main/pi/tools.js';
import type { FoundryToolContext } from '../../../src/main/pi/transport.js';
import { jsonSchemaFor, type Envelope } from '../../../src/main/engine/envelopes.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import type { PipelineDef } from '../../../src/shared/types.js';

const PIPELINE: PipelineDef = {
  id: 'pi-tools',
  name: 'pi-tools',
  description: 'pi tools unit',
  acceptance: { kind: 'all_phases_pass' },
  phases: [],
};

interface Harness {
  tracer: Tracer;
  runId: string;
  phaseId: string;
}

function openTracer(): Harness {
  const support = tempDir('foundry-pi-tools-');
  const repo = tempDir('foundry-pi-tools-repo-');
  const tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
  const runId = `run_pi_${Date.now().toString(36)}`;
  tracer.startRun({
    runId,
    projectId: 'p',
    pipeline: PIPELINE,
    request: 'tools',
    engineer: 'tester',
    worktreePath: null,
    branch: null,
    baseRef: 'main',
    mode: 'pi',
  });
  const phaseId = tracer.openPhase({
    runId,
    seq: 0,
    name: 'scout',
    kind: 'agent',
    owner: 'scout',
    description: 'pi tools unit',
  });
  return { tracer, runId, phaseId };
}

function context(h: Harness, envelopes: Map<string, Envelope> = new Map()): FoundryToolContext {
  return {
    runId: h.runId,
    agentName: 'scout',
    phaseId: () => h.phaseId,
    envelopes: () => envelopes,
    tracer: h.tracer,
  };
}

/** The runtime hands `execute` a call id, the args, and context it may ignore. */
function call(
  tool: { execute: (...args: never[]) => unknown },
  params: unknown,
): Promise<{ content: { type: string; text: string }[] }> {
  const execute = tool.execute as unknown as (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: undefined,
  ) => Promise<{ content: { type: string; text: string }[] }>;
  return execute('call-1', params, undefined, undefined, undefined);
}

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((block) => block.text).join('');
}

describe('the Foundry tool set', () => {
  it('is exactly the three tools the policy knows about', () => {
    expect([...FOUNDRY_TOOL_NAMES]).toEqual([
      'report_progress',
      'read_phase_context',
      'submit_envelope',
    ]);
  });

  it('declares a schema on every tool, so the runtime validates before executing', () => {
    const h = openTracer();
    const tools = [
      reportProgressTool(context(h)),
      readPhaseContextTool(context(h)),
      submitEnvelopeTool(jsonSchemaFor('build') as unknown as Record<string, unknown>).definition,
    ];
    for (const tool of tools) {
      expect(tool.parameters, `${tool.name} must carry a schema`).toBeDefined();
      expect((tool.parameters as { type?: string }).type).toBe('object');
    }
  });

  it('never writes the filesystem', () => {
    // These tools run unattended inside a run's worktree. A write here would
    // sit outside the boundary machinery entirely, so the module must not have
    // the capability at all rather than be trusted not to use it.
    const src = readFileSync(join(process.cwd(), 'apps/desktop/src/main/pi/tools.ts'), 'utf8');
    expect(src).not.toMatch(/\b(writeFile|writeFileSync|appendFile|mkdirSync|createWriteStream)\b/);
    expect(src).not.toMatch(/from 'node:fs'/);
  });
});

describe('report_progress', () => {
  it('traces a log event named "{agent}: progress" against the live phase', async () => {
    const h = openTracer();
    const result = await call(reportProgressTool(context(h)), { summary: 'skimmed the README' });
    expect(textOf(result)).toBe('recorded');

    const progress = h.tracer
      .eventsAfter(h.runId, 0, 1000)
      .find((e) => e.type === 'log' && e.name === 'scout: progress');
    expect(progress).toBeDefined();
    expect(progress!.payload).toMatchObject({
      message: 'skimmed the README',
      summary: 'skimmed the README',
    });
    expect(progress!.phaseId).toBe(h.phaseId);
  });

  it('records one event per call, not one per argument shape', async () => {
    const h = openTracer();
    const tool = reportProgressTool(context(h));
    await call(tool, { summary: 'one' });
    await call(tool, { summary: 'two' });
    const progress = h.tracer
      .eventsAfter(h.runId, 0, 1000)
      .filter((e) => e.type === 'log' && e.name === 'scout: progress');
    expect(progress.map((e) => e.payload.summary)).toEqual(['one', 'two']);
  });
});

describe('read_phase_context', () => {
  it('returns the validated envelope chain in insertion order', async () => {
    const h = openTracer();
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
          commit_message: 'add helper',
        },
      ],
    ]);
    const result = await call(readPhaseContextTool(context(h, envelopes)), {});
    const chain = JSON.parse(textOf(result)) as PhaseContextEntry[];
    expect(chain.map((entry) => entry.phase)).toEqual(['scout', 'build']);
    expect(chain[0]!.envelope).toEqual(envelopes.get('scout'));
  });

  it('answers with an empty chain before any phase has produced one', async () => {
    const h = openTracer();
    const result = await call(readPhaseContextTool(context(h)), {});
    expect(JSON.parse(textOf(result))).toEqual([]);
  });
});

describe('submit_envelope', () => {
  const schemaFor = (kind: 'build' | 'review') =>
    jsonSchemaFor(kind) as unknown as Record<string, unknown>;

  const build = {
    status: 'success',
    summary: 'built it',
    artifacts: [],
    commit_message: 'add a thing',
    notes_for_next_agent: '',
  };

  it('carries the phase’s own envelope schema, the one the reply is parsed against', () => {
    const tool = submitEnvelopeTool(schemaFor('build'));
    expect(tool.definition.parameters).toEqual(schemaFor('build'));
    expect(tool.definition.description).toBe("Submit this phase's result envelope.");
    // The review kind has fields build does not, so a phase cannot be handed
    // the wrong constraint without this differing.
    const review = submitEnvelopeTool(schemaFor('review'));
    expect((review.definition.parameters as { required?: string[] }).required).toContain(
      'approved',
    );
  });

  it('reports nothing until the agent calls it', () => {
    expect(submitEnvelopeTool(schemaFor('build')).submitted()).toBeNull();
  });

  it('captures the submitted arguments verbatim', async () => {
    const tool = submitEnvelopeTool(schemaFor('build'));
    const result = await call(tool.definition, build);
    expect(textOf(result)).toBe('envelope received');
    expect(tool.submitted()).toEqual(build);
  });

  it('keeps the last submission when the agent submits twice in one turn', async () => {
    const tool = submitEnvelopeTool(schemaFor('build'));
    await call(tool.definition, build);
    await call(tool.definition, { ...build, summary: 'second thoughts' });
    // The phase answers with what the agent last said, not its first draft.
    expect(tool.submitted()!.summary).toBe('second thoughts');
  });

  it('gives each phase a fresh definition object rather than a mutated one', () => {
    const first = submitEnvelopeTool(schemaFor('build'));
    const second = submitEnvelopeTool(schemaFor('review'));
    // The runtime caches compiled validators against the schema object's
    // identity, so a swapped schema must be a new object or the previous
    // phase's validator keeps deciding what conforms.
    expect(second.definition).not.toBe(first.definition);
    expect(second.definition.parameters).not.toBe(first.definition.parameters);
    expect(second.definition.name).toBe(first.definition.name);
  });

  it('keeps captures separate per tool, so one phase cannot read another’s answer', async () => {
    const first = submitEnvelopeTool(schemaFor('build'));
    const second = submitEnvelopeTool(schemaFor('build'));
    await call(first.definition, build);
    expect(second.submitted()).toBeNull();
  });

  it('captures nothing when called with something that is not an object', async () => {
    const tool = submitEnvelopeTool(schemaFor('build'));
    await call(tool.definition, 'not an envelope');
    expect(tool.submitted()).toBeNull();
  });
});
