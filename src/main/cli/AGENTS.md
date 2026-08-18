# AGENTS.md — src/main/cli

Descriptors for agent CLIs the app **does not run**. `types.ts` is the contract, `index.ts` is the registry.

This directory used to own vendor argv construction and one-shot stdout parsing, so a `droid exec` child could be spawned for a turn. Nothing spawns one now: agent phases run on `src/main/pi/`'s in-process transport, and every one-shot call site opens a short-lived session there. The argv, the parse, and the stream normalisers went with the code that called them.

## Project Overview

- One descriptor per `CliVendor` (currently `droid`): where the binary lives, how it says it is authenticated, where to send someone whose install is broken, and which models it publishes.
- The readers are Settings (roster model pickers), `system/doctor.ts` (install and auth probes), and `store/settings.ts` (the configured path).
- Nothing here builds an argument, spawns a process, or parses output.

## Development Workflow

- This directory is on its way out. Settings, the doctor, and the model picker move to Pi's own provider and credential model; when they do, this goes with them. Treat it as a shim, not a seam to extend.
- Add a field only if the doctor or Settings actually reads it. A descriptor that describes something nothing asks about is dead weight that the next migration has to carry.
- `CLI_VENDOR_IDS` lives in `src/shared/types.ts` because the renderer names vendors too. Keep the registry in sync with it; do not define a second copy.

## Testing Instructions

```bash
npx vitest run tests/cli-vendors.test.ts
npx vitest run tests/catalog.test.ts
npx vitest run tests/catalog-discovery.test.ts
```

- `tests/cli-vendors.test.ts` covers the registry: every contract vendor has a descriptor, an unknown one falls back rather than crashing, and probed paths are absolute (a relative one resolves against whatever directory the app launched from).
- Do not shell out to `droid` in tests.

## Code Style

- Descriptor data and lookups only — no `fs` writes, no `child_process`, no `better-sqlite3`, no Electron.
- No `eslint-disable`; fix the real issue. Use `@main/*` / `@shared/*` aliases.
- Do not duplicate constants from `src/shared/types.ts` — import them.

## Build and Deployment

```bash
npm run typecheck && npm run lint && npm run build
```

No standalone build; this bundles into `out/main/main.js`.

## Additional Notes

- `supportsRpc` is true for droid alone and means an SDK client exists in `src/main/droid/sdk/`, not that anything here frames protocol.
- `tools()` reads the last live session's catalog and ignores its arguments; it is honestly empty before a session has run.
