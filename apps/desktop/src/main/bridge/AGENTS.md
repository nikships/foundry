# AGENTS.md — src/main/bridge

The Bridge runs a vendored CLIProxyAPI child that exposes an operator’s provider subscriptions through a local endpoint and projects its authenticated model catalog into pi.

## Ownership

- `paths.ts` resolves the packaged or development binary.
- `config.ts` emits stable localhost-only configuration.
- `providers.ts` is the provider/login/API-kind table.
- `catalog.ts` filters the vendored model catalog by authenticated providers.
- `model-denylist.ts` contains exact model IDs the operator does not want offered.
- `manager.ts` owns child startup, health, and termination.
- `auth.ts` owns login files and the auth-directory watcher.
- `models.ts` merges Bridge providers into pi’s `models.json`.
- `service.ts` coordinates lifecycle, regeneration, and runtime refresh.

`npm run fetch:bridge` downloads and verifies the pinned binary and catalog. A checkout without it is supported: `bridgeBinaryPath()` returns null and `ensure()` reports `binary_missing`.

## Security and lifecycle invariants

- **Localhost only.** Bind `127.0.0.1`, disable remote management, and never expose subscription credentials to the LAN.
- **Never use `~/.cli-proxy-api`.** Config and auth live under Foundry Application Support.
- **No token leaves `auth.ts`.** Expose only non-secret account metadata. Never echo login-child output, which may contain OAuth callback codes.
- **Merge `models.json`; never overwrite it.** Replace only `bridge-*` providers so user-added providers and unknown fields survive.
- Refresh pi exactly once per committed model-file write; skip byte-identical writes.
- Only authenticated providers enter the generated catalog.
- Every `ensure()` records the child in the app-scoped trace with null `run_id`, regardless of caller.
- Close a process row only after `terminate()` confirms the PID is gone.
- Bridge models have zero per-token cost because they use existing subscriptions.
- The model denylist is exact, lowercase, and deny-by-default only for listed IDs. Do not convert it to an allowlist or prefix matching.
- Reject models declaring image output, including mixed text/image models. Keep entries with unspecified modalities.
- Anthropic receives the root base URL; other providers receive `/v1`.
- GitHub Copilot and request-body rewriting are out of scope.

Provider IDs use a `bridge-` prefix so they cannot override pi’s built-in providers.

## Tests

Tests use a scripted child and fixtures, never the real vendored binary or an account. Serialized account assertions must prove tokens do not escape.

```bash
npx vitest run -t "bridge"
npx vitest run apps/desktop/tests/main/bridge/bridge-process-row.test.ts
```
