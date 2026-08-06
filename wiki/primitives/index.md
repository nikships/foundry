# Primitives

Domain types that every Foundry surface shares. They live in `apps/desktop/src/shared/types.ts` as the contract between main and renderer. Engine code implements their behaviour; the UI only ever sees these shapes over IPC.

| Primitive | Role |
|---|---|
| [Phase](phase.md) | One step in a pipeline: `agent`, `code`, or `engineer`. Status lifecycle and earned success. |
| [Envelope](envelope.md) | Typed JSON report from an agent phase. Zod schemas, kind-specific fields, schema-generated prompt examples. |
| [Gate](gate.md) | Post-envelope check that returns evidence (`GateCheck[]`), not a bare verdict. Six builtins; unknown names fail. |
| [Pipeline](pipeline.md) | Ordered `PhaseDef[]` plus an acceptance criterion and optional isolation flag. |
| [Agent](agent.md) | Roster entry: model, effort, prompts, tools, write boundary, envelope kind. |

## Doctrine (one line each)

1. **A phase is born fail.** Success is earned by a clean finish (plus envelope and gates for agent phases).
2. **Code owns the loop.** Agents work inside one phase; the engine owns sequencing, retries, and acceptance.
3. **Typed seams.** Context crosses phases only as validated envelopes (and handoff files).
4. **Gates return evidence.** One `GateCheck` per examined item; a green gate says *what* it verified.
5. **Write boundaries are enforced after the call** by diffing git status, not by trusting the agent.

## Related

- [Envelopes and gates](../features/envelopes-and-gates.md)
- [Pipelines](../features/pipelines.md)
- [Roster](../features/roster.md)
- [Engine](../systems/engine.md)
- [Glossary](../overview/glossary.md)
- [Data models](../reference/data-models.md)
