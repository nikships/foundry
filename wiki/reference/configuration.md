# Configuration

Three scopes: **app**, **project**, and **roster** (agents). Pipelines are data documents edited in the designer; see [Pipelines](../features/pipelines.md).

## App settings

Stored via electron-store / JSON under Application Support (`src/main/store/settings.ts`). Shape: `AppSettings` in `src/shared/types.ts`.

| Setting | Default (conceptually) | Role |
|---|---|---|
| `clis` | auto PATH | `{ path, extraArgs }` for `droid`. See [Agent CLI](../systems/clis.md) |
| `defaultCli` | `droid` | Agent CLI provider (`droid`) |
| `engineerName` | — | Recorded on every run |
| `defaultAutonomy` | medium | droid `--auto` |
| `defaultModel` / `defaultReasoningEffort` | droid default | Defaults pane |
| `pollCadenceMs` | 500 | Renderer poll interval |
| `turnTimeoutMs` | 20 min class | Per-turn timeout |
| `envelopeRetries` / `gateRetries` | 3 / 2 class | Correction budgets |
| `notifications` | per outcome | Native notify toggles |
| `dockBadge` | on | Running-run count |
| `appearance` | system / dark | UI |
| `retentionDays` | forever / N | Maintenance |
| `onboarded` | false until done | Skips onboarding |

Exact defaults live in the settings store implementation; treat this table as the map of knobs, not a substitute for the code.

A settings file written before multi-CLI support carries a single `droidPath`. `migrate()` in the settings store folds it into `clis.droid.path` on read, so a custom droid location survives an upgrade.

## Project settings

`ProjectDef` per added repo (`store/projects.ts`):

| Field | Role |
|---|---|
| `path` | Absolute path to git repo |
| `baseRef` | Branch/ref worktrees fork from (often `main`) |
| `isolation` | Worktree on/off |
| `mergePolicy` | `auto` \| `ask` \| `never` |
| `commands` | Named argv lists (`test`, `lint`, …) for `command.ref` |
| `protectedPaths` | Extra protected paths for boundaries |
| `allowedCommands` | ask_user auto-approve memory |
| `ownRoster` / `ownPipelines` | Per-project overrides |

Optional export to `{repo}/.foundry/project.json` for sharing.

## Roster (agents)

`AgentDef`: model, reasoning effort, system/user prompts, `writes`, envelope kind, optional custom fields, tools allow/deny, color, emblem. Builtins in `builtin-agents.ts` are seeds.

## Environment / external

| External | Used for |
|---|---|
| `droid` on PATH | Agent execution |
| Factory auth (as droid expects) | Model access |
| git | Worktrees, status, commit builtins |
| Operator shell env | Inherited by droid and code phases (PATH, toolchains) |

Foundry does not require `OPENROUTER_API_KEY` style vars itself; those belong to SSSF/pi setups or to whatever droid is configured to use.
