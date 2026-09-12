# AGENTS.md — Foundry

Foundry is a native macOS Electron app that turns a prompt into reviewed code in an isolated run. The stack is TypeScript, React 19, Electron, `better-sqlite3`, Zod, and an exact-pinned `@earendil-works/pi-coding-agent`.

## Repository map

- `apps/desktop/src/main/` — privileged Electron process: engine, agent runtime, stores, SQLite, system integration, and IPC routers.
- `apps/desktop/src/preload/` — narrow, named IPC bridge.
- `apps/desktop/src/renderer/` — unprivileged React UI.
- `apps/desktop/src/shared/` — side-effect-free types and IPC contracts.
- `apps/desktop/tests/` — Vitest suites and Playwright Electron smoke tests.
- `apps/android/` — companion Android app.
- `apps/website/` — marketing/docs site. Do not change it unless explicitly asked.
- `references/` — vendored docs for the pinned pi runtime.
- `.github/` — CI and packaging workflows.

More specific `AGENTS.md` files define local contracts. Read the closest one before editing a subsystem.

## Non-negotiable boundaries

- **Main owns privilege.** Renderer code never imports `fs`, `child_process`, `electron`, or `src/main`. Capabilities flow through `shared/ipc-contract.ts` → `main/ipc/` → `preload/bridge.ts` → `renderer/api.ts`. Never add a generic channel passthrough.
- **One worktree per pipeline.** Each run uses `.foundry-worktrees/<runId>` on `foundry/<runId>`. Every phase of that run shares that one worktree; workers do not get their own. Never modify engine-owned `.foundry-worktrees/` directories by hand. The `open_pr` agent commits remaining work and pushes `foundry/<runId>`.
- **Phases fail closed.** A phase starts failed and succeeds only after a clean exit, valid envelope, and passing gates. Write boundaries are enforced after the call by diffing git.
- **Tracer is the only SQLite writer.** Polling uses `change_id` as the cursor and `rowid` as display order. Every insert and update gets a new `change_id`.
- **`finish()` settles completion atomically.** Run status, operator-facing outcome, notification, and banner must not be updated independently.
- **Resolve the GUI environment first.** `resolveEnv()` must finish before CLI lookup or spawn; every spawn uses `spawnEnv()`.
- **Pi imports stay in `src/main/pi/`.** Before changing that directory or any `@earendil-works/pi-*` integration, read `references/README.md` and the referenced vendored docs. Do not use live upstream docs.
- **One Electron instance writes state.** Preserve the single-instance lock.
- Treat existing tracked and untracked changes as user work. Do not overwrite, clean, or revert them.

## Working method

Requirements are macOS 26+, Apple Silicon, Git, Node 22, and pnpm 12 (pinned via the `packageManager` field; `corepack enable` picks it up).

1. Install with `pnpm install --frozen-lockfile`.
2. Inspect the relevant source, its closest guide, and neighboring tests.
3. Make the smallest complete change that preserves process and persistence boundaries.
4. Run the narrowest relevant test or static check while iterating.
5. Run `pnpm run check` before submitting. It is the authoritative local gate.

Do not launch the app for small fixes. For substantial UI changes, use the `foundry-ui` skill to drive the real Electron app. Do not create scratch Playwright specs for manual validation.

Tests must not call a model or network. Engine tests use real Git temp repositories with `apps/desktop/tests/helpers/scripted-transport.ts`; do not mock Git. Do not run Android builds or tests in an orb, rely on the CI Android job there.

### Orbs force commit signing (test environment quirk)

Amp orbs set `/etc/gitconfig` to sign every commit with the Amp-managed key (`commit.gpgsign=true` → `amp-sign-commit`). That helper cannot sign any other identity, so a `git commit` in a repo with a repo-local `user.email` — every engine scratch repo — fails with "No signing key is available for this commit". The vitest setup (`apps/desktop/tests/helpers/setup-tmp.ts`) sets `GIT_CONFIG_NOSYSTEM=1` for all suites, which makes the scratch repos ignore the system git config; this is why plain `pnpm test` passes in an orb without touching signing for real checkouts. Don't disable signing globally to work around this.

### Orb test caveats

- `apps/desktop/tests/main/system/env.test.ts` can intermittently fail in an orb with `/bin/bash: line 1: agent-only-tool: command not found`, while passing standalone and locally. Recheck it standalone; do not “fix” product environment code without evidence of a product bug.
- Never run concurrent `pnpm run check` or coverage jobs in one checkout: Vitest shares `coverage/.tmp`, and overlapping jobs corrupt its temporary coverage files.

## Commands

All commands run from the repository root.

| Task                       | Command                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| Install and hooks          | `pnpm install --frozen-lockfile` (`pnpm run prepare` repairs hooks) |
| Electron development       | `pnpm run dev`                                                      |
| Built-app preview          | `pnpm run start`                                                    |
| Build desktop app          | `pnpm run build`                                                    |
| Web UI development         | `pnpm run dev:web`                                                  |
| Build/preview web UI       | `pnpm run build:web`; `pnpm run preview:web`                        |
| Type check                 | `pnpm run typecheck`                                                |
| Lint / fix                 | `pnpm run lint`; `pnpm run lint:fix`                                |
| Format / check             | `pnpm run format`; `pnpm run format:check`                          |
| Dead-code check            | `pnpm run knip`                                                     |
| Unit tests                 | `pnpm test`; `pnpm run test:watch`                                  |
| Coverage gate              | `pnpm run test:coverage`                                            |
| Electron smoke             | `pnpm run test:e2e` (after `pnpm run build`)                        |
| CSS collision check        | `pnpm run check:css`                                                |
| Command-doc check          | `pnpm run check:docs`                                               |
| File-size check            | `pnpm run check:files`                                              |
| Duplication check          | `pnpm run check:duplicate`                                          |
| Dependency audit           | `pnpm run audit:deps`                                               |
| Full local gate            | `pnpm run check`                                                    |
| Fetch Bridge               | `pnpm run fetch:bridge`                                             |
| Refresh model intelligence | `pnpm run fetch:intelligence` (`-- --check` verifies only)          |
| Dogfood seed / launch      | `pnpm run dogfood:seed`; `pnpm run dogfood`                         |
| Package signed macOS app   | `pnpm run package`                                                  |

Vitest accepts a file or name filter, for example:

```bash
pnpm exec vitest run apps/desktop/tests/main/engine/executor.test.ts
pnpm exec vitest run -t "<name>"
pnpm exec vitest run --coverage
```

Vitest uses its adaptive default worker count. Do not add a fixed worker cap: it
needlessly underuses higher-core development Macs and can oversubscribe smaller
CI runners.

## Code conventions

- TypeScript is strict. Prefer type-only imports and never introduce `any` without a real justification.
- ESLint enforces naming, complexity, React rules, and process boundaries. Fix violations rather than adding disable comments.
- Match surrounding module structure and comment density. Split complex functions instead of raising lint ceilings.
- Keep path aliases (`@main/*`, `@shared/*`, `@renderer/*`) aligned with existing usage.
- Preload output must remain CJS (`out/preload/bridge.cjs`).
- Update documentation only when behavior or repository instructions changed.

## Delivery

- Pull request titles use `[component] Brief description`.
- Use `.github/pull_request_template.md`.
- Report exactly which checks ran and any checks skipped or failed.
