---
name: foundry-electron-agent
description: Dispatch a coding task to the "foundry-electron" Gemini Antigravity cloud agent — a pre-configured Google-hosted Linux VM with github.com/nikships/foundry cloned, Node 22, npm dependencies and the Electron binary already installed. Use when the user wants work done on the Foundry Electron desktop app (apps/desktop) by a remote agent, wants to delegate/offload/parallelize a Foundry task, or asks to check on, continue, or cancel a dispatched cloud run.
---

# Foundry Electron cloud agent

Delegates work on the **Foundry Electron desktop app** to a managed Antigravity agent
running in Google's cloud sandbox. The agent plans, edits files, runs the build and the
test suite, and reports back. Runs are asynchronous: dispatch, then poll.

## Prerequisites

- `GEMINI_API_KEY` in the environment (a Gemini API key with Interactions API access).
- `curl` and `jq`.
- Optional `GITHUB_TOKEN` — a GitHub PAT with `repo` scope. Without it the sandbox can
  clone and read (the repo is public) but **cannot push**; the agent returns a patch instead.

## The managed agent

|                   |                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent ID          | `foundry-electron`                                                                                                                                    |
| Base agent        | `antigravity-preview-05-2026` (model `gemini-3.7-flash`, thinking enabled)                                                                            |
| Repo              | `/workspace/foundry` — clone of `nikships/foundry`, branch `main`                                                                                     |
| Pre-installed     | Node 22.23.2, `npm ci` completed (772 packages), Electron 43 binary, `g++`/`make`/`python3`                                                           |
| Verified baseline | `npm run typecheck` PASS ~18s · `npm run lint` PASS ~10s · `npm test` 1324 pass / 1 known env failure ~93s                                            |
| Scope             | The Electron app only: `apps/desktop/src/{main,preload,renderer,shared}`, root `electron.vite.config.ts`, `electron-builder.yml`, `scripts/`, `tests` |

Every dispatch starts from a **fresh copy of that warm snapshot**, so runs never collide.
The agent refreshes `main` and re-runs `npm ci` when the lockfile moved, then works.

## Usage

All commands go through `scripts/foundry-agent.sh` (run from anywhere):

```bash
SKILL=.agents/skills/foundry-electron-agent/scripts/foundry-agent.sh

# Dispatch a task — returns an interaction id immediately
"$SKILL" dispatch "Fix the pipeline side panel closing when a phase is inserted. Add a vitest regression test."

# Check on it
"$SKILL" status  <interaction_id>          # status + final output when done
"$SKILL" wait    <interaction_id> [secs]   # block until completed/failed (default 1800s)
"$SKILL" steps   <interaction_id>          # what the agent actually did, step by step
"$SKILL" stream  <interaction_id>         # live SSE progress/events while it runs
"$SKILL" follow  <interaction_id> "Also update the docs"   # continue in the SAME sandbox
"$SKILL" cancel  <interaction_id>
"$SKILL" runs                              # local log of dispatched runs
"$SKILL" info                              # the stored agent definition
```

Run records land in `.foundry-agent-runs/` (interaction id, environment id, task, timestamp).

## Writing a good task

The remote agent has no chat channel — it gets one prompt and runs to completion. Include:

1. **Goal** in one sentence, plus the user-visible symptom or desired behavior.
2. **Where to look** if you know it (`apps/desktop/src/renderer/...`), otherwise say "find it".
3. **Definition of done**: which of `npm run typecheck`, `npm run lint`, `npm test` must pass.
4. **Deliverable**: "leave the branch `agent/<slug>` committed and print `git diff main` at the end"
   is the safest default when no `GITHUB_TOKEN` is present.

Keep tasks bounded — one bug, one feature, one refactor. The token budget (4M
`max_total_tokens`) is stored in `agent-definition.json`; the API rejects per-interaction
`agent_config` overrides for a managed agent, so change it there and run `rewarm.sh`. A run
that returns `status: incomplete` hit the budget — `follow` resumes it with a fresh one.

Expect ~2-5 minutes for a smoke-level task, 10-30 for a real change with a full verify pass.

## Guardrails baked into the agent

- Never runs `npm run test:e2e` or `npm run package` (both need a macOS GUI session).
- Never touches `apps/android` or `apps/website` unless the task says so.
- Reads `/workspace/foundry/AGENTS.md` before editing, and follows the repo invariants.
- Reports commands run with pass/fail rather than claiming success.
- Knows the one pre-existing failure — `apps/desktop/tests/main/companion/companion.test.ts`
  → "produces a single-use pairing payload that cannot be replayed" (a headless Linux box has
  no desktop hostname) — and will not claim credit for it or try to "fix" it.
- Knows the two sandbox build workarounds (`--nodedir` for `better-sqlite3`'s node-gyp
  `fchown EPERM`, proxy-aware download for the Electron binary) instead of rediscovering them.

## Reporting back to the user

Give them: what the agent changed, the verification results it reported, and the branch or
patch. Do not paste the whole step log — summarize, and offer `steps` if they want detail.

## Maintenance

The warm snapshot ages (dependencies drift from `package-lock.json`). If dispatches start
spending minutes on `npm ci`, re-warm and re-point the agent:

```bash
.agents/skills/foundry-electron-agent/scripts/rewarm.sh
```

API reference for the underlying Interactions API: `reference/api.md`.
