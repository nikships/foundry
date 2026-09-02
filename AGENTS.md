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
- **Runs are isolated.** Each run uses `.foundry-worktrees/<runId>` on `foundry/<runId>`. Never modify or push engine-owned `.foundry-worktrees/` branches directly.
- **Phases fail closed.** A phase starts failed and succeeds only after a clean exit, valid envelope, and passing gates. Write boundaries are enforced after the call by diffing git.
- **Tracer is the only SQLite writer.** Polling uses `change_id` as the cursor and `rowid` as display order. Every insert and update gets a new `change_id`.
- **`finish()` settles completion atomically.** Run status, operator-facing outcome, notification, and banner must not be updated independently.
- **Resolve the GUI environment first.** `resolveEnv()` must finish before CLI lookup or spawn; every spawn uses `spawnEnv()`.
- **Pi imports stay in `src/main/pi/`.** Before changing that directory or any `@earendil-works/pi-*` integration, read `references/README.md` and the referenced vendored docs. Do not use live upstream docs.
- **One Electron instance writes state.** Preserve the single-instance lock.
- Treat existing tracked and untracked changes as user work. Do not overwrite, clean, or revert them.

## Working method

Requirements are macOS 26+, Apple Silicon, Git, and Node 22.

1. Install with `npm ci`.
2. Inspect the relevant source, its closest guide, and neighboring tests.
3. Make the smallest complete change that preserves process and persistence boundaries.
4. Run the narrowest relevant test or static check while iterating.
5. Run `npm run check` before submitting. It is the authoritative local gate.

Do not launch the app for small fixes. For substantial UI changes, use the `foundry-ui` skill to drive the real Electron app. Do not create scratch Playwright specs for manual validation.

Tests must not call a model or network. Engine tests use real Git temp repositories with `apps/desktop/tests/helpers/scripted-transport.ts`; do not mock Git. Do not run Android builds or tests in an orb, rely on the CI Android job there.

## Commands

All commands run from the repository root.

| Task                       | Command                                                   |
| -------------------------- | --------------------------------------------------------- |
| Install and hooks          | `npm ci` (`npm run prepare` repairs hooks)                |
| Electron development       | `npm run dev`                                             |
| Built-app preview          | `npm run start`                                           |
| Build desktop app          | `npm run build`                                           |
| Web UI development         | `npm run dev:web`                                         |
| Build/preview web UI       | `npm run build:web`; `npm run preview:web`                |
| Type check                 | `npm run typecheck`                                       |
| Lint / fix                 | `npm run lint`; `npm run lint:fix`                        |
| Format / check             | `npm run format`; `npm run format:check`                  |
| Dead-code check            | `npm run knip`                                            |
| Unit tests                 | `npm test`; `npm run test:watch`                          |
| Coverage gate              | `npm run test:coverage`                                   |
| Electron smoke             | `npm run test:e2e` (after `npm run build`)                |
| CSS collision check        | `npm run check:css`                                       |
| Command-doc check          | `npm run check:docs`                                      |
| File-size check            | `npm run check:files`                                     |
| Duplication check          | `npm run check:duplicate`                                 |
| Dependency audit           | `npm run audit:deps`                                      |
| Full local gate            | `npm run check`                                           |
| Fetch Bridge               | `npm run fetch:bridge`                                    |
| Refresh model intelligence | `npm run fetch:intelligence` (`-- --check` verifies only) |
| Package signed macOS app   | `npm run package`                                         |

Vitest accepts a file or name filter, for example:

```bash
npx vitest run apps/desktop/tests/main/engine/executor.test.ts
npx vitest run -t "<name>"
npx vitest run --coverage --maxWorkers=2
```

Default parallelism can be killed locally, so cap broad runs with `--maxWorkers=2`.

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
