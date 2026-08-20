/**
 * Page copy, kept out of the components so the writing can be edited without
 * touching layout. Generated with Magic Patterns against the repository
 * (design `ihtfy7myi65njlwx6wgjug`, design system `Factory`) and then checked
 * against the real source — the CLI protocol, exit codes and socket path in
 * the Smith transcript are the ones in src/cli/ and skills/foundry-smith/.
 */

export const DOWNLOAD_URL = 'https://github.com/nikships/foundry/releases';
export const REPO_URL = 'https://github.com/nikships/foundry';
export const SMITH_URL = 'https://github.com/nikships/foundry/tree/main/skills/foundry-smith';

export interface NavLink {
  id: string;
  label: string;
}

export const NAV_LINKS: NavLink[] = [
  { id: 'run', label: 'The run' },
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'crew', label: 'Crew' },
  { id: 'gates', label: 'Gates' },
  { id: 'app', label: 'The app' },
  { id: 'smith', label: 'Smith' },
];

export interface HeroStat {
  value: string;
  label: string;
  note: string;
}

export const HERO_STATS: HeroStat[] = [
  { value: '08', label: 'agents', note: 'each with its own prompt, reasoning budget and boundary' },
  { value: '10', label: 'pipelines', note: 'built in, all editable on the canvas' },
  { value: '06', label: 'gates', note: 'mechanical checks against the claim' },
  { value: '00', label: 'telemetry', note: 'local app, your models, your machine' },
];

export const HERO_SPEC = 'macOS 26+ · Apple Silicon · use your subscriptions or API keys · no telemetry';

export interface Point {
  title: string;
  body: string;
}

export const PROBLEM_POINTS: Point[] = [
  {
    title: 'One thread, one context',
    body: 'You prompt, you wait, you review, you re-prompt. The model is fast. The loop around it is you.',
  },
  {
    title: 'You are the orchestrator',
    body: 'Sequencing, retries and acceptance live in your head instead of in something that can repeat them tomorrow.',
  },
  {
    title: 'The evidence is prose',
    body: '“I updated the three files” is a claim. Nothing checked it against git before you read it.',
  },
  {
    title: 'Your checkout is the workspace',
    body: 'One confident edit in the wrong direction and you are bisecting your own tree instead of shipping.',
  },
];

export const SAFE_POINTS: Point[] = [
  {
    title: 'Your checkout stays clean',
    body: 'Every run is an isolated worktree on its own branch. Nothing lands on main until you merge it.',
  },
  {
    title: 'Agents stay in their lane',
    body: 'Write boundaries are enforced by git diff after every call. Violations get reverted and the phase fails.',
  },
  {
    title: 'Gates check the work',
    body: 'Claimed files exist? Not empty? Diff matches the claim? Verdict matches the findings? Green means it was actually checked.',
  },
  {
    title: 'Failures are kept, not swept',
    body: 'A failed run keeps its worktree so you can open it, learn from it, and discard it deliberately.',
  },
];

export const ISOLATION_POINTS: Point[] = [
  {
    title: 'Branch per run',
    body: 'foundry/<run-id> is cut from your base commit. The checkout you are working in is never mutated.',
  },
  {
    title: 'Runs in parallel',
    body: 'Three pipelines against the same repo at once, each in its own worktree, none of them stepping on the others.',
  },
  {
    title: 'Merge is a human act',
    body: 'The factory never lands work. You read the diff, you merge, or you discard the branch and the worktree with it.',
  },
];

export interface Step {
  index: string;
  title: string;
  body: string;
}

export const STEPS: Step[] = [
  {
    index: '01',
    title: 'Download and drag',
    body: 'Grab Foundry.dmg from the releases page and drop it into Applications. No npm ci, no setup script.',
  },
  {
    index: '02',
    title: 'Add a repo',
    body: 'Point Foundry at any git repository on disk. It reads the project, detects the test command, and stops there.',
  },
  {
    index: '03',
    title: 'Describe the work',
    body: '“Add rate limiting to the public API” is a complete brief. The refiner will ground the rest in your codebase.',
  },
  {
    index: '04',
    title: 'Pick a pipeline and run',
    body: 'Watch the waterfall, inspect any phase, pause at a checkpoint. Merge when the evidence says you should.',
  },
];

export const REQUIREMENTS = 'Requires macOS 26+, Apple Silicon, git, and a model provider subscription or API key.';

/* ── Smith: the propose → approve transcript ─────────────────────────────
 * The op names, the JSON envelopes and the exit codes match src/cli/ and the
 * NDJSON protocol documented in skills/foundry-smith/SKILL.md.
 */

export type SmithLineKind = 'cmd' | 'out' | 'note' | 'pending' | 'ok' | 'err';

export interface SmithLine {
  kind: SmithLineKind;
  text: string;
}

export const SMITH_FACTS: Array<[string, string]> = [
  ['Transport', '~/Library/…/smith/foundry.sock'],
  ['Kinds', 'agent · pipeline · envelope'],
  ['Scope', 'global, or one project id'],
  ['Writes', 'proposed via --file, approved in-app'],
  ['Exit 1', 'validation failed, or the human said no'],
  ['Exit 2', 'Foundry is not running'],
];

export const SMITH_LINES: SmithLine[] = [
  { kind: 'cmd', text: 'foundry-cli project list' },
  {
    kind: 'out',
    text: '{ "ok": true, "kind": "project", "entities": [ { "id": "proj_1a2b", "name": "foundry" } ] }',
  },
  { kind: 'cmd', text: 'foundry-cli pipeline show plan-build-test --project proj_1a2b' },
  {
    kind: 'out',
    text: '{ "ok": true, "kind": "pipeline", "entity": { "id": "plan-build-test", "phases": 5 } }',
  },
  {
    kind: 'note',
    text: 'smith — no lint step in this chain. proposing a `lint` code phase between build and test.',
  },
  {
    kind: 'cmd',
    text: 'cat > /tmp/pbt.json  ·  { "phases": [ … , { "name": "lint", "kind": "code" } , … ] }',
  },
  { kind: 'cmd', text: 'foundry-cli pipeline edit plan-build-test --file /tmp/pbt.json --project proj_1a2b' },
  { kind: 'pending', text: 'awaiting approval in Foundry — one proposal card open' },
];

export const SMITH_APPROVED: SmithLine[] = [
  { kind: 'ok', text: '{ "ok": true, "entity": { "id": "plan-build-test", "phases": 6 } }' },
  { kind: 'note', text: 'smith — saved. plan-build-test now runs six phases.' },
];

export const SMITH_REJECTED: SmithLine[] = [
  { kind: 'err', text: '{ "ok": false, "rejected": true }' },
  { kind: 'note', text: 'smith — nothing was written. the pipeline is unchanged.' },
];
