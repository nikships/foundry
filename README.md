<div align="center">

# Foundry

**Your SDLC. Your models. Your rules.**

[![Version](https://img.shields.io/github/v/release/nikships/foundry?style=for-the-badge)](https://github.com/nikships/foundry/releases)
[![Stars](https://img.shields.io/github/stars/nikships/foundry?style=for-the-badge)](https://github.com/nikships/foundry/stargazers)
[![License: MIT](https://img.shields.io/github/license/nikships/foundry?style=for-the-badge)](https://github.com/nikships/foundry/blob/main/LICENSE)

<img src="assets/icon/app-icon-1024.png" alt="Foundry app icon" width="140">

**The software factory you configure, not the one you're handed.**

Shape the delivery lifecycle to the way your team actually ships,<br>and run every phase of it on whichever model you want — from any provider, all at once.

[Download latest for Mac or Android](https://github.com/nikships/foundry/releases/latest) · macOS 26+ · Apple Silicon

</div>



https://github.com/user-attachments/assets/2a12273a-280f-4703-8690-c8c018e3d8d3



---

## Two lock-ins are slowing you down

**Someone else's process.** Every agent tool ships one opinion about how software gets built — one loop, one definition of done, one place a human is allowed to interject. If your team specs before it builds, or gates on a security pass, or needs a sign-off before a PR opens, you bend your process to the tool.

**Someone else's model.** Pick a vendor, get their strengths and their outages. When their reasoning model degrades on a Tuesday, your whole pipeline degrades with it. One family is better at open-ended planning, another at grinding out precise code, a third at catching what both missed — and you get to use exactly one.

**Foundry removes both.** You define the lifecycle as data — phases, checks, boundaries, human checkpoints — and you assign a model per agent and per phase, mixed freely across providers, with automatic failover to the next reachable model when one dies mid-run.

<p align="center">
  <img src="assets/readme/onboarding-hero.png" alt="Foundry onboarding — the factory" width="820">
</p>

## What this actually is

Foundry is a native macOS app. Not a CLI wrapper. Not a chat skin.

You point it at any git repo. Every run gets its own branch and worktree. Every phase leaves typed evidence — what was tried, what was checked, why it passed or failed. Code judges the work, not the model.

**Agent proposes. Code disposes.** That's why the same request gives you the same _kind_ of result twice, no matter which model answered.

<p align="center">
  <img src="assets/readme/concepts.png" alt="Three primitives: run as data, typed reports, checks that leave evidence" width="820">
</p>

## Structure the SDLC to your liking

A pipeline is a recipe — data, not a mega-prompt and not a script. You compose it on a freeform canvas out of three kinds of phase:

| Phase kind   | What it is                                                                     |
| ------------ | ------------------------------------------------------------------------------ |
| **agent**    | A specialist takes a turn and must return a typed envelope                     |
| **code**     | A real command in the worktree — your tests, your linter, your build, a commit |
| **engineer** | A checkpoint that stops and asks _you_ a question before the line moves on     |

Then you decide, per phase:

- **What proves it.** Attach gates: `artifacts_exist`, `files_non_empty`, `json_parses`, `verdict_consistent`, `disapproval_halts`, `command_passes` (your argv, must exit 0). A gate returns evidence, not an opinion.
- **What it may touch.** A write boundary per agent: unrestricted, read-only, or an allowlist of paths and globs. Enforced after every call by diffing git, so a violation is reverted and the phase fails.
- **What it must return.** Built-in envelopes (brief, plan, build, scout, review, document, pr, issue) or your own named envelope with typed fields, validated on the way out.
- **Where failure goes.** `feedbackTo` hands the evidence back to an earlier agent phase with its own retry budget, instead of failing the run.
- **What "done" means.** Acceptance is explicit: last phase passes, every phase passes, a named phase sets a flag, or a named phase's envelope reports success.

Six built-ins ship as starting points, not as the menu — fork any of them, reorder phases by dragging, insert your own checkpoint, save it, run it tomorrow:

| Pipeline                         | When to use it                                               |
| -------------------------------- | ------------------------------------------------------------ |
| **Plan → Build → Test → PR**     | The standard: spec, build, prove with your tests, open PR.   |
| **Diagnose → Fix → PR**          | Bug work: find the fault with evidence, fix exactly that.    |
| **Spec → PR**                    | No code changes — survey the repo, PR an implementable spec. |
| **Diagnose → Issue → Spec → PR** | Triage: file the GitHub issue, then PR the spec for the fix. |
| **Refine → Build → Ship → PR**   | Sharpens the ask, builds, holds to ship bar, re-proves it.   |
| **Full SDLC → PR**               | Refine, plan, build, test, polish, review, docs, PR.         |

Nothing is committed unproven: every code edit runs your tests before the commit that records it, and a reviewer who doesn't approve halts the run before it can reach the PR.

No scripts to write. No YAML to learn. Dry-run a pipeline to see the rendered prompts without spending a run.

<p align="center">
  <img src="assets/readme/pipeline-canvas.png" alt="Pipeline canvas — drag phases, set boundaries, save instantly" width="820">
</p>

## Never bet a run on one model

Foundry keeps no model allowlist of its own. A model id is an opaque `provider/model` string, so anything your install can actually reach is selectable anywhere a model is chosen.

**Mix providers inside a single run.** Model and reasoning effort are set per agent, and any phase can override the agent's choice. Plan on one family, build on another, review with a third — because a reviewer that shares the builder's blind spots isn't a review.

**Cast each role for what that model is actually good at.** A run might look like this:

| Phase             | Cast                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ |
| **refine → plan** | **Claude Opus 5** — creative reach, turns a vague ask into an approach worth building      |
| **build**         | **GPT-5.6 Sol** — mechanical precision and thoroughness, executes the plan as written      |
| **review**        | **Gemini 3.1 Pro** — broad world knowledge, a second opinion from outside the build's head |

Then swap any seat. Put **Kimi K3** on a frontend build, **GLM-5.2** or **DeepSeek V4** on the review, **Qwen3-Coder-Next** on the docs — Chinese open-weight models are first-class here, whether you reach them through a hosted API or run the weights yourself. Nobody's roster is hardcoded, including this one.

**Bring whatever you already pay for.**

- **Subscriptions** — sign in to Claude, ChatGPT (Codex), Gemini, Kimi, or Grok through the built-in Bridge, which turns the subscription you already have into a local endpoint. No per-token cost. Let the big labs keep subsidizing your inference while you keep the freedom to walk: your process lives here, not in their walled garden, and the day one of them raises the price or nerfs a model, you change a dropdown instead of rebuilding your workflow.
- **Direct API keys** — Anthropic, OpenAI, Google, Vertex, Bedrock, Azure, OpenRouter, Groq, Cerebras, Fireworks, Together, DeepSeek, Mistral, MiniMax, Moonshot, NVIDIA, xAI, Z.ai, Baseten, Hugging Face, Cloudflare and more. Keys are held in the runtime's credential store on your Mac.
- **Local and self-hosted** — a hand-added OpenAI-compatible endpoint in the runtime's model file survives every regeneration, so your own inference stays in the picker. An open coder that fits in unified memory can hold a seat next to a frontier model in the same run.

**Failover is automatic and mid-turn.** When a model exhausts its retries, the run continues on the next reachable model in catalog order, keeping the conversation and tool results intact and giving the fallback its own retry budget. A provider going down degrades a run's speed, not its outcome.

**The picker is honest.** A provider with no usable credential isn't listed, so a model you can select is a model a run can start on. Hide the ones you never want. Reasoning effort offers only the levels that model genuinely supports.

## A crew, not a chatbot

Seven specialists, each with their own model, prompt, tool surface, and write boundaries. Or bring your own.

| Agent          | What they do                                          |
| -------------- | ----------------------------------------------------- |
| **refiner**    | Turns a half-formed ask into a grounded brief         |
| **planner**    | Writes the plan the builder needs — no questions left |
| **builder**    | Builds exactly what the plan says                     |
| **scout**      | Maps the repo and answers with paths and symbols      |
| **reviewer**   | Checks the diff against your original request         |
| **finisher**   | Audits to ship bar and closes the gaps                |
| **documenter** | Leaves the trail for the next person                  |

You're not locked in — open the Roster, retune the prompt, change the model, drop an agent to a read-only tool surface, tighten what it can touch.

<p align="center">
  <img src="assets/readme/roster.png" alt="Roster — seven agents, each tunable" width="820">
</p>

## Watch every move

No black box. The Inspector is a live waterfall — tool calls streaming mid-phase, reports and check evidence inspectable per phase, tokens and timing filling in as you go, and the model that actually answered recorded alongside the one you picked. Same view for live runs and history.

Pause at any checkpoint. Approve, edit, or reject — the factory keeps going.

<p align="center">
  <img width="1552" height="1052" alt="image" src="https://github.com/user-attachments/assets/c2b40fad-626a-4857-8c00-14171e0d570b" />
</p>

## Safe by default

- **Your checkout stays clean.** Every run is an isolated worktree on its own branch. Nothing lands on `main` until you merge it.
- **Agents stay in their lane.** Write boundaries are enforced by git diff after every call. Violations get reverted and the phase fails.
- **Checks verify the work.** Claimed files exist? Not empty? Diff matches the claim? Verdict matches the findings? Green means it was actually checked.

Failed runs keep their worktree so you can open it, learn, and discard deliberately.

## Get started in 60 seconds

**Requirements:** macOS 26+, Apple Silicon, `git`, and at least one model reachable — a subscription signed in or an API key stored under Settings → Providers.

1. [Download `Foundry.dmg`](https://github.com/nikships/foundry/releases/latest) and drag to Applications
2. Open Foundry, connect a provider, add any git repo as a project
3. Describe the work — _"Add rate limiting to the public API"_ is a complete brief
4. Pick a pipeline (or fork one into your own shape) and hit run
5. Watch the waterfall, inspect any phase, merge when you're happy

No `npm ci`. No setup script. Just download and build.

## Philosophy

**Agent proposes, code disposes.** Agents do the creative work. Code decides if it counted. Sequencing, retries, and acceptance live in the factory — never in a prompt, and never in a single vendor's hands.

That's why Foundry doesn't feel like chatting. It feels like running a shop you own.

---

<div align="center">

MIT · Built for builders who ship

[![Star History Chart](https://api.star-history.com/svg?repos=nikships/foundry&type=Date)](https://star-history.com/#nikships/foundry&Date)

</div>
