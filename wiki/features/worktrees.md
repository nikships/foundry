# Worktrees

Each Foundry run can work in its own git worktree and branch so a failed or abandoned run leaves the operator's checkout untouched and the work remains reviewable. Isolation is the default product behaviour; merge policy decides what happens when a run is accepted.

Implementation: `apps/desktop/src/main/engine/worktree.ts` (lifecycle) and git helpers in `engine/git.ts`.

## Why it exists

Running agents on the current branch mixes unfinished work with the operator's tree, blocks parallel runs, and makes "discard this attempt" destructive. Worktrees are the isolation layer SSSF documented as the obvious next step; Foundry builds them into the engine.

## Isolation default

Two flags combine:

| Layer | Field | Default |
|---|---|---|
| Project | `ProjectDef.isolation` | `true` |
| Pipeline | `PipelineDef.isolation` | omitted (inherit / treat as on) |

Executor rule: isolate when `pipeline.isolation !== false && project.isolation`. Built-in `prompt` and `scout` set `isolation: false` because they are single-agent, typically non-mutating (scout is write-boundary read-only). Longer SDLC pipelines leave isolation to the project default.

When isolation is off, phases run against the project path (still subject to write boundaries and protected paths). When isolation is on, every phase cwd is the worktree path.

## Branch and path naming

| Item | Pattern | Example |
|---|---|---|
| Worktree directory | `{repo}/.foundry-worktrees/{runId}` | `/Users/me/app/.foundry-worktrees/run_abc` |
| Branch | `foundry/{runId}` | `foundry/run_abc` |
| Base | Project `baseRef` (default `main`) | checked at create time |
| Branch point | SHA recorded at create | used so merge can detect base drift |

Constants: `WORKTREE_DIR = '.foundry-worktrees'`, `branchNameFor(runId) = foundry/${runId}`.

`create()` registers `/.foundry-worktrees/` in the repo's `.git/info/exclude` before adding the worktree, so the directory never shows as untracked. That file is local to the clone and never committed; a project that already ignores the path through `.gitignore` is left alone, and the entry is written once. Nothing is added to the operator's tracked files.

## Merge policies

Project setting `mergePolicy`: `auto` | `ask` | `never` (default `ask` for new projects).

`settle()` after `finish()`:

| Accepted? | Policy | Behaviour |
|---|---|---|
| No | any | Worktree **kept** for review ("run not accepted"). |
| Yes | `never` | Kept; no merge. |
| Yes | `ask` | Kept; UI shows merge / discard (awaiting decision). |
| Yes | `auto` | Attempt merge into `baseRef`, then remove worktree and delete branch on success. |

Manual merge and discard are available from the run detail outcome banner (`runs.mergeWorktree`, `runs.discardWorktree`). Open worktree opens the path in the system file UI / editor path the app uses for that action.

Merge uses the recorded branch point so a moved base can fail safely rather than force a rebase. Automatic merge is not applied when policy or drift forbids it; the operator remains in control under `ask`.

Uncommitted work in the base checkout does not block a merge. Git refuses a checkout or merge that would overwrite local changes and names the files, which is both narrower and more accurate than a blanket dirty-tree veto; a refused merge is aborted and the original branch restored, so the base is left exactly as it was found.

## Orphan sweep

Kill, crash, or failed acceptance deliberately leaves worktrees on disk. An **orphan** is a path under `.foundry-worktrees/` whose run id is not in the active-run set.

- `findOrphans({ repo, projectId, activeRunIds })` lists them.
- Settings → **Maintenance** loads orphans and offers cleanup (discard path / prune).
- Orphan listing never includes worktrees for runs still live.

On app relaunch, the process registry finalizes dead PIDs so runs do not stay `running` while their worktrees sit around as orphans.

## UI surfaces

| Place | What the operator sees |
|---|---|
| Run detail facts | Branch name (click to open worktree). |
| Outcome banner | Merge / discard when a worktree remains and is not merged. |
| Settings → Project | Isolation toggle, merge policy, base ref. |
| Settings → Maintenance | Orphan worktree list and sweep. |
| Doctor (project) | Submodule warning (worktrees do not populate submodules automatically); dirty base advisory (only files the merge touches can be refused). |

## Related

- [Runs and traces](runs-and-traces.md)
- [Onboarding](onboarding.md)
- [Engine](../systems/engine.md)
- [System services](../systems/system-services.md)
- [Design invariants](../background/design-invariants.md)

## Active contributors

Foundry maintainers.
