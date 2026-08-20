#!/usr/bin/env node
// Validates that the commands documented for agents actually exist.
//
// Foundry's AGENTS.md files are the contract a coding agent reads before it
// touches this repository. If a script is renamed and the docs are not, an agent
// follows the doc, gets "Missing script", and either guesses or stalls. This
// checker makes that drift a build failure instead of a surprise.
//
// It is deliberately STATIC: it parses command references and asserts the
// referenced target exists. It never executes a documented command, so prose,
// GUI-only commands (`npm run dev`), and platform-specific packaging
// (`npm run package`) are safe to reference and are validated by existence only.
//
// Checks
//   A  every `npm run <script>` referenced in docs/Makefile/workflows exists
//   B  every `make <target>` referenced in docs exists in the Makefile
//   C  the core commands an agent needs are documented in the root AGENTS.md
//   D  every step composed into `npm run check` is named in the root AGENTS.md
//   E  every package.json script is documented somewhere, or explicitly internal
//   F  every `scripts/<file>` referenced in docs or package.json exists on disk
//
// Usage: node scripts/check-docs-commands.mjs   (npm run check:docs)

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Documentation that describes the CURRENT repository and must stay accurate.
 * `specs/` and `.factory/docs/` are deliberately excluded: they are historical
 * run plans and session records that describe the repository as it was at the
 * time (including the retired `apps/desktop` layout). Rewriting history to
 * satisfy a linter would destroy the record.
 */
const MARKDOWN_DOCS = [
  'README.md',
  'AGENTS.md',
  '.github/AGENTS.md',
  ...findNestedAgentDocs('apps/desktop/src'),
];

/** Non-markdown files that also invoke npm scripts and can therefore go stale. */
const COMMAND_SOURCES = ['Makefile', ...findWorkflows()];

/**
 * Commands an agent must be able to find in the root AGENTS.md to work here at
 * all: install, the full gate, and the individual gates it will run while
 * iterating. Keep this list small — it is the floor, not an index.
 */
const CORE_COMMANDS = [
  'npm ci',
  'npm run check',
  'npm run typecheck',
  'npm run lint',
  'npm run format:check',
  'npm test',
  'npm run build',
];

/**
 * Scripts that intentionally have no prose entry.
 *   icons        — an implementation detail of `npm run package`, never run alone
 *   engine:demo  — a local scratch harness for engine work, not part of any gate
 * Anything else that is undocumented is drift and fails check E.
 */
const INTERNAL_SCRIPTS = new Set(['icons', 'engine:demo']);

/**
 * npm subcommands that are not repository scripts, so `npm <x>` references to
 * them must not be treated as missing scripts.
 */
const NPM_BUILTINS = new Set(['ci', 'install', 'test', 'audit', 'ping', 'run', 'exec', 'version']);

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const scripts = pkg.scripts ?? {};
const makefileTargets = readMakefileTargets();
const problems = [];

function fail(location, message, hint) {
  problems.push({ location, message, hint });
}

// ── Collect command references ──────────────────────────────────────────────

/** @type {{script: string, location: string}[]} */
const npmRunRefs = [];
/** @type {{target: string, location: string}[]} */
const makeRefs = [];
/** @type {{path: string, location: string}[]} */
const scriptFileRefs = [];

for (const docPath of MARKDOWN_DOCS) {
  const absolute = join(repoRoot, docPath);
  if (!existsSync(absolute)) {
    fail(
      docPath,
      'documented file is missing',
      'Remove it from MARKDOWN_DOCS or restore the file.',
    );
    continue;
  }
  collectFromText(readFileSync(absolute, 'utf8'), docPath, { markdown: true });
}

for (const sourcePath of COMMAND_SOURCES) {
  const absolute = join(repoRoot, sourcePath);
  if (!existsSync(absolute)) continue;
  collectFromText(readFileSync(absolute, 'utf8'), sourcePath, { markdown: false });
}

for (const [name, body] of Object.entries(scripts)) {
  for (const path of body.matchAll(/\bscripts\/[\w./-]+/g)) {
    scriptFileRefs.push({ path: path[0], location: `package.json (scripts.${name})` });
  }
}

/**
 * Pull command references out of one file.
 *
 * For markdown we scan fenced code blocks AND inline code spans, because the
 * docs legitimately use both ("Run `npm run format` to fix."). For plain files
 * (Makefile, workflows) we scan every non-comment line.
 */
function collectFromText(text, docPath, { markdown }) {
  const lines = text.split('\n');
  let inFence = false;

  lines.forEach((rawLine, index) => {
    const location = `${docPath}:${index + 1}`;

    if (markdown) {
      if (/^\s*```/.test(rawLine)) {
        inFence = !inFence;
        return;
      }
      const segments = inFence ? [rawLine] : [...rawLine.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
      segments.forEach((segment) => collectFromLine(segment, location));
      return;
    }

    if (/^\s*#/.test(rawLine)) return;
    // YAML prose fields ("- name: Install npm dependencies") are not commands.
    if (/^\s*-?\s*(?:name|description|title):/.test(rawLine)) return;
    collectFromLine(rawLine, location);
  });
}

function collectFromLine(line, location) {
  // Strip trailing shell comments so `npm run check   # mirrors ci.yml` parses.
  const command = line.replace(/#.*$/, '');

  for (const match of command.matchAll(/\bnpm\s+run\s+([\w:.-]+)/g)) {
    npmRunRefs.push({ script: match[1], location });
  }

  // `npm test`, `npm ci`, ... — flag anything that is neither a builtin nor a script.
  for (const match of command.matchAll(/\bnpm\s+(?!run\b)([\w:.-]+)/g)) {
    const word = match[1];
    if (NPM_BUILTINS.has(word) || word.startsWith('-')) continue;
    if (!(word in scripts)) {
      fail(
        location,
        `unknown npm subcommand or script: \`npm ${word}\``,
        'Use `npm run <script>` for repository scripts, or fix the command.',
      );
    }
  }

  for (const match of command.matchAll(/(?:^|\s|&&\s*)make\s+([\w:.-]+)/g)) {
    makeRefs.push({ target: match[1], location });
  }

  // Lookbehind keeps remote paths out: the actionlint installer lives at
  // raw.githubusercontent.com/.../scripts/download-actionlint.bash and is not ours.
  for (const match of command.matchAll(/(?<![\w/.-])scripts\/[\w./-]+/g)) {
    scriptFileRefs.push({ path: match[0], location });
  }
}

// ── A: referenced npm scripts exist ────────────────────────────────────────
for (const { script, location } of npmRunRefs) {
  if (script in scripts) continue;
  fail(
    location,
    `unknown npm script: \`npm run ${script}\``,
    `package.json defines no "${script}" script. Update the doc, or add the script.`,
  );
}

// ── B: referenced make targets exist ──────────────────────────────────────
for (const { target, location } of makeRefs) {
  if (makefileTargets.has(target)) continue;
  fail(
    location,
    `unknown make target: \`make ${target}\``,
    `Makefile defines no "${target}" target. Update the doc, or add the target.`,
  );
}

// ── C: core commands are documented in the root AGENTS.md ─────────────────
const rootAgentsPath = join(repoRoot, 'AGENTS.md');
const rootAgents = existsSync(rootAgentsPath) ? readFileSync(rootAgentsPath, 'utf8') : '';
for (const command of CORE_COMMANDS) {
  if (rootAgents.includes(command)) continue;
  fail(
    'AGENTS.md',
    `core command not documented: \`${command}\``,
    'An agent reads the root AGENTS.md first; it must be able to find this command there.',
  );
}

// ── D: the documented gate matches the real `check` script ────────────────
const checkScript = scripts.check ?? '';
if (!checkScript) {
  fail('package.json', 'no "check" script defined', 'The repository gate is `npm run check`.');
} else {
  for (const step of checkSteps(checkScript)) {
    if (rootAgents.includes(step)) continue;
    fail(
      'AGENTS.md',
      `\`npm run check\` runs \`${step}\`, but the root AGENTS.md never mentions it`,
      'Document the new gate step so agents know what must pass before submitting.',
    );
  }
}

// ── E: every script is documented, or explicitly internal ────────────────
const allDocText = MARKDOWN_DOCS.filter((p) => existsSync(join(repoRoot, p)))
  .map((p) => readFileSync(join(repoRoot, p), 'utf8'))
  .join('\n');

for (const name of Object.keys(scripts)) {
  if (INTERNAL_SCRIPTS.has(name)) continue;
  const documented =
    allDocText.includes(`npm run ${name}`) || (name === 'test' && allDocText.includes('npm test'));
  if (documented) continue;
  fail(
    'AGENTS.md',
    `undocumented npm script: \`npm run ${name}\``,
    `Document it, or add "${name}" to INTERNAL_SCRIPTS in scripts/check-docs-commands.mjs with a reason.`,
  );
}

// ── F: referenced helper scripts exist on disk ───────────────────────────
for (const { path, location } of scriptFileRefs) {
  if (existsSync(join(repoRoot, path))) continue;
  fail(location, `missing helper script: \`${path}\``, 'The referenced file does not exist.');
}

// ── Report ───────────────────────────────────────────────────────────────
if (problems.length > 0) {
  const noun = problems.length === 1 ? 'problem' : 'problems';
  console.error(`check-docs-commands: ${problems.length} ${noun}\n`);
  for (const { location, message, hint } of problems) {
    console.error(`  ${location}`);
    console.error(`    ${message}`);
    console.error(`    → ${hint}\n`);
  }
  console.error('Documented commands must match package.json and the Makefile.');
  process.exit(1);
}

console.log(
  `check-docs-commands: ok (${npmRunRefs.length} npm, ${makeRefs.length} make, ` +
    `${scriptFileRefs.length} script refs across ${MARKDOWN_DOCS.length} docs + ` +
    `${COMMAND_SOURCES.length} command sources)`,
);

// ── Helpers ──────────────────────────────────────────────────────────────

/** Split a composed `check` script into the individual gates it runs. */
function checkSteps(script) {
  const steps = new Set();
  for (const match of script.matchAll(/\bnpm\s+run\s+([\w:.-]+)/g))
    steps.add(`npm run ${match[1]}`);
  for (const match of script.matchAll(/\bnpm\s+(?!run\b)([\w:.-]+)/g)) {
    if (NPM_BUILTINS.has(match[1])) steps.add(`npm ${match[1]}`);
  }
  return [...steps];
}

/** Target names declared in the Makefile, including .PHONY declarations. */
function readMakefileTargets() {
  const targets = new Set();
  const makefilePath = join(repoRoot, 'Makefile');
  if (!existsSync(makefilePath)) return targets;

  for (const line of readFileSync(makefilePath, 'utf8').split('\n')) {
    const phony = line.match(/^\.PHONY:\s*(.+)$/);
    if (phony) {
      phony[1]
        .trim()
        .split(/\s+/)
        .forEach((t) => targets.add(t));
      continue;
    }
    const rule = line.match(/^([\w.:-]+)\s*:(?!=)/);
    if (rule) targets.add(rule[1]);
  }
  return targets;
}

/** Nested AGENTS.md guides under a directory, sorted for stable output. */
function findNestedAgentDocs(root) {
  const found = [];
  walk(join(repoRoot, root));
  return found.sort();

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name === 'AGENTS.md') found.push(relative(repoRoot, absolute));
    }
  }
}

/** Workflow files, which invoke npm scripts and drift when scripts are renamed. */
function findWorkflows() {
  const dir = join(repoRoot, '.github/workflows');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => `.github/workflows/${name}`);
}
