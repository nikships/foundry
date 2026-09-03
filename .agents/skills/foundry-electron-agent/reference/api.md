# Gemini Interactions API — the bits this skill relies on

Base URL `https://generativelanguage.googleapis.com/v1beta`, auth header
`x-goog-api-key: $GEMINI_API_KEY`. Preview status (May 2026 agent).

## Dispatch

`POST /interactions`

```json
{
  "agent": "foundry-electron",
  "input": "…the task…",
  "environment": "remote",
  "background": true
}
```

- `background: true` returns immediately with `{id, status: "in_progress", environment_id}`.
- `environment: "remote"` provisions a fresh sandbox from the agent's stored
  `base_environment` — the warm snapshot, `node_modules` included. Passing an existing
  `environment_id` reuses that live sandbox instead.
- `agent_config` cannot be overridden per interaction for a named agent: the API answers
  `AntigravityConfig cannot be overriden for custom agents.` Only `system_instruction`,
  `tools` and `environment.network` can. It takes exactly `type`, `model` and
  `max_total_tokens` — there is no thinking or reasoning-level field.
- `agent_config.model` accepts `gemini-3.8-flash` (default), `gemini-3.7-flash`,
  `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`. An unknown string is
  accepted by `POST /agents` and only fails at dispatch with `Requested entity was not found.`
- Returns 400: `temperature`, `top_p`, `top_k`, `stop_sequences`, `max_output_tokens`.

## Poll

`GET /interactions/{id}` → `status` is `in_progress`, `completed`, `incomplete`, `failed` or
`requires_action`. While in progress the response is minimal; when finished it carries
`output_text`, `steps[]` and `usage`. `incomplete` means the run hit `max_total_tokens`;
continue with `previous_interaction_id` and the same environment for a fresh budget.

Live progress:

```bash
curl -N "https://generativelanguage.googleapis.com/v1beta/interactions/$ID?stream=true" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Api-Revision: 2026-05-20"
```

Emits `step.start`, `step.delta`, `step.stop`. Reconnect with `last_event_id=<event_id>`.
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

Files, installed packages and git state persist there.

## Credentials

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

The allowlist is deny-by-default, so keep the `*` catch-all. Overriding `network` at
invocation time replaces the stored rules but keeps the agent's `sources` — that is how you
rotate an expired token.

## Managing the agent

`GET /agents`, `GET /agents/{id}`, `DELETE /agents/{id}`, and `POST /agents` with
`{id, base_agent, agent_config, system_instruction, base_environment}`. Passing an
`environment_id` as `base_environment` forks that live sandbox into the definition, which is
how the warm snapshot is captured. There is no update endpoint — changing the definition
means delete and recreate, which is what `rewarm.sh` does.

## Sandbox facts

Ubuntu, Python 3.12, Node.js 22, git/curl/ripgrep/jq preinstalled. A repo clone source is
capped at 500 MB. Context auto-compacts around 135k tokens, so long runs keep the thread.

Docs: <https://ai.google.dev/gemini-api/docs/antigravity-agent>,
<https://ai.google.dev/gemini-api/docs/agent-environment>,
<https://ai.google.dev/gemini-api/docs/custom-agents>
