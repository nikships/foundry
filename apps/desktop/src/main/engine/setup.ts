/**
 * Worktree bootstrap: what to run after `git worktree add` so agents find their
 * binaries. This is the dependency side of `.foundry-worktrees/` isolation.
 *
 * A fresh worktree has tracked files but never `node_modules/`, `.venv/`,
 * `target/`, or any other untracked dependency directory — those live only in
 * the base checkout and are deliberately not copied. Without a setup step,
 * every `npm run check` or `cargo build` fails with "command not found" or
 * missing type definitions, which reads as a broken project rather than a bare
 * clone.
 *
 * The script is a single `sh -c` string run at the worktree root. That gives
 * multi-ecosystem repos one place (`npm ci && cargo fetch`) instead of one
 * argv per ecosystem, and keeps the executor to one spawn. Detection gives a
 * manifest-sniffed guess for free; an agent fallback is the one-click path
 * when manifests are ambiguous or nested.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Where the install commands keep cwd at the git root without a shell cd. */
function nodeRunnerFor(root: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

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

function packageRoots(repoRoot: string): string[] {
  const roots = [repoRoot];
  try {
    for (const ent of readdirSync(repoRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
      roots.push(join(repoRoot, ent.name));
    }
  } catch {
    // Unreadable root still yields itself.
  }
  return roots;
}

function nodeInstallLine(root: string, rel: string): { line: string; source: string } | null {
  const hasPkg = existsSync(join(root, 'package.json'));
  const locks = [
    { file: 'pnpm-lock.yaml', present: existsSync(join(root, 'pnpm-lock.yaml')) },
    { file: 'yarn.lock', present: existsSync(join(root, 'yarn.lock')) },
    { file: 'bun.lockb', present: existsSync(join(root, 'bun.lockb')) },
    { file: 'package-lock.yaml', present: existsSync(join(root, 'package-lock.yaml')) },
  ];
  const sourceFile = locks.find((lock) => lock.present)?.file ?? 'package.json';
  const hasAnyLock = sourceFile !== 'package.json';

  // A package.json without a lockfile still needs an install, but a lockfile
  // without a package.json (workspace root pointing at packages/*) is still
  // actionable at that root.
  if (!hasPkg && !hasAnyLock) return null;

  const source = rel ? `${rel}/${sourceFile}` : sourceFile;

  const runner = nodeRunnerFor(root);
  let line: string;
  if (runner === 'pnpm') {
    // pnpm without a lock still works but should not pass --frozen.
    const flag = sourceFile === 'pnpm-lock.yaml' ? ' --frozen-lockfile' : '';
    line = rel ? `pnpm --dir ${rel} install${flag}` : `pnpm install${flag}`;
  } else if (runner === 'yarn') {
    const flag = sourceFile === 'yarn.lock' ? ' --frozen-lockfile' : '';
    line = rel ? `yarn --cwd ${rel} install${flag}` : `yarn install${flag}`;
  } else if (runner === 'bun') {
    line = rel ? `bun --cwd ${rel} install` : 'bun install';
  } else {
    const verb = sourceFile === 'package-lock.yaml' ? 'ci' : 'install';
    line = rel ? `npm ${verb} --prefix ${rel}` : `npm ${verb}`;
  }
  return { line, source };
}

function pythonInstallLine(root: string, rel: string): { line: string; source: string } | null {
  if (existsSync(join(root, 'uv.lock'))) {
    return {
      line: rel ? `uv sync --directory ${rel}` : 'uv sync',
      source: rel ? `${rel}/uv.lock` : 'uv.lock',
    };
  }
  if (existsSync(join(root, 'requirements.txt'))) {
    const file = rel ? `${rel}/requirements.txt` : 'requirements.txt';
    return { line: `pip install -r ${file}`, source: file };
  }
  if (existsSync(join(root, 'pyproject.toml'))) {
    // Bare pyproject without uv or requirements: let pip handle it. Keep cwd
    // at root via cd shim rather than guessing a --directory flag.
    return {
      line: rel ? `(cd ${rel} && pip install -e .)` : 'pip install -e .',
      source: rel ? `${rel}/pyproject.toml` : 'pyproject.toml',
    };
  }
  return null;
}

function cargoInstallLine(root: string, rel: string): { line: string; source: string } | null {
  if (!existsSync(join(root, 'Cargo.toml'))) return null;
  const sourceFile = existsSync(join(root, 'Cargo.lock')) ? 'Cargo.lock' : 'Cargo.toml';
  const source = rel ? `${rel}/${sourceFile}` : sourceFile;
  const arg = rel ? ` --manifest-path ${rel}/Cargo.toml` : '';
  return { line: `cargo fetch${arg}`, source };
}

function goInstallLine(root: string, rel: string): { line: string; source: string } | null {
  if (!existsSync(join(root, 'go.mod'))) return null;
  const source = rel ? `${rel}/go.mod` : 'go.mod';
  // Go 1.21+ supports -C, older does not; the cd shim works everywhere.
  const line = rel ? `(cd ${rel} && go mod download)` : 'go mod download';
  return { line, source };
}

function rubyInstallLine(root: string, rel: string): { line: string; source: string } | null {
  if (!existsSync(join(root, 'Gemfile.lock')) && !existsSync(join(root, 'Gemfile'))) return null;
  const sourceFile = existsSync(join(root, 'Gemfile.lock')) ? 'Gemfile.lock' : 'Gemfile';
  const source = rel ? `${rel}/${sourceFile}` : sourceFile;
  const line = rel ? `(cd ${rel} && bundle install)` : 'bundle install';
  return { line, source };
}

/**
 * One manifest group per package root, plus repo-root-only checks. First
 * claim per ecosystem wins so a workspace root install is not repeated for
 * each package inside it.
 */
export interface SetupSniffResult {
  /** Shell script with one install command per line, or "" when nothing found. */
  script: string;
  /** Which files made the script. Shown to the human who confirms. */
  sources: string[];
  detail: string;
}

export async function sniffSetupScript(repoRoot: string): Promise<SetupSniffResult> {
  const roots = packageRoots(repoRoot);
  const seen = new Set<string>();
  const lines: string[] = [];
  const sources: string[] = [];

  for (const root of roots) {
    const rel = relative(repoRoot, root);

    const add = (hit: { line: string; source: string } | null, key: string): void => {
      if (!hit) return;
      const k = `${key}:${rel}`;
      if (seen.has(k)) return;
      seen.add(k);
      lines.push(hit.line);
      sources.push(hit.source);
    };

    add(nodeInstallLine(root, rel), 'node');
    add(pythonInstallLine(root, rel), 'python');
    add(cargoInstallLine(root, rel), 'cargo');
    add(goInstallLine(root, rel), 'go');
    add(rubyInstallLine(root, rel), 'ruby');
  }

  if (!lines.length) {
    return {
      script: '',
      sources: [],
      detail: 'no dependency manifest found — no setup needed',
    };
  }

  const script = lines.join('\n');
  const detail = `found ${sources.join(', ')} — ${lines.length} install step(s)`;
  return { script, sources, detail };
}

export const SETUP_PROMPT = `You are configuring the worktree bootstrap for this repository.
After Foundry creates a fresh git worktree (tracked files only, no untracked dependency dirs), this shell script runs at the worktree root via \`sh -c\` to install dependencies so build/test/lint commands can run.

Read the build and dependency manifests (including one directory down from the git root), lockfiles, Makefile, CI workflows, and contributor docs (AGENTS.md, README, CONTRIBUTING). Decide the minimal, reliable install steps.

Reply with a single JSON object and nothing else:

{"script":"npm ci\\nuv sync"}

Rules:
- "script" is a shell script string. One command per line, no empty lines needed. It runs with \`sh -c\` at the worktree root (repo root). Prefer flags that keep cwd at the root: --prefix, --dir, --cwd, --package-path, --manifest-path, or a (cd dir && ...) shim only when the tool has no such flag.
- Use frozen-lockfile installs when a lockfile exists: npm ci, pnpm install --frozen-lockfile, yarn install --frozen-lockfile, bun install, uv sync, cargo fetch, go mod download, bundle install.
- Keep it short and idempotent: install only, no build, no test, no lint. The script must be safe to run on every new worktree.
- No sudo, no rm -rf, no curl|bash, no secrets. No interactive prompts.
- If the repository truly needs no dependency install (pure docs, no manifests), reply {"script":""} — empty string. Omit the install rather than guessing.
- Do not include markdown fences or prose outside the JSON.
`;

export interface SetupParseResult {
  script: string;
  rawReply: string;
  parseError?: string;
}

/**
 * Parses the agent's reply into a script. Defensive: the reply is executed
 * later via sh -c, so only a string script is accepted; truncation and
 * control-character checks happen here rather than at exec time.
 */
export function parseSetupReply(text: string): SetupParseResult {
  const rawReply = text;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { script: '', rawReply, parseError: 'the reply contained no JSON object' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return {
      script: '',
      rawReply,
      parseError: `the reply was not valid JSON: ${(e as Error).message}`,
    };
  }
  const obj = parsed as { script?: unknown };
  if (typeof obj.script !== 'string') {
    return { script: '', rawReply, parseError: 'the JSON object had no "script" string' };
  }
  // Normalise: trim surrounding whitespace, preserve internal newlines, cap length.
  const script = obj.script.trim();
  if (script.length > 8000) {
    return {
      script: '',
      rawReply,
      parseError: 'the script is too long (max 8000 chars)',
    };
  }
  return { script, rawReply };
}
