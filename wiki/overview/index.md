# Foundry overview

Foundry is a native macOS Electron app that runs **repeatable agent-plus-code pipelines** against your git repos. You describe the work, pick (or design) a pipeline, and a deterministic TypeScript engine sequences bounded agent phases, code commands, and optional human interrupts. Every event lands in a per-project SQLite trace that the UI polls live.

This repository holds two related things. **Foundry** (`apps/desktop/`) is the active product. The original Python skill under `.claude/skills/sssf/` is the **idea source** (phases, envelopes, gates, earned success, poll-don't-push). Foundry reimplements those ideas in TypeScript and does not import or run the skill.

## Who uses it

- **Operators** who want plan → build → test → review to run the same way every time, while watching swim lanes fill.
- **Tuners** who edit the agent roster, swap models, add gates, and tighten write boundaries in the UI.
- **Skeptics** who open a finished run and ask what was verified: gate evidence, costs, prompts, and raw JSONL are one click deep.

## Table of contents

### Overview

- [Architecture](architecture.md)
- [Getting started](getting-started.md)
- [Glossary](glossary.md)

### Snapshot and history

- [By the numbers](../by-the-numbers.md)
- [Lore](../lore.md)
- [Fun facts](../fun-facts.md)

### How to contribute

- [How to contribute](../how-to-contribute/index.md)
  - [Development workflow](../how-to-contribute/development-workflow.md)
  - [Testing](../how-to-contribute/testing.md)
  - [Debugging](../how-to-contribute/debugging.md)
  - [Patterns and conventions](../how-to-contribute/patterns-and-conventions.md)
  - [Tooling](../how-to-contribute/tooling.md)

### Apps

- [Apps](../apps/index.md)
  - [Foundry desktop](../apps/foundry.md)

### Systems

- [Systems](../systems/index.md)
  - [Engine](../systems/engine.md)
  - [Droid harness](../systems/droid.md)
  - [Trace](../systems/trace.md)
  - [Store](../systems/store.md)
  - [IPC and preload](../systems/ipc-and-preload.md)
  - [System services](../systems/system-services.md)
  - [Renderer](../systems/renderer.md)

### Features

- [Features](../features/index.md)
  - [Pipelines](../features/pipelines.md)
  - [Roster](../features/roster.md)
  - [Runs and traces](../features/runs-and-traces.md)
  - [Envelopes and gates](../features/envelopes-and-gates.md)
  - [Worktrees](../features/worktrees.md)
  - [Onboarding](../features/onboarding.md)

### Primitives

- [Primitives](../primitives/index.md)
  - [Phase](../primitives/phase.md)
  - [Envelope](../primitives/envelope.md)
  - [Gate](../primitives/gate.md)
  - [Pipeline](../primitives/pipeline.md)
  - [Agent](../primitives/agent.md)

### Background and security

- [Background](../background/index.md)
  - [From SSSF to Foundry](../background/from-sssf-to-foundry.md)
  - [Design invariants](../background/design-invariants.md)
- [Security](../security.md)

### Reference

- [Reference](../reference/index.md)
  - [Configuration](../reference/configuration.md)
  - [Data models](../reference/data-models.md)
  - [Dependencies](../reference/dependencies.md)

## Doctrines in one line each

1. **Code owns the loop.** The engine owns sequencing, retries, and acceptance. Agents work inside one phase and never decide whether they succeeded.
2. **Typed seams.** Context crosses phases only as validated envelopes (zod) plus handoff files. Parse failures re-prompt the same live session.
3. **Poll, don't push.** The main process writes SQLite (WAL); the renderer polls with a `rowid` cursor. Live view and history are the same query.
