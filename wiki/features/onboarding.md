# Onboarding

Onboarding is the first-run path that gets a Mac to a usable Foundry: environment checks, identity, and a first git project. It ends inside the real app (Runs), not a "you're done" dead end. The natural smoke test is the built-in **Scout** pipeline: read-only reconnaissance with isolation off.

## Why it exists

Foundry depends on Factory's droid CLI, git, and a repository. Silent failure at first Start run reads as a broken product. Doctor checks name what is wrong and how to fix it. A first project anchors every later run, worktree, and trace db shard.

## Flow

Screen: `apps/desktop/src/renderer/screens/OnboardingScreen.tsx`. Shown while `settings.onboarded` is false (`App.tsx`).

### Step 0 — Welcome

Hero art (`scenes/onboarding-hero.png`) and three product claims: pipelines as data, every phase judged (envelopes, gates, boundaries), nothing hidden (prompts, tools, corrections, cost). **Get started** advances.

### Step 1 — Doctor

Runs `doctor.run()` and renders `DoctorList` with re-check.

App-level checks (`apps/desktop/src/main/system/doctor.ts`):

| Id | Label | Pass when | Fix when fail |
|---|---|---|---|
| `droid` | droid CLI | `droid --version` (or configured path) works | Link to Factory droid quickstart |
| `auth` | Factory authentication | `FACTORY_API_KEY` set or `~/.factory/settings.json` present | Link to Factory API keys |
| `git` | git | `git --version` succeeds | Install / PATH |
| `macos` | macOS 26 or newer | Darwin major meets the supported floor | Upgrade OS (packaged floor is 26.0) |

Blocking for a real agent run: **droid** and **git**. The UI warns if those fail but still allows continue so settings can be configured offline. Auth and macOS failures are surfaced honestly; a run will fail later without a working model path.

Doctor is also available later from Settings (general / about style panes).

### Step 2 — First project

- Optional **engineer name** (stored on settings, recorded on every run).
- **Choose a repository…** → `projects.add()` folder picker; path must be usable as a project (git repo expected; project Doctor goes deeper after add).
- Finish: patch name if set, call onDone → `settings.onboarded = true`, land on **Runs**.

Skip is allowed if no project was added; Runs then shows the empty-state prompt to add one.

### Project Doctor (after add)

`checkProject` (Settings → Project and related):

| Check | Meaning |
|---|---|
| Path exists | Folder still there. |
| Git repository | Required for isolation. |
| Base ref | Project `baseRef` resolves. |
| Submodules | Warn if present (worktrees do not populate them automatically). |
| Clean base | Uncommitted changes block automatic merge. |
| Project commands | Named argv (`test`, `lint`, …) for code-phase `ref`s; **Try it** runs and shows exit/tail. |

New projects default to `isolation: true`, `mergePolicy: 'ask'`, `baseRef: 'main'`. See [Worktrees](worktrees.md).

## Smoke Scout

After onboarding, the recommended first live trace is the built-in **Scout** pipeline:

| Property | Why it is a good smoke |
|---|---|
| Single agent (`scout`) | One lane, short waterfall. |
| `writes: []` | Read-only boundary; no source edits. |
| `isolation: false` on the pipeline | No worktree ceremony for a pure Q&A. |
| Envelope `scout` + `artifacts_exist` | Exercises parse and one gate. |
| Acceptance `envelope_status` | Clear accepted/not-accepted without a test suite. |

From Runs: pick **Scout**, ask a concrete question about the repo, **Start run**. Watch the waterfall, open the phase drawer for tools and envelope, confirm cost/usage reporting when the model provides it.

If Doctor's droid or auth checks failed, Scout fails for the same reasons a longer pipeline would; fix Doctor first.

Project commands (**Try it**) are the smoke for **code** phases. Without a working `test` command, `plan-build-test` cannot prove anything even when agents succeed.

## After onboarding

| Goal | Where |
|---|---|
| Start more runs | Runs composer |
| Change models / boundaries | Roster |
| Edit or design chains | Pipelines |
| Isolation, merge policy, commands | Settings → Project |
| Orphan worktrees | Settings → Maintenance |
| Re-run Doctor | Settings |

State: `~/Library/Application Support/foundry/` (settings, roster, pipelines, `projects/<hash>/trace.db`).

## Related

- [Getting started](../overview/getting-started.md)
- [Runs and traces](runs-and-traces.md)
- [Roster](roster.md) (scout agent)
- [Pipelines](pipelines.md) (scout pipeline)
- [Worktrees](worktrees.md)
- [System services](../systems/system-services.md) (doctor, notifications)

## Active contributors

Foundry maintainers.
