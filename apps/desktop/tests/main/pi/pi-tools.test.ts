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

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import {
  FOUNDRY_TOOL_NAMES,
  GIT_DIFF_MAX_CHARS,
  GIT_DIFF_TRUNCATED_MARKER,
  gitDiffTool,
  readPhaseContextTool,
  reportProgressTool,
  runToolsFor,
  submitEnvelopeTool,
  submitResultTool,
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
  repo: string;
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
  return { tracer, runId, phaseId, repo };
}

function context(
  h: Harness,
  envelopes: Map<string, Envelope> = new Map(),
  diff?: { cwd: string; branchPointSha: string },
): FoundryToolContext {
  return {
    runId: h.runId,
    agentName: 'scout',
    phaseId: () => h.phaseId,
    envelopes: () => envelopes,
    tracer: h.tracer,
    diff: () => diff ?? { cwd: h.repo, branchPointSha: '' },
  };
}

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

/** A real repo with one commit, so `git diff` has a branch point to work from. */
function gitRepo(): { dir: string; branchPoint: string } {
  const dir = tempDir('foundry-pi-diff-repo-');
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'kept.txt'), 'original\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return { dir, branchPoint: sh(dir, ['git', 'rev-parse', 'HEAD']).trim() };
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
  it('is exactly the four tools the policy knows about', () => {
    expect([...FOUNDRY_TOOL_NAMES]).toEqual([
      'report_progress',
      'read_phase_context',
      'git_diff',
      'submit_envelope',
    ]);
  });

  it('declares a schema on every tool, so the runtime validates before executing', () => {
    const h = openTracer();
    const tools = [
      reportProgressTool(context(h)),
      readPhaseContextTool(context(h)),
      gitDiffTool(context(h)),
      submitEnvelopeTool(jsonSchemaFor('build') as unknown as Record<string, unknown>).definition,
    ];
    for (const tool of tools) {
      expect(tool.parameters, `${tool.name} must carry a schema`).toBeDefined();
      expect((tool.parameters as { type?: string }).type).toBe('object');
    }
  });

  it('captures one-shot structured output behind the supplied schema', async () => {
    const schema = {
      type: 'object',
      properties: { plan: { type: 'string' } },
      required: ['plan'],
      additionalProperties: false,
    };
    const tool = submitResultTool(schema);
    expect(tool.definition.name).toBe('submit_result');
    expect(tool.definition.parameters).toBe(schema);
    expect(tool.submitted()).toBeNull();

    await call(tool.definition, { plan: 'build then test' });
    expect(tool.submitted()).toEqual({ plan: 'build then test' });
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

describe('runToolsFor', () => {
  it('gives a full agent every built-in plus Foundry’s own', () => {
    expect(runToolsFor('full')).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'find',
      'ls',
      ...FOUNDRY_TOOL_NAMES,
    ]);
  });

  it('treats an absent profile as full, so an older agent loses nothing', () => {
    expect(runToolsFor(undefined)).toEqual(runToolsFor('full'));
  });

  it('drops edit, write, and bash for a read-only agent', () => {
    const tools = runToolsFor('read-only');
    expect(tools).toEqual(['read', 'grep', 'find', 'ls', ...FOUNDRY_TOOL_NAMES]);
    for (const tool of ['edit', 'write', 'bash']) expect(tools).not.toContain(tool);
  });

  it('keeps Foundry’s own tools on a read-only agent, which is how a phase answers', () => {
    // `submit_envelope` is the answer channel. Narrowing that away would leave
    // a read-only phase unable to report at all.
    for (const name of FOUNDRY_TOOL_NAMES) expect(runToolsFor('read-only')).toContain(name);
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

/**
 * The diff affordance a read-only agent has instead of `bash`. The properties
 * that matter are that it returns a real patch (not a stat), that a patch too
 * big to send says so instead of looking complete, and that the one argument
 * the model controls cannot point it outside the run.
 */
describe('git_diff', () => {
  it('returns the real patch body for a change against the branch point', async () => {
    const h = openTracer();
    const repo = gitRepo();
    writeFileSync(join(repo.dir, 'kept.txt'), 'original\nadded line\n');

    const result = await call(
      gitDiffTool(context(h, new Map(), { cwd: repo.dir, branchPointSha: repo.branchPoint })),
      {},
    );
    const patch = textOf(result);

    // The whole point of the tool: hunks, not a file list. A reviewer must be
    // able to tell a new line from a pre-existing one.
    expect(patch).toContain('diff --git a/kept.txt b/kept.txt');
    expect(patch).toContain('@@');
    expect(patch).toContain('+added line');
    expect(patch).not.toContain(GIT_DIFF_TRUNCATED_MARKER);
  });

  it('sees a committed change, not just an unstaged one', async () => {
    const h = openTracer();
    const repo = gitRepo();
    writeFileSync(join(repo.dir, 'kept.txt'), 'original\ncommitted change\n');
    sh(repo.dir, ['git', 'commit', '-qam', 'second']);

    const result = await call(
      gitDiffTool(context(h, new Map(), { cwd: repo.dir, branchPointSha: repo.branchPoint })),
      {},
    );
    expect(textOf(result)).toContain('+committed change');
  });

  it('narrows to a single path when asked', async () => {
    const h = openTracer();
    const repo = gitRepo();
    writeFileSync(join(repo.dir, 'kept.txt'), 'original\ntouched\n');
    writeFileSync(join(repo.dir, 'other.txt'), 'new file\n');
    sh(repo.dir, ['git', 'add', '-A']);

    const tool = gitDiffTool(
      context(h, new Map(), { cwd: repo.dir, branchPointSha: repo.branchPoint }),
    );
    const narrowed = textOf(await call(tool, { path: 'other.txt' }));
    expect(narrowed).toContain('other.txt');
    expect(narrowed).not.toContain('kept.txt');
  });

  it('truncates past the cap and names the files it dropped', async () => {
    const h = openTracer();
    const repo = gitRepo();
    // Two files, each individually under the cap but together over it, so the
    // second is dropped whole rather than the patch being cut mid-hunk.
    const filler = (token: string): string =>
      Array.from(
        { length: 1200 },
        (_, i) => `${token} line ${i} with enough text to make this file substantial`,
      ).join('\n');
    writeFileSync(join(repo.dir, 'aaa-big.txt'), `${filler('alpha')}\n`);
    writeFileSync(join(repo.dir, 'zzz-big.txt'), `${filler('omega')}\n`);
    sh(repo.dir, ['git', 'add', '-A']);

    const result = await call(
      gitDiffTool(context(h, new Map(), { cwd: repo.dir, branchPointSha: repo.branchPoint })),
      {},
    );
    const answer = textOf(result);

    expect(answer).toContain(GIT_DIFF_TRUNCATED_MARKER);
    // A truncated answer that did not say what was missing would read as the
    // whole diff, and the agent would report on a file it never saw.
    expect(answer).toContain('zzz-big.txt');
    expect(answer).toContain('path');
    expect(answer).toContain('aaa-big.txt');
    expect(answer.length).toBeLessThan(GIT_DIFF_MAX_CHARS * 2);
  });

  it('still answers when one file alone is larger than the cap', async () => {
    const h = openTracer();
    const repo = gitRepo();
    const huge = Array.from({ length: 4000 }, (_, i) => `line ${i} of a very large single file`);
    writeFileSync(join(repo.dir, 'huge.txt'), `${huge.join('\n')}\n`);
    sh(repo.dir, ['git', 'add', '-A']);

    const answer = textOf(
      await call(
        gitDiffTool(context(h, new Map(), { cwd: repo.dir, branchPointSha: repo.branchPoint })),
        {},
      ),
    );
    // Returning nothing would be the worst outcome: the agent would conclude
    // there was no change at all.
    expect(answer).toContain('diff --git');
    expect(answer).toContain(GIT_DIFF_TRUNCATED_MARKER);
    expect(answer).toContain('huge.txt');
  });

  it('refuses a path that escapes the worktree instead of reading it', async () => {
    const h = openTracer();
    const repo = gitRepo();
    writeFileSync(join(repo.dir, 'kept.txt'), 'original\ntouched\n');
    const tool = gitDiffTool(
      context(h, new Map(), { cwd: repo.dir, branchPointSha: repo.branchPoint }),
    );

    for (const path of ['../outside.txt', 'nested/../../outside.txt', '/etc/hosts']) {
      const answer = textOf(await call(tool, { path }));
      expect(answer, path).toContain('refused path');
      expect(answer, path).not.toContain('diff --git');
    }
  });

  it('refuses a path that would read as a git flag', async () => {
    const h = openTracer();
    const repo = gitRepo();
    const tool = gitDiffTool(
      context(h, new Map(), { cwd: repo.dir, branchPointSha: repo.branchPoint }),
    );
    // Belt and braces: the path already goes after `--`, so this is refused
    // before git ever sees it rather than relying on argv placement alone.
    expect(textOf(await call(tool, { path: '--output=/tmp/pwned' }))).toContain('refused path');
  });

  it('reports plainly when nothing changed, rather than looking broken', async () => {
    const h = openTracer();
    const repo = gitRepo();
    const answer = textOf(
      await call(
        gitDiffTool(context(h, new Map(), { cwd: repo.dir, branchPointSha: repo.branchPoint })),
        {},
      ),
    );
    expect(answer).toBe('no changes against the branch point');
  });

  it('takes no ref, no flags, and no command from the model', () => {
    const h = openTracer();
    const schema = gitDiffTool(context(h)).parameters as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    // The model may narrow the diff and nothing else: a ref would let it read
    // history outside the run, and argv would make this a shell by another name.
    expect(Object.keys(schema.properties ?? {})).toEqual(['path']);
    expect(schema.additionalProperties).toBe(false);
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
