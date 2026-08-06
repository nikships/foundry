# Fun facts

Odd, load-bearing, or easy-to-miss details about Foundry and the SSSF skill. For system shape see [Architecture](overview/architecture.md); for tables see [By the numbers](by-the-numbers.md); for timeline see [Lore](lore.md).

## 1. The droid protocol looks like bugs, and is not

`src/main/droid/protocol.ts` encodes behaviour observed against the real CLI, not the docs. Three details will break a naive JSON-RPC client every time:

1. Frames need a `type` discriminator **plus** `factoryApiVersion` / `factoryProtocolVersion`. A plain JSON-RPC frame is rejected with `-32700`.
2. Request `id` **must be a string**. A number is rejected the same way, so "JSON-RPC allows numeric ids" is the wrong assumption here.
3. Session settings (`modelId`, reasoning effort, autonomy) are **flat params** on `droid.update_session_settings`. Nest them under `settings` and they are **silently ignored** (no error, no model switch, just quiet wrongness).

Also: `add_user_message` takes `params.text` (not `message`) and returns immediately; the turn ends on an `agent_turn_completed` notification. `tool_call` is re-emitted per `toolUseId` as arguments stream, so the client must fold multiple frames into one span.

`tests/fake-droid.ts` reproduces these quirks on purpose. "Simplifying" the client toward textbook JSON-RPC is how you get a green unit suite and a dead real session.

## 2. A phase is born `fail`

Every phase row starts life as a failure. It flips to success only on a clean exit, and for agent phases only after a parsed envelope and green gates. The same doctrine lives in SSSF and Foundry (`tracer.ts` and `executor.ts` both spell it out).

That sounds pessimistic until you watch a crash mid-phase: the default already matches reality, and partial success never paints a green lane by accident. Run acceptance is a second question, settled only in `finish()`, because a test phase that correctly reported a red suite did its job and still must not mark the run accepted.

## 3. There is no tester agent

Five builtin agents: planner, builder, scout, reviewer, documenter. Running the suite is a **code phase** (`command: { ref: 'test' }` or equivalent), not a sixth personality with a system prompt.

The lore goes back to SSSF hard rule 8: if you can write the invocation down, it belongs in code. Agents rediscovering your test runner burn context to learn what a subprocess already knows, and they charge for it every run. Failures still feed back to the builder as envelopes; the repair loop is the same without renting a model to run arithmetic.

## 4. The synced triad was fixed by construction

SSSF warned operators that type, `## Report` example, and `output_type=` must stay aligned by hand, and that drift burns correction rounds. Foundry's `envelopes.ts` opens with the same problem statement and then removes the footgun:

> The synced-triad problem (type ↔ prompt example ↔ call site) is solved by construction here: `exampleFor` derives the JSON example the agent is shown from the same zod schema the answer is parsed against.

Builtin agent prompts intentionally **do not** embed the report example. The schema generates it at render time and appends it, so the shape shown and the shape parsed cannot diverge without a deliberate schema change. Custom agent fields compile into schema and example on the same path.

## 5. The longest files are the spine, not the chrome

On 2026-08-06 the tallest TypeScript files were:

| File | ~Lines |
|---|---|
| `executor.ts` | 841 |
| `tracer.ts` | 825 |
| `client.ts` | 465 |
| `ipc.ts` | 427 |

The run loop, the only SQLite writer, the droid session, and the full IPC surface: that is the factory. The renderer is larger in aggregate (~3.7k LOC) but spread across many screens and components. If you are hunting for "where does Foundry actually decide things?", start with those four files, not the waterfall chrome.

## 6. The first SSSF commit message was a rocket

Public history on the ancestor line records the **2026-08-02** skill landing with commit subject **🚀** (nothing else). Foundry's **2026-08-06** commit is the opposite register: a multi-paragraph message that restates the doctrines (code owns the loop, phase born fail, live-session corrections) before listing engine, droid, trace, and renderer.

One era opened with an emoji. The next era's house style, written into `AGENTS.md`, forbids emoji in source and UI copy. Both artefacts still share the same control-plane ideas.

## Bonus trivia

- **No TODOs** in `apps/desktop/src` on the snapshot date. The unfinished work is product scope (see `PLAN.md`), not scattered `// TODO` markers.
- **Preload is CJS** (`bridge.cjs`) because sandboxed Electron preloads cannot be ESM, even though the rest of the app is `"type": "module"`.
- **`main` in package.json** points at `out/main/main.js`, not `index.js`: electron-vite names the bundle after the entry file.
- **Bot-attributed history** in this snapshot is effectively zero; the line is human-scale commits, not a dependency-bot timeline.
