# Testing

Foundry tests run with **vitest** from `apps/desktop/`. They use real git repositories in temporary directories and a scripted droid peer. There is no network and no live model in the loop.

## Commands

```bash
cd apps/desktop
npm test           # vitest run
npm run test:watch # watch mode
```

Config: `vitest.config.ts` (node environment, `tests/**/*.test.ts`, 30s timeout, forks pool).

## Suites

| File | Focus |
|---|---|
| `tests/envelopes.test.ts` | zod seams, extraction, correction messages |
| `tests/boundary.test.ts` | glob matching, three-state allow, revert |
| `tests/ipc-clone.test.ts` | payloads survive structured clone |
| `tests/gates.test.ts` | each gate's evidence, unknown-gate failure |
| `tests/droid-client.test.ts` | wire protocol against `fake-droid.ts` |
| `tests/executor.test.ts` | run loop against real git temp repos |

AGENTS.md cites ~94 tests across these files. Prefer extending an existing suite over inventing a parallel harness.

## fake-droid

`tests/fake-droid.ts` is a scripted stdio peer built from recorded frames. It intentionally reproduces droid quirks (type discriminator, string ids, flat settings). Do not "simplify" the protocol in tests so they pass against a friendlier fake than production.

## Patterns

- **Temp git repos:** create with `mkdtemp`, `git init`, seed commits, pass the path as project root / worktree target.
- **No model:** agent phases are driven by the fake peer or pure code paths under test.
- **Assert evidence:** gate tests check `GateCheck` items, not only boolean pass.
- **Assert earned success:** failed phases stay failed unless the scenario completes cleanly.

## Adding a test

1. Place it in the suite that owns the behaviour (executor vs gates vs droid).
2. Keep assertions on observable outcomes: phase status, envelope validity, git tree contents, event rows.
3. Run the full suite before claiming done.
