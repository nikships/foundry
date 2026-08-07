# AGENTS.md

Guidance for agents working in this repository.

## What this repo contains

Two unrelated things. Know which one you are touching.

| Path | What it is | Status |
|---|---|---|
| `apps/desktop/` | **Foundry**, a native macOS Electron app. TypeScript + React 18. | The active codebase. |
| `.claude/skills/sssf/` | The original Python "super simple software factory" skill. | **Reference only.** |

`.claude/skills/sssf/` is where Foundry's *ideas* come from (phases, envelopes, gates,
the trace db, agent-proposes-code-disposes). Its *code* is not a dependency.

- Do not import from, execute, or link against anything under `.claude/`.
- Do not add Python to `apps/desktop/`.
- Read it to understand a concept, then implement the concept in TypeScript.

`README.md` documents the Python skill, not the app. `PLAN.md` is the app's spec.

## Working in `apps/desktop`

Run everything from `apps/desktop/`.

```bash
npm run dev         # electron-vite dev
npm run build       # required before `npm start`; emits out/{main,preload,renderer}
npm run typecheck   # tsc --noEmit
npm test            # vitest run, 164 tests
npm run engine:demo # headless run of the engine, no UI
```

**Before you finish any change, all three must pass:** `npm run typecheck`, `npm test`,
`npm run build`. The renderer is plain TSX, so `tsc` covers it.

### Environment notes

- `.npmrc` pins `allow-scripts = electron,esbuild,better-sqlite3`. If `electron/dist`
  is missing after an install, run `node node_modules/electron/install.js`.
- `main` in `package.json` is `out/main/main.js`, not `index.js`. electron-vite names
  the bundle after the entry file.
- The preload bundle is CJS (`bridge.cjs`) because sandboxed preloads cannot be ESM.

## Architecture

```
src/main/       Node. Owns everything: git, disk, agent CLIs, sqlite.
  engine/       The deterministic pipeline runner.
  cli/          One adapter per agent CLI: argv in, parsed turn out.
  droid/        The agent harness: droid's JSON-RPC client plus the shared one-shot runner.
  trace/        SQLite (WAL). Single writer.
  store/        JSON-backed config: agents, pipelines, projects, settings.
  system/       Process control, doctor checks, notifications.
src/preload/    Named-invoke bridge. No generic escape hatch.
src/renderer/   React 18. Polls; never touches disk, git, or droid.
src/shared/     types.ts (the contract) + ipc-contract.ts (the channels).
```

The renderer's entire capability surface is `src/shared/ipc-contract.ts`. If the UI
needs something new, add a channel there first, then a handler in `src/main/ipc.ts`.

### Invariants worth not breaking

- **A phase is born `fail`.** It flips to success only on a clean exit, plus (for agent
  phases) a parsed envelope and green gates. Never default a phase to success.
- **Code owns sequencing, retries, and acceptance. Agents own the work inside one
  phase.** An agent never decides whether it succeeded.
- **Corrections re-prompt the same live session**, so a retry costs one message rather
  than a cold restart. Envelope retries and gate retries have separate budgets.
- **Gates return evidence, not verdicts.** A gate emits one `GateCheck` per item it
  examined, so a green gate says *what* it verified. An unknown gate name fails.
- **Write boundaries are enforced in code after the call**, by diffing git status, not
  by asking the agent nicely. Unauthorized writes are reverted and the phase fails.
- **`finish()` settles status, notification, banner, and `outcome_detail` together** so
  they cannot disagree.
- Every run gets a git worktree and a `foundry/run_*` branch. The base checkout is
  never touched.

### The trace

One data path: the main process writes SQLite, the renderer polls SQLite.

```sql
select * from events where run_id = ? and rowid > ? order by rowid limit 500;
```

That cursor query is the whole transport. No websocket, no push, no replay path. Live
view and history differ only in cadence. WAL is on, so reads never block a run.

Keep the schema normalised. Per-phase cost, duration, and model are **derived** from
events in `src/renderer/derive.ts`, not stored as columns, so a retry's real cost stays
visible. Do not add a denormalised `total_tokens` column to `phases`.

State lives at `~/Library/Application Support/foundry/`, sharded per project by a hash
of the project path (`projects/<hash>/trace.db`).

## Agent CLIs

Foundry drives five: `droid`, `claude` (Claude Code), `codex`, `junie`, and `grok`
(xAI's Grok Build). An agent picks one in `AgentDef.cli`; absent means `droid`, so
rosters written before this existed still load.

```
src/main/cli/types.ts   The CliAdapter interface and the shared parse helpers.
src/main/cli/<vendor>.ts One adapter each: argv, parse, models, auth, caveats.
src/main/cli/index.ts   The registry, PATH lookup, and per-vendor defaults.
```

An adapter is two functions worth caring about. `turn(req)` builds one turn's
argv; `parse(out)` folds whatever the process printed into `{ text, usage,
sessionId, reason, isError }`. `droid/oneshot.ts` owns process mechanics (spawn,
timeout, kill, stderr) and knows no vendor's flags, so **adding a sixth CLI is one
file plus one registry entry** and touches nothing in `engine/`.

### Invariants for adapters

- **Autonomy is a sandbox tier, never an approval prompt.** Nothing watches a
  phase, so a CLI left in its default "ask the human" mode blocks on a stdin
  nobody types into. Every adapter but droid disables approvals and confines the
  agent instead. The write boundary still diffs git afterwards, so a sandbox wider
  than the agent's `writes` is caught and reverted as before.
- **Never invent a flag.** Junie publishes no headless autonomy flag, so its
  adapter emits none and the doctor checks for `~/.junie/allowlist.json` instead.
  A guessed flag fails on builds that lack it, and the failure reads as a broken
  agent. The per-CLI extra arguments field in Settings is the escape hatch.
- **Never invent a model id.** A vendor that publishes no list returns only its
  documented aliases plus `inherit`. A wrong id is accepted and then yields empty
  turns, which reads far worse than a short list.
- **Unreported usage stays unreported.** Codex reports no cost and Grok's usage
  field names are unpublished, so both can return `null` rather than a zero that
  claims a turn was free.
- Only droid sets `supportsRpc`. Junie (`--acp true`), Grok (`grok agent stdio`),
  and Codex (`codex app-server`) all speak ACP or JSON-RPC over stdio, which is the
  same shape as `droid/client.ts`, so a later PR can turn that on per vendor
  without the engine noticing.

`tests/cli-vendors.test.ts` pins each adapter's argv and parse against the output
shapes those CLIs actually print, including Codex's two spellings of its item
discriminator. Fixtures come from real documented output, not from shapes the
parser finds convenient.

## The droid protocol

`src/main/droid/protocol.ts` encodes findings observed against the real CLI, not the
docs. Three are load-bearing and a naive client gets all three wrong:

1. Frames need a `type` discriminator plus `factoryApiVersion` / `factoryProtocolVersion`.
   A plain JSON-RPC frame is rejected with `-32700`.
2. Request `id` **must be a string**. A number is rejected the same way.
3. Session settings (`modelId`, reasoning effort, autonomy) are **flat params** on
   `droid.update_session_settings`. Nested under `settings` they are silently ignored.

Also: `add_user_message` takes `params.text` (not `message`) and returns immediately;
the turn ends with an `agent_turn_completed` notification. `tool_call` is re-emitted per
`toolUseId` as arguments stream in, so it must be folded into one span.

Test against `tests/fake-droid.ts`, a scripted stdio peer built from recorded frames.
It reproduces these quirks on purpose. Do not "simplify" them away.

## Testing

```
tests/envelopes.test.ts     12   zod seams, extraction, correction messages
tests/boundary.test.ts      12   glob matching, three-state allow, revert
tests/ipc-clone.test.ts      6   payloads survive the structured-clone bridge
tests/gates.test.ts         19   each gate's evidence, unknown-gate failure
tests/droid-client.test.ts  24   the wire protocol against fake-droid
tests/executor.test.ts      21   the run loop against real git temp repos
tests/cli-vendors.test.ts   40   each vendor's argv and parse, per real CLI output
```

Tests use real git repositories in `mkdtemp` directories and a scripted droid stub.
No network, no model in the loop. New engine behaviour needs a test in this style.

## Conventions

- Comments explain **why**, never what. Every non-obvious decision in this codebase has
  a comment giving the constraint behind it. Match that; do not narrate code.
- No emoji in source or UI copy.
- Prefer a comma or parenthesis over an em dash in prose and UI strings.
- Anything sent over IPC is structured-cloned. Send plain data: `api.ts` routes every
  argument through `plain()` so a wrapped object cannot fail to serialise, because that
  failure surfaces only as a button that appears to do nothing.
- A handler that can reject must catch and show the error. Silence reads as a bug.
- Failure modes stay honest: unreported usage displays as unreported, unknown gates
  fail, a policy-blocked model degrades with a warning instead of killing the session.

## Built-ins

Five agents (`planner`, `builder`, `scout`, `reviewer`, `documenter`) in
`store/builtin-agents.ts`. There is no tester agent, because running a suite is a known
command and therefore a `code` phase.

Seven pipelines in `store/builtin-pipelines.ts`, from `prompt` (one agent) to
`full-sdlc`. Pipelines are JSON data, not scripts.

Six gates: `artifacts_exist`, `files_non_empty`, `json_parses`, `diff_matches_claims`,
`verdict_consistent`, `command_passes`.

Builtins are seeds. A user's edited copy lives in their own store and must never be
clobbered by a change to the builtin list.
