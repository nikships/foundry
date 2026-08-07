/**
 * Discovery of a project's commands, kept strictly separate from running them.
 *
 * A `code` phase runs a frozen argv, never a command an agent chose that run,
 * because a test phase whose command varies run to run makes a green phase
 * meaningless. Detection happens once, the human confirms (or start preflight
 * accepts a fill-missing candidate), and the argv becomes data.
 *
 * Manifests answer for most repos in milliseconds and for free, so the agent is
 * a fallback for the repos they cannot answer, not the first move. Nested
 * package roots matter: many native apps keep Package.swift / package.json one
 * directory down from the git root.
 */

import { readdirSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

export type CommandRole = 'test' | 'lint' | 'typecheck' | 'build';

export interface CommandCandidate {
  /** The name a pipeline references, so `{ref: 'test'}` resolves. */
  name: CommandRole;
  argv: string[];
  /** Which file said so, shown to the human who confirms. */
  source: string;
}

/** Script names each role accepts, best first. */
const SCRIPT_ALIASES: Record<CommandRole, string[]> = {
  test: ['test', 'tests', 'test:unit', 'unit', 'jest', 'vitest', 'spec'],
  lint: ['lint', 'eslint', 'lint:js', 'check:lint'],
  typecheck: ['typecheck', 'type-check', 'tsc', 'types', 'check:types'],
  build: ['build', 'compile', 'bundle'],
};

const ROLES = Object.keys(SCRIPT_ALIASES) as CommandRole[];

/** Directories that are never package roots even when they sit next to the repo. */
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
  '.lavish',
  'coverage',
  'out',
]);

function pickScript(scripts: Record<string, unknown>, role: CommandRole): string | null {
  for (const alias of SCRIPT_ALIASES[role]) {
    if (typeof scripts[alias] === 'string') return alias;
  }
  return null;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The lockfile picks the runner: `npm test` in a pnpm workspace can resolve a
 * different tree than the one the developer builds against.
 */
function nodeRunner(root: string): string {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/** Argv that runs a node script from the git root even when the package is nested. */
function nodeArgv(runner: string, script: string, rel: string): string[] {
  if (!rel) {
    return runner === 'npm' && script !== 'test' ? [runner, 'run', script] : [runner, script];
  }
  if (runner === 'npm') {
    return script === 'test'
      ? ['npm', 'test', '--prefix', rel]
      : ['npm', 'run', script, '--prefix', rel];
  }
  if (runner === 'yarn') return ['yarn', '--cwd', rel, script];
  if (runner === 'pnpm') return ['pnpm', '--dir', rel, script];
  return ['bun', '--cwd', rel, script];
}

async function fromPackageJson(pkgRoot: string, repoRoot: string): Promise<CommandCandidate[]> {
  const pkg = await readJson(join(pkgRoot, 'package.json'));
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== 'object') return [];

  const runner = nodeRunner(pkgRoot);
  const rel = relative(repoRoot, pkgRoot);
  const source = rel ? `${rel}/package.json` : 'package.json';
  const out: CommandCandidate[] = [];
  for (const role of ROLES) {
    const script = pickScript(scripts as Record<string, unknown>, role);
    if (!script) continue;
    out.push({ name: role, argv: nodeArgv(runner, script, rel), source });
  }
  return out;
}

async function fromMakefile(root: string, repoRoot: string): Promise<CommandCandidate[]> {
  const text = await readText(join(root, 'Makefile'));
  if (!text) return [];
  // A target is a line-initial name before a colon; `.PHONY` and pattern rules
  // are not runnable targets.
  const targets = new Set<string>();
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:(?!=)/);
    if (m && !m[1]!.startsWith('.') && !m[1]!.includes('%')) targets.add(m[1]!);
  }
  const rel = relative(repoRoot, root);
  const source = rel ? `${rel}/Makefile` : 'Makefile';
  // make -C keeps cwd at the git root so the worktree executor does not need
  // a shell `cd`.
  return ROLES.flatMap((role) => {
    const hit = SCRIPT_ALIASES[role].find((alias) => targets.has(alias));
    if (!hit) return [];
    const argv = rel ? ['make', '-C', rel, hit] : ['make', hit];
    return [{ name: role, argv, source }];
  });
}

async function fromCargo(root: string, repoRoot: string): Promise<CommandCandidate[]> {
  if (!existsSync(join(root, 'Cargo.toml'))) return [];
  const rel = relative(repoRoot, root);
  const source = rel ? `${rel}/Cargo.toml` : 'Cargo.toml';
  const manifest = rel ? ['--manifest-path', join(rel, 'Cargo.toml')] : [];
  return [
    { name: 'test', argv: ['cargo', 'test', ...manifest], source },
    { name: 'build', argv: ['cargo', 'build', ...manifest], source },
  ];
}

async function fromPython(root: string, repoRoot: string): Promise<CommandCandidate[]> {
  const pyproject = await readText(join(root, 'pyproject.toml'));
  const hasReqs = existsSync(join(root, 'requirements.txt'));
  if (!pyproject && !hasReqs) return [];
  // uv is the repo-preferred runner and is a no-op prefix when the project is
  // not a uv project, so it is offered only where uv actually manages the env.
  const usesUv = existsSync(join(root, 'uv.lock'));
  const rel = relative(repoRoot, root);
  const source = pyproject
    ? rel
      ? `${rel}/pyproject.toml`
      : 'pyproject.toml'
    : rel
      ? `${rel}/requirements.txt`
      : 'requirements.txt';
  if (usesUv) {
    const prefix = rel ? ['uv', 'run', '--directory', rel] : ['uv', 'run'];
    return [{ name: 'test', argv: [...prefix, 'pytest'], source }];
  }
  // Bare pytest only works when the package is the cwd; nested plain python
  // projects need the agent path rather than a wrong root-level invocation.
  if (rel) return [];
  return [{ name: 'test', argv: ['pytest'], source }];
}

async function fromGo(root: string, repoRoot: string): Promise<CommandCandidate[]> {
  if (!existsSync(join(root, 'go.mod'))) return [];
  const rel = relative(repoRoot, root);
  const source = rel ? `${rel}/go.mod` : 'go.mod';
  const pkg = rel ? `./${rel}/...` : './...';
  return [
    { name: 'test', argv: ['go', 'test', pkg], source },
    { name: 'build', argv: ['go', 'build', pkg], source },
  ];
}

async function fromGradle(root: string, repoRoot: string): Promise<CommandCandidate[]> {
  const wrapper = existsSync(join(root, 'gradlew'));
  if (
    !wrapper &&
    !existsSync(join(root, 'build.gradle')) &&
    !existsSync(join(root, 'build.gradle.kts'))
  ) {
    return [];
  }
  const rel = relative(repoRoot, root);
  const cmd = wrapper ? (rel ? join(rel, 'gradlew') : './gradlew') : 'gradle';
  const source = wrapper
    ? rel
      ? `${rel}/gradlew`
      : 'gradlew'
    : rel
      ? `${rel}/build.gradle`
      : 'build.gradle';
  // Gradle's -p selects the project dir without a shell cd.
  const projectFlag = rel ? ['-p', rel] : [];
  return [
    { name: 'test', argv: [cmd, ...projectFlag, 'test'], source },
    { name: 'build', argv: [cmd, ...projectFlag, 'build'], source },
  ];
}

async function fromSwift(root: string, repoRoot: string): Promise<CommandCandidate[]> {
  const text = await readText(join(root, 'Package.swift'));
  if (text == null) return [];
  const rel = relative(repoRoot, root);
  const source = rel ? `${rel}/Package.swift` : 'Package.swift';
  // --package-path keeps the executor cwd at the worktree root.
  const pkgFlag = rel ? ['--package-path', rel] : [];
  // No testTarget means `swift test` fails with an empty suite error; build is
  // the verification command those packages actually have (common for apps).
  const hasTestTarget = /\.testTarget\s*\(/.test(text) || /testTarget\s*\(/.test(text);
  const out: CommandCandidate[] = [];
  if (hasTestTarget) {
    out.push({ name: 'test', argv: ['swift', 'test', ...pkgFlag], source });
  } else {
    out.push({
      name: 'test',
      argv: ['swift', 'build', ...pkgFlag],
      source: `${source} (no test target; build is the gate)`,
    });
  }
  out.push({ name: 'build', argv: ['swift', 'build', ...pkgFlag], source });
  return out;
}

async function fromSwiftLint(root: string): Promise<CommandCandidate[]> {
  if (!existsSync(join(root, '.swiftlint.yml')) && !existsSync(join(root, '.swiftlint.yaml'))) {
    return [];
  }
  return [
    {
      name: 'lint',
      argv: ['swiftlint', 'lint', '--strict'],
      source: existsSync(join(root, '.swiftlint.yml')) ? '.swiftlint.yml' : '.swiftlint.yaml',
    },
  ];
}

/**
 * Xcode projects without a Package.swift still have a build command. Scheme is
 * inferred from the project name, which matches xcodegen defaults.
 */
async function fromXcode(root: string): Promise<CommandCandidate[]> {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const proj = entries.find((name) => name.endsWith('.xcodeproj'));
  if (!proj) return [];
  const scheme = basename(proj, '.xcodeproj');
  const source = proj;
  // Destination keeps xcodebuild from asking for a simulator interactively.
  const dest = ['-destination', 'platform=macOS'];
  return [
    {
      name: 'build',
      argv: ['xcodebuild', '-project', proj, '-scheme', scheme, ...dest, 'build'],
      source,
    },
    {
      name: 'test',
      argv: ['xcodebuild', '-project', proj, '-scheme', scheme, ...dest, 'build'],
      source: `${source} (build is the gate; no test action assumed)`,
    },
  ];
}

/**
 * Root plus one level of child directories. Deep monorepos still fall through
 * to the agent; most native apps (Package.swift under AppName/) are one deep.
 */
function packageRoots(repoRoot: string): string[] {
  const roots = [repoRoot];
  try {
    for (const ent of readdirSync(repoRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
      roots.push(join(repoRoot, ent.name));
    }
  } catch {
    // Unreadable root yields only itself; callers still get a clean empty list.
  }
  return roots;
}

/**
 * First claim wins per role. Root manifests beat nested ones so a workspace
 * root package.json is not overridden by a package inside it.
 */
export async function sniffCommands(root: string): Promise<CommandCandidate[]> {
  const roots = packageRoots(root);
  const groups = await Promise.all([
    ...roots.flatMap((pkgRoot) => [
      fromPackageJson(pkgRoot, root),
      fromCargo(pkgRoot, root),
      fromGo(pkgRoot, root),
      fromPython(pkgRoot, root),
      fromSwift(pkgRoot, root),
      fromGradle(pkgRoot, root),
      fromMakefile(pkgRoot, root),
    ]),
    // Repo-root-only signals: lint config and the xcodeproj next to the checkout.
    fromSwiftLint(root),
    fromXcode(root),
  ]);

  const byRole = new Map<CommandRole, CommandCandidate>();
  for (const candidate of groups.flat()) {
    if (!byRole.has(candidate.name)) byRole.set(candidate.name, candidate);
  }
  return ROLES.flatMap((role) => {
    const hit = byRole.get(role);
    return hit ? [hit] : [];
  });
}

/**
 * Fill missing project command names from candidates without clobbering names
 * the human (or a prior detect) already set.
 */
export function mergeCommandsFillMissing(
  existing: { name: string; argv: string[] }[],
  candidates: CommandCandidate[],
  onlyNames?: string[],
): { name: string; argv: string[] }[] {
  const have = new Set(existing.map((c) => c.name));
  const allow = onlyNames ? new Set(onlyNames) : null;
  const extra = candidates.filter((c) => !have.has(c.name) && (!allow || allow.has(c.name)));
  if (!extra.length) return existing;
  return [...existing, ...extra.map(({ name, argv }) => ({ name, argv }))];
}

export const DETECT_PROMPT = `Identify the shell commands this repository uses for tests, linting, type checking, and building.

Read the build and dependency manifests (including one directory down from the git root), CI workflow files, and contributor docs (AGENTS.md, README, CONTRIBUTING). Report only commands the repository itself documents or configures.

If the repository has no automated test suite, report the primary verification command (usually build or lint) as the "test" role. A pipeline's test phase needs something real to run.

Reply with a single JSON object and nothing else:

{"commands":[{"name":"test","argv":["swift","build","--package-path","App"],"source":"App/Package.swift"}]}

Rules for the reply:
- "name" is one of: test, lint, typecheck, build. At most one entry per name.
- "argv" is the command already split into arguments. No shell operators, no pipes, no "&&", no "cd".
- Prefer flags that keep cwd at the git root (for example --package-path, --prefix, -C, -p).
- "source" is the file that told you, so a human can check.
- Omit a role entirely rather than supplying a placeholder. An empty list is a valid answer only when the repo truly has no verifiable command.`;

const ARGV_SHELL_TOKENS = /[|&;><$`(){}]|^cd$/;

/**
 * The agent's reply is parsed defensively: a detected command is written into
 * project config and later executed, so a shell operator or an unknown role is
 * dropped rather than trusted.
 */
export function parseDetectReply(text: string): CommandCandidate[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }

  const list = (parsed as { commands?: unknown })?.commands;
  if (!Array.isArray(list)) return [];

  const byRole = new Map<CommandRole, CommandCandidate>();
  for (const raw of list) {
    const item = raw as { name?: unknown; argv?: unknown; source?: unknown };
    const name = item.name as CommandRole;
    if (!ROLES.includes(name) || byRole.has(name)) continue;
    if (!Array.isArray(item.argv) || !item.argv.length) continue;
    const argv = item.argv.filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
    if (argv.length !== item.argv.length) continue;
    if (argv.some((a) => ARGV_SHELL_TOKENS.test(a))) continue;
    byRole.set(name, {
      name,
      argv,
      source: typeof item.source === 'string' && item.source ? item.source : 'agent',
    });
  }
  return ROLES.flatMap((role) => {
    const hit = byRole.get(role);
    return hit ? [hit] : [];
  });
}
