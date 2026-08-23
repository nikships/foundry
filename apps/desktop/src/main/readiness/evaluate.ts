/**
 * Language- and monorepo-aware static readiness evaluation.
 *
 * This is the dedicated evaluation — not a pipeline phase and not a model call.
 * The agent uses the same checklist when remediating; tests can assert the
 * verdict from repo contents alone.
 */

import { existsSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  AgentReadyStack,
  ReadinessCriterion,
  ReadinessCriterionId,
  ReadinessEvaluation,
} from '@shared/types.js';
import { READINESS_CRITERION_IDS } from '@shared/types.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.build',
  'build',
  'dist',
  'target',
  'vendor',
  'DerivedData',
  'checkouts',
  '.foundry-worktrees',
  'coverage',
  'out',
  '.next',
  '.turbo',
]);

export interface RepoFileIndex {
  files: Set<string>;
  dirs: Set<string>;
}

/** An unreadable entry is skipped rather than aborting the whole index. */
function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function readdirOrEmpty(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export function indexRepo(root: string, maxFiles = 8_000): RepoFileIndex {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const walk = (abs: string): void => {
    if (files.size >= maxFiles) return;
    for (const name of readdirOrEmpty(abs)) {
      if (SKIP_DIRS.has(name)) continue;
      const child = join(abs, name);
      const stat = statOrNull(child);
      if (!stat) continue;
      const rel = relative(root, child).replaceAll('\\', '/');
      if (stat.isDirectory()) {
        dirs.add(rel);
        walk(child);
      } else if (stat.isFile()) {
        files.add(rel);
      }
    }
  };
  walk(root);
  return { files, dirs };
}

function read(root: string, rel: string): string | null {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

/** Missing file reads as empty, so callers can pattern-match without a null check. */
function readText(root: string, rel: string): string {
  return read(root, rel) ?? '';
}

function hasAny(index: RepoFileIndex, names: string[]): boolean {
  return names.some((n) => index.files.has(n) || index.dirs.has(n));
}

function filesMatching(index: RepoFileIndex, test: (rel: string) => boolean): string[] {
  return [...index.files].filter(test);
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** A marker file whose presence alone declares the language. */
const LANGUAGE_MARKERS: [language: string, files: string[]][] = [
  ['python', ['pyproject.toml', 'requirements.txt', 'setup.py']],
  ['go', ['go.mod']],
  ['rust', ['Cargo.toml']],
  ['swift', ['Package.swift']],
  ['ruby', ['Gemfile']],
];

const MONOREPO_MARKERS = ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json'];

export function detectStack(root: string, index: RepoFileIndex): AgentReadyStack {
  const languages: string[] = [];
  let monorepo = MONOREPO_MARKERS.some((name) => index.files.has(name));

  const pkg = parseJson(read(root, 'package.json'));
  if (pkg) {
    languages.push('javascript');
    const deps = { ...record(pkg.dependencies), ...record(pkg.devDependencies) };
    if (index.files.has('tsconfig.json') || 'typescript' in deps) languages.push('typescript');
    if (Array.isArray(pkg.workspaces) || (pkg.workspaces && typeof pkg.workspaces === 'object')) {
      monorepo = true;
    }
  }
  for (const [language, files] of LANGUAGE_MARKERS) {
    if (files.some((name) => index.files.has(name))) languages.push(language);
  }

  const suffix = '/package.json';
  const packages = filesMatching(index, (rel) => rel.endsWith(suffix) && rel !== 'package.json')
    .map((rel) => rel.slice(0, -suffix.length))
    .filter((dir) => dir && !dir.includes('node_modules'));

  if (packages.length > 1 || languages.length > 1) monorepo = true;
  if (!languages.length) languages.push('shell');

  return { languages: [...new Set(languages)], monorepo, packages };
}

function scriptsOf(root: string): Record<string, string> {
  const pkg = parseJson(read(root, 'package.json'));
  const out: Record<string, string> = {};
  for (const [name, body] of Object.entries(record(pkg?.scripts))) {
    if (typeof body === 'string') out[name] = body;
  }
  return out;
}

function makefile(root: string): string {
  return read(root, 'Makefile') ?? readText(root, 'makefile');
}

function criterion(
  id: ReadinessCriterionId,
  status: ReadinessCriterion['status'],
  notes: string,
  measurement?: Record<string, unknown>,
): ReadinessCriterion {
  return measurement ? { id, status, notes, measurement } : { id, status, notes };
}

const LINT_CONFIGS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.json',
  'prettier.config.js',
  'biome.json',
  'biome.jsonc',
  'ruff.toml',
  '.ruff.toml',
  '.flake8',
  '.golangci.yml',
  '.golangci.yaml',
  'rustfmt.toml',
  '.swiftlint.yml',
];

function lintFormat(
  root: string,
  index: RepoFileIndex,
  stack: AgentReadyStack,
): ReadinessCriterion {
  const scripts = scriptsOf(root);
  const lintKey = ['lint', 'format', 'lint:fix', 'prettier'].find((k) => scripts[k]);
  const hasPyLint = /\[tool\.(ruff|black|isort|flake8)\]/.test(readText(root, 'pyproject.toml'));
  const hasMake = /\b(lint|fmt|format)\b/.test(makefile(root));
  if (lintKey || hasAny(index, LINT_CONFIGS) || hasPyLint || hasMake) {
    return criterion('lint_format', 'pass', 'Lint/format tooling is configured.', {
      command: lintKey ? `npm run ${lintKey}` : undefined,
      via: lintKey ? 'package.json' : hasPyLint ? 'pyproject.toml' : 'config',
    });
  }
  return criterion(
    'lint_format',
    'fail',
    `No lint/format command or config found for ${stack.languages.join(', ')}.`,
  );
}

function typecheck(root: string, index: RepoFileIndex, stack: AgentReadyStack): ReadinessCriterion {
  const scripts = scriptsOf(root);
  if (stack.languages.includes('typescript')) {
    if (!index.files.has('tsconfig.json')) {
      return criterion('typecheck', 'fail', 'TypeScript is in use but tsconfig.json is missing.');
    }
    const typeKey = ['typecheck', 'type-check', 'tsc'].find((k) => scripts[k]);
    if (!typeKey && !/tsc/.test(JSON.stringify(scripts))) {
      return criterion(
        'typecheck',
        'fail',
        'tsconfig.json exists but no documented typecheck command.',
      );
    }
    return criterion('typecheck', 'pass', 'TypeScript typecheck is documented.', {
      command: typeKey ? `npm run ${typeKey}` : 'npx tsc --noEmit',
    });
  }
  if (stack.languages.includes('python')) {
    if (
      index.files.has('mypy.ini') ||
      index.files.has('pyrightconfig.json') ||
      /\[tool\.(mypy|pyright)\]/.test(readText(root, 'pyproject.toml'))
    ) {
      return criterion('typecheck', 'pass', 'Python typechecker is configured.');
    }
    return criterion(
      'typecheck',
      'n/a',
      'Python repo without a published typecheck policy; recorded as not applicable.',
    );
  }
  if (stack.languages.includes('go')) {
    return criterion(
      'typecheck',
      'pass',
      'Go is compiled; `go test` / `go vet` cover the type system.',
      { command: 'go vet ./...' },
    );
  }
  if (stack.languages.includes('rust')) {
    return criterion(
      'typecheck',
      'pass',
      'Rust is compiled; `cargo check` covers the type system.',
      {
        command: 'cargo check',
      },
    );
  }
  return criterion('typecheck', 'n/a', 'No typed language applies in this repository.');
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|test_.*\.py$|_test\.py$|Tests\.swift$/;

/** Ordered: the first language present wins, as with every other criterion. */
const NATIVE_TEST_COMMANDS: [language: string, command: string][] = [
  ['go', 'go test ./...'],
  ['rust', 'cargo test'],
  ['python', 'pytest'],
];

function tests(root: string, index: RepoFileIndex, stack: AgentReadyStack): ReadinessCriterion {
  const scripts = scriptsOf(root);
  const testScript = scripts.test || scripts.tests || scripts.vitest || scripts.jest;
  const testFiles = filesMatching(index, (rel) => TEST_FILE.test(rel));
  const dirs = ['tests', 'test', '__tests__', 'spec'].some((d) => index.dirs.has(d));
  if (testScript || testFiles.length || dirs) {
    const command = testScript
      ? 'npm test'
      : NATIVE_TEST_COMMANDS.find(([language]) => stack.languages.includes(language))?.[1];
    return criterion('tests', 'pass', 'A documented test command or test files exist.', {
      command,
      tests: testFiles.length || undefined,
    });
  }
  return criterion(
    'tests',
    'fail',
    `No tests or test command found for ${stack.languages.join(', ')}.`,
  );
}

function build(root: string, index: RepoFileIndex, stack: AgentReadyStack): ReadinessCriterion {
  const scripts = scriptsOf(root);
  if (scripts.build || scripts.compile || scripts.bundle) {
    return criterion('build', 'pass', 'A documented build command exists.', {
      command: 'npm run build',
    });
  }
  if (stack.languages.includes('go')) {
    return criterion('build', 'pass', 'Go modules build with `go build`.', {
      command: 'go build ./...',
    });
  }
  if (stack.languages.includes('rust')) {
    return criterion('build', 'pass', 'Cargo builds the crate.', { command: 'cargo build' });
  }
  if (
    stack.languages.includes('swift') &&
    (index.files.has('Package.swift') ||
      filesMatching(index, (r) => r.endsWith('.xcodeproj/project.pbxproj')).length)
  ) {
    return criterion('build', 'pass', 'Swift package / Xcode project can be built.', {
      command: 'swift build',
    });
  }
  if (/\bbuild\b/.test(makefile(root))) {
    return criterion('build', 'pass', 'Makefile documents a build target.', {
      command: 'make build',
    });
  }
  if (stack.languages.includes('javascript') && !stack.languages.includes('typescript')) {
    return criterion('build', 'n/a', 'Interpreted JavaScript package; no compile step required.');
  }
  if (stack.languages.every((l) => l === 'shell' || l === 'python')) {
    return criterion('build', 'n/a', 'No compile/build step applies.');
  }
  return criterion('build', 'fail', 'No documented build command found.');
}

const INSTALL_COMMAND =
  /\b(npm ci|npm install|pnpm i|pnpm install|yarn install|bun install|bundle install|pip install|uv sync|cargo fetch)\b/i;

function setup(root: string, index: RepoFileIndex): ReadinessCriterion {
  const docs = `${readText(root, 'README.md')}\n${readText(root, 'AGENTS.md')}`;
  const scripts = scriptsOf(root);
  const hasInstall = INSTALL_COMMAND.test(docs);
  const hasDev = Boolean(scripts.dev || scripts.start || scripts.serve);
  if (hasInstall || hasDev || /\b(setup|install|bootstrap)\b/.test(makefile(root))) {
    return criterion('setup', 'pass', 'A clone-to-running sequence is documented or scripted.', {
      hasInstall,
      hasDev,
    });
  }
  if (index.files.has('package.json')) {
    return criterion(
      'setup',
      'fail',
      'package.json exists but no documented install → dev/run sequence was found.',
    );
  }
  return criterion('setup', 'fail', 'No single-command setup (install → run) is documented.');
}

function agentsMd(index: RepoFileIndex, stack: AgentReadyStack): ReadinessCriterion {
  if (!index.files.has('AGENTS.md')) {
    return criterion('agents_md', 'fail', 'Root AGENTS.md is required.');
  }
  const nested = filesMatching(index, (rel) => rel.endsWith('/AGENTS.md'));
  const notes = stack.monorepo
    ? nested.length
      ? `Root AGENTS.md plus ${nested.length} nested file(s).`
      : 'Root AGENTS.md present; nested AGENTS.md files are encouraged in this monorepo.'
    : 'Root AGENTS.md is present.';
  return criterion('agents_md', 'pass', notes, { nested: nested.length });
}

function envExample(index: RepoFileIndex): ReadinessCriterion {
  const hasExample = hasAny(index, ['.env.example', '.env.sample', '.env.template']);
  const hasEnv = hasAny(index, ['.env', '.env.local', '.env.development']);
  if (hasExample) {
    return criterion(
      'env_example',
      'pass',
      'Environment variables are documented via an example file.',
    );
  }
  if (hasEnv) {
    return criterion(
      'env_example',
      'fail',
      'An .env file exists but there is no .env.example documenting required variables.',
    );
  }
  return criterion(
    'env_example',
    'n/a',
    'No environment files detected; an example file is not required.',
  );
}

function ciParity(root: string, index: RepoFileIndex): ReadinessCriterion {
  const workflows = filesMatching(
    index,
    (rel) => rel.startsWith('.github/workflows/') && /\.ya?ml$/.test(rel),
  );
  if (!workflows.length) {
    return criterion(
      'ci_parity',
      'fail',
      'No GitHub Actions workflows found under .github/workflows/.',
    );
  }
  const body = workflows.map((rel) => readText(root, rel)).join('\n');
  const scripts = scriptsOf(root);
  const expected = ['lint', 'test', 'typecheck', 'build', 'format'].filter((name) => scripts[name]);
  const missing = expected.filter(
    (name) => !body.includes(name) && !body.includes(`npm run ${name}`),
  );
  if (expected.length && missing.length === expected.length) {
    return criterion(
      'ci_parity',
      'fail',
      `Workflows exist (${workflows.join(', ')}) but do not mention local check scripts: ${missing.join(', ')}.`,
      { workflows },
    );
  }
  return criterion(
    'ci_parity',
    'pass',
    `GitHub Actions workflows mirror local checks (${workflows.join(', ')}).`,
    { workflows },
  );
}

function templates(index: RepoFileIndex): ReadinessCriterion {
  const issue =
    index.dirs.has('.github/ISSUE_TEMPLATE') ||
    index.files.has('.github/ISSUE_TEMPLATE.md') ||
    index.files.has('ISSUE_TEMPLATE.md') ||
    filesMatching(index, (rel) => rel.startsWith('.github/ISSUE_TEMPLATE/')).length > 0;
  const pr =
    index.files.has('.github/pull_request_template.md') ||
    index.files.has('.github/PULL_REQUEST_TEMPLATE.md') ||
    index.files.has('pull_request_template.md') ||
    index.files.has('PULL_REQUEST_TEMPLATE.md') ||
    index.dirs.has('.github/PULL_REQUEST_TEMPLATE') ||
    filesMatching(index, (rel) => rel.startsWith('.github/PULL_REQUEST_TEMPLATE/')).length > 0;
  if (issue && pr) {
    return criterion(
      'templates',
      'pass',
      'Issue and pull request templates are present under .github/.',
    );
  }
  const missing = [issue ? '' : 'issue templates', pr ? '' : 'PR template'].filter(Boolean);
  return criterion('templates', 'fail', `Missing ${missing.join(' and ')}.`);
}

function precommit(index: RepoFileIndex): ReadinessCriterion {
  if (
    index.dirs.has('.husky') ||
    index.files.has('.pre-commit-config.yaml') ||
    index.dirs.has('.githooks') ||
    index.files.has('lefthook.yml') ||
    index.files.has('.lefthook.yml')
  ) {
    return criterion('precommit', 'pass', 'Pre-commit hooks are configured.');
  }
  return criterion(
    'precommit',
    'fail',
    'No pre-commit hooks found (.husky, .githooks, pre-commit, or lefthook).',
  );
}

function coverage(
  root: string,
  index: RepoFileIndex,
  testStatus: ReadinessCriterion['status'],
): ReadinessCriterion {
  if (testStatus !== 'pass') {
    return criterion('coverage', 'n/a', 'Coverage is not applicable until tests exist.');
  }
  const vitest = read(root, 'vitest.config.ts') ?? readText(root, 'vitest.config.mts');
  const jest = parseJson(read(root, 'jest.config.json'));
  const pkgText = readText(root, 'package.json');
  const pyproject = readText(root, 'pyproject.toml');
  const measured =
    /thresholds?\s*:/.test(vitest) ||
    /coverageThreshold/.test(JSON.stringify(jest ?? {})) ||
    /coverageThreshold/.test(pkgText) ||
    /--coverage/.test(JSON.stringify(scriptsOf(root))) ||
    /\[tool\.coverage/.test(pyproject) ||
    /--cov/.test(pyproject) ||
    ['codecov.yml', '.codecov.yml', 'coverage.toml'].some((name) => index.files.has(name));
  if (measured) {
    return criterion(
      'coverage',
      'pass',
      'Test coverage is measured and a threshold is configured.',
    );
  }
  return criterion(
    'coverage',
    'fail',
    'Tests exist but no coverage measurement or threshold was found.',
  );
}

export function evaluateRepo(root: string): ReadinessEvaluation {
  if (!existsSync(root)) {
    return {
      stack: { languages: [], monorepo: false, packages: [] },
      criteria: READINESS_CRITERION_IDS.map((id) =>
        criterion(id, 'fail', `repository path does not exist: ${root}`),
      ),
      ready: false,
      summary: 'Repository path is missing.',
    };
  }
  const index = indexRepo(root);
  const stack = detectStack(root, index);
  const testCrit = tests(root, index, stack);
  const criteria: ReadinessCriterion[] = [
    lintFormat(root, index, stack),
    typecheck(root, index, stack),
    testCrit,
    build(root, index, stack),
    setup(root, index),
    agentsMd(index, stack),
    envExample(index),
    ciParity(root, index),
    templates(index),
    precommit(index),
    coverage(root, index, testCrit.status),
  ];

  const failed = criteria.filter((c) => c.status === 'fail');
  const ready = failed.length === 0;
  const lang = stack.languages.join(', ') || 'unknown';
  const shape = stack.monorepo ? 'monorepo' : 'single package';
  const summary = ready
    ? `${lang} ${shape}. All ${criteria.length} readiness criteria pass or are recorded N/A.`
    : `${lang} ${shape}. ${failed.length} criterion(s) need work: ${failed.map((c) => c.id).join(', ')}.`;
  return { stack, criteria, ready, summary };
}
