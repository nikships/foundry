/**
 * Discovery of a project's commands, kept strictly separate from running them.
 *
 * A `code` phase runs a frozen argv, never a command an agent chose that run,
 * because a test phase whose command varies run to run makes a green phase
 * meaningless. Detection happens once, the human confirms (or start preflight
 * accepts a fill-missing candidate), and the argv becomes data.
 *
 * The freeze is about who chooses the argv, not about ignoring a worktree that
 * is no longer the project that was detected. Before a `{ref}` phase runs,
 * `resolveRefCommand` re-sniffs the worktree. If the sniff winner disagrees
 * with the frozen argv, this run uses the sniff winner and records drift.
 * The agent still cannot pick an argv.
 *
 * Manifests answer for most repos in milliseconds and for free, so the agent is
 * a fallback for the repos they cannot answer, not the first move. Nested
 * package roots matter: many native apps keep Package.swift / package.json one
 * directory down from the git root.
 */

import { readdirSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { z } from 'zod';
import { jsonSchemaWithoutDialect } from '@shared/zod-json-schema.js';
import type { OutputFormat } from '../pi/transport.js';

export type CommandRole = 'test' | 'lint' | 'typecheck' | 'build';

export interface CommandCandidate {
  /**
   * The name a pipeline references, so `{ref: 'test'}` resolves. The four roles
   * are the ones pipelines are built around, but `ProjectCommand.name` is a
   * free-form string and an agent may propose others (`e2e`, `format`, `bench`)
   * — a repo's real verification story is not always four commands.
   */
  name: string;
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
  const sourceFile = pyproject ? 'pyproject.toml' : 'requirements.txt';
  const source = rel ? `${rel}/${sourceFile}` : sourceFile;
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
  const sourceFile = wrapper ? 'gradlew' : 'build.gradle';
  const source = rel ? `${rel}/${sourceFile}` : sourceFile;
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
  const hasTestTarget = /testTarget\s*\(/.test(text);
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
export function packageRoots(repoRoot: string): string[] {
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

  const byRole = new Map<string, CommandCandidate>();
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

function argvEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export interface CommandDriftRecord {
  name: string;
  from: string[];
  to: string[];
  source: string;
}

export type ResolvedRefCommand =
  | { ok: true; argv: string[]; drifted: false }
  | { ok: true; argv: string[]; drifted: true; drift: CommandDriftRecord }
  | { ok: false; reason: 'missing' };

/**
 * Frozen project argv wins when it still matches the worktree sniff, or when
 * sniff has nothing to say. When both exist and disagree, the worktree wins
 * for this run — that is a stack change, not an agent choosing a command.
 */
export function resolveRefCommand(
  name: string,
  projectCommands: { name: string; argv: string[] }[],
  sniffed: CommandCandidate[],
): ResolvedRefCommand {
  const frozen = projectCommands.find((c) => c.name === name);
  const sniff = sniffed.find((c) => c.name === name);
  if (frozen && sniff && !argvEqual(frozen.argv, sniff.argv)) {
    return {
      ok: true,
      argv: sniff.argv,
      drifted: true,
      drift: { name, from: frozen.argv, to: sniff.argv, source: sniff.source },
    };
  }
  if (frozen) return { ok: true, argv: frozen.argv, drifted: false };
  return { ok: false, reason: 'missing' };
}

export function applyCommandDrifts(
  commands: { name: string; argv: string[] }[],
  drifts: CommandDriftRecord[],
): { name: string; argv: string[] }[] {
  if (!drifts.length) return commands;
  const byName = new Map(drifts.map((d) => [d.name, d]));
  return commands.map((command) => {
    const drift = byName.get(command.name);
    return drift ? { name: command.name, argv: [...drift.to] } : command;
  });
}

export function parseCommandDrift(raw: string): CommandDriftRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: CommandDriftRecord[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { name?: unknown; from?: unknown; to?: unknown; source?: unknown };
    if (typeof rec.name !== 'string' || !rec.name) continue;
    if (!Array.isArray(rec.from) || !Array.isArray(rec.to)) continue;
    const from = rec.from.filter((a): a is string => typeof a === 'string');
    const to = rec.to.filter((a): a is string => typeof a === 'string');
    if (
      !from.length ||
      !to.length ||
      from.length !== rec.from.length ||
      to.length !== rec.to.length
    )
      continue;
    out.push({
      name: rec.name,
      from,
      to,
      source: typeof rec.source === 'string' ? rec.source : '',
    });
  }
  return out;
}

export const DETECT_PROMPT = `Identify the shell commands this repository uses to verify itself: tests, linting, type checking, and building.

Read the build and dependency manifests (including one directory down from the git root), CI workflow files, and contributor docs (AGENTS.md, README, CONTRIBUTING). Report only commands the repository itself documents or configures.

If the repository has no automated test suite, report the primary verification command (usually build or lint) as the "test" role. A pipeline's test phase needs something real to run.

Call submit_result exactly once with:

{"commands":[{"name":"test","argv":["swift","build","--package-path","App"],"source":"App/Package.swift"}]}

Do not print the answer as prose or JSON. After submit_result succeeds, stop.

Rules for the reply:
- Prefer these names where they apply: test, lint, typecheck, build. Other names are allowed when the repo really has that command (for example e2e, format, bench). At most one entry per name.
- "argv" is the command already split into arguments. No shell operators, no pipes, no "&&", no "cd".
- Prefer flags that keep cwd at the git root (for example --package-path, --prefix, -C, -p).
- "source" is the file that told you, so a human can check.
- Omit a command entirely rather than supplying a placeholder. An empty list is a valid answer only when the repo truly has no verifiable command.`;

/**
 * The repository context shared by interactive detection and run-start fill.
 * Keeping it here prevents the first run from asking the same detection agent
 * a weaker question than the Project pane does.
 */
export function buildDetectPrompt(
  sniffed: CommandCandidate[],
  existingCommands: string[] = [],
): string {
  const parts = ['Inspect this repository and report the verification commands.'];
  if (sniffed.length) {
    parts.push(
      '',
      'Reading this repository’s manifests suggested the commands below. Confirm, correct, or replace them, and add any the manifests missed:',
      sniffed.map((c) => `- ${c.name}: ${c.argv.join(' ')} (from ${c.source})`).join('\n'),
    );
  }
  if (existingCommands.length) {
    parts.push(
      '',
      `This project already has these command names configured: ${existingCommands.join(', ')}. Proposing a better argv for one of them is useful; the human chooses whether to replace it.`,
    );
  }
  return parts.join('\n');
}

const ARGV_SHELL_TOKENS = /[|&;><$`(){}]|^cd$/;

/** Names must survive into `ProjectCommand.name` and a pipeline `{ref}`. */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,39}$/;

/** One entry the agent proposed that was not accepted, and why. */
export interface RejectedCandidate {
  /** Echoed back as the agent wrote it, so a human sees what was dropped. */
  raw: unknown;
  reason: string;
}

export interface DetectReply {
  commands: CommandCandidate[];
  /** Never silently empty: a dropped proposal is reported with its reason. */
  rejected: RejectedCandidate[];
  /**
   * The agent's reply as received. A parse that yields nothing is otherwise
   * indistinguishable from a repo with no commands, which is the single most
   * confusing outcome this flow can produce.
   */
  rawReply: string;
  /** Set when the reply as a whole could not be read. */
  parseError?: string;
}

const detectCommandSchema = z
  .object({
    name: z.string(),
    argv: z.array(z.string()).min(1),
    source: z.string().optional(),
  })
  .strict();

const detectReplySchema = z
  .object({
    commands: z.array(detectCommandSchema),
  })
  .strict();

const DETECT_OUTPUT_FORMAT: OutputFormat = {
  type: 'json_schema',
  schema: jsonSchemaWithoutDialect(detectReplySchema),
};

/** Schema-bound `submit_result` channel for detection. */
export function detectOutputFormat(): OutputFormat {
  return DETECT_OUTPUT_FORMAT;
}

export function detectCorrection(parseError: string): string {
  return [
    `Foundry could not read that reply: ${parseError}.`,
    'Call submit_result exactly once with {"commands":[{"name":"...","argv":["..."],"source":"..."}]} then stop.',
  ].join(' ');
}

/**
 * Prefer a `submit_result` object; fall back to extracting JSON from prose so
 * a release that still dumps the object in text does not fail closed.
 */
export function parseDetectResult(structured: unknown, text: string): DetectReply {
  if (structured != null && typeof structured === 'object' && !Array.isArray(structured)) {
    return parseDetectCommands(structured, text || JSON.stringify(structured));
  }
  return parseDetectReply(text);
}

/**
 * The agent's reply is parsed defensively: a detected command is written into
 * project config and later executed, so a shell operator is never accepted.
 *
 * Every rejection is reported rather than dropped. Silent filtering here is
 * what made a correct answer look like "no command found".
 */
export function parseDetectReply(text: string): DetectReply {
  const rawReply = text;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return {
      commands: [],
      rejected: [],
      rawReply,
      parseError: 'the reply contained no JSON object',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return {
      commands: [],
      rejected: [],
      rawReply,
      parseError: `the reply was not valid JSON: ${(e as Error).message}`,
    };
  }

  return parseDetectCommands(parsed, rawReply);
}

function parseDetectCommands(parsed: unknown, rawReply: string): DetectReply {
  const list = (parsed as { commands?: unknown })?.commands;
  if (!Array.isArray(list)) {
    return {
      commands: [],
      rejected: [],
      rawReply,
      parseError: 'the JSON object had no "commands" array',
    };
  }

  const byName = new Map<string, CommandCandidate>();
  const rejected: RejectedCandidate[] = [];

  for (const raw of list) {
    const item = raw as { name?: unknown; argv?: unknown; source?: unknown };
    const name = typeof item.name === 'string' ? item.name.trim() : '';

    if (!name) {
      rejected.push({ raw, reason: 'no name' });
      continue;
    }
    if (!NAME_RE.test(name)) {
      rejected.push({
        raw,
        reason: `"${name}" is not usable as a command name (letters, digits, : _ - only)`,
      });
      continue;
    }
    if (byName.has(name)) {
      rejected.push({ raw, reason: `duplicate name "${name}"` });
      continue;
    }
    if (!Array.isArray(item.argv) || !item.argv.length) {
      rejected.push({ raw, reason: `"${name}" has no argv` });
      continue;
    }
    const argv = item.argv.filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
    if (argv.length !== item.argv.length) {
      rejected.push({ raw, reason: `"${name}" has a non-string or empty argv entry` });
      continue;
    }
    const shellToken = argv.find((a) => ARGV_SHELL_TOKENS.test(a));
    if (shellToken) {
      rejected.push({
        raw,
        reason: `"${name}" uses the shell token "${shellToken}"; commands run without a shell`,
      });
      continue;
    }
    byName.set(name, {
      name,
      argv,
      source: typeof item.source === 'string' && item.source ? item.source : 'agent',
    });
  }

  // The four pipeline roles lead, in their canonical order, then anything else
  // the agent proposed in the order it proposed it.
  const roleHits = ROLES.flatMap((role) => {
    const hit = byName.get(role);
    return hit ? [hit] : [];
  });
  const extras = [...byName.values()].filter((c) => !ROLES.includes(c.name as CommandRole));
  return { commands: [...roleHits, ...extras], rejected, rawReply };
}
