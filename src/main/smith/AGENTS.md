# AGENTS.md — src/main/smith

Smith is a real `droid` session running inside Foundry, in an embedded Ghostty terminal, that can create and edit Foundry's own entities (agents, pipelines, envelopes) through a helper CLI — with every write gated on human approval. `SmithService` (`index.ts`) wires the three halves together and is owned by `AppContext`, started once at boot.

## Project Overview

- **Transport**: `socket-server.ts` listens on a unix domain socket (`<supportDir>/smith/foundry.sock`, exported as `$FOUNDRY_SMITH_SOCKET`). `protocol.ts` is the newline-delimited JSON contract, shared verbatim with the helper binary.
- **Approval**: `proposals.ts` is a one-slot queue. A `create`/`edit` blocks the calling CLI on a promise until a human answers the card in the renderer.
- **Terminal**: `engine.ts` spawns `droid` inside a headless Ghostty (vendored prebuilt addon); `registry.ts` owns one session per project, its status machine, and droid session-id discovery for `--resume`.
- **Prompt**: `system-prompt.ts` renders the appended prompt teaching droid the helper CLI, the three entity schemas, and the project's current inventory.
- Sessions live in the main process, so closing the modal does not kill the terminal — only an explicit kill or app quit does.

## Setup Commands

```bash
npm ci
droid --version    # Smith blocks with `droid-missing` without it on PATH
npm run dev        # macOS arm64 only: the vendored engine has no fallback
```

The engine needs `vendor/electron-ghostty` present and loadable. On any other platform `ghosttyAvailable()` is false and Smith reports `blocked: 'engine-missing'` rather than degrading.

**The prebuilt addon is not in the repo.** `available()` checks for `vendor/electron-ghostty/build/Release/ghostty_renderer.node`, which the root `.gitignore`'s generic `build/` rule excludes. Nothing in `scripts/` or the workflows builds or fetches it, so a fresh clone — and every CI-packaged build — reports `engine-missing`. Supply the binary out of band before testing the terminal.

## Development Workflow

- Adding a protocol op: extend `CliRequest`/`CliResponse` in `protocol.ts`, handle it in `SmithSocketServer.dispatch()`, teach `src/cli/foundry-cli.ts` to send it, and document it in `system-prompt.ts` — droid only knows what the prompt says.
- Read ops (`list`/`show`) answer straight from the stores, scope-aware. Write ops validate through the store's own `validate()` **first**: errors return as JSON and never raise a card, warnings ride along on the card.
- The queue never imports a store. `context.ts` injects `saveProposal` from `src/main/ipc/smith.ts` as the `SaveHandler`, which is also what broadcasts the settings-changed event a form save would.
- Status (`starting`/`idle`/`busy`/`exited`/`blocked`/`absent`) is inferred from presented frames: a frame marks busy, `ACTIVITY_IDLE_MS` (1.5s) of quiet marks idle. Cursor blink is disabled in the config so a frame means real output.

## Testing Instructions

```bash
npm test
npx vitest run -t "smith"
npx vitest run tests/smith-socket.test.ts     # dispatch() without a real socket
npx vitest run tests/smith-registry.test.ts   # fake engine + fake session discovery
```

- `SmithRegistryDeps.spawnEngine` and `discoverSessions` exist so tests drive the registry with no Electron and no droid. Keep new dependencies injectable the same way.
- `engine-config.ts` is pure on purpose — assert the exact ghostty config and command strings there rather than through the engine.
- `SmithSocketServer.dispatch()` is exposed for tests; do not test through a live socket.

## Invariants and Landmines

- **`engine: 'utility'` only.** The current ghostty pin has a known IOSurface size-mismatch bug in main-process mode. Never switch it.
- **Exit codes are synthesized, not real.** Ghostty reports no exit code across the utilityProcess boundary, so `engine.ts` infers one from how fast the process died: inside `RESUME_FAILURE_WINDOW_MS` (15s) → `1` (a failed `--resume`, retried fresh once, stored id dropped), later → `0`.
- **The command line is the only channel for per-session env.** The utilityProcess environment is fixed at fork, so `ghosttyCommand()` builds `/bin/sh -c 'K="v" exec …'`. It **throws** on any value containing a single quote — that would break the outer quoting. `PATH` must ride along via `spawnEnv()` or droid cannot find its tools.
- **Only `#rrggbb` theme values survive.** `ghosttyConfig()` drops CSS `rgba(...)` rather than risk a config parse error.
- **The user's ghostty config is structurally unreachable.** The vendored addon never calls `ghostty_config_load_default_files`; Smith passes a config string and nothing else. Do not add a code path that reads or writes `~/.config/ghostty`.
- **`protocol.ts` must stay stdlib + type-only imports.** It is compiled into the standalone helper binary; one value import from the app drags the app into it.
- **One pending proposal at a time.** A second concurrent write rejects with `proposal_pending`. A failed save leaves the proposal pending (`answer()` returns false) so the card can show the error instead of silently dismissing. `cancelAll()` on shutdown unblocks a waiting CLI that would otherwise hang until its socket dies.
- **Session-id discovery must not claim a session the user started.** Attempts at 5/15/45s pick the newest droid session whose cwd matches, created after our spawn (±`DISCOVERY_SKEW_MS`). Keep the created-after guard.
- **The generated system prompt never lands in the repo.** It is written per-spawn to `<supportDir>/smith/<projectId>/system-prompt.md`.
- A stale socket file from a crashed run is removed before `listen`, or bind fails with `EADDRINUSE`.

## Code Style

- Keep the `SmithServiceDeps` seam narrow: the service takes callbacks, not `AppContext`. New capabilities arrive as another injected function, not an import reaching up.
- Pure string/config builders belong in `engine-config.ts`; anything importing `electron` belongs in `engine.ts`.
- No `eslint-disable`; use `@main/*` / `@shared/*` aliases.

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build
npm run package   # build + icons + electron-builder --mac --arm64
```

- `electron.vite.config.ts` builds a second main entry, `out/main/foundry-cli.js`, from `src/cli/foundry-cli.ts`.
- `electron-builder.yml` ships `vendor/electron-ghostty/**` outside `out/` and `asarUnpack`s it: the `.node` addon cannot load from an asar and `host.js` must be forkable from a real path. `ghosttyVendorDir()` rewrites `app.asar` → `app.asar.unpacked` to match.
- Open: `TODO(smith-cli-exec)` in `index.ts`, now **confirmed broken** in a packaged build. The shebang does survive minification, but `foundryCliPath()` resolves next to the main entry — i.e. inside `app.asar` — and the asar entry carries no executable flag. Nothing inside an asar can be `exec`'d by the OS, so droid cannot invoke `$FOUNDRY_CLI` directly. Fix by `asarUnpack`ing `out/main/foundry-cli.js` (and marking it executable) or by writing the shell shim the TODO describes.
- Open: the `asarUnpack` glob ships whatever is on disk under `vendor/electron-ghostty/`. Since the addon binary is gitignored (above), a packaged build made from a clean checkout contains no engine.

## Routing

Smith spans four directories beyond this one. Change them together.

| Location                             | Responsibility                                                           |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `src/main/ipc/smith.ts`              | 5 invoke channels + 2 events; `saveProposal` store write                 |
| `src/cli/foundry-cli.ts`             | The `$FOUNDRY_CLI` helper binary droid invokes (**not** `src/main/cli/`) |
| `src/preload/ghostty.ts`             | Frame receiver + key/mouse/IME input, on the vendored package's own IPC  |
| `src/renderer/components/Smith*.tsx` | The terminal modal and the approval card                                 |
| `vendor/electron-ghostty/`           | Vendored prebuilt Ghostty engine (third-party, do not edit)              |

`src/cli/` is the helper binary; `src/main/cli/` is vendor argv construction. They are unrelated despite the name.

## Additional Notes

- Frames reach the renderer zero-copy via `sharedTexture` onto a `<canvas data-ghostty="smith:<projectId>">`; the slot string comes from `smithSlot()` in the shared contract. Nothing terminal-shaped crosses the `FoundryApi` contract.
- `preload/ghostty.ts` discovers canvases with a `MutationObserver`, not once at `DOMContentLoaded`, because the canvas mounts and unmounts with the React modal. Registering a canvas sends `ready`, which is what repaints scrollback on reopen.
- Mouse coordinates are passed in unscaled CSS pixels — ghostty applies content scale itself, and scaling here lands clicks on the wrong cell. `Cmd` keydowns are deliberately not forwarded so app shortcuts keep working.
