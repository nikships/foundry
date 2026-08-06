# PLAN.md — Foundry

**A native macOS software factory.** One Electron app (macOS 26+) that owns the entire loop: you describe work, a deterministic TypeScript pipeline engine sequences bounded agent phases, Factory's **droid CLI** executes them with per-phase model substitution, typed envelopes carry context across seams, gates decide "done," and every event streams live into a trace you watch like a build monitor.

Foundry is **not** a port, wrapper, or migration of the SSSF skill in `.claude/`. That code is the *reference implementation of the ideas* — phases, envelopes, gates, write-boundaries, earned success, poll-don't-push — and we take the ideas, not the code. No Python, no `pi`, no YAML roster, no stamped `adws/` scripts, no dependency on anything under `.claude/`. Anything copied out of there (provider icons, palette values, schema inspiration) is copied into the app tree and owned there.

Target maturity: past POC, short of shipping product. Real engine, real settings, real error states, packaged DMG. Not in scope: auto-update, notarization pipeline, multi-machine sync, cloud anything.

---

## Part I — Product

### 1. What Foundry is

A control room plus the factory itself, in one app:

1. **Describe** — type a request, pick a pipeline (or design one).
2. **Run** — the engine executes phases in order: agent phases via droid, code phases as plain subprocesses (tests, lint, git). Retries and corrections happen inside the same droid session, never as cold restarts.
3. **Watch** — a live waterfall of swim lanes per agent, tool calls appearing mid-phase, envelopes and gate evidence inspectable per phase, token/cost meters filling in real time.
4. **Judge** — the run ends `accepted` or not by its own declared criterion, with native notification, outcome art, and a full queryable trace.

Three doctrines inherited from SSSF, restated as Foundry law:

- **Code owns the loop.** The engine (TypeScript, main process) owns sequencing, retries, and acceptance. Agents work inside one bounded phase each. A known command is a code phase, never an agent.
- **Typed seams.** Context crosses phases only as validated envelopes (zod schemas) plus handoff files. If an envelope doesn't parse, the same session is re-prompted with a correction naming exactly what was wrong.
- **Poll, don't push.** Engine writes every event to SQLite (WAL) as it happens; renderer polls with a rowid cursor. One transport, live view and history are the same query.

### 2. What Foundry deliberately does differently from SSSF

| SSSF (reference) | Foundry | Why |
|---|---|---|
| Python ADW scripts stamped per repo | TypeScript engine inside the app; pipelines are **data** (JSON), not scripts | The app is the runtime; users compose pipelines in UI, no code stamping |
| Pi coding agent | **droid CLI**, stream-JSON-RPC | Factory-native harness, model substitution via `-m`, BYOK via `custom:` models |
| YAML roster edited by hand | Roster is app state with a full editor UI; exportable/importable as JSON | User-facing settings are the product surface |
| `pydantic` envelope types fixed in code | zod schemas; built-in envelope kinds + user-definable fields per agent (schema editor, guarded) | Custom agents need custom report shapes |
| Runs on current branch, no isolation | **Git worktree per run by default** (engine-managed, merge/discard step at run end) | The gap SSSF documents as "the obvious next thing" — Foundry builds it |
| Trace db inside target repo | Trace db in app support dir, one db per project | The repo shouldn't need gitignore hygiene for the app to work |
| Visualizer = separate Bun server + Vue SPA | Renderer is the visualizer; no server, direct SQLite read in main process | One process tree, no ports |

### 3. Primary personas / use moments

- **The operator**: has a repo, wants "plan → build → test → review" to run the same way the fortieth time as the first, watching lanes fill while doing something else. Foundry's default.
- **The tuner**: opens the Roster and Pipeline editors, swaps the reviewer to a heavier model, adds a `tests_pass` gate, tightens the builder's write-boundary. Every knob is a real setting.
- **The skeptic**: clicks into a finished run and asks "what exactly did you verify?" — gate evidence, per-phase cost table, the exact prompts sent, the raw JSONL. All one click deep.

---

## Part II — Architecture

### 4. Process topology

```
┌──────────────────────────────── Foundry.app (Electron, macOS 26+) ─────────────────────────────┐
│                                                                                                 │
│  MAIN PROCESS (Node 22, TypeScript, esbuild)                                                    │
│  ├─ engine/            the factory: pipeline executor, phase primitive, gates, permissions      │
│  │   ├─ executor.ts        run loop: sequence phases, retries, corrections, finish(accepted)    │
│  │   ├─ phase.ts           the one phase primitive (agent | code | engineer kinds)              │
│  │   ├─ envelopes.ts       zod schemas + parse-or-correct loop                                  │
│  │   ├─ gates.ts           built-in gates + gate runner (evidence, not verdicts)                │
│  │   ├─ boundary.ts        write-boundary enforcement: snapshot → diff → rollback               │
│  │   └─ worktree.ts        per-run git worktree lifecycle, merge/discard                        │
│  ├─ droid/             the harness                                                              │
│  │   ├─ client.ts          long-lived `droid exec` child, JSON-RPC over stdio, per agent        │
│  │   ├─ catalog.ts         model discovery (`droid exec --list-tools`, models doc, custom:)     │
│  │   ├─ oneshot.ts         fallback: `droid exec -o json --session-id` per prompt               │
│  │   └─ events.ts          droid event stream → trace event rows (tool_call folding, usage)     │
│  ├─ trace/                                                                                       │
│  │   ├─ db.ts              better-sqlite3, WAL, one db per project, migrations                  │
│  │   └─ tracer.ts          the only writer of run state; every insert is one small txn          │
│  ├─ store/                                                                                       │
│  │   ├─ settings.ts        app settings (electron-store, JSON, schema-validated)                │
│  │   ├─ roster.ts          agents (JSON in app support, per project override possible)          │
│  │   └─ pipelines.ts       pipeline definitions (JSON), built-ins + user-created                │
│  ├─ system/                                                                                      │
│  │   ├─ procs.ts           child registry, kill children-first, orphan sweep on relaunch        │
│  │   ├─ notify.ts          native notifications, dock badge (running-run count)                 │
│  │   └─ doctor.ts          env checks: droid on PATH, FACTORY_API_KEY, git, versions            │
│  └─ ipc.ts             the entire typed IPC surface (contextBridge, invoke/handle only)         │
│                                                                                                  │
│  RENDERER (Vue 3 + Vite + TypeScript; contextIsolation on, nodeIntegration off, sandbox on)     │
│  ├─ screens: Onboarding · Runs · RunDetail · PipelineDesigner · Roster · Settings               │
│  ├─ polling store: one composable, rowid cursor per run, cadence from settings                  │
│  └─ design system: tokens ported from the SSSF visualizer palette, owned in-app                 │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
        │ spawns per agent                        │ spawns per code phase
        ▼                                         ▼
  droid exec --input-format stream-jsonrpc   plain child_process (bun test, ruff, git …)
        │                    both feed ──────────────►  tracer ──► {project}.db (WAL)
        ▼                                                             ▲
  the project repo (inside a per-run worktree)            renderer polls (rowid cursor)
```

Hard rules:

- **The renderer never touches disk, git, or droid.** Everything crosses `ipc.ts` as typed request/response plus a tiny set of subscription channels (settings-changed, run-registry-changed). Trace data itself is *polled* via `trace.events(runId, afterRowid)` IPC, mirroring the SQLite cursor contract.
- **The tracer is the single writer** of run state. Engine, droid adapter, and code phases all report through it. The renderer's only write is the `archived` triage flag.
- **Success must be earned.** A phase row is born `fail` and flips only on clean exit (+ parsed envelope + green gates for agent phases). `finish(accepted)` settles run status, notification, and exit banner in one call so they cannot disagree.

### 5. The engine

#### 5.1 Pipelines are data

A pipeline is a JSON document, not a script — this is the biggest departure from SSSF and what makes the Pipeline Designer possible:

```jsonc
{
  "id": "plan-build-test",
  "name": "Plan → Build → Test",
  "description": "The standard chain: spec first, implement, prove it.",
  "acceptance": { "kind": "phase_flag", "phase": "test", "flag": "passed" },
  "phases": [
    { "name": "plan",   "kind": "agent", "agent": "planner",
      "description": "Turn the request into a plan the builder needs no questions to implement.",
      "envelope": "plan", "gates": ["artifacts_exist", "files_non_empty"],
      "prompt": { "template": "plan", "inputs": ["request"] } },
    { "name": "build",  "kind": "agent", "agent": "builder", "retries": 2,
      "description": "Implement the plan exactly; report every changed file.",
      "envelope": "build", "gates": ["diff_matches_claims"],
      "prompt": { "template": "build", "inputs": ["request", "envelope:plan"] } },
    { "name": "test",   "kind": "code",
      "description": "Run the project's test command and capture the evidence.",
      "command": { "ref": "project.test" }, "feedback_to": "build", "feedback_retries": 2 },
    { "name": "commit", "kind": "code",
      "description": "Commit the worktree using the builder's proposed message.",
      "command": { "builtin": "git_commit", "message_from": "envelope:build.commit_message" } }
  ]
}
```

Engine semantics, per phase kind:

- **agent** — render the prompt template with its declared inputs (the request, prior envelopes, handoff-file listing), send it through the droid client for that agent's session, await final JSON, parse against the envelope schema. Parse failure → correction message into the *same session* (max `envelopeRetries`, setting, default 3). Then run gates; violations → correction into the same session (max `retries` on the phase). Then boundary check (5.4).
- **code** — resolve the command (project command ref, builtin, or raw argv from the designer), spawn with timeout, capture exit/stdout tail as a `QualityResult`-style record. If `feedback_to` names an earlier agent phase and the command failed, wrap the failure as a synthetic envelope and loop back to that agent (bounded by `feedback_retries`). This is SSSF's build-test repair loop, generalized into data.
- **engineer** — a human-input phase: the run pauses, the app raises a sheet (approve / edit text / reject). This is new versus SSSF (which left human-in-the-loop out) and is cheap because the engine lives in an app with a UI attached.

Built-in pipelines shipped: `prompt` (one agent), `scout`, `plan`, `plan-build`, `plan-build-test`, `plan-build-review`, `full-sdlc` (plan → build → test → review → document, three commits). All are editable copies, not locked.

#### 5.2 Envelopes

zod schemas in `envelopes.ts`; the built-in kinds mirror the concepts (not the code) of SSSF's types: `generic`, `plan` (+`commit_message`), `build` (+`changed_files`, `commit_message`), `scout` (+`findings[]`), `review` (+`approved`, `findings[{requirement,met,evidence}]`, `blocking[]`), `document` (+`document_path`, `documented_files`). All extend a base: `status`, `summary`, `artifacts[]`, `notes_for_next_agent`.

The **synced-triad problem** (type ↔ prompt example ↔ call site) that SSSF handles by discipline, Foundry handles by construction: the JSON example embedded in the agent's user prompt is *generated from the zod schema* at prompt-render time. One source of truth; the triad cannot drift.

Custom agents may extend an envelope with additional fields via a constrained schema editor (field name, type: string/number/boolean/string[], required). Stored as JSON-schema fragments on the agent record, compiled to zod at run time.

#### 5.3 Gates

`gate(envelope, ctx) → GateReport` where a report is a list of `{item, ok, note}` checks and violations are derived from failures — evidence, not verdicts, exactly the SSSF idea. Built-ins: `artifacts_exist`, `files_non_empty`, `json_parses`, `diff_matches_claims`, `verdict_consistent` (review self-consistency), `command_passes(argv)` (the `tests_pass` generalization, configured in the designer). Gate results land in their own table with full check evidence; the UI renders a green gate as *what it verified*, not just a checkmark.

#### 5.4 Write boundaries

Each agent has `writes`: `null` = unrestricted (minus protected paths), `[]` = repo-read-only, or a list of paths/prefixes/globs. Enforced in code after every agent phase: `git status --porcelain` inside the worktree, diff against the phase-start snapshot, classify each change against the boundary, revert unauthorized paths (`git checkout -- / clean`) and fail the phase with the violation list in the trace. Droid's own `--auto` level is the *outer* safety envelope (setting, per Part III); the boundary is the *inner*, per-agent one. Protected always: `.foundry/`, `.git/`, and the app has no stamped scripts to protect — one whole class of SSSF's protected-files problem disappears.

#### 5.5 Worktrees (run isolation)

Default on (setting): each run creates `{repo}/.foundry-worktrees/{runId}` on branch `foundry/{runId}` from the configured base ref. All phases execute there. At `finish()`: **accepted** → offer merge (fast-forward or merge commit, setting: auto / ask / never) and remove the worktree; **not accepted** → keep the worktree and surface "open in editor / discard" in the run header. Kill/crash leaves the worktree in place; the orphan sweep lists abandoned ones for cleanup in Settings → Maintenance. Users can disable isolation per pipeline for docs-only chains.

### 6. The droid harness

#### 6.1 Session client

One `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc --cwd {worktree} --auto {level} -m {model} [-r {effort}]` child **per agent per run**, started lazily on the agent's first phase and kept alive across that agent's phases (correction loops and multi-phase agents reuse the live window — SSSF's "correction costs one message, restart costs everything" preserved by construction).

- `droid.initialize_session` on first use; session id persisted on the run's `agent_sessions` row; `droid.load_session` if the app restarted mid-run and the run is resumed.
- Newline-delimited JSON-RPC: requests with unique ids, responses matched by id, notifications streamed. Timeouts per turn (setting, default 20 min), kill children-first on cancel.
- `droid.ask_user` server-requests are answered by policy: in-boundary permission requests auto-approved up to the configured autonomy, everything else surfaces as an engineer interrupt sheet (with "always allow this command for this project" memory). This is Foundry's permission-policy layer, the thing the raw JSON-RPC surface exists for.
- Per-turn events fold into trace rows: droid tool events → one `tool_call` row per real call named readably (`bash: bun test`), text deltas → live "agent is typing" tail in the phase panel (ring buffer, not stored), usage totals → `agent_end` payload with the input/output/cache breakdown.

#### 6.2 Model substitution

- The roster's per-agent `model` maps to `-m`; `reasoningEffort` to `-r` (off/low/medium/high — droid's levels used directly; no seven-level thinking scale to translate).
- Catalog: seeded from Factory's models doc at build time, refreshed at runtime via `droid exec --list-tools --output-format json` probing plus a static fetch of the models list; **BYOK custom models** read from `~/.factory/settings.json` `customModels` and offered as `custom:{DisplayName}-{index}` picker entries with a "BYOK" badge. Unknown-but-typed model ids are allowed with a warning (the catalog is advisory, droid is authoritative; failure surfaces on first turn, in the trace, attributed to the phase).
- Tool policy per agent: droid tool names (from `--list-tools` for the selected model) shown as checkboxes; selections pass through `--restrict-tools` / `--disabled-tools`. No cross-harness tool-name mapping table needed — droid's names are the only names.

#### 6.3 Fallback mode

If the JSON-RPC child dies or the protocol misbehaves twice in a run, the agent drops to one-shot mode: `droid exec -o json --session-id {id} "{prompt}"` per turn. Loses mid-turn tool visibility (the trace shows a single spanning event per turn); keeps sessions, envelopes, gates, boundaries, cost. The adapter interface (`send(turn) → stream of events + final text`) is identical either way; mode is recorded on the run.

### 7. Trace store

One SQLite db per project at `~/Library/Application Support/Foundry/projects/{projectHash}/trace.db`, WAL, `synchronous=NORMAL`, `busy_timeout=5000`. Schema is Foundry's own, informed by SSSF's seven tables:

```sql
runs            (run_id PK, project_id, pipeline_id, pipeline_snapshot_json, request, status
                 /* running|accepted|rejected|failed|killed */, engineer, worktree_path, branch,
                 base_ref, merged INTEGER, archived INTEGER, started_at, ended_at,
                 total_tokens, total_cost)
phases          (phase_id PK, run_id, seq, name, kind, owner, description,
                 status /* queued|running|success|fail|skipped */, attempt, error, started_at, ended_at)
events          (rowid, event_id, run_id, phase_id, parent_id, type, name, payload_json,
                 tokens, started_at, ended_at)      -- ended_at only on spanning events (tool calls)
envelopes       (envelope_id PK, run_id, phase_id, agent, schema_kind, payload_json, valid, attempt, created_at)
gate_results    (id PK, run_id, phase_id, attempt, gate, passed, checks_json, created_at)
agent_sessions  (run_id, agent, model, reasoning_effort, droid_session_id, mode /* rpc|oneshot */,
                 color, context_tokens, context_window, created_at, last_used_at, PRIMARY KEY(run_id, agent))
processes       (id PK, run_id, kind /* engine|droid|code */, name, pid, command, started_at, ended_at)
migrations      (version PK, applied_at)
```

Event types: `phase_start/end`, `agent_start/end`, `tool_call`, `handoff`, `gate_pass/fail`, `correction` (new: an explicit row every time the engine re-prompts, with the reason — SSSF buries this in gate events), `interrupt` (engineer phases / ask_user), `log`, `error`. Cursor contract for the UI: `SELECT * FROM events WHERE run_id=? AND rowid>? ORDER BY rowid LIMIT 500`.

Files remain the raw record under the project dir: `runs/{runId}/{agent}/prompts/*.md`, `raw.jsonl`, `envelope-{phase}-{attempt}.json`, `handoff/`. The db is the queryable mirror; losing it loses nothing unbuildable.

`processes` powers the kill path (verify recorded command still matches the pid, children first) and the relaunch sweep: on app start, any `processes` row with `ended_at NULL` whose pid is gone finalizes its run to `failed`, so a crashed app never leaves runs reading `running` forever.

---

## Part III — User-facing settings

Every setting lives in one of three scopes, and each pane labels its scope. All are schema-validated on change with inline errors, never on save.

**App scope** (`settings.json`, electron-store):

| Setting | Control | Default |
|---|---|---|
| Droid binary path | path field, live `droid --version` check | auto from PATH |
| Factory auth status | read-only indicator + "open Factory settings" | — |
| Default autonomy (`--auto`) | segmented low / medium / high; high requires typed confirm; risk table shown inline | medium |
| Global default model + effort | catalog picker (provider icons) + segmented | droid default |
| Poll cadence | slider 250–2000 ms | 500 |
| Turn timeout | 5–60 min | 20 |
| Envelope retries / gate retries | steppers 0–5 | 3 / 2 |
| Notifications | per outcome toggles (accepted / rejected / failed / needs-input) | all on |
| Dock badge | toggle | on |
| Appearance | system / always dark | system |
| Data retention | keep runs N days / forever; "compact db now"; orphan-worktree sweeper | forever |

**Project scope** (per added repo, stored app-side with optional export to `{repo}/.foundry/project.json`):

| Setting | Control |
|---|---|
| Base ref | text with existing-ref validation (default `main`) |
| Run isolation | worktree on/off; merge policy auto / ask / never |
| Project commands | named argv list (`test`, `lint`, `typecheck`, `build`) with a **Try it** button that runs and shows exit/tail — these are what `command.ref` resolves; the "placeholder tests are theater" trap from SSSF becomes a first-run checklist item |
| Protected paths | tag editor, `.foundry/` and `.git/` always implied |
| Roster / pipeline overrides | "this project uses its own copy" toggles |

**Roster scope** (the agent editor; ships with five agents — Planner, Builder, Scout, Reviewer, Documenter — each card wearing its generated emblem):

| Per agent | Control |
|---|---|
| Model | searchable catalog picker, provider icon, BYOK badge, context-window shown |
| Reasoning effort | segmented off/low/medium/high |
| Purpose | one line (used in prompts and UI) |
| System / user prompt | in-app markdown editor with template-variable palette (`{{request}}`, `{{envelope:plan.summary}}`, `{{handoff_files}}`) and rendered preview against a sample run |
| Tools | checkbox list from droid's catalog for that model |
| Writes boundary | tag editor with the three-state semantics (unrestricted / read-only / list) made explicit in the control |
| Envelope | base kind picker + custom-field editor |
| Lane color + emblem | color well; emblem picker from bundled art or user PNG |
| Duplicate / delete / export | agents are JSON documents; share by file |

---

## Part IV — Screens

1. **Onboarding** — hero art; Doctor checks (droid found, authed, git, macOS ≥ 26) each with a fix-it action; add first project (folder picker, validates git repo); set project commands with Try-it; offer a smoke run (`scout` pipeline, read-only) and show it live as the user's first trace. Finish inside the real Runs screen, not a "you're done" dead end.
2. **Runs** (home) — project switcher; run list with status chips, phase-dot progress, cost, age; empty-state art; **composer** docked at bottom: request text, pipeline picker (with phase preview), roster summary line ("planner → kimi-k3 · builder → sonnet…"), Run.
3. **Run detail** — header: request, status, outcome art on finish, worktree chip (merge / open / discard), kill button. Body: swim-lane waterfall (engineer / code / one lane per agent, lane color + emblem), phase blocks on a time axis, queued phases dashed. Drawer per phase: description, attempts, tool-call list with args/result snippets, envelope (pretty JSON, valid/invalid + which attempt), gate evidence table, corrections shown as explicit loop-back arrows, cost breakdown (input/output/cache, reasoning nested under output), context-occupancy bar per lane. Live text tail while an agent is mid-turn.
4. **Pipeline Designer** — vertical phase list editor (add agent/code/engineer phase, drag to reorder); per-phase inspector (agent picker, envelope, gates with per-gate config, retries, feedback edges drawn as arrows back to an earlier phase); acceptance-criterion picker; validation rail (missing agents, unreachable feedback edges, description-must-not-echo-name enforced here at edit time, same rule SSSF enforces at construction); "dry-run preview" renders the exact prompts that would be sent, without spending a token.
5. **Roster** — agent card grid (emblem, model with provider icon, purpose), click into the editor from Part III.
6. **Settings** — app + project + maintenance panes as specced.

Design system: dark, deep-space gradient with faint aurora, 16px readability floor, mono reserved for data — the SSSF visualizer's palette (`#06080f` bg, cyan `#5ad2dd`, purple `#c89bff`, amber `#e8b64a`, green `#4ade80`, red `#ff6f67`) adopted as Foundry tokens and owned in `apps/desktop/src/design/tokens.css`. Native macOS: `titleBarStyle: hiddenInset`, vibrancy under-window, native context menus, ⌘N new run, ⌘K command palette (jump to run/project/screen).

---

## Part V — Assets (generated, in repo)

All under `apps/desktop/assets/`, generated with Gemini 3.1 Flash Image; emblems and icon are true-alpha PNGs (difference-matte) so they sit directly on gradient surfaces.

| Path | Use |
|---|---|
| `icon/app-icon-1024.png` | Dock icon master → `.iconset` → `.icns` at build |
| `agents/{planner,builder,scout,reviewer,documenter}.png` | Roster cards, lane headers, composer summary |
| `concepts/envelope.png` | Envelope drawer header + onboarding "how it works" |
| `concepts/gate.png` | Gate-evidence drawer header + designer gate rows |
| `concepts/pipeline.png` | Pipeline Designer empty state / picker |
| `scenes/onboarding-hero.png` | Onboarding, 16:9 2K |
| `scenes/empty-state.png` | Runs list, zero runs |
| `scenes/run-success.png` | Run header on accepted |
| `scenes/run-failed.png` | Run header on rejected/failed |
| `scenes/pipeline-designer.png` | Designer onboarding panel |
| `providers/{claude,gemini,kimi,openai,zai}.png` | Model picker rows, lane model chips (copied out of the reference visualizer, now app-owned) |

Custom agents get a tinted generic emblem fallback; a "generate an emblem" hook is a stretch goal, not v1.

---

## Part VI — Build

### 8. Repo layout (new, app-owned)

```
apps/desktop/
├── package.json  electron-vite  electron-builder.yml  (minimumSystemVersion: "26.0", arm64)
├── assets/                        (Part V, already in place)
├── src/main/                      engine/ droid/ trace/ store/ system/ ipc.ts  main.ts
├── src/preload/                   bridge.ts (contextBridge, the only IPC doorway)
├── src/renderer/                  screens/ components/ stores/ design/
├── src/shared/                    types.ts (IPC contracts, envelope kinds, pipeline schema — one file both sides import)
└── tests/                         engine unit (vitest) · droid adapter against a fake JSON-RPC peer · e2e happy-path (playwright-electron)
```

### 9. Milestones (each ends runnable; acceptance stated)

**M1 — Engine on a wire.** Engine + tracer + schema, code phases only, no UI: a CLI harness (`bun run engine:demo`) executes a two-phase code pipeline in a scratch repo and the db shows correct rows, statuses, WAL polling. *Accept: kill -9 mid-run → relaunch sweep finalizes the run to failed.*

**M2 — Droid adapter.** JSON-RPC client, session lifecycle, event folding, one-shot fallback, catalog. *Accept: `scout` pipeline end-to-end against a real repo with tool calls landing in the db mid-turn; model swap in roster JSON changes `-m` on next run; forced child-kill mid-run flips to fallback and completes.*

**M3 — Envelopes, gates, boundaries, corrections.** Full agent-phase semantics + worktrees. *Accept: `plan-build-test` on a toy repo where the first build intentionally fails tests → feedback loop repairs in-session → accepted run merges its worktree; a boundary-violating write is rolled back and the phase fails with evidence.*

**M4 — Shell + live trace UI.** Electron shell, Runs, Run detail with waterfall/drawers/polling, composer, kill, notifications, dock badge. *Accept: launch, watch, and kill runs entirely from the app; a finished run's gate evidence and cost table match the db.*

**M5 — Editors.** Roster editor (all Part III controls, prompt preview), Pipeline Designer (validation rail, dry-run preview), project commands with Try-it. *Accept: create a custom agent + custom pipeline in-UI and run them without touching a file.*

**M6 — Onboarding, settings, polish, package.** Doctor, onboarding flow, full settings panes, maintenance (retention, orphan sweep), outcome/empty art wired, `.icns`, DMG via electron-builder, e2e suite green. *Accept: fresh Mac profile → DMG → first accepted run without a terminal.*

### 10. Risks, honest edges

- **droid stream-JSON-RPC drift** — lowest-level surface, explicitly evolving. Mitigation: SDK-shaped adapter boundary, one-shot fallback wired from M2 (not bolted on later), protocol fixtures recorded as test doubles.
- **`ask_user` policy is genuinely hard** — auto-approve too much and autonomy settings are theater; too little and unattended runs stall. Mitigation: conservative default (only in-boundary, in-worktree file ops auto-approve at `medium`), every decision traced as an `interrupt` event, per-project allowlist memory.
- **Worktrees meet real repos** — submodules, LFS, hooks, uncommitted base changes. Mitigation: Doctor warns per project; isolation is a setting; merge is never auto when the base moved (rebase offered, not forced).
- **Custom envelope schemas can produce unparseable asks** — constrained field editor (no nesting v1), schema-generated prompt examples, and the correction loop as the backstop.
- **Cost visibility depends on droid usage reporting** — if a model/provider omits usage, show "unreported" honestly rather than zeros (SSSF's own rule, kept).
- **macOS 26-only conveniences** — vibrancy/notification behaviors verified on 26 only; no fallback burden accepted, that's the point of the floor.
- **Electron footprint** — accepted trade for velocity; engine is UI-free TypeScript behind IPC, so a future Tauri/native shell swap strands nothing.
