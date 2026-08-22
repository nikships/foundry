# Gemini Interactions API — the bits this skill relies on

Base URL `https://generativelanguage.googleapis.com/v1beta`, auth header
`x-goog-api-key: $GEMINI_API_KEY`. Everything below is preview-status (May 2026 agent).

## Dispatch

`POST /interactions`

```json
{
  "agent": "foundry-electron",
  "input": "…the task…",
  "environment": "remote",
  "background": true,
  "agent_config": { "type": "antigravity", "max_total_tokens": 1500000 }
}
```

- `background: true` returns immediately with `{id, status: "in_progress", environment_id}`.
  Requires `store: true`, which is the default.
- For a **managed agent** (`foundry-electron`), `environment: "remote"` provisions a fresh
  sandbox from the agent's stored `base_environment` — the warm snapshot, including
  `node_modules`. Passing an existing `environment_id` instead reuses that live sandbox.
- `agent_config.model` cannot be overridden per-interaction for a named agent; only
  `system_instruction`, `tools` and `environment.network` can.
- Unsupported and returns 400: `temperature`, `top_p`, `top_k`, `stop_sequences`,
  `max_output_tokens`. No structured output.

## Poll

`GET /interactions/{id}` → `status` is one of `in_progress`, `completed`, `incomplete`,
`failed`, `requires_action`. While in progress the response is minimal (no `steps`).
When finished you get `output_text`, `steps[]` and `usage`.

- `incomplete` = hit `max_total_tokens`. Continue with a new interaction that passes
  `previous_interaction_id` and the same `environment` — the new run gets a fresh budget.
- `requires_action` = a custom `function` tool wants a result. This skill defines no custom
  functions, so it should not happen.

For live progress while a background interaction is running, use the SSE stream:

```bash
curl -N "https://generativelanguage.googleapis.com/v1beta/interactions/$ID?stream=true" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Api-Revision: 2026-05-20"
```

The stream emits `step.start`, `step.delta`, and `step.stop` events, including code
execution calls and results. Reconnect with `last_event_id=<event_id>` after a dropped
connection. The skill exposes this as `foundry-agent.sh stream <id> [last_event_id]`.

`POST /interactions/{id}:cancel` stops a background run.

## Continue in the same sandbox

```json
{
  "agent": "foundry-electron",
  "input": "…follow-up…",
  "previous_interaction_id": "<id>",
  "environment": "<environment_id from that interaction>",
  "background": true
}
```

Files, installed packages and git state persist in that environment.

## Credentials (never exposed inside the sandbox)

Network `transform` headers are injected by an egress proxy, so tokens never land in the
sandbox filesystem or env:

```json
"environment": {
  "type": "remote",
  "network": { "allowlist": [
    { "domain": "github.com",     "transform": { "Authorization": "Basic <base64 of x-oauth-basic:PAT>" } },
    { "domain": "api.github.com", "transform": { "Authorization": "Bearer <PAT>" } },
    { "domain": "*" }
  ]}
}
```

An allowlist is deny-by-default — include `{"domain": "*"}` as a catch-all, and note that
`*.example.com` does not match the bare root domain. `"network": "disabled"` blocks all
egress. Overriding `network` at invocation time replaces the stored rules but keeps the
agent's `sources`; this is the supported way to rotate an expired token.

## Managing the agent

- `GET /agents`, `GET /agents/{id}`, `DELETE /agents/{id}`.
- `POST /agents` with `{id, base_agent, agent_config, system_instruction, base_environment}`.
  `base_environment` may be `"remote"`, a config object with `sources`/`network`, or an
  `environment_id` — passing an id **forks** that live sandbox into the agent definition,
  which is how the warm snapshot is captured.
- There is no versioning or update endpoint: to change the definition, delete and recreate
  (`rewarm.sh` does exactly that from `agent-definition.json`).
- Agent ids cannot start with reserved prefixes (`gemini-`, `google-`, `android-`, …).

## Sandbox facts

Ubuntu, Python 3.12, Node.js 22, git/curl/ripgrep/jq/gcloud preinstalled. Sources: a git
repo clone is capped at 500 MB, GCS copies at 2 GB, inline files at 1 MB each / 2 MB total.
Context auto-compacts around 135k tokens, so long runs do not lose the thread.

## Cost

Billed on model tokens, not sandbox compute (free during preview). A typical bounded coding
task lands well under a dollar; heavy multi-hour runs can reach a few dollars. `max_total_tokens`
is the seatbelt.

Docs: <https://ai.google.dev/gemini-api/docs/antigravity-agent>,
<https://ai.google.dev/gemini-api/docs/agent-environment>,
<https://ai.google.dev/gemini-api/docs/custom-agents>
