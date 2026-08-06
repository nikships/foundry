# From SSSF to Foundry

Foundry is **not** a port of the Super Simple Software Factory skill. The skill under `.claude/skills/sssf/` is a reference implementation of ideas: phases, envelopes, gates, write boundaries, earned success, and poll-don't-push. Foundry reimplements those ideas in TypeScript inside an Electron app and does not execute or import the skill.

## Side-by-side

| SSSF (reference) | Foundry | Why |
|---|---|---|
| Python ADW scripts stamped into each repo | TypeScript engine in the app; pipelines are **JSON data** | Users compose pipelines in UI; no code stamping |
| Pi coding agent | **droid CLI**, stream-JSON-RPC | Factory-native harness, model substitution, BYOK |
| YAML roster by hand | Roster as app state with editor UI | Settings are the product surface |
| pydantic envelope types fixed in code | zod schemas + optional custom fields per agent | Custom agents need custom report shapes |
| Runs on current branch | **Git worktree per run** by default | Isolation that SSSF left as "the obvious next thing" |
| Trace db inside target repo | Trace in app support dir, one db per project | Repo does not need gitignore hygiene for the app |
| Separate Bun + Vue visualizer | Renderer is the visualizer; no server or ports | One process tree |

Sources for this comparison: root `PLAN.md`, `AGENTS.md`, and the skill's `SKILL.md`.

## What stayed the same

- **Code owns sequencing, retries, and acceptance.** Agents work inside one phase.
- **Typed JSON envelopes** across seams; parse failure re-prompts the same session.
- **Gates validate claims with evidence**, then feed corrections.
- **Write boundaries enforced after the fact** with git, not by tool-list theater.
- **Poll SQLite with a rowid cursor**; live and history are one transport.
- **A known command is a code phase**, never an agent rediscovering `bun test`.

## What the skill still is for

- Reading cookbooks and module design when you want the original vocabulary
- Stamping a Python factory into a different repo (outside Foundry's product path)
- The Vue visualizer templates as design ancestry for the waterfall UI

Do not treat the skill as a dependency of `apps/desktop/`. See [Patterns and conventions](../how-to-contribute/patterns-and-conventions.md).

## Timeline note

The public skill history and Foundry app history share this repository in August 2026 (see [Lore](../lore.md)). Conceptual continuity is intentional; runtime coupling is not.
