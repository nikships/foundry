# Lore

A short narrative history of this repository. Dates are from git and project docs as of **2026-08-06**. Where motives are not written down, this page hedges rather than invents them. Product shape today is described in the [overview](overview/index.md) and [architecture](overview/architecture.md); migration detail also lives under [From SSSF to Foundry](background/from-sssf-to-foundry.md) when that page is present.

## Two things in one tree

The checkout is not a single product line with a long rewrite story. It is **two related artefacts**:

1. **Super Simple Software Factory (SSSF)** under `.claude/skills/sssf/`: a Claude skill that stamps Python ADW scripts, a YAML roster, and a polled Vue visualizer into a target repo.
2. **Foundry** under `apps/desktop/`: a native macOS Electron app that reimplements the *ideas* of SSSF in TypeScript, with no import or runtime dependency on the skill.

`README.md` still documents the skill. `PLAN.md` and `AGENTS.md` document the app. Agents and humans both need to know which layer they are touching.

## Era 1 — SSSF skill (August 2026)

**2026-08-02.** The repository opens with the SSSF skill tree. Public history records the initial commit message as a single rocket emoji (see [Fun facts](fun-facts.md)). The skill packages a doctrine that would outlive its first implementation:

- **Code owns the loop.** Python ADW scripts sequence phases, retries, and acceptance. Coding agents (Pi in v1) work inside named phases only.
- **Typed seams.** Context crosses phases as validated envelopes. The skill treats type, `## Report` example, and `output_type=` as a **synced triad** that humans must keep aligned by hand.
- **Gates return verdicts as violations.** Claims are checked in code after the agent stops talking.
- **Poll, don't push.** Events land in SQLite (WAL); a Bun + Vue visualizer polls rather than subscribing to a push channel.
- **Known commands are code phases.** There is no tester agent; `bun test` and friends are subprocesses.

ADWs are **stamped scripts** (`adw_plan_build_test.py` and siblings) plus shared modules under `adw_modules/`. Config is YAML. The trace database lives **inside the target repo**, which forces gitignore hygiene on every project that adopts the factory. Isolation via worktrees is documented more as the obvious next step than as the default path.

Why ship as a skill first? Likely because a skill can land inside existing Claude Code workflows without asking operators to install a desktop app. That reading is consistent with the install cookbooks and the "stamp into any repo" framing; it is not a recorded product decision memo.

## Era 2 — Foundry (August 2026)

**2026-08-06.** Foundry lands as a full Electron application in the same repository: main-process engine, droid harness, SQLite tracer, JSON stores, sandboxed React renderer, and ~94 tests that exercise real git repositories plus a scripted droid peer.

This is not a line-by-line port. `PLAN.md` states the skill is the **reference implementation of the ideas**, not a library. Foundry deliberately changes the runtime shape:

| SSSF (era 1) | Foundry (era 2) |
|---|---|
| Python ADW scripts stamped per repo | TypeScript engine inside the app; pipelines are **JSON data** |
| Pi coding agent | **droid** CLI, stream-JSON-RPC |
| YAML roster edited by hand | Roster as app state with a full editor UI |
| pydantic envelope types + hand-synced prompt examples | zod schemas; **schema-generated** prompt examples |
| Trace db inside the target repo | Trace db under Application Support, sharded per project |
| Separate Bun server + Vue SPA | Renderer is the visualizer; main process reads SQLite |
| Runs on the current branch by default | **Git worktree per run** on `foundry/run_*` by default |

The longest-standing material is conceptual, not syntactic: **phases, envelopes, gates, earned success, write boundaries, poll-don't-push**. Those doctrines appear almost unchanged between skill hard rules and Foundry invariants. What flipped was ownership of the runtime: from "scripts you stamp into a repo" to "an app that owns sequencing for any project you point it at."

Why Electron and droid rather than a thicker Python desktop? The written goal is a native macOS control room with Factory-native model substitution and BYOK. Beyond that, the choice looks like a product bet on one process tree and one IPC contract rather than a skill plus a side server. Treat deeper "why" as inferred.

## What stayed load-bearing across both eras

A few ideas survived the language and packaging change intact enough to count as lore rather than rewrite collateral:

1. **A phase is born `fail`.** Success is earned on clean exit (and, for agents, envelope + gates). Defaulting to success is treated as a lie the UI would happily show.
2. **Agents never decide whether they succeeded.** Code does.
3. **Corrections re-prompt the same live session** so a retry is a message, not a cold restart.
4. **Write boundaries are enforced after the call** by inspecting the tree (git status / diff), not by trusting tool lists alone.
5. **`finish()` settles status, notification, and banner together** so those surfaces cannot disagree.

Foundry's main technical additions on top of that spine are worktree isolation by default, a normalised event-derived cost model in the UI, and a droid wire protocol encoded from **observed CLI behaviour** rather than from documentation alone.

## Growth trajectory

As of the wiki date, history is measured in **days and two product-scale commits**, not years of continuous delivery. The [by the numbers](by-the-numbers.md) page shows a cold-start footprint: roughly 13.5k lines of Foundry TypeScript/TSX (including tests), about 3.6k lines of skill Python, and complexity concentrated in `executor.ts`, `tracer.ts`, and the droid client.

Trajectory so far looks like:

1. **Doctrine first** (skill, cookbooks, hard rules).
2. **App second** (engine + harness + trace + UI in one landing).
3. **Wiki and packaging** around that vertical slice (DMG-capable Electron app at version 0.1.0, headless `engine:demo`).

There is not yet a long public curve of weekly LOC or release cadence. If the project stays in this repo, later wiki refreshes should replace this section with measured growth rather than a two-point line.

## How to read the repo today

- Want to **run the factory against a project**? Foundry is the path: [Getting started](overview/getting-started.md).
- Want to **understand a concept** (envelope, gate, phase)? Prefer Foundry types and the [glossary](overview/glossary.md); open SSSF only as the idea ancestor.
- Want to **change app behaviour**? Stay in `apps/desktop/`. Do not import from `.claude/`.

The lore of the place is short: invent the control plane as a skill, then build the control room as an app, without throwing away the doctrines that made the skill worth keeping around as reference.
