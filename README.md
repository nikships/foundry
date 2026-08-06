# Foundry

> **A native macOS software factory.** You describe the work, a deterministic TypeScript engine sequences bounded agent phases, and every event lands in a trace you watch live.

<p align="center">
  <img src="apps/desktop/assets/icon/app-icon-1024.png" alt="The Foundry app icon: a robot arm placing a glowing cube onto a conveyor" width="180">
</p>

Everyone can get an agent to write code once. Almost nobody gets the same result twice. Foundry fixes that by moving the control plane out of the prompt and into code. The engine owns sequencing, retries, and acceptance. Agents work inside named, bounded phases. Typed envelopes carry context across the seams. Gates decide what "done" means, with evidence. **Agent proposes, code disposes.**

> [!NOTE]
> **This repo holds two things.** `apps/desktop/` is Foundry, the active codebase (Electron, TypeScript, React 18). `.claude/skills/sssf/` is the original Python "super simple software factory" skill the ideas came from: phases, envelopes, gates, the trace db, agent-proposes-code-disposes. It is **reference only**. Nothing under `.claude/` is imported, executed, or linked, and there is no Python in the app. [`PLAN.md`](PLAN.md) is the product spec.

---

## The loop

1. **Describe.** Type a request, pick a pipeline (or design one in the UI).
2. **Run.** The engine executes phases in order. Agent phases go through Factory's `droid` CLI with per-agent model substitution. Code phases are plain subprocesses (tests, lint, git).
3. **Watch.** A live swim-lane waterfall: tool calls appearing mid-phase, envelopes and gate evidence inspectable per phase, costs filling in as usage is reported.
4. **Judge.** The run ends `accepted` or not by its own declared criterion, with a native notification and a full queryable trace.

Three doctrines, inherited from the skill and restated as Foundry law:

- **Code owns the loop.** Sequencing, retries, and acceptance live in the engine, never in a prompt. An agent never decides whether it succeeded.
- **Typed seams.** Context crosses phases only as validated envelopes (zod schemas) plus handoff files. If an envelope does not parse, the same live session is re-prompted with a correction naming exactly what was wrong.
- **Poll, don't push.** The main process writes every event to SQLite (WAL) as it happens. The renderer polls with a `rowid` cursor. Live view and history are the same query.

---

## Run it

**Prereqs:** macOS (26+ for the packaged app), Node 22+, git, and Factory's [`droid`](https://factory.ai) CLI on `PATH` with auth set up. Python, `pi`, and the skill are **not** required.

```bash
cd apps/desktop
npm install
npm run dev            # electron-vite dev: main, preload, renderer
```

Everyday commands, all from `apps/desktop/`:

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest, 94 tests, no network and no model in the loop
npm run build          # emits out/{main,preload,renderer}, required before npm start
npm start              # preview the built app
npm run engine:demo    # headless engine run against a temp git repo, no UI
npm run package        # build + icons + electron-builder, arm64 DMG under dist/
```

If `electron/dist` is missing after install (the `.npmrc` pins `allow-scripts`), run `node node_modules/electron/install.js`.

First launch runs onboarding: Doctor checks (droid on PATH, auth, git, OS version), add a project (must be a git repo), set the project's commands (`test`, `lint`, ...) with a **Try it** button, then optionally smoke-test with the read-only `scout` pipeline.

App state lives at `~/Library/Application Support/foundry/`, sharded per project by a hash of the project path (`projects/<hash>/trace.db`). Your repos stay clean.

---

## Pipelines are data, not scripts

A pipeline is a JSON document, which is what makes the in-app Pipeline Designer possible:

```jsonc
{
  "id": "plan-build-test",
  "acceptance": { "kind": "phase_flag", "phase": "test", "flag": "passed" },
  "phases": [
    { "name": "plan",  "kind": "agent", "agent": "planner",
      "description": "Turn the request into a plan the builder needs no questions to implement.",
      "envelope": "plan", "gates": ["artifacts_exist", "files_non_empty"],
      "prompt": { "template": "user", "inputs": ["request"] } },
    { "name": "commit_plan", "kind": "code",
      "description": "Record the spec as its own commit so the plan has a history separate from the work.",
      "command": { "builtin": "git_commit", "messageFrom": "envelope:plan.commit_message" } },
    { "name": "build", "kind": "agent", "agent": "builder", "retries": 2,
      "description": "Implement the plan exactly and report every changed file.",
      "envelope": "build", "gates": ["diff_matches_claims"],
      "prompt": { "template": "user", "inputs": ["request", "envelope:plan"] } },
    { "name": "test",  "kind": "code",
      "description": "Run the project's test command and capture the evidence either way.",
      "command": { "ref": "test" }, "feedbackTo": "build", "feedbackRetries": 2 },
    { "name": "commit_build", "kind": "code",
      "description": "Commit the implementation once its tests are green.",
      "command": { "builtin": "git_commit", "messageFrom": "envelope:build.commit_message" } }
  ]
}
```

Phase kinds:

- **agent** — render the prompt, send it through that agent's droid session, parse the final JSON against the envelope schema, run the gates, check the write boundary. Parse or gate failure re-prompts the *same session* with a correction, so a retry costs one message instead of a cold restart. Envelope retries and gate retries have separate budgets.
- **code** — a known command runs as a subprocess: the project's test command, a `git_commit` builtin, or raw argv. `bun test` is not a judgement call, so no agent runs it. If `feedbackTo` names an earlier agent phase and the command fails, the failure goes back to that agent as a synthetic envelope, bounded by `feedbackRetries`. That is the build-test repair loop, generalized into data.
- **engineer** — the run pauses and raises an interrupt sheet (approve / edit / reject). Human-in-the-loop is cheap when the engine lives in an app with a UI attached.

Seven built-in pipelines ship as editable copies:

| Pipeline | Chain |
|---|---|
| `prompt` | one agent, one turn, one envelope |
| `scout` | read-only reconnaissance |
| `plan` | spec, committed as its own commit |
| `plan-build` | spec, implement, each step committed |
| `plan-build-test` | the standard chain, accepted when tests pass |
| `plan-build-review` | build, then a second agent checks it against the request |
| `full-sdlc` | plan, build, test, review, document, committing at each boundary |

Acceptance is declared per pipeline (`last_phase_pass`, `envelope_status`, or `phase_flag`), because phases passing is not the same as the run being acceptable: a test phase that ran a red suite did its job perfectly.

---

## The roster

Five built-in agents, each with its own model, reasoning effort, prompts, tools, and write boundary. Every field is editable in the Roster screen; the builtins are seeds, not law, and your edited copies are never clobbered by app updates.

| Agent | Model | Effort | May write |
|---|---|---|---|
| `planner` | claude-opus-5 | high | `specs/`, `.foundry-handoff/` |
| `builder` | claude-opus-5 | medium | unrestricted (minus protected paths) |
| `scout` | claude-sonnet-5 | medium | nothing (read-only) |
| `reviewer` | claude-opus-5 | high | nothing (read-only) |
| `documenter` | claude-sonnet-5 | medium | `docs/`, `README.md` |

There is no tester agent. Running a suite is a known command, and therefore a code phase.

**Write boundaries are enforced in code, after the call**, by diffing `git status` inside the run's worktree against the phase-start snapshot. Unauthorized writes are reverted and the phase fails with the violation list in the trace. "Read-only agent" means read-only with respect to your repo, never unable to write its own report.

---

## Envelopes and gates

An agent has two output channels: handoff files, and a final JSON response parsed against a zod schema. Six built-in envelope kinds (`generic`, `plan`, `build`, `scout`, `review`, `document`) share a base of `status`, `summary`, `artifacts`, `notes_for_next_agent`; the specialized kinds add fields like `changed_files`, `commit_message`, `approved`, and `findings`.

The classic failure mode of this design is the synced triad: the type, the JSON example in the prompt, and the parse target drifting apart. Foundry solves it by construction. The JSON example embedded in the agent's prompt is **generated from the zod schema at render time**, so the shape the agent is shown and the shape its answer is parsed against cannot drift.

Six built-in gates: `artifacts_exist`, `files_non_empty`, `json_parses`, `diff_matches_claims`, `verdict_consistent`, `command_passes`. **Gates return evidence, not verdicts.** Each gate emits one check per item it examined, so a green gate says *what* it verified. An unknown gate name fails rather than passing silently.

---

## Run isolation

Every run gets a git worktree and a `foundry/run_*` branch. The base checkout is never touched. At the end of the run: accepted runs offer a merge, rejected or failed runs keep the worktree with "open / discard" actions, and a kill or crash leaves the worktree in place for the orphan sweep in Settings.

---

## The trace

One data path: the main process writes SQLite, the renderer polls SQLite.

```sql
select * from events where run_id = ? and rowid > ? order by rowid limit 500;
```

That cursor query is the whole transport. No websocket, no push, no replay path. WAL is on, so reads never block a run. The schema is normalized (`runs`, `phases`, `events`, `envelopes`, `gate_results`, `agent_sessions`, `processes`); per-phase cost, duration, and model are **derived** from events in the renderer, not stored as columns, so a retry's real cost stays visible. Files under the run directory (`raw.jsonl`, per-attempt envelopes, prompts, handoffs) stay the raw record; the db is the queryable mirror.

The `processes` table powers the kill path (children first) and the relaunch sweep: on app start, any row with no `ended_at` whose pid is gone finalizes its run to `failed`, so a crashed app never leaves runs reading `running` forever.

---

## The droid harness

Agent phases run on `droid exec --input-format stream-jsonrpc`, one long-lived child per agent per run, kept alive across that agent's phases so corrections reuse the live context window. Per-agent models map to `-m`, reasoning effort to `-r`. If the JSON-RPC child misbehaves, the adapter drops to one-shot mode (`droid exec -o json --session-id`) and the run continues, with the mode recorded on the run.

`src/main/droid/protocol.ts` encodes findings observed against the real CLI. Three are load-bearing:

1. Frames need a `type` discriminator plus `factoryApiVersion` / `factoryProtocolVersion`. A plain JSON-RPC frame is rejected.
2. Request ids **must be strings**. A number is rejected the same way.
3. Session settings are **flat params** on `droid.update_session_settings`. Nested under `settings` they are silently ignored.

Tests run against `tests/fake-droid.ts`, a scripted stdio peer built from recorded frames that reproduces these quirks on purpose.

---

## Development

```
apps/desktop/
├── src/main/       Node. Owns everything: git, disk, droid, sqlite.
│   ├── engine/     the deterministic pipeline runner
│   ├── droid/      the agent harness
│   ├── trace/      SQLite (WAL), single writer
│   ├── store/      JSON-backed config: agents, pipelines, projects, settings
│   └── system/     process control, doctor checks, notifications
├── src/preload/    named-invoke bridge, no generic escape hatch
├── src/renderer/   React 18: Onboarding, Runs, Run detail, Pipelines, Roster, Settings
├── src/shared/     types.ts (the contract) + ipc-contract.ts (the channels)
└── tests/          vitest: real git temp repos, scripted droid stub, no network
```

The renderer never touches disk, git, or droid. Its entire capability surface is `src/shared/ipc-contract.ts`; if the UI needs something new, add a channel there, then a handler in `src/main/ipc.ts`.

94 tests across six files: envelopes, boundaries, gates, the droid wire protocol, IPC structured-clone survival, and the run loop against real git repos. New engine behavior needs a test in that style.

**Before finishing any change, all three must pass:** `npm run typecheck`, `npm test`, `npm run build`.

[`AGENTS.md`](AGENTS.md) carries the working agreements: the invariants (a phase is born `fail`, `finish()` settles status and notification together, gates emit evidence), the conventions (comments explain why, no emoji, plain data over IPC), and the honest failure modes (unreported usage displays as unreported, a policy-blocked model degrades with a warning).

---

## Honest edges

- **Maturity target is past POC, short of shipping product.** Real engine, real settings, real error states, packaged DMG. Not in scope: auto-update, notarization, multi-machine sync, cloud anything.
- **The droid stream-JSON-RPC surface is explicitly evolving.** The adapter boundary is SDK-shaped and the one-shot fallback is wired in, but protocol drift is the top risk.
- **macOS 26 is the floor.** Vibrancy and notification behaviors are verified on 26 only; no fallback burden accepted.
- **Cost visibility depends on droid usage reporting.** If a model omits usage, the UI shows "unreported" rather than zeros.
- **Gates check what a predicate can check**, not plan quality or code taste. That is what the reviewer phase is for.

The full spec, including the milestone plan and the settings surface, is [`PLAN.md`](PLAN.md).

---

## License

MIT, see [`LICENSE`](LICENSE).
