/**
 * Discovery of a project's commands, kept strictly separate from running them.
 *
 * A `code` phase runs a frozen argv, never a command an agent chose that run,
 * because a test phase whose command varies run to run makes a green phase
 * meaningless. Detection happens once, the human confirms, and the argv becomes
 * data. That keeps acceptance built on something fixed.
 *
 * Manifests answer for most repos in milliseconds and for free, so the agent is
 * a fallback for the repos they cannot answer, not the first move.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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

async function fromPackageJson(root: string): Promise<CommandCandidate[]> {
  const pkg = await readJson(join(root, 'package.json'));
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== 'object') return [];

  const runner = nodeRunner(root);
  const out: CommandCandidate[] = [];
  for (const role of ROLES) {
    const script = pickScript(scripts as Record<string, unknown>, role);
    if (!script) continue;
    // `npm` needs `run` for everything but its own built-in verbs; yarn, pnpm,
    // and bun accept a bare script name.
    const argv =
      runner === 'npm' && script !== 'test' ? [runner, 'run', script] : [runner, script];
    out.push({ name: role, argv, source: 'package.json' });
  }
  return out;
}

async function fromMakefile(root: string): Promise<CommandCandidate[]> {
  const text = await readText(join(root, 'Makefile'));
  if (!text) return [];
  // A target is a line-initial name before a colon; `.PHONY` and pattern rules
  // are not runnable targets.
  const targets = new Set<string>();
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:(?!=)/);
    if (m && !m[1]!.startsWith('.') && !m[1]!.includes('%')) targets.add(m[1]!);
  }
  return ROLES.flatMap((role) => {
    const hit = SCRIPT_ALIASES[role].find((alias) => targets.has(alias));
    return hit ? [{ name: role, argv: ['make', hit], source: 'Makefile' }] : [];
  });
}

async function fromCargo(root: string): Promise<CommandCandidate[]> {
  if (!existsSync(join(root, 'Cargo.toml'))) return [];
  return [
    { name: 'test', argv: ['cargo', 'test'], source: 'Cargo.toml' },
    { name: 'build', argv: ['cargo', 'build'], source: 'Cargo.toml' },
  ];
}

async function fromPython(root: string): Promise<CommandCandidate[]> {
  const pyproject = await readText(join(root, 'pyproject.toml'));
  const hasReqs = existsSync(join(root, 'requirements.txt'));
  if (!pyproject && !hasReqs) return [];
  // uv is the repo-preferred runner and is a no-op prefix when the project is
  // not a uv project, so it is offered only where uv actually manages the env.
  const usesUv = existsSync(join(root, 'uv.lock'));
  const prefix = usesUv ? ['uv', 'run'] : [];
  const source = pyproject ? 'pyproject.toml' : 'requirements.txt';
  return [{ name: 'test', argv: [...prefix, 'pytest'], source }];
}

async function fromGo(root: string): Promise<CommandCandidate[]> {
  if (!existsSync(join(root, 'go.mod'))) return [];
  return [
    { name: 'test', argv: ['go', 'test', './...'], source: 'go.mod' },
    { name: 'build', argv: ['go', 'build', './...'], source: 'go.mod' },
  ];
}

async function fromGradle(root: string): Promise<CommandCandidate[]> {
  const wrapper = existsSync(join(root, 'gradlew'));
  if (!wrapper && !existsSync(join(root, 'build.gradle')) && !existsSync(join(root, 'build.gradle.kts'))) {
    return [];
  }
  const cmd = wrapper ? './gradlew' : 'gradle';
  return [
    { name: 'test', argv: [cmd, 'test'], source: wrapper ? 'gradlew' : 'build.gradle' },
    { name: 'build', argv: [cmd, 'build'], source: wrapper ? 'gradlew' : 'build.gradle' },
  ];
}

async function fromSwift(root: string): Promise<CommandCandidate[]> {
  if (!existsSync(join(root, 'Package.swift'))) return [];
  return [
    { name: 'test', argv: ['swift', 'test'], source: 'Package.swift' },
    { name: 'build', argv: ['swift', 'build'], source: 'Package.swift' },
  ];
}

/**
 * First manifest to claim a role wins, so a Node repo with an incidental
 * Makefile keeps its package.json scripts.
 */
export async function sniffCommands(root: string): Promise<CommandCandidate[]> {
  const groups = await Promise.all([
    fromPackageJson(root),
    fromCargo(root),
    fromGo(root),
    fromPython(root),
    fromSwift(root),
    fromGradle(root),
    fromMakefile(root),
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

export const DETECT_PROMPT = `Identify the shell commands this repository uses for tests, linting, type checking, and building.

Read the build and dependency manifests, CI workflow files, and contributor docs. Report only commands the repository itself documents or configures. Do not guess, and do not invent a command for a role the repository has no command for.

Reply with a single JSON object and nothing else:

{"commands":[{"name":"test","argv":["npm","test"],"source":"package.json"}]}

Rules for the reply:
- "name" is one of: test, lint, typecheck, build. At most one entry per name.
- "argv" is the command already split into arguments. No shell operators, no pipes, no "&&", no "cd".
- "source" is the file that told you, so a human can check.
- Omit a role entirely rather than supplying a placeholder. An empty list is a valid answer.`;

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
