# AGENTS.md — src/main/engine

Deterministic runner. Code owns sequencing/retries/acceptance; agents work
inside one phase and never decide if they succeeded.

## Invariants

- A phase is born `fail`. Corrections re-prompt the **same live session**
  (one message, not a cold restart); envelope and gate retries have separate
  budgets.
- Envelopes are typed seams (`envelopes.ts`): the JSON example shown to the
  agent, the JSON Schema sent as an output constraint (`jsonSchemaFor`), and
  the parse all come off the same zod instance — don't hand-write examples,
  don't hand-write a JSON Schema, don't parse outside the schema.
  `jsonSchemaFor` emits the **output** view, so every `.default()` field is
  `required`: the model is asked for strictly more than `parseEnvelope`
  demands, so anything conforming to the schema parses. `tests/envelopes.test.ts`
  pins the `required` array per kind — a drift there is a failing test, not a
  surprise at runtime.
- Gates return evidence, not verdicts — one `GateCheck` per item examined
  (`gates.ts`). Unknown gate names fail.
- Write boundaries are enforced after the call by diffing `git status`
  (`boundary.ts`): `null` = unrestricted minus protected, `[]` = read-only,
  list = allowlist (`*` within segment, `**` across). Always-protected
  `.foundry/` `.git/` `.foundry-worktrees/` plus project `protectedPaths`.
  Violations are reverted and the phase fails. This is the ONLY enforcement:
  runs never stop for permission (`droid/permissions.ts` always decides), so a
  mid-turn allow is safe precisely because the diff runs afterwards.
- `InterruptRequest` / the interrupt sheet belongs to **engineer phases only** —
  a checkpoint a pipeline author wrote, not a permission prompt.
- **A kill outranks acceptance.** Once `cancel()` has fired the run settles
  `killed`, both at the top of the loop and after it: the phases that finished
  before the kill landed are never run through `decideAcceptance`, or a
  pipeline whose criterion was already satisfied settles `accepted` after the
  operator ended it. The sessions stand down too (`droid/AGENTS.md`).
- Every run gets a fresh `foundry/run_*` branch + worktree; merge/discard
  stays in `worktree.ts`. `create()` registers `/.foundry-worktrees/` in
  `.git/info/exclude` first, or the run's own directory reports as the
  operator's untracked work. Merge never vetoes on a dirty base — git refuses
  only what would actually be overwritten, and a failed merge is aborted and
  the original branch restored. `git.ts` porcelain parser ignores git's stderr
  chatter.
- New `PhaseKind` or gate: add to `src/shared/types.ts`, wire runner/registry,
  add a test against real git temp repos (see `tests/executor.test.ts`).

## Command detection (`detect.ts`, `detect-session.ts`, `detections.ts`)

Two separate paths, and conflating them is the bug this design exists to
prevent:

- `sniffCommands()` reads manifests. Free, no model, no child process.
- `DetectSession` **always** spawns an agent. Manifest results are passed into
  the prompt as context to confirm or correct — never as a reason to skip the
  agent. A button labelled "Ask AI" that quietly returns a manifest guess is
  indistinguishable from a broken one.

A detection is not a run: no worktree, no phase, no tracer — so nothing reverts
what it writes, and it runs against the operator's **base checkout**. Its
read-only guarantee comes from `DETECT_TOOLS` (`restrictTools`), not from an
autonomy level; keep an editing or shell tool out of that list. It lives in
`detections.ts` rather than `RunRegistry`, and progress is **pushed**
(`detection-progress`) because there are no trace rows and therefore no
`change_id` cursor to poll. The IPC handler returns a `detectionId` immediately
and never awaits the turn.

`parseDetectReply` returns `{commands, rejected, rawReply, parseError}`. Every
rejection carries a reason and the raw reply is always kept: silent filtering
made a correct answer read as "no command found". Names are free-form
(`ProjectCommand.name` is a string); the four pipeline roles just sort first.
Shell metacharacters in argv are still refused — argv is executed without a
shell.
