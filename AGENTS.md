# AGENTS.md — Foundry Repository

## Project Overview

Foundry is a native macOS Electron app (TypeScript + React 19, Electron 43) that turns a prompt into reviewed code in an isolated run. You describe the change, pick a pipeline, and a team of specialized agents executes it. Pipelines are declarative recipes of phases — not scripts — and every phase leaves evidence.

**Stack:** Electron + Vite (`electron-vite`), React 19, TypeScript 6 (strict), `better-sqlite3` + WAL, Zod 4, `@factory/droid-sdk` 0.7.0 (exact-pinned), `lucide-react`.

**Key concepts:**

- **Pipeline / Phase / Agent / Envelope / Gate** — see `apps/desktop/src/shared/types.ts` and `apps/desktop/src/main/engine/`.
- **Worktree isolation** — each run gets `.foundry-worktrees/<runId>` on branch `foundry/<runId>`. The base checkout is never mutated; merge/discard is an explicit operator action in `engine/worktree.ts`.
- **Main owns privilege** — git, disk, child processes, CLIs, and SQLite live in `src/main/`. The renderer (`src/renderer/`) is unprivileged and reaches main only through the typed IPC seam (`src/shared/ipc-contract.ts` → `src/main/ipc/` → `src/preload/bridge.ts` → `src/renderer/api.ts`).

## Architecture

```
apps/desktop/                  ← the application (all commands run here)
├── src/main/                  ← Node main process (privileged)
│   ├── engine/                ← sequencing, retries, boundaries, gates, worktrees
│   ├── droid/ + sdk/          ← Droid transport (daemon → RPC → one-shot)
│   ├── cli/                   ← vendor argv + one-shot parse adapters
│   ├── trace/                 ← Tracer: sole SQLite writer (WAL)
│   ├── store/                 ← JSON config (JsonStore, builtins, migrations)
│   ├── system/                ← PATH resolution, process control, doctor
│   ├── ipc/                   ← domain routers, named channel seam
│   └── updater.ts             ← electron-updater
├── src/renderer/              ← React 19 (no fs/child_process/electron imports)
├── src/shared/                ← pure types & IPC constants (no side effects)
├── src/preload/               ← narrow CJS bridge (bridge.cjs) for sandbox
├── tests/                     ← Vitest suites (real git temp repos + fake-droid)
└── scripts/                   ← check-css-collisions, audit-deps, engine-demo
.github/workflows/             ← CI (ci.yml) + packaging (mac-package.yml)
```

**Phase handoffs** are JSON files under `.foundry-handoff/` inside the worktree. A fresh worktree has tracked files only; its project `setupScript` runs as `sh -c` at the worktree root before phases. For projects marked `scaffold`, a missing referenced code command is a warning and that code phase is skipped rather than blocking creation.

## Invariants (read before changing sequencing or persistence)

- **Every phase starts `fail`** and becomes `success` only after clean exit, parsed envelope, and passing gates. Boundaries are enforced after the call by diffing git; protected paths always fail.
- **`Tracer` is the sole SQLite writer.** See `apps/desktop/src/main/trace/AGENTS.md`. WAL lets renderer reads proceed while the writer commits. Polling uses `run_id = ? AND change_id > ? ORDER BY rowid`; `change_id` is the cursor (`MAX(change_id)`), `rowid` is display order. Every insert/update stamps a new `change_id`.
- **`finish()` settles run status + operator-facing completion together** (notification, banner, `outcome_detail`). Do not update those independently. See `apps/desktop/src/main/AGENTS.md`.
- **Electron single-instance lock** — a second writer would corrupt the per-project trace (`app.requestSingleInstanceLock()` in `src/main/main.ts`).

## Setup Commands

**Requirements:** macOS 26+, Apple Silicon, `git`, `droid` CLI installed and signed in, Node 22.

```bash
# Clone and install (from repo root)
npm --prefix apps/desktop ci
# or
cd apps/desktop && npm ci
```

`.npmrc` allow‑lists install scripts only for `electron`, `esbuild`, and `better-sqlite3`. If Electron's distribution is absent after install:

```bash
node apps/desktop/node_modules/electron/install.js
```

App state lives under `~/Library/Application Support/foundry/` (sharded per project). Assets for the running app are in `apps/desktop/assets/`.

**GUI PATH trap:** a packaged launch inherits launchd's minimal PATH. `src/main/system/env.ts:resolveEnv()` must complete before any CLI lookup/spawn; every spawn uses `spawnEnv()`. See `apps/desktop/src/main/system/AGENTS.md`.

## Development Workflow

All app commands run from `apps/desktop/`, not the repo root. The Makefile at the repo root provides aliases.

```bash
cd apps/desktop

# Electron app with hot reload
npm run dev                 # electron-vite dev
npm run build               # electron-vite build (main + preload + renderer)
npm run start               # electron-vite preview

# Renderer-only in a plain browser (no Electron) — iterate on UI
npm run dev:web             # vite --config vite.web.config.ts
npm run build:web           # vite build --config vite.web.config.ts
npm run preview:web         # serve last web build

# From repo root (Makefile aliases):
make dev        # → npm --prefix apps/desktop run dev
make build      # → npm --prefix apps/desktop run build
make web        # build:web + preview:web --open
make check      # → npm --prefix apps/desktop run check
```

**Path aliases** are configured in both `electron.vite.config.ts` and `tsconfig.json`:

- `@shared/*` → `src/shared/*`
- `@main/*` → `src/main/*`
- `@renderer/*` → `src/renderer/*`

**Preload must stay CJS** (`out/preload/bridge.cjs`) because sandboxed preloads cannot be ESM.

**SDK import boundary:** only `src/main/droid/sdk/**` may import `@factory/droid-sdk` (ESLint `no-restricted-imports`). Everything above it uses `droid/turn.ts` and protocol notification types.

## Testing Instructions

Framework: **Vitest 4** (`forks` pool, `environment: node`, 30s timeout). Suites live in `apps/desktop/tests/`.

```bash
cd apps/desktop
npm test                    # vitest run (all suites)
npm run test:watch          # vitest watch mode
npx vitest run -t "<name>"  # focus by test name pattern
npx vitest run tests/engine.test.ts  # single file
```

**Conventions:**

- Tests use **real git temp repositories** and `tests/fake-droid.ts` (real child handshake fixture). Never use a network or model; do not mock git. Follow the executor pattern in `tests/executor.test.ts` for new engine behavior.
- `@lobehub/icons` is inlined via `server.deps.inline` so bare directory specifiers resolve under Vite.
- `tests/cli-vendors.test.ts` owns CLI adapter fixtures; `tests/fake-droid.ts` owns the handshake fixture.
- New engine phase/gate behavior needs a dedicated executor test with a real worktree snapshot.

**What to run before submitting:** `npm run check` (see below) — it already runs the full Vitest suite.

## Code Style

- **TypeScript strict** (`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`). `tsc --noEmit` must pass.
- **ESLint (flat config)** — `eslint.config.js` with `typescript-eslint`, `eslint-plugin-react`, `eslint-plugin-react-hooks`. Rules: `@typescript-eslint/no-explicit-any: error`, `no-console: warn` (allow `warn`/`error` only), `no-restricted-imports` for `@factory/droid-sdk`. Never use `eslint-disable` comments — fix the real issue.
- **Prettier** — `prettier --check .` must pass. Run `npm run format` to fix.
- **Knip** — `npm run knip` flags dead code / unused exports. Intentional unused exports need an explicit comment or pr-template note so a bot doesn't remove them.
- **No `any`** unless intentionally justified; use `type` imports where possible (`consistent-type-imports`).

```bash
cd apps/desktop
npm run typecheck           # tsc --noEmit -p tsconfig.json
npm run lint                # eslint . --max-warnings 0
npm run lint:fix            # eslint . --fix
npm run format:check        # prettier --check .
npm run format              # prettier --write .
npm run knip                # dead code
```

## Build and Deployment

```bash
cd apps/desktop
npm run build               # electron-vite build (minified via esbuild)
npm run check:css           # fails if <style> blocks redefine tokens-base.css classes
npm run audit:deps          # npm audit --audit-level=high (clean env)
npm run check               # full local gate (typecheck + lint + format:check + knip + test + build + check:css + audit:deps)
npm run package             # build + icons + electron-builder --mac --arm64 (local DMG)
```

- `check:css` (`scripts/check-css-collisions.mjs`) walks `src/renderer/**/*.tsx` and fails if an inline `<style>` redefines a class owned by `design/tokens-base.css` (e.g. `.btn`, `.field`). Move it to a `.module.css` file.
- `audit:deps` (`scripts/audit-deps.mjs`) spawns `npm audit` in a clean env (strips `npm_config_allow_scripts`) so it works on npm 12.

**CI** (`.github/workflows/ci.yml`, runs on `macos-26`):

- `verify` job from `apps/desktop`: typecheck, lint, format:check, knip, test, build, audit:deps.
- `actionlint` on `ubuntu-latest` (1.7.12+, required for `macos-26` label).
- Pull requests run both jobs unconditionally (no paths filter) so required checks are never unsatisfied.

**Packaging** (`.github/workflows/mac-package.yml`, `macos-26`, `main` / `v*` / manual):

- Builds, signs, notarizes, and staples an arm64 DMG. Main/manual use run-number versioning and publish a `Latest` release; tags use the tagged `package.json` version. Requires `APPLE_*` + `CERT_P12` secrets and pins the Developer ID certificate SHA‑1.

Useful commands:

```bash
gh run list --workflow ci.yml --limit 5
gh run list --workflow mac-package.yml --limit 5
```

## Pull Request Guidelines

- **Title:** `[component] Brief description` (e.g. `[engine] fix boundary bypass on renames`).
- **Body:** use `.github/pull_request_template.md` — fill Summary and How verified. Note any contracts touched (IPC, envelopes, gates, boundaries) and intentional unused exports.
- **Required checks:** `cd apps/desktop && npm run check` must pass locally; CI `verify` + `actionlint` must be green. CI enforces the same gates (except `check:css` which is local-only).
- **Commits:** keep history readable; never `git push --force` to `main`. Match recent commit style.

## Directory Guide Routing

The nearest `AGENTS.md` takes precedence. Start here, then follow the guide closest to the code you are changing.

| Guide | Scope |
|---|---|
| `apps/desktop/AGENTS.md` | Desktop app top-level: checks, process boundaries, install |
| `apps/desktop/src/main/AGENTS.md` | Main-process invariants + routing to subdirectories |
| `apps/desktop/src/main/engine/AGENTS.md` | Deterministic runner, envelopes, gates, worktrees |
| `apps/desktop/src/main/droid/AGENTS.md` | Droid transport, SDK quirks, permissions |
| `apps/desktop/src/main/cli/AGENTS.md` | Vendor argv / one-shot parse adapters |
| `apps/desktop/src/main/trace/AGENTS.md` | Tracer, WAL, polling cursor |
| `apps/desktop/src/main/store/AGENTS.md` | JSON config, JsonStore, builtin restoration |
| `apps/desktop/src/main/system/AGENTS.md` | PATH, process control, doctor |
| `apps/desktop/src/main/ipc/AGENTS.md` | Domain routers, IPC channel seam |
| `apps/desktop/src/renderer/AGENTS.md` | React UI, polling, Inspector, CSS modules |
| `apps/desktop/src/shared/AGENTS.md` | Pure types, IPC contract |
| `apps/desktop/src/preload/AGENTS.md` | Narrow CJS bridge |
| `.github/AGENTS.md` | CI and releases |

## Additional Notes

- `specs/` — run plans; `wiki/` — generated docs (do not hand-edit generated output).
- `dogfood-output/` — local dogfood artifacts, ignored by git.
- Never modify or push `.foundry-worktrees/` branches directly — the engine owns them.
- Secrets: `FACTORY_API_KEY` or stored WorkOS JWT; never log or persist them.
