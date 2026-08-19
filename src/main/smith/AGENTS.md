# AGENTS.md — src/main/smith

Smith is Foundry's entity-smith: an agent that creates and edits Foundry's own entities (agents, pipelines, envelopes) with every write gated on human approval.

**The agent does not live here, and the app never spawns it.** Smith is a skill (`skills/foundry-smith/`) that the user loads into whatever agent and harness they like, running in their own terminal. This directory is the app's half of that arrangement: a unix socket to call, validation, and a one-slot approval queue. `SmithService` (`index.ts`) wires the two halves together and is owned by `AppContext`, started once at boot.

## Project Overview

- **Transport**: `socket-server.ts` listens on a unix domain socket at `<supportDir>/smith/foundry.sock`. `protocol.ts` is the newline-delimited JSON contract, shared verbatim with the helper binary.
- **Approval**: `proposals.ts` is a one-slot queue. A `create`/`edit` blocks the calling CLI on a promise until a human answers the card in the renderer.
- **The helper**: `src/cli/foundry-cli.ts` (+ `src/cli/args.ts`) is the standalone binary the agent invokes. It is not spawned by the app; it is run by the agent, from outside.
- **The instructions**: `skills/foundry-smith/SKILL.md` is where the CLI, the entity schemas, and the approval contract are documented for the agent. It replaced a per-spawn generated system prompt, so it is now the _only_ place an agent learns this surface.
- **The handoff**: `launch.ts` resolves what a user cannot guess — the helper binary's path, where the skill shipped, the socket — and formats both the copyable bootstrap and the prepared session script. `session.ts` writes that script plus a `foundry-cli` shim under `<supportDir>/smith/`. `src/main/system/terminal.ts` either opens the preferred emulator at the project root (`open -a <App> <dir>`) or, for an emulator flagged `prepared`, hands it the script to run. The sidebar's Smith entry calls `smith:start`, which launches directly and answers `needs-launcher` only when it could not; `SmithLauncher` is the fallback that reason opens.

There is no session, no PTY, and no process supervision in this directory. Handing the terminal a command is still a handoff, not ownership: `open` exits immediately, the app does not hold the process, feed it input, or read its output, and nothing is registered in `procs.ts`. If a change here wants any of that, it is the wrong change.

## Setup Commands

```bash
npm ci
npm run build   # emits out/main/foundry-cli.js alongside out/main/main.js
```

Exercising the round trip needs the app running (the socket exists only while it is) and any agent that can load the skill:

```bash
npm run dev
node out/main/foundry-cli.js project list                          # → project ids
node out/main/foundry-cli.js agent list                            # → roster JSON
node out/main/foundry-cli.js agent create --file /tmp/spec.json    # → blocks on the card
```

A dev app on a custom `--user-data-dir` does not live at the CLI's default path; export `FOUNDRY_SMITH_SOCKET=<that dir>/foundry/smith/foundry.sock`.

## Development Workflow

- Adding a protocol op: extend `CliRequest`/`CliResponse` in `protocol.ts`, handle it in `SmithSocketServer.dispatch()`, teach `src/cli/args.ts` to parse it, and **document it in `skills/foundry-smith/SKILL.md`** — an agent only knows what the skill says.
- Read ops (`list`/`show`) answer straight from the stores, scope-aware. Write ops validate through the store's own `validate()` **first**: errors return as JSON and never raise a card, warnings ride along on the card.
- The queue never imports a store. `context.ts` injects `saveProposal` from `src/main/ipc/smith.ts` as the `SaveHandler`, which is also what broadcasts the settings-changed event a form save would.
- Scope is the agent's to supply (`--project` / `$FOUNDRY_SMITH_PROJECT`) because it has no ambient project. Absent means global.

## Testing Instructions

```bash
npm test
npx vitest run -t "smith"
npx vitest run tests/smith-socket.test.ts      # dispatch() without a real socket
npx vitest run tests/smith-cli-args.test.ts    # pure argv + socket-path resolution
npx vitest run tests/smith-skill.test.ts       # skill/template drift guard
npx vitest run tests/smith-launch.test.ts      # shell quoting + asar path rewriting
```

- `SmithSocketServer.dispatch()` is exposed for tests; do not test through a live socket.
- `src/cli/args.ts` exists so the CLI's parsing is testable: it must stay pure — no fs, no socket, no `process.exit`. Failures come back as data and only the binary turns them into exit codes.
- `launch.ts` splits `resolveFromMainDir(mainDir, ...)` out from the two callers precisely so the packaged layout is assertable from a machine that cannot package. Keep new path logic on that seam rather than reaching for `import.meta.url` again.
- The skill is not part of the build, so nothing else would notice it rotting. `tests/smith-skill.test.ts` is the guard: it asserts the documented `{{token}}` vocabulary exists in each template and that the socket path in the prose matches `defaultSocketPath()`.

## Invariants and Landmines

- **`protocol.ts` must stay stdlib + type-only imports.** It is compiled into the standalone helper binary; one value import from the app drags the app into it. The same rule binds `src/cli/args.ts`.
- **The CLI's protocol import must stay `import type`.** A value import would make `protocol.ts` a shared runtime chunk across the two main-process entries.
- **Projects are read-only over the socket, and projected.** `list` answers with `{ id, name, path }` only — never a full `ProjectDef` (commands, protected paths, setup script, merge policy). Every other op on `kind: 'project'` errors, in both the CLI and `dispatch()`, so neither side is the only gate.
- **One pending proposal at a time.** A second concurrent write rejects with `proposal_pending`. A failed save leaves the proposal pending (`answer()` returns false) so the card can show the error instead of silently dismissing. `cancelAll()` on shutdown unblocks a waiting CLI that would otherwise hang until its socket dies.
- **Rejection carries no note.** The human is at the same terminal as the agent, so their next message _is_ the revision guidance. `note` survives on the answer type only for the shutdown path.
- **The socket path is the app's, and the CLI hardcodes its default.** `defaultSocketPath()` reproduces `userData/foundry` + `smith/foundry.sock` without asking the app, because the CLI has to answer "is Foundry running?" when there is nothing to ask. Changing where the app puts the socket means changing that default and the skill's prose together — `tests/smith-skill.test.ts` fails if they part ways.
- **A stale socket file** from a crashed run is removed before `listen`, or bind fails with `EADDRINUSE`.
- **Exit 2 means "not running", and only that.** `ENOENT`/`ECONNREFUSED` map to it; a real protocol error is exit 1 with the app's own message.
- **Settings stores a terminal `id` and a coding-agent `id`, never an application or binary name.** `terminalFor()` maps the terminal id to the `appName` handed to `open -a`, and `codingAgentFor()` maps the agent id to the PATH name `whichBinary()` looks up. Both fall back to a catalogued default for an id we no longer know — so a hand-edited settings file can never put an arbitrary string on that command line. (`execFile` takes an argument array, so it would not be shell-interpreted either; this is the second lock.)
- **The skill has to ship in the bundle, unpacked.** The user's agent reads `SKILL.md` from disk, from outside the app, so `skills/**` is in electron-builder's `files` _and_ its `asarUnpack`. `resolveFromMainDir()` rewrites `app.asar` → `app.asar.unpacked` for both the skill and the CLI; a path left pointing inside the archive is not a file at all.
- **Only inject a command where the emulator's own command line takes one.** `TERMINAL_APPS` flags that with `prepared`, and today only Ghostty carries it (`open -na Ghostty.app --args --working-directory=<dir> -e <cmd>`, documented in its `--help`). Terminal and iTerm would need AppleScript that types into a window — breakable by a vendor update and gated on the Automation permission — and the rest have no macOS-side equivalent, so they keep the copyable bootstrap. Do not add `prepared` to an emulator without a documented flag for it.
- **A prepared session's shim is an executable on PATH, not a shell function.** The bootstrap's function is right for a human's own shell and wrong for an agent, which spawns its own shells for each command: a function does not survive that, an executable inherited through the environment does.
- **The auto-start requires an absolute, existing agent CLI.** Settings names which catalogued harness to start (Droid, Claude Code, Codex, OpenCode, Pi); the binary itself is still a `whichBinary()` lookup on the resolved PATH. Foundry never stores a user-typed command line. The lookup falls back to a bare name when nothing is installed, and a script that sets its own PATH cannot be trusted to resolve one, so `canAutoStart` is false and the launcher shows the manual handoff rather than opening a window that dies on its first line. Per-CLI flags live in `smithAgentArgv()` — do not inline them at the spawn site.

## Code Style

- Keep the `SmithServiceDeps` seam narrow: the service takes callbacks, not `AppContext`. New capabilities arrive as another injected function, not an import reaching up.
- No `eslint-disable`; use `@main/*` / `@shared/*` aliases.

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build
npm run package   # build + icons + electron-builder --mac --arm64
```

- `electron.vite.config.ts` builds a second main entry, `out/main/foundry-cli.js`, from `src/cli/foundry-cli.ts`.
- `electron-builder.yml` `asarUnpack`s that one file. The agent runs it as `node <path>`, and a path inside `app.asar` is not a real file on disk — unpacking gives it one at `app.asar.unpacked/out/main/foundry-cli.js`, which is the path the skill documents.

## Routing

Smith spans three places beyond this directory. Change them together.

| Location                                      | Responsibility                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `src/main/ipc/smith.ts`                       | 5 invoke channels + 1 event; `saveProposal` store write                  |
| `src/main/system/terminal.ts`                 | `open -a <App> <dir>`; the emulator catalog and install check            |
| `src/shared/types.ts` `CODING_AGENTS`         | Catalog of harnesses Smith can start; settings stores the `id` only      |
| `src/cli/`                                    | The helper binary + its pure arg parsing                                 |
| `src/renderer/components/SmithProposalCard.*` | The approval card — where a write is allowed or refused                  |
| `src/renderer/components/SmithLauncher.*`     | The fallback handoff, shown only when the one-click start cannot run     |
| `skills/foundry-smith/`                       | The skill an agent loads: persona, CLI reference, schemas, HTML previews |

`src/cli/` is the helper binary Smith drives over the socket. It has nothing to do with the agent the user runs it from.

## Additional Notes

- Two sources of truth for the entity schemas is a known, accepted cost: the skill's prose, and the stores' `validate()`. The store is the enforcement, and a validation failure returns to the agent as JSON precise enough to correct itself, so the skill only has to be roughly right. Keep it roughly right anyway.
- Security posture: a per-user unix socket, and a human's Approve as the only write gate. Nothing here authenticates the caller because anything that can reach the socket already runs as the user.
