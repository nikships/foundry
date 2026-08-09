# Create a new GitHub project

Today the only way into Foundry is `projects:add` → a native folder picker that rejects anything without `.git`. This adds a second door: **Create a new project**, a focused wizard that creates the repo on GitHub via the operator's own `gh` CLI, clones it, and registers it. It also makes pipelines survive a repo that has no test/build command yet.

All work is in `apps/desktop/`. No new dependencies; `gh` is already the GitHub surface (`src/main/system/gh.ts`) and is already a doctor check.

## 1. Shared contract

`src/shared/types.ts`
- `GithubAccount { available, detail, login?, owners? }` — who `gh` is signed in as, answerable without a repo (`ghStatus` needs a checkout, so it can't serve this).
- `ProjectDef.scaffold?: boolean` — set only by this flow. Marks "created empty from Foundry, has no build/test command yet".

`src/shared/ipc-contract.ts` — three channels + `FoundryApi.projects` methods:
- `githubAccount(): Promise<GithubAccount>`
- `chooseParentDir(): Promise<string | null>` (native folder picker for where to clone)
- `createGithub(input: NewRepoInput): Promise<NewRepoResult>`

```ts
export interface NewRepoInput {
  name: string;                       // repo name, no owner
  owner?: string;                     // defaults to the signed-in login
  visibility: 'private' | 'public';
  description?: string;
  parentDir: string;                  // where the clone lands
}
export interface NewRepoResult {
  ok: boolean;
  detail: string;                     // gh's own words on failure
  project?: ProjectDef;
  url?: string;
  nameWithOwner?: string;
  path?: string;
}
```

## 2. Main process

`src/main/system/gh.ts` (same `execFile` + `GhOptions` test seam as the existing helpers)
- `githubAccount(cwd, opts)` — `gh auth status`, then `gh api user --jq .login`, then `gh api user/orgs` for owners. Reports the same three-step reason ladder as `ghStatus` (not installed → not signed in → could not read account).
- `createRepo(input, opts)` — `gh repo create <owner/name> --private|--public [--description ...] --add-readme --clone`, run with `cwd = parentDir`. `--add-readme` is not cosmetic: a repo with no commits has no HEAD, and `git worktree add` fails, so every run would die at isolation. Then verifies the clone directory exists and returns `{ path, url, nameWithOwner }`.
- Validation before spending a network call: name matches `^[A-Za-z0-9._-]{1,100}$`, is not `.`/`..`, and `parentDir/name` does not already exist.

`src/main/store/projects.ts`
- `scaffold` in `projectSchema` (`z.boolean().optional()`) and `defaultProject`; `add(path, baseRef, opts)` accepts it. Existing `projects.json` files load unchanged (optional field).

`src/main/ipc/projects.ts` — the three handlers. `createGithub` clones, reads `currentBranch` for `baseRef`, registers the project with `scaffold: true`, and broadcasts `settings-changed`. No manifest sniffing: a fresh repo has no manifest, and inventing commands for it is exactly the failure mode below.

`src/preload/bridge.ts` + `src/renderer/mockFoundry.ts` — wire the three channels (mock returns "not available in web preview").

## 3. Pipelines must tolerate an empty repo

This is the part that silently breaks otherwise: `Plan → Build → Test` has a `test` phase with `command: { ref: 'test' }`, and a brand-new repo has no test command. Today that path is: `runs:start` → `ensureMissingCommands` → nothing in the manifests → **agent detection burns a turn** → still nothing → `preflightForRun` returns an error → the run refuses to start.

Changes, all keyed on `project.scaffold`:
- `src/main/ipc/runs.ts` — skip the agent detection pass for a scaffold project (manifest sniffing still runs; it is free and starts working the moment the agent writes a `package.json`). Once sniffing fills a command, clear `scaffold` so the project rejoins the normal strict path.
- `src/main/engine/preflight.ts` — `preflightForRun` takes the project's scaffold flag; an unresolved `{ref}` becomes a **warning** ("no test command yet — this phase will be skipped") instead of a start-blocking error.
- `src/main/engine/runners/code.ts` — `resolveCommand` returns the existing `skip` resolution for an unconfigured ref on a scaffold project, so the phase closes `skipped` with a reason rather than `fail`. The `skip` branch already exists and is already traced; this just gives it a caller.
- `src/main/engine/acceptance.ts` — `phase_flag` with `flag: 'passed'` accepts a `skipped` phase (there is no command result to fail on). `all_phases_pass` already treats `skipped` as passing.

Net effect: a scaffolded project can run `Plan → Build → Test` on day one; the test phase reports "skipped: no test command configured yet", and the run is judged on the phases that did run. The moment the build produces a `package.json`, sniffing fills `test` and the phase becomes real, with no user action.

`src/main/system/doctor.ts` — `checkProject`'s "Project commands" check reads `ok` for a scaffold project with the detail "none yet — this project was created empty", instead of the current "a pipeline with a test phase cannot run".

## 4. Renderer: the wizard

New `src/renderer/components/NewProjectWizard.tsx` + `.module.css`, built on the existing `ModalShell` / `Button` / `Field` / `TextInput` / `SegmentedControl` primitives. Four steps, one decision each, back/next, Esc closes:

1. **Name** — repo name, live-validated against the same rule the main process enforces, with the resolved `owner/name` shown underneath. Owner is a select only when `gh` reports orgs; otherwise it is just the login.
2. **Visibility** — Private / Public segmented control, private preselected, one line each on what it means.
3. **Location** — parent folder (native picker via `chooseParentDir`, defaults to the parent of the last added project, else home), plus an optional one-line description. Shows the exact path the clone will land at and refuses one that already exists.
4. **Review** — name, owner, visibility, path in one summary, then Create. While running it shows the step it is on; on success it shows the repo URL, "Open on GitHub", and "Reveal in Finder", and the new project is already selected. On failure it shows `gh`'s own message and keeps the entered values so Back/retry works.

Before step 1 the wizard resolves `githubAccount()`; when `gh` is missing or signed out it shows that reason with a link (`gh auth login` / cli.github.com) rather than a dead form.

Hosting (the flow is offered everywhere "add a project" is offered):
- `screens/onboarding/ProjectScreen.tsx` — a second button next to "Choose a repository…", reading "Create a new project…". This is the requested "instead of choosing an existing repository" entry point.
- `App.tsx` — owns the wizard as a global modal; `Sidebar.tsx` and `RunsScreen`'s empty state get a "Create a new project…" action.
- `SettingsScreen.tsx` — same action in the empty Project pane.

## 5. Tests (vitest, real git temp repos, no network)

- `tests/fake-gh.ts` — teach the fake `gh` `auth status` (already there), `api user` / `api user/orgs`, and `repo create`. `repo create` really does `git init` + a README commit in `parentDir/name`, so the flow is exercised against a real repo without touching the network, and `calls.log` pins the argv (`--private` is actually passed).
- `tests/new-project.test.ts` — name validation rejects bad names before any gh call; `--private` reaches gh when private is chosen; a clone with no commits would be a bug, so the created project's `baseRef` resolves; an existing directory is refused; a gh failure surfaces gh's message and registers nothing.
- `tests/preflight.test.ts` — a missing `test` ref on a scaffold project is a warning, not an error; still an error on a normal project.
- `tests/executor.test.ts` — a scaffold project running a pipeline with an unconfigured `{ref:'test'}` phase records that phase as `skipped` and still reaches an accepted verdict.
- `tests/ipc-surface.test.ts` — channel count 74 → 77.

## 6. Validation

`npm run check` from `apps/desktop` (typecheck, lint, format, knip, test, build, css collisions, audit) must pass, per the repo's AGENTS.md.
