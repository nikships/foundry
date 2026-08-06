# Features

Operator-facing capabilities of Foundry. Each feature is a product surface: screens, data models, and engine behaviour the user can configure or inspect without reading TypeScript.

Subsystem implementation lives under [Systems](../systems/index.md). Shared vocabulary lives under [Primitives](../primitives/index.md).

## Catalog

| Feature | Summary |
|---|---|
| [Pipelines](pipelines.md) | JSON pipeline definitions, designer UI, validation, dry-run, seven builtins. |
| [Roster](roster.md) | Five seed agents, model catalog, write boundaries, editor and seed rule. |
| [Runs and traces](runs-and-traces.md) | Composer, run list, waterfall detail, polling, kill, cost, outcome banner. |
| [Envelopes and gates](envelopes-and-gates.md) | Typed phase handoffs and six evidence-producing gates. |
| [Worktrees](worktrees.md) | Per-run isolation, merge policies, branch naming, orphan sweep. |
| [Onboarding](onboarding.md) | Doctor, first project, smoke Scout path. |

## How features relate

```
Onboarding → first project + Doctor green
     ↓
Runs composer → pick Pipeline + request
     ↓
Worktree (default) + Roster agents + Envelopes/Gates per phase
     ↓
Trace polled live on Run detail
```

Pipelines name agents from the roster and gates from the gate catalog. Isolation is a project (and optional pipeline) setting, enforced by the worktree layer. The runs UI is the only place live factory output is watched.

## Related

- [Foundry desktop](../apps/foundry.md)
- [Architecture](../overview/architecture.md)
- [Systems](../systems/index.md)
- [Primitives](../primitives/index.md)

## Active contributors

Foundry maintainers.
