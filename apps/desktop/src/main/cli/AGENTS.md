# AGENTS.md — src/main/cli

Adapters that own vendor argv construction and one-shot output parsing. `types.ts` is the seam, `index.ts` is the registry. RPC wire behavior lives in `src/main/droid/sdk/`, not here.

## Project Overview

- One adapter per `CliVendor` (currently `droid`). Adapters build `argv` for `exec` and parse `result`/`completion` output into the uniform `CliOutput` shape.
- The engine and Droid transport consume this interface; adapters never manage sessions or notifications.
- Catalog and model discovery helpers (`models()`, `tools()`) support roster/pipeline UIs.

## Setup Commands

```bash
cd apps/desktop
npm ci
# droid CLI must be on PATH for live parsing (tests use fixtures).
droid --version
```

No separate CLI setup — adapters are invoked through the engine/droid layers.

## Development Workflow

- Add flags in the vendor adapter file (`droid.ts`), not in callers.
- Keep fixtures alongside `tests/cli-vendors.test.ts` — do not add wire framing here.
- `types.ts` defines the adapter contract (`argv`, `parse`, `models`, `tools`, `supportsRpc`); `index.ts` re-exports the vendor map (`CLI_VENDOR_IDS` must stay in sync with `src/shared/types.ts`).

## Testing Instructions

```bash
cd apps/desktop
npm test
npx vitest run tests/cli-vendors.test.ts
npx vitest run tests/catalog.test.ts
npx vitest run tests/catalog-discovery.test.ts
```

- `tests/cli-vendors.test.ts` owns all argv/parse fixtures — add cases there.
- Do not shell out to `droid` in tests; parse synthetic output strings.

## Droid‑Specific Compatibility

- Only Droid sets `supportsRpc`; it means an SDK transport exists, not that this adapter owns protocol framing. A degraded session still uses `argv`/`parse`.
- `droid exec -o json` ends with `result`, while `-o stream-json` ends with `completion` + `finalText`; `parse()` must accept both.
- One-shot usage reports `input_tokens` but RPC reports `inputTokens`; map the fields before recording token usage.
- `models()` is a subprocess (`droid models` or equivalent). `tools()` reads the last live session catalog, ignores the passed `binary`/`model`, and is honestly empty before a session runs.

## Code Style

- Vendor files are pure argv/parse — no `fs`, no `better-sqlite3`, no Electron.
- No `eslint-disable`; fix the real issue. Use `@main/*` / `@shared/*` aliases.
- Do not duplicate constants in `src/shared/types.ts` — import them.

## Build and Deployment

```bash
cd apps/desktop
npm run typecheck && npm run lint && npm run build
```

No standalone build; adapters bundle into `out/main/main.js`.

## Additional Notes

- `index.ts` CLI registry feeds both the roster UI and the engine's vendor lookup — keep `CLI_VENDOR_IDS` in `src/shared/types.ts` synchronized.
