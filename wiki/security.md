# Security

Trust boundaries inside Foundry: process sandbox, agent write limits, droid autonomy, and secrets.

## Process isolation

| Layer | Control |
|---|---|
| Renderer | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (`main.ts`) |
| Preload | Named API only (`preload/bridge.ts`); no generic invoke |
| Main | Owns git, disk, droid, SQLite |
| External links | `setWindowOpenHandler` opens `http(s)` in the system browser, denies in-app navigation |

The renderer cannot read the project tree or spawn droid even if XSS were present in agent-rendered content; it only sees what IPC returns.

## Write boundaries

Per-agent `writes` (`AgentDef` in `types.ts`):

- `null` — unrestricted except protected paths
- `[]` — repo read-only (session/handoff mechanics still need care)
- `string[]` — path prefixes / globs only

Enforced **after** the agent turn by git status diff and revert (`engine/boundary.ts`). This is the inner boundary. Droid's `--auto` autonomy level is the outer one (settings).

Protected paths always include `.git/` and Foundry-owned directories; projects can add more.

## Worktree isolation

Default: each run executes in `{repo}/.foundry-worktrees/{runId}` on `foundry/run_*` from the project base ref. The operator's working tree is not the execution cwd. Merge/discard is policy-driven (`auto` / `ask` / `never`).

## droid permissions and ask_user

When droid requests user approval (`ask_user`), Foundry applies policy in `droid/permissions.ts` and may auto-approve in-boundary operations or surface an interrupt sheet. Per-project `allowedCommands` remembers approvals. Every decision should be traceable as an interrupt-related event.

Autonomy levels (`low` / `medium` / `high`) map to droid `--auto`. High autonomy is intentionally a sharper edge; the settings UI is expected to make risk visible (see `PLAN.md`).

## Secrets

- Factory / model credentials are owned by droid and the operator's Factory settings, not stored as Foundry app secrets in the trace db.
- Trace databases and run artifacts can contain prompt text and command output; treat `~/Library/Application Support/foundry/` as sensitive on a shared machine.
- Project export may write `.foundry/project.json` into a repo; avoid putting secrets there.

## Packaging notes

- Hardened runtime is enabled in `electron-builder.yml` for mac builds.
- `better-sqlite3` is asar-unpacked because native modules cannot load from asar.
- Notarization and auto-update are explicitly out of scope for the current maturity target.

## Threat model (honest edges)

- A compromised main process is game over for the machine-local project data; Electron main is privileged by design.
- Write boundaries stop unauthorized **paths**, not all harmful content inside allowed paths (e.g. builder with `writes: null` can still write bad code that tests then catch).
- Prompt injection from repo files is an agent-level risk; gates and code phases reduce blast radius but do not eliminate it.
