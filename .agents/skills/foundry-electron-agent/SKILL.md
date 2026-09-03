---
name: foundry-electron-agent
description: Dispatch a coding task to the "foundry-electron" Gemini Antigravity cloud agent — a pre-configured Google-hosted Linux VM with github.com/nikships/foundry cloned, Node 22, npm dependencies and the Electron binary already installed. Use when the user wants work done on the Foundry Electron desktop app (apps/desktop) by a remote agent, wants to delegate/offload/parallelize a Foundry task, or asks to check on, continue, or cancel a dispatched cloud run.
---

# Foundry Electron cloud agent

Delegates work on the Foundry Electron desktop app to a managed Antigravity agent in Google's
cloud sandbox. It plans, edits, runs the tests, and reports back. Dispatch, then poll.

Needs `GEMINI_API_KEY`, `curl` and `jq`. `GITHUB_TOKEN` (PAT, `repo` scope) is optional and is
what lets the sandbox push; without it the agent returns a patch instead.

## The managed agent

|                   |                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| Agent ID          | `foundry-electron`                                                                                           |
| Base agent        | `antigravity-preview-05-2026` on `gemini-3.8-flash`                                                          |
| Repo              | `/workspace/foundry` — clone of `nikships/foundry`, branch `main`                                            |
| Pre-installed     | Node 22.23.2, `npm ci` completed, Electron 43 binary, `g++`/`make`/`python3`                                 |
| Verified baseline | `npm run typecheck` PASS · `npm run lint` PASS · `npm test` 1324 pass / 1 known env failure                  |
| Scope             | Electron app only: `apps/desktop/src/{main,preload,renderer,shared}`, root configs, `scripts/`, `tests`      |

Every dispatch starts from a fresh copy of that warm snapshot, so runs never collide.

## Usage

```bash
SKILL=.agents/skills/foundry-electron-agent/scripts/foundry-agent.sh

"$SKILL" dispatch "Fix the pipeline side panel closing when a phase is inserted. Add a vitest regression test."

"$SKILL" status  <interaction_id>          # status + final output when done
"$SKILL" wait    <interaction_id> [secs]   # block until finished (default 1800s)
"$SKILL" steps   <interaction_id>          # step-by-step trace
"$SKILL" stream  <interaction_id>          # live SSE progress
"$SKILL" follow  <interaction_id> "Also update the docs"   # continue in the SAME sandbox
"$SKILL" cancel  <interaction_id>
"$SKILL" runs                              # local log of dispatched runs
"$SKILL" info                              # the stored agent definition
```

Run records land in `.foundry-agent-runs/`.

## Writing a good task

One prompt, no chat channel. Give the goal and symptom in a sentence, where to look if you
know, which of typecheck/lint/test must pass, and the deliverable (branch `agent/<slug>` plus
`git diff main` is the safe default without a `GITHUB_TOKEN`). Keep it to one bug, one feature,
or one refactor.

`status: incomplete` means the run hit the 4M token budget; `follow` resumes it with a fresh one.

## Guardrails baked into the agent

- Never runs `npm run test:e2e` or `npm run package` (both need a macOS GUI session).
- Never touches `apps/android` or `apps/website` unless the task says so.
- Reads `AGENTS.md` before editing and reports pass/fail instead of claiming success.
- Knows the one pre-existing failure (`companion.test.ts` → "produces a single-use pairing
  payload that cannot be replayed"; a headless Linux box has no desktop hostname) and the two
  sandbox build workarounds, so it will not rediscover or "fix" them.

## Maintenance

`scripts/rewarm.sh` rebuilds the snapshot and recreates the agent from `agent-definition.json`.
Run it when dispatches start spending minutes on `npm ci`, or after changing that definition —
model and token budget cannot be overridden per interaction.

Interactions API reference: `reference/api.md`.
