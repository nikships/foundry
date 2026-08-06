# Glossary

Project-specific terms used across Foundry and the SSSF reference skill.

| Term | Meaning |
|---|---|
| **Foundry** | The native macOS Electron app in `apps/desktop/`. Active product in this repo. |
| **SSSF** | Super Simple Software Factory: the Python skill under `.claude/skills/sssf/`. Idea reference only; not a runtime dependency of Foundry. |
| **ADW** | AI Developer Workflow. In SSSF, a stamped Python script that owns a pipeline. In Foundry, replaced by **pipeline data** (JSON) run by the TypeScript engine. |
| **Phase** | One step in a pipeline: `agent`, `code`, or `engineer`. Born `fail`; success is earned. |
| **Agent phase** | Spawns or reuses a droid session, sends a rendered prompt, parses an envelope, runs gates, checks write boundary. |
| **Code phase** | Known command as a subprocess (`project.test`, builtin `git_commit`, or raw argv). No model. |
| **Engineer phase** | Human interrupt: approve / edit / reject sheet in the UI. |
| **Envelope** | Typed JSON report from an agent phase, validated with zod. Carries `status`, `summary`, `artifacts`, plus kind-specific fields. |
| **Gate** | Post-envelope check that returns **evidence** (`GateCheck[]`), not a bare pass/fail. Unknown gate names fail. |
| **Correction** | Re-prompt into the **same live droid session** after envelope parse failure or gate violation. |
| **Write boundary** | Per-agent allow list: `null` unrestricted (minus protected), `[]` read-only, or path/glob list. Enforced via git status after the phase. |
| **Worktree** | Per-run isolation under `.foundry-worktrees/` on branch `foundry/run_*`. |
| **Pipeline** | JSON document of ordered phases plus an acceptance criterion. Editable in the Pipeline Designer. |
| **Roster** | The set of agent definitions (model, prompts, tools, writes, envelope kind). Builtins are seeds; user copies live in the store. |
| **Acceptance** | How the engine decides the run is `accepted` vs not (e.g. phase flag, all phases pass). Settled only in `finish()`. |
| **Trace** | SQLite db of runs, phases, events, envelopes, gates, sessions. Single writer in main; renderer polls. |
| **rowid cursor** | `SELECT * FROM events WHERE run_id = ? AND rowid > ? ORDER BY rowid LIMIT 500`. The whole live-transport contract. |
| **droid** | Factory's coding-agent CLI. Foundry drives it via stream-JSON-RPC (`droid exec --input-format stream-jsonrpc`). |
| **oneshot** | Fallback mode: one `droid exec -o json` per turn if RPC fails repeatedly. Keeps sessions/envelopes/gates; loses mid-turn tool streaming. |
| **Handoff** | Files under `.foundry-handoff/` (or equivalent) that agents write for later phases; listed into prompts as `handoff_files`. |
| **Doctor** | Startup / project checks: droid present, auth, git, versions. |
| **Dry run** | Pipeline prompt preview: exact prompts that would be sent, zero tokens spent. |
| **Builtin** | Seed agents or pipelines shipped with the app. Marked `builtin: true`; user edits are separate store copies and must not be clobbered. |
| **Earned success** | Doctrine: never default a phase or run to success; status flips only on verified clean outcomes. |
| **Agent proposes, code disposes** | Agents produce work and claims; code (engine, gates, git, tests) decides acceptance. |
