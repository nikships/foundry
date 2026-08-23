/**
 * Page copy, kept out of the components so the writing can be edited without
 * touching layout. Everything factual here is checked against the app tree —
 * see the mirror table in apps/website/README.md.
 */

export const DOWNLOAD_URL = 'https://github.com/nikships/foundry/releases/latest';
export const REPO_URL = 'https://github.com/nikships/foundry';
export const ISSUES_URL = 'https://github.com/nikships/foundry/issues';
export const AGENTS_MD_URL = 'https://github.com/nikships/foundry/blob/main/AGENTS.md';

export interface NavLink {
  id: string;
  label: string;
}

export const NAV_LINKS: NavLink[] = [
  { id: 'run', label: 'The run' },
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'models', label: 'Models' },
  { id: 'crew', label: 'Crew' },
  { id: 'checks', label: 'Checks' },
  { id: 'smith', label: 'Smith' },
  { id: 'phone', label: 'Phone' },
];

export interface HeroStat {
  value: string;
  label: string;
  note: string;
}

export const HERO_STATS: HeroStat[] = [
  { value: '09', label: 'agents', note: 'each with its own model, prompt, tool surface and boundary' },
  { value: '06', label: 'pipelines', note: 'shipped as starting points, all editable on the canvas' },
  { value: '01', label: 'vendor', note: 'never. mix providers inside a single run, with failover' },
  { value: '00', label: 'telemetry', note: 'local app, your models, your machine, no account' },
];

export const HERO_SPEC =
  'macOS 26+ · Apple Silicon · your subscriptions or API keys · MIT · no telemetry';

export interface Point {
  title: string;
  body: string;
}

export const PROBLEM_POINTS: Point[] = [
  {
    title: "Someone else's process",
    body: 'Every agent tool ships one opinion about how software gets built — one loop, one definition of done, one place a human may interject.',
  },
  {
    title: "Someone else's model",
    body: 'Pick a vendor, get their strengths and their outages. When their reasoning model degrades on a Tuesday, your pipeline degrades with it.',
  },
  {
    title: 'You are the orchestrator',
    body: 'Sequencing, retries and acceptance live in your head instead of in something that can repeat them tomorrow.',
  },
  {
    title: 'The evidence is prose',
    body: '“I updated the three files” is a claim. Nothing checked it against git before you read it.',
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
    title: 'Nothing is recorded unproven',
    body: "Every phase that edits code runs the project's tests before the commit that records it — the production check included.",
  },
  {
    title: 'A rejection halts',
    body: 'A reviewer that does not approve must report failure, so disapproved work can never reach a commit or a pull request.',
  },
];

export const ISOLATION_POINTS: Point[] = [
  {
    title: 'Branch per run',
    body: 'foundry/<run-id> is cut from your base commit — and Foundry checks that commit is not behind its remote before it starts.',
  },
  {
    title: 'Runs in parallel',
    body: 'Three pipelines against the same repo at once, each in its own worktree, none of them stepping on the others.',
  },
  {
    title: 'Merge is a human act',
    body: 'The factory opens the pull request. You read the diff and merge, or discard the branch and the worktree with it.',
  },
  {
    title: 'Failures are kept, not swept',
    body: 'A failed run keeps its worktree so you can open it, learn from it, resume it, or discard it deliberately.',
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
    title: 'Connect a provider',
    body: 'Sign in to a subscription you already pay for through the built-in Bridge, or paste an API key. The doctor proves the setup before you run anything.',
  },
  {
    index: '03',
    title: 'Add a repo',
    body: 'Point Foundry at any git repository on disk. It reads the project and detects the test command, then stops there.',
  },
  {
    index: '04',
    title: 'Describe the work',
    body: '“Add rate limiting to the public API” is a complete brief. The refiner grounds the rest in your codebase.',
  },
  {
    index: '05',
    title: 'Pick a pipeline and run',
    body: 'Watch the waterfall, inspect any phase, answer a checkpoint. The chain ends by opening the pull request.',
  },
];
