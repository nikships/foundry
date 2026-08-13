import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.js';
import { describe, expect, it } from 'vitest';
import { defaultProject } from '../src/main/store/projects.js';
import { ProjectStore } from '../src/main/store/projects.js';
import { defaultSettings } from '../src/main/store/settings.js';
import { answersComplete, answersFromUser, parkAskUser } from '../src/main/readiness/ask-user.js';
import { evaluateRepo } from '../src/main/readiness/evaluate.js';
import { readMarker } from '../src/main/readiness/marker.js';
import { mergeCheckFromView, pollPrMerged } from '../src/main/readiness/merge.js';
import { inspectProject } from '../src/main/readiness/sessions.js';
import { ReadinessSession, type ReadinessRemediator } from '../src/main/readiness/session.js';
import { evaluate } from '../src/main/droid/permissions.js';
import { makeFakeGh } from './fake-gh.js';
import { viewPrMergeState } from '../src/main/system/gh.js';

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

function gitRepo(prefix: string): string {
  const dir = tempDir(prefix);
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  write(dir, 'README.md', '# scratch\nnpm ci && npm run dev\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

function seedReadyFiles(root: string): void {
  write(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'ready-app',
        scripts: {
          test: 'vitest',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          build: 'vite build',
          dev: 'vite',
        },
        devDependencies: { typescript: '5.0.0', vitest: '4.0.0' },
      },
      null,
      2,
    ),
  );
  write(root, 'tsconfig.json', '{ "compilerOptions": { "strict": true } }\n');
  write(root, 'eslint.config.js', 'export default [];\n');
  write(
    root,
    'vitest.config.ts',
    'export default { test: { coverage: { thresholds: { lines: 70 } } } }\n',
  );
  write(root, 'src/math.test.ts', 'test("ok", () => {});\n');
  write(root, 'AGENTS.md', '# Agents\n');
  write(
    root,
    '.github/workflows/ci.yml',
    'run: npm test\nrun: npm run lint\nrun: npm run typecheck\nrun: npm run build\n',
  );
  write(root, '.github/ISSUE_TEMPLATE/bug.md', '---\nname: Bug\n---\n');
  write(root, '.github/pull_request_template.md', '## Summary\n');
  write(root, '.husky/pre-commit', 'npm run lint\n');
  write(root, 'README.md', 'Clone, then `npm ci` and `npm run dev`.\n');
}

function sessionFor(
  repo: string,
  io: ConstructorParameters<typeof ReadinessSession>[0]['io'] = {},
) {
  const project = defaultProject(repo);
  project.baseRef = 'main';
  const snapshots: string[] = [];
  const s = new ReadinessSession({
    project,
    settings: defaultSettings(),
    persist: (next) => {
      project.readinessValidated = next.readinessValidated;
      project.readinessSkipped = next.readinessSkipped;
    },
    onChange: (state) => snapshots.push(state.phase),
    io: { pollIntervalMs: 0, sleep: async () => {}, ...io },
  });
  return { session: s, project, snapshots };
}

describe('readiness inspect and cache', () => {
  it('stays confirming when the checklist is green but the marker is missing', () => {
    const repo = gitRepo('foundry-ready-valid-');
    seedReadyFiles(repo);
    expect(evaluateRepo(repo).ready).toBe(true);
    const { session, project } = sessionFor(repo);
    const state = session.inspect();
    expect(state.phase).toBe('confirming');
    expect(state.markerValid).toBe(false);
    expect(project.readinessValidated).toBe(false);
  });

  it('treats a valid committed marker as ready and sets the cache', () => {
    const repo = gitRepo('foundry-ready-mark-');
    seedReadyFiles(repo);
    const { session, project } = sessionFor(repo);
    session.inspect();
    expect(session.snapshot().phase).toBe('confirming');

    write(
      repo,
      '.agents/agent-ready.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: '2026-08-11T05:00:00Z',
          commit: 'abc',
          agent: { harness: 'droid', model: 'inherit', reasoningEffort: 'high' },
          verdict: 'ready',
          summary: 'Ready.',
          stack: { languages: ['typescript'], monorepo: false, packages: [] },
          criteria: evaluateRepo(repo).criteria.map((c) => ({
            ...c,
            status: c.status === 'fail' ? 'pass' : c.status,
          })),
        },
        null,
        2,
      ),
    );
    const again = sessionFor(repo);
    const state = again.session.inspect();
    expect(state.phase).toBe('complete');
    expect(state.markerValid).toBe(true);
    expect(again.project.readinessValidated).toBe(true);
    expect(inspectProject(again.project).ready).toBe(true);
    expect(project.readinessValidated).toBe(false);
  });

  it('never lets a validated cache override a missing marker', () => {
    const repo = gitRepo('foundry-ready-stale-');
    const project = defaultProject(repo);
    project.readinessValidated = true;
    const status = inspectProject(project);
    expect(status.ready).toBe(false);
    expect(status.validatedCache).toBe(true);
    expect(status.markerValid).toBe(false);
  });
});

describe('onboarding transitions, skip, and retry', () => {
  it('evaluates a missing marker into not_ready', async () => {
    const repo = gitRepo('foundry-ready-eval-');
    const { session, snapshots } = sessionFor(repo);
    session.inspect();
    await session.evaluate();
    expect(session.snapshot().phase).toBe('not_ready');
    expect(session.snapshot().evaluation?.ready).toBe(false);
    expect(snapshots).toContain('evaluating');
    expect(snapshots).toContain('not_ready');
  });

  it('skips explicitly and can be retried', async () => {
    const repo = gitRepo('foundry-ready-skip-');
    const { session, project } = sessionFor(repo);
    session.inspect();
    await session.evaluate();
    const skipped = session.skip();
    expect(skipped.phase).toBe('skipped');
    expect(skipped.skipDetail).toMatch(/project settings/);
    expect(project.readinessSkipped).toBe(true);

    const retried = await session.retry();
    expect(project.readinessSkipped).toBe(false);
    expect(retried.phase).toBe('not_ready');
  });
});

describe('persistence', () => {
  it('round-trips skipped and validated flags through the project store', () => {
    const dir = tempDir('foundry-ready-store-');
    const store = new ProjectStore(dir);
    const added = store.add('/tmp/some-repo');
    expect(added.readinessSkipped).toBeUndefined();
    const saved = store.save({ ...added, readinessSkipped: true, readinessValidated: false });
    expect(saved.ok).toBe(true);
    expect(store.get(added.id)?.readinessSkipped).toBe(true);
    store.save({ ...store.get(added.id)!, readinessSkipped: false, readinessValidated: true });
    expect(store.get(added.id)?.readinessValidated).toBe(true);
    expect(store.get(added.id)?.readinessSkipped).toBe(false);
  });
});

describe('make it ready, merge polling, and failed confirmation', () => {
  it('writes the marker last, opens a PR, and refuses a false merge confirm', async () => {
    const repo = gitRepo('foundry-ready-pr-');
    seedReadyFiles(repo);
    sh(repo, ['git', 'add', '-A']);
    sh(repo, ['git', 'commit', '-qm', 'ready files']);

    let opened = false;
    let merged = false;
    const { session, snapshots } = sessionFor(repo, {
      openPr: async () => {
        opened = true;
        return {
          ok: true,
          detail: 'opened',
          number: 12,
          url: 'https://github.com/acme/widgets/pull/12',
        };
      },
      viewPrMerge: async () => ({
        number: 12,
        url: 'https://github.com/acme/widgets/pull/12',
        merged,
        state: merged ? 'MERGED' : 'OPEN',
      }),
    });

    session.inspect();
    await session.evaluate();
    expect(session.snapshot().evaluation?.ready).toBe(true);
    expect(readMarker(repo).ok).toBe(false);

    await session.makeReady();
    expect(opened).toBe(true);
    expect(session.snapshot().phase).toBe('awaiting_merge');
    expect(snapshots).toContain('pr_ready');
    expect(session.snapshot().pr?.url).toContain('/pull/12');
    expect(readMarker(repo).ok).toBe(false);

    const refused = await session.confirmMerge();
    expect(refused.phase).toBe('awaiting_merge');
    expect(refused.mergeDetail).toMatch(/still/i);

    merged = true;
    const done = await session.confirmMerge();
    expect(done.phase).toBe('complete');
    expect(session.snapshot().pr?.merged).toBe(true);
  });

  it('exempts the marker from .prettierignore when the repo already uses prettier', async () => {
    const repo = gitRepo('foundry-ready-prettier-');
    seedReadyFiles(repo);
    write(repo, '.prettierrc.json', '{ "printWidth": 100 }\n');
    sh(repo, ['git', 'add', '-A']);
    sh(repo, ['git', 'commit', '-qm', 'ready files']);

    const { session } = sessionFor(repo, {
      openPr: async () => ({
        ok: true,
        detail: 'opened',
        number: 5,
        url: 'https://github.com/acme/widgets/pull/5',
      }),
      viewPrMerge: async () => ({
        number: 5,
        url: 'https://github.com/acme/widgets/pull/5',
        merged: false,
        state: 'OPEN',
      }),
    });
    session.inspect();
    await session.evaluate();
    expect(session.snapshot().evaluation?.ready).toBe(true);
    await session.makeReady();
    expect(session.snapshot().phase).toBe('awaiting_merge');
    expect(session.snapshot().entries.some((e) => e.text.includes('Exempting'))).toBe(true);
  });

  it('lets an injected remediator fix a failing repo, then writes the marker last', async () => {
    const repo = gitRepo('foundry-ready-fix-');
    const remediator: ReadinessRemediator = {
      async run(job) {
        seedReadyFiles(job.cwd);
        job.onEntry({ kind: 'note', text: 'Implementing linting' });
        return { ok: true, detail: 'fixed' };
      },
    };
    const { session } = sessionFor(repo, {
      remediator,
      openPr: async () => ({
        ok: true,
        detail: 'opened',
        number: 3,
        url: 'https://github.com/acme/widgets/pull/3',
      }),
      viewPrMerge: async () => ({
        number: 3,
        url: 'https://github.com/acme/widgets/pull/3',
        merged: false,
        state: 'OPEN',
      }),
    });
    session.inspect();
    await session.evaluate();
    expect(session.snapshot().evaluation?.ready).toBe(false);
    await session.makeReady();
    expect(session.snapshot().phase).toBe('awaiting_merge');
    expect(session.snapshot().markerValid).toBe(true);
    expect(session.snapshot().entries.some((e) => e.text.includes('agent-ready.json'))).toBe(true);
  });

  it('records the phase that was running when make-ready fails', async () => {
    const repo = gitRepo('foundry-ready-failphase-');
    const remediator: ReadinessRemediator = {
      async run() {
        return { ok: false, detail: 'agent gave up' };
      },
    };
    const { session } = sessionFor(repo, { remediator });
    session.inspect();
    await session.evaluate();
    await session.makeReady();
    expect(session.snapshot().phase).toBe('failed');
    expect(session.snapshot().failedPhase).toBe('remediating');
  });

  it('polls until merged and reports a still-open PR', async () => {
    const views = [
      { number: 1, url: 'https://example.com/1', merged: false, state: 'OPEN' },
      { number: 1, url: 'https://example.com/1', merged: false, state: 'OPEN' },
      { number: 1, url: 'https://example.com/1', merged: true, state: 'MERGED' },
    ];
    let i = 0;
    const result = await pollPrMerged({
      view: async () => views[Math.min(i++, views.length - 1)]!,
      intervalMs: 1,
      timeoutMs: 1_000,
      sleep: async () => {},
    });
    expect(result.merged).toBe(true);
    expect(i).toBe(3);

    const open = mergeCheckFromView({
      number: 9,
      url: 'https://example.com/9',
      merged: false,
      state: 'OPEN',
    });
    expect(open.merged).toBe(false);
    expect(open.detail).toMatch(/still open/i);
  });

  it('reads merge state through fake gh', async () => {
    const repo = gitRepo('foundry-ready-gh-');
    const gh = makeFakeGh({
      prView: {
        number: 4,
        url: 'https://github.com/acme/widgets/pull/4',
        state: 'MERGED',
        mergedAt: '2026-08-12T00:00:00Z',
      },
    });
    const viewed = await viewPrMergeState(repo, 4, { bin: gh.bin });
    expect(viewed?.merged).toBe(true);
    expect(viewed?.state).toBe('MERGED');
  });
});

describe('readiness AskUser does not weaken pipeline zero-interrupt', () => {
  it('parks questions instead of picking the first option', () => {
    const pending = parkAskUser({
      questions: [{ index: 0, question: 'which CI?', options: ['github', 'gitlab'] }],
    });
    expect(pending.questions[0]?.options[0]).toBe('github');
    expect(answersComplete(pending.questions, [])).toBe(false);
    const mapped = answersFromUser(pending.questions, [{ index: 0, answer: 'gitlab' }]);
    expect(mapped[0]?.answer).toBe('gitlab');
  });

  it('still auto-answers droid.ask_user for pipeline runs', () => {
    const outcome = evaluate(
      {
        method: 'droid.ask_user',
        params: {
          questions: [{ index: 0, question: 'which CI?', options: ['github', 'gitlab'] }],
        },
      },
      { worktree: '/repo', writes: null, protectedPaths: [] },
    );
    expect(outcome.decision).toEqual({
      outcome: 'allow',
      answers: [{ index: 0, question: 'which CI?', answer: 'github' }],
    });
  });

  it('surfaces a parked ask on the session and resumes only after a real answer', async () => {
    const repo = gitRepo('foundry-ready-ask-');
    let asked = false;
    const remediator: ReadinessRemediator = {
      async run(job) {
        asked = true;
        const answers = await job.onAskUser({
          questions: [{ index: 0, question: 'Coverage floor?', options: ['70', '90'] }],
        });
        expect(answers[0]?.answer).toBe('70');
        seedReadyFiles(job.cwd);
        return { ok: true, detail: 'fixed' };
      },
    };
    const { session } = sessionFor(repo, {
      remediator,
      openPr: async () => ({
        ok: true,
        detail: 'opened',
        number: 8,
        url: 'https://github.com/acme/widgets/pull/8',
      }),
      viewPrMerge: async () => ({
        number: 8,
        url: 'https://github.com/acme/widgets/pull/8',
        merged: false,
        state: 'OPEN',
      }),
    });
    session.inspect();
    await session.evaluate();
    const running = session.makeReady();
    await viWaitFor(() => session.snapshot().pendingAsk !== null);
    expect(session.snapshot().pendingAsk?.questions[0]?.question).toMatch(/Coverage/);
    expect(session.answerAsk([])).toBe(false);
    expect(session.answerAsk([{ index: 0, answer: '70' }])).toBe(true);
    await running;
    expect(asked).toBe(true);
    expect(session.snapshot().phase).toBe('awaiting_merge');
  });
});

describe('readiness remediator streams mid-turn work', () => {
  it('folds assistant text and closed tool rows into the session transcript', async () => {
    const dir = tempDir('foundry-ready-stream-cli-');
    const js = join(dir, 'fake.mjs');
    writeFileSync(
      js,
      `
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake-model' });
out({ type: 'message', role: 'assistant', id: 'm1', text: 'Adding a linter.' });
out({ type: 'tool_call', id: 'c1', toolId: 'Read', toolName: 'Read', parameters: { file_path: '/repo/package.json' } });
out({ type: 'tool_result', id: 'c1', toolId: 'Read', isError: false, value: '{}' });
out({ type: 'message', role: 'assistant', id: 'm2', text: 'Done.' });
out({ type: 'completion', finalText: 'Done.', session_id: 's1', usage: { input_tokens: 4, output_tokens: 2 } });
process.exit(0);
`,
    );
    const bin = join(dir, 'droid');
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
    chmodSync(bin, 0o755);

    const { createAgentRemediator } = await import('../src/main/readiness/remediator.js');
    const { __setResolvedEnvForTest } = await import('../src/main/system/env.js');
    __setResolvedEnvForTest({ path: '/usr/bin:/bin', via: 'login-shell' });
    try {
      const settings = defaultSettings();
      settings.clis.droid = { path: bin, extraArgs: [] };
      const remediator = createAgentRemediator({ settings, vendor: 'droid' });
      const entries: { kind: string; text: string; done?: boolean }[] = [];
      const result = await remediator.run({
        cwd: dir,
        evaluation: evaluateRepo(dir),
        model: 'inherit',
        reasoningEffort: 'off',
        onEntry: (entry) => {
          const full = { ...entry, id: String(entries.length), at: 0 };
          entries.push(full);
          return full;
        },
        flush: () => {},
        onAskUser: async () => [],
        signal: { cancelled: false },
      });
      expect(result.ok).toBe(true);
      expect(entries.some((e) => e.kind === 'text' && e.text.includes('Adding a linter'))).toBe(
        true,
      );
      const tool = entries.find((e) => e.kind === 'tool');
      expect(tool?.text).toContain('package.json');
      expect(tool?.done).toBe(true);
    } finally {
      __setResolvedEnvForTest(null);
    }
  });
});

async function viWaitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for readiness ask');
    await new Promise((r) => setTimeout(r, 10));
  }
}
