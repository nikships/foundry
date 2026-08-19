# AGENTS.md — src/main/bridge

The Bridge turns an operator's provider **subscriptions** (Claude, ChatGPT, Gemini, Kimi, Grok) into a local OpenAI- or Anthropic-shaped endpoint that `pi/` can call. It is a vendored [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) binary, started as a child of the app, plus the code that configures it, logs providers in, and writes the models it serves into pi's `models.json`.

## Project Overview

- `paths.ts` — where the binary, config, and auth material live. The binary is **resolved, never assumed**: packaged under `process.resourcesPath/bridge/`, in dev under the checkout's `resources/bridge/`, and null when neither is an executable file.
- `config.ts` — the generated YAML the child is started with. Hand-emitted so the bytes are stable; pinned to `127.0.0.1` with remote management off.
- `providers.ts` — the one table: login flag, the `type` values CLIProxyAPI writes into auth files, the pi API kind, and the base-URL suffix. A provider is loggable and reachable from the same row or not at all. Models are not listed here.
- `catalog.ts` — projects CLIProxyAPI's `models.json` (vendored next to the binary by `fetch:bridge`) onto those logins. A new model in that file appears on the next regeneration; Foundry does not keep its own allowlist.
- `manager.ts` — the child's lifecycle: `ensure()` with coalescing, port scan, health poll, SIGTERM→SIGKILL.
- `auth.ts` — provider login/logout, account reading, and the debounced auth-directory watcher.
- `models.ts` — generating and merging the `bridge-*` half of pi's `models.json`.
- `service.ts` — the orchestrator the app holds: manager + watcher + regeneration + one pi refresh per committed write.

## Setup Commands

```bash
npm ci
npm run fetch:bridge   # downloads + checksums the pinned CLIProxyAPI into resources/bridge/
npm run dev
```

`fetch:bridge` is **fail-closed**: a checksum mismatch leaves nothing executable on disk and exits non-zero. The version and both hashes (archive and extracted binary) are pinned in `package.json` under `config.bridge`; `node scripts/fetch-bridge.mjs --bump` recomputes both from a new upstream release (the `update-cliproxyapi.yml` workflow opens that as a PR). The same tag's `internal/registry/models/models.json` is written beside the binary — that file is the model catalog, so bumping CLIProxyAPI is enough for new models to appear. `resources/bridge/` is gitignored and shipped through electron-builder `extraResources`, with the binary listed in `mac.binaries` so hardened-runtime signing covers it. `mac-package.yml` must fetch the binary before electron-builder runs.

A checkout that never ran the fetch simply has no Bridge: `bridgeBinaryPath()` returns null and `ensure()` answers `binary_missing`. That is a supported state, not a broken install.

## Invariants

- **Localhost only.** `host: 127.0.0.1`, `allow-remote: false`, `secret-key: ""`, control panel disabled. The Bridge holds the operator's provider subscriptions; a bind on `0.0.0.0` would put their Claude and Codex accounts on the local network.
- **Never `~/.cli-proxy-api`.** Config and auth live under Foundry's Application Support directory. The operator may run CLIProxyAPI themselves, and an app that logged into their directory would rewrite the accounts their own tools use.
- **No token leaves `auth.ts`.** Auth files hold refresh and access tokens. Only `type`, `email`/`login`, `expired`, and `disabled` are parsed out; nothing is logged, and login-child stdout is never echoed (a failing OAuth flow can print a callback URL carrying a code).
- **`models.json` is merged, never overwritten.** Only `bridge-*` keys are replaced. A hand-added Ollama provider and any unknown top-level field survive every regeneration.
- **One `modelRuntime.refresh()` per committed write.** The write is skipped when the rendered bytes match what is on disk, and the refresh happens only when the write did. An auth directory emits several events for one login.
- **Only authenticated providers reach the catalog.** A provider with no usable account is absent, not present-and-failing: pi would list its models and refuse at request time, which reads as a broken model rather than a missing login.
- **The `processes` row carries a null run id, in the app's own trace.** `processes.run_id` has a foreign key to `runs` with `foreign_keys = ON`, so a synthetic id is rejected. Null satisfies the constraint, keeps the row out of every per-run query (retention's delete, the kill-by-run path), and still reaches the relaunch sweep's unfiltered `openProcesses()`. The store is `appDbPath()` (`trace/db.ts`), not a project's: the Bridge is app-scoped, a project can be removed while its Bridge still holds a port, and a Bridge started from Settings before any project exists has no project trace to be written to.
- **Every `ensure()` records, no caller opts in.** `BridgeService` wires `onProcess`/`onProcessEnd` to `opts.trace` at construction, so the run path, the doctor, and a Settings login all record identically. A row written only by some callers leaves exactly the orphan it exists to catch.
- **A row is closed only when the pid is confirmed gone.** `terminate()` (`system/procs.ts`) SIGTERMs the tree, escalates to SIGKILL, and reports whether the pid actually died. A survivor keeps its row open, because closing it would hide the one process still holding the port from the only sweep that could reclaim it.
- **Cost is zero for every Bridge model.** These run against a subscription already paid for; a per-token price would accumulate a dollar figure in the trace that no invoice will ever show.
- **Anthropic gets the root base URL, everything else `/v1`.** pi's Anthropic SDK appends `/v1/messages` itself, so an `anthropic-messages` entry pointing at `/v1` requests `/v1/v1/messages` and 404s.

## Scope

- **GitHub Copilot is out of scope.** The vendored CLIProxyAPI has no Copilot login flow. Listing it would offer a login that cannot happen.
- **No request-body rewriting.** The Bridge passes requests through; thinking-budget and tool-schema rewrites are not this layer's concern.

## Testing Instructions

```bash
npx vitest run tests/bridge-manager.test.ts
npx vitest run tests/bridge-models.test.ts
npx vitest run tests/bridge-catalog.test.ts
npx vitest run tests/bridge-service.test.ts
npx vitest run tests/bridge-process-row.test.ts
npx vitest run tests/procs-terminate.test.ts
npx vitest run tests/pi-catalog.test.ts
```

- The child under test is a **scripted stand-in** that reads the same generated config the real binary is given and binds the port it names. The vendored binary is not required to run the suite (and a real one would want an account).
- Auth fixtures are written the way CLIProxyAPI writes them, tokens included, because the parser's job is to read that format without carrying a secret out of it. `tests/bridge-models.test.ts` asserts no token appears in a serialized account.
- Port assertions stay inside `37700–37799`, the band this app claims for the Bridge.

## Code Style

- This directory may not import `@earendil-works/pi-*` (ESLint `no-restricted-imports`). It reaches pi through `../pi/catalog.ts`, loaded lazily so constructing a service does not build a runtime.
- No `eslint-disable`; use `@main/*` / `@shared/*` aliases.

## Additional Notes

- Provider ids are prefixed `bridge-` in `models.json` so a Bridge entry cannot collide with, or silently override, a built-in pi provider: `anthropic` stays the operator's own key and `bridge-claude` is the subscription.
- The Gemini flow is Antigravity's and is routed as `openai-completions`, not `google-generative-ai`, which would build v1beta URLs the Bridge does not serve.
