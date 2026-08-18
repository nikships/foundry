# AGENTS.md — Foundry Repository

## Project Overview

Foundry is a native macOS Electron app (TypeScript + React 19, Electron 43) that turns a prompt into reviewed code in an isolated run. You describe the change, pick a pipeline, and a team of specialized agents executes it. Pipelines are declarative recipes of phases — not scripts — and every phase leaves evidence.

**Stack:** Electron + Vite (`electron-vite`), React 19, TypeScript 6 (strict), `better-sqlite3` + WAL, Zod 4, `@earendil-works/pi-coding-agent` 0.84.2 (exact-pinned), `lucide-react`.

**Key concepts:**

- **Pipeline / Phase / Agent / Envelope / Gate** — see `src/shared/types.ts` and `src/main/engine/`.
- **Worktree isolation** — each run gets `.foundry-worktrees/<runId>` on branch `foundry/<runId>`. The base checkout is never mutated; merge/discard is an explicit operator action in `engine/worktree.ts`.
- **Smith** — Foundry's entity-smith. Not a feature of the app's UI: it is a skill (`skills/foundry-smith/`) the user loads into their own agent, in their own terminal, which drives the app through the `foundry-cli` helper over a unix socket. The app validates each proposal and holds every write behind a native approval card (`src/main/smith/`, `SmithProposalCard`). Read-only ops answer immediately; there is no delete, and projects are list-only. The sidebar's Smith entry opens the user's preferred terminal (Settings → General) at the project root and hands over the bootstrap line and the skill's path — a handoff, not an embedded terminal.
- **Main owns privilege** — git, disk, child processes, CLIs, and SQLite live in `src/main/`. The renderer (`src/renderer/`) is unprivileged and reaches main only through the typed IPC seam (`src/shared/ipc-contract.ts` → `src/main/ipc/` → `src/preload/bridge.ts` → `src/renderer/api.ts`).

## Architecture

```
.                              ← the application (repo root)
├── src/main/                  ← Node main process (privileged)
│   ├── engine/                ← sequencing, retries, boundaries, gates, worktrees
│   ├── pi/                    ← every agent call, in-process: run sessions and one-shots (no fallback)
│   ├── bridge/                ← vendored CLIProxyAPI: provider OAuth → local endpoint pi calls
│   ├── readiness/             ← agent-readiness evaluation and its marker
│   ├── smith/                 ← Smith's socket, validation, approval queue
│   ├── trace/                 ← Tracer: sole SQLite writer (WAL)
│   ├── store/                 ← JSON config (JsonStore, builtins, migrations)
│   ├── system/                ← PATH resolution, process control, doctor
│   ├── ipc/                   ← domain routers, named channel seam
│   └── updater.ts             ← electron-updater
├── src/renderer/              ← React 19 (no fs/child_process/electron imports)
├── src/shared/                ← pure types & IPC constants (no side effects)
├── src/preload/               ← narrow CJS bridge (bridge.cjs) for sandbox
├── src/cli/                   ← foundry-cli: the standalone Smith helper binary
├── skills/                    ← agent skills for users, keep up-to-date with 'smith' capabilities
├── website/                   ← marketing website for foundry app (do not update unless told to)
├── tests/                     ← Vitest suites (real git temp repos + scripted transport)
│   └── e2e/                   ← Playwright Electron UI smoke (not in npm run check)
└── scripts/                   ← check-css-collisions, check-docs-commands, audit-deps, engine-demo

.githooks/                     ← tracked git hooks (pre-commit); installed by npm run prepare
.github/workflows/             ← CI (ci.yml) + packaging (mac-package.yml)
.github/ISSUE_TEMPLATE/
```

**Phase handoffs** are JSON files under `.foundry-handoff/` inside the worktree. A fresh worktree has tracked files only; its project `setupScript` runs as `sh -c` at the worktree root before phases. For projects marked `scaffold`, a missing referenced code command is a warning and that code phase is skipped rather than blocking creation.

## Invariants (read before changing sequencing or persistence)

- **Every phase starts `fail`** and becomes `success` only after clean exit, parsed envelope, and passing gates. Boundaries are enforced after the call by diffing git; protected paths always fail.
- `**Tracer` is the sole SQLite writer.** See `src/main/trace/AGENTS.md`. WAL lets renderer reads proceed while the writer commits. Polling uses `run_id = ? AND change_id > ? ORDER BY rowid`; `change_id` is the cursor (`MAX(change_id)`), `rowid` is display order. Every insert/update stamps a new `change_id`.
- `**finish()` settles run status + operator-facing completion together** (notification, banner, `outcome_detail`). Do not update those independently. See `src/main/AGENTS.md`.
- **Electron single-instance lock** — a second writer would corrupt the per-project trace (`app.requestSingleInstanceLock()` in `src/main/main.ts`).

## Setup Commands

**Requirements:** macOS 26+, Apple Silicon, `git`, Node 22, and a model provider signed in through Settings → Providers (the Bridge's OAuth, or a direct API key).

```bash
# Clone and install (from repo root)
npm ci
```

`.npmrc` allow‑lists install scripts only for `electron`, `esbuild`, and `better-sqlite3`. If Electron's distribution is absent after install:

```bash
node node_modules/electron/install.js
```

`npm ci` also runs `npm run prepare`, which points git at the repo's tracked hooks
(`git config core.hooksPath .githooks`). If hooks are not firing, run `npm run prepare` by hand — the
`prepare` step is best-effort and never fails an install.

**Pre-commit hook** (`.githooks/pre-commit`): runs ESLint and Prettier against the **staged files only**,
so feedback is seconds rather than minutes. It is a convenience, not the gate — `npm run check` and CI
remain authoritative.

- It is **check-only**, never `--fix`/`--write`: a hook that rewrote files would clobber unstaged edits
  in a partially staged file. When it fails it prints the fix (`npm run lint:fix`, `npm run format`).
- Corollary: ESLint and Prettier read the working tree, so for a partially staged file the hook reports
  on the file **as it exists on disk**, not on the staged snapshot.
- It skips silently when `node_modules` is absent, and never builds, spawns a model, or touches the network.
- **Bypass:** `git commit --no-verify` skips it entirely. That is legitimate for WIP commits on a branch —
  CI still runs the real gate, so a bypassed commit cannot land unchecked.
- No `husky`/`lint-staged` dependency: `core.hooksPath` is a native git feature, and this repo keeps its
  dependency and dead-code surface tight. The script targets bash 3.2 (what macOS ships), so it avoids
  `mapfile` and process substitution.

App state lives under `~/Library/Application Support/foundry/` (sharded per project). Assets for the running app are in `assets/`.

**GUI PATH trap:** a packaged launch inherits launchd's minimal PATH. `src/main/system/env.ts:resolveEnv()` must complete before any CLI lookup/spawn; every spawn uses `spawnEnv()`. See `src/main/system/AGENTS.md`.

## Development Workflow

All app commands run from the repo root.

```bash
# Electron app with hot reload
npm run dev                 # electron-vite dev
npm run build               # electron-vite build (main + preload + renderer)
npm run start               # electron-vite preview

Makefile aliases still work:
make dev        # → npm run dev
make build      # → npm run build
make web        # build:web + preview:web --open
make check      # → npm run check
```

Do not run app to validate small fixes.

Use foundry-ui skill to validate larger changes. Drive the real app with that
skill (CDP + agent-browser) rather than writing a scratch Playwright spec:
`tests/e2e/` is for committed regression specs, and the skill is the harness
for checking your own work. If the launch looks blocked, the skill's
Troubleshooting section covers the usual causes; verify with
`pgrep -fl "electron \."` before concluding the environment is at fault.

**Path aliases** are configured in both `electron.vite.config.ts` and `tsconfig.json`:

- `@shared/*` → `src/shared/*`
- `@main/*` → `src/main/*`
- `@renderer/*` → `src/renderer/*`

**Preload must stay CJS** (`out/preload/bridge.cjs`) because sandboxed preloads cannot be ESM.

**Agent-runtime import boundary** (ESLint `no-restricted-imports`): only `src/main/pi/**` may import `@earendil-works/pi-*`. Everything above it talks to `pi/transport.ts`'s `AgentTransport`, so the runtime stays replaceable without touching every layer.

## Testing Instructions

Framework: **Vitest 4** (`forks` pool, `environment: node`, 30s timeout). Suites live in `tests/`.

```bash
npm test                    # vitest run (all suites)
npm run test:watch          # vitest watch mode
npm run test:coverage       # vitest run --coverage (enforces thresholds; part of npm run check)
npx vitest run -t "<name>"  # focus by test name pattern
npx vitest run tests/engine.test.ts  # single file

# Run the suite with capped workers; the default parallelism can be killed locally.
npx vitest run --maxWorkers=2
npx vitest run --coverage --maxWorkers=2

# Electron UI smoke — Playwright + the built app. Needs a macOS GUI session.
# Not part of `npm run check`; do not add it there.
npm run build && npm run test:e2e
```

**Coverage is enforced, not advisory.** `npm run test:coverage` fails when any threshold in
`vitest.config.ts` is breached, and `npm run check` runs that variant rather than plain `npm test`,
so local and CI enforce the same floor. An HTML report lands in `coverage/` (gitignored).

- **Scope** — `src/main/**`, `src/shared/**`, `src/cli/**`: the privileged, headless core that
  Vitest can execute under `environment: node`. `src/renderer/**` and `src/preload/**` are excluded
  because they only run inside Electron, as is `src/main/main.ts` (app bootstrap). UI verification
  is `npm run test:e2e` (Playwright launching `out/` against isolated fixtures). The fixture seeder
  itself is covered by `tests/e2e-fixture.test.ts` inside the Vitest gate.
- **Floors** — statements 62, branches 54, functions 61, lines 65. These sit a few points under the
  measured values and exist to catch regressions, not to certify the codebase. The scope deliberately
  includes the thin IPC routers that drag the average down rather than excluding them to look better.
- **Raise them as coverage climbs; never lower them to turn a red run green.** If a change legitimately
  removes covered code, say so in the PR.

**Conventions:**

- Tests use **real git temp repositories** and `tests/scripted-transport.ts` (an in-memory `AgentTransport` that performs real disk side effects in the worktree and answers asks through the real policy). Never use a network or model; do not mock git. Follow the executor pattern in `tests/executor.test.ts` for new engine behavior.
- **Electron UI smoke** (`tests/e2e/*.spec.ts`, `@playwright/test` + `_electron.launch()`): isolated `--user-data-dir`, seeded stores + WAL trace, no model or network. Onboarding walks Welcome → Ready; Inspector opens a seeded run and asserts the phase transcript. Failures write `test-results/` + `playwright-report/` (screenshot, trace, video). Interactive agent driving of the same app is the `foundry-ui` skill (CDP + agent-browser); do not add a second harness. The `e2e` CI job on `macos-26` is advisory — not a required check, not part of `npm run check`.
- `@lobehub/icons` is inlined via `server.deps.inline` so bare directory specifiers resolve under Vite.
- `tests/scripted-transport.ts` owns the agent-transport fixture. `tests/doctor.test.ts` owns the provider-doctor fixtures, injected as `ProviderDoctorDeps` so no Bridge, port, or credential is involved.
- New engine phase/gate behavior needs a dedicated executor test with a real worktree snapshot.

**What to run before submitting:** `npm run check` (see below) — it already runs the full Vitest suite.

## Code Style

- **TypeScript strict** (`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`). `tsc --noEmit` must pass.
- **ESLint (flat config)** — `eslint.config.js` with `typescript-eslint`, `eslint-plugin-react`, `eslint-plugin-react-hooks`. Rules: `@typescript-eslint/no-explicit-any: error`, `no-console: warn` (allow `warn`/`error` only), `no-restricted-imports` for `@earendil-works/pi-*`. Never use `eslint-disable` comments — fix the real issue.
- **Prettier** — `prettier --check .` must pass. Run `npm run format` to fix.
- **Knip** — `npm run knip` flags dead code / unused exports. Intentional unused exports need an explicit comment or pr-template note so a bot doesn't remove them.
- **No `any`** unless intentionally justified; use `type` imports where possible (`consistent-type-imports`).

```bash
npm run typecheck           # tsc --noEmit -p tsconfig.json
npm run lint                # eslint . --max-warnings 0
npm run lint:fix            # eslint . --fix
npm run format:check        # prettier --check .
npm run format              # prettier --write .
npm run knip                # dead code
```

## Build and Deployment

```bash
npm run build               # electron-vite build (minified via esbuild)
npm run check:css           # fails if <style> blocks redefine tokens-base.css classes
npm run check:docs          # fails if a documented command no longer exists
npm run audit:deps          # npm audit --audit-level=high (clean env)
npm run check               # full local gate (typecheck + lint + format:check + knip + test:coverage + build + check:css + check:docs + audit:deps)
npm run fetch:bridge        # downloads + checksums the pinned CLIProxyAPI into resources/bridge/
npm run package             # build + icons + fetch:bridge + electron-builder --mac --arm64 (local DMG)
```

- `check:css` (`scripts/check-css-collisions.mjs`) walks `src/renderer/**/*.tsx` and fails if an inline `<style>` redefines a class owned by `design/tokens-base.css` (e.g. `.btn`, `.field`). Move it to a `.module.css` file.
- `check:docs` (`scripts/check-docs-commands.mjs`) keeps this file honest. It parses every `npm run …`, `make …`, and `scripts/…` reference in the `AGENTS.md` guides, `README.md`, the `Makefile`, and `.github/workflows/**`, then asserts each target actually exists — and, in the other direction, that every `package.json` script is documented and every step composed into `npm run check` is named here. Failures print `file:line` plus the fix. It is **static**: nothing documented is ever executed, so GUI and packaging commands (`npm run dev`, `npm run package`) are validated by existence only. `specs/` and `.factory/docs/` are excluded on purpose — they are historical records that describe the repo as it was, including the retired `apps/desktop` layout. Two scripts are intentionally undocumented and allowlisted in the script: `icons` (an implementation detail of `package`) and `engine:demo` (a local scratch harness).
- `audit:deps` (`scripts/audit-deps.mjs`) spawns `npm audit` in a clean env (strips `npm_config_allow_scripts`) so it works on npm 12.
- `fetch:bridge` (`scripts/fetch-bridge.mjs`) downloads the CLIProxyAPI release pinned in `package.json` → `config.bridge` and verifies both the archive and the extracted binary against their recorded sha256. It also writes that tag's `models.json` next to the binary — Foundry has no separate model allowlist, so a CLIProxyAPI bump is enough for new models to appear. It is **fail-closed**: a mismatch leaves nothing executable behind and exits non-zero. `resources/bridge/` is gitignored; `electron-builder.yml` ships it as `extraResources` and signs it through `mac.binaries`. `mac-package.yml` must run this before electron-builder — `mac.binaries` codesigns `Contents/Resources/bridge/cli-proxy-api`, and a missing file fails signing. `node scripts/fetch-bridge.mjs --bump` (or `--bump <version>`) rewrites the pin from a new upstream release; `.github/workflows/update-cliproxyapi.yml` does that every 12 hours and opens a PR. A checkout that skipped the fetch simply has no Bridge — the manager reports `binary_missing` and the app runs on whatever other credentials pi has.

**CI** (`.github/workflows/ci.yml`, runs on `macos-26`):

- `verify` job: typecheck, lint, format:check, check:docs, knip, test:coverage, build, audit:deps.
- `e2e` job: `npm run build` then `npm run test:e2e` on `macos-26`. Advisory — not a required check. Artifacts (`playwright-report/`, `test-results/`) upload on every run.
- `actionlint` on `ubuntu-latest` (1.7.12+, required for `macos-26` label).
- Pull requests run `verify` + `actionlint` + `e2e` unconditionally (no paths filter) so required checks are never unsatisfied. Only `verify` and `actionlint` are required.

**Packaging** (`.github/workflows/mac-package.yml`, `macos-26`, `main` / `v*` / manual):

- Builds, signs, notarizes, and staples an arm64 DMG. Fetches the pinned CLIProxyAPI Bridge (`npm run fetch:bridge`) before electron-builder so `mac.binaries` has a file to sign. Main/manual use run-number versioning and publish a `Latest` release; tags use the tagged `package.json` version. Requires `APPLE_*` + `CERT_P12` secrets and pins the Developer ID certificate SHA‑1.
- `.github/workflows/update-cliproxyapi.yml` (every 12 hours / manual) bumps `package.json` `config.bridge` and opens a PR. Merging that PR to `main` triggers a new signed release. Needs the `AUTO_UPDATE_TOKEN` PAT (repo + workflow); `GITHUB_TOKEN` cannot start CI or `mac-package`.

## Pull Request Guidelines

- **Title:** `[component] Brief description` (e.g. `[engine] fix boundary bypass on renames`).
- **use** `.github/pull_request_template.md`

## Additional Notes

- Never modify or push `.foundry-worktrees/` branches directly — the engine owns them.
- Don't update the Website, unless specifically asked to do so. Instead file a GitHub issue for what  needs to be changed if you believe one is required
