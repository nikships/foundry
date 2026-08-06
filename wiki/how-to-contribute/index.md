# How to contribute

Foundry development happens under `apps/desktop/`. The SSSF skill under `.claude/` is reference material, not something you extend as part of the app.

## Before you start

Read [Getting started](../overview/getting-started.md) and [Patterns and conventions](patterns-and-conventions.md). Run typecheck, tests, and build before you call a change done.

## Pages in this section

- [Development workflow](development-workflow.md) — branch, edit, verify, PR
- [Testing](testing.md) — vitest suites, fake-droid, real git temp repos
- [Debugging](debugging.md) — traces, common failures, doctor
- [Patterns and conventions](patterns-and-conventions.md) — invariants and style
- [Tooling](tooling.md) — electron-vite, builder, scripts

## Definition of done

1. `npm run typecheck` passes
2. `npm test` passes
3. `npm run build` passes
4. New engine behaviour has a test in the existing style (temp git repo + scripted droid where relevant)
5. IPC changes update `src/shared/ipc-contract.ts` first
6. No imports from `.claude/`

## Work pickup

Useful entry points when looking for a task:

| Area | Start here |
|---|---|
| Run loop / phases | `src/main/engine/executor.ts` |
| Agent wire protocol | `src/main/droid/client.ts`, `protocol.ts` |
| UI for a run | `src/renderer/screens/RunDetailScreen.tsx`, `stores/run.tsx` |
| New setting or store field | `src/shared/types.ts` → store module → Settings UI |
| New gate | `src/main/engine/gates.ts` + `tests/gates.test.ts` |
