# Apps

Foundry ships as one product: the native macOS desktop app under `apps/desktop/`.

There is no separate server, web visualizer, or multi-app suite. The Electron shell is the control room and the factory runtime in one process tree.

## Catalog

| App | Path | Role |
|---|---|---|
| [Foundry desktop](foundry.md) | `apps/desktop/` | Electron app (main, preload, React renderer). Runs pipelines, hosts the roster and designer, polls the per-project trace. |

## What is not an app

| Path | Why it is listed elsewhere |
|---|---|
| `.claude/skills/sssf/` | Reference skill only. Idea source for phases, envelopes, gates, and poll-don't-push. Not imported or packaged. See [From SSSF to Foundry](../background/from-sssf-to-foundry.md). |

## Related

- [Foundry desktop](foundry.md)
- [Architecture](../overview/architecture.md)
- [Systems](../systems/index.md)
- [Features](../features/index.md)

## Active contributors

Foundry maintainers.
