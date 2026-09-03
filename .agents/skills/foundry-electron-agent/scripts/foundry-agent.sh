#!/usr/bin/env bash
# Dispatch and manage tasks on the "foundry-electron" Antigravity cloud agent.
set -euo pipefail

API="https://generativelanguage.googleapis.com/v1beta"
AGENT_ID="${FOUNDRY_AGENT_ID:-foundry-electron}"
RUN_DIR="${FOUNDRY_AGENT_RUN_DIR:-.foundry-agent-runs}"
# NOTE: agent_config (model, max_total_tokens) cannot be overridden per-interaction for a
# managed agent — the API answers "AntigravityConfig cannot be overriden for custom agents."
# Both live in agent-definition.json and are applied by rewarm.sh when the agent is recreated.

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

[[ -n "${GEMINI_API_KEY:-}" ]] || die "GEMINI_API_KEY is not set"
command -v jq >/dev/null || die "jq is required"

api() { # api <method> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "$API$path" \
      -H "Content-Type: application/json" \
      -H "x-goog-api-key: $GEMINI_API_KEY" \
      -d "$body"
  else
    curl -sS -X "$method" "$API$path" -H "x-goog-api-key: $GEMINI_API_KEY"
  fi
}

# Network overrides: inject a GitHub PAT so the sandbox can push branches / use the API.
network_json() {
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    local basic
    basic="$(printf 'x-oauth-basic:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
    jq -n --arg basic "$basic" --arg tok "$GITHUB_TOKEN" '{
      allowlist: [
        { domain: "github.com",     transform: { "Authorization": ("Basic " + $basic) } },
        { domain: "api.github.com", transform: { "Authorization": ("Bearer " + $tok) } },
        { domain: "*" }
      ]
    }'
  else
    echo "null"
  fi
}

environment_json() { # environment_json [environment_id]
  local env_id="${1:-}" net
  net="$(network_json)"
  if [[ -z "$env_id" && "$net" == "null" ]]; then
    echo '"remote"'
  elif [[ -z "$env_id" ]]; then
    jq -n --argjson net "$net" '{ type: "remote", network: $net }'
  elif [[ "$net" == "null" ]]; then
    jq -n --arg id "$env_id" '$id'
  else
    jq -n --arg id "$env_id" --argjson net "$net" '{ type: "remote", environment_id: $id, network: $net }'
  fi
}

record_run() { # record_run <json-response> <task>
  mkdir -p "$RUN_DIR"
  local id; id="$(jq -r '.id' <<<"$1")"
  jq -n --arg id "$id" \
        --arg env "$(jq -r '.environment_id // ""' <<<"$1")" \
        --arg task "$2" \
        --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{id: $id, environment_id: $env, task: $task, dispatched_at: $at}' \
        > "$RUN_DIR/${id//\//_}.json"
}

print_result() { # print_result <interaction-json>
  local st; st="$(jq -r '.status' <<<"$1")"
  printf 'status: %s\n' "$st"
  jq -r '.usage // empty | "tokens: \(.total_tokens // "?")"' <<<"$1"
  # Finished interactions usually carry the report in the trailing model_output step;
  # output_text is often empty, so fall back to the steps.
  local out
  out="$(jq -r '
    if (.output_text // "") != "" then .output_text
    else [ (.steps // [])[] | select(.type == "model_output" or .type == "message")
           | ((.content // []) | map(.text // "") | join("\n")) ] | join("\n\n")
    end' <<<"$1")"
  [[ -n "$out" ]] && { printf '\n--- agent output ---\n%s\n' "$out"; }
  [[ "$st" == "incomplete" ]] && printf '\nHit the token budget. Resume with: %s follow %s "continue"\n' "$0" "$(jq -r .id <<<"$1")"
  return 0
}

cmd_dispatch() {
  local task="${1:-}"
  [[ -n "$task" ]] || die 'usage: dispatch "<task description>"'
  local payload
  payload="$(jq -n \
    --arg agent "$AGENT_ID" \
    --arg input "$task" \
    --argjson env "$(environment_json)" \
    '{agent: $agent, input: $input, environment: $env, background: true}')"
  local resp; resp="$(api POST "/interactions" "$payload")"
  jq -e '.id' >/dev/null <<<"$resp" || { echo "$resp" >&2; die "dispatch failed"; }
  record_run "$resp" "$task"
  jq -r '"dispatched\ninteraction: \(.id)\nenvironment: \(.environment_id // "pending")\nstatus: \(.status)"' <<<"$resp"
  printf 'poll with: %s wait %s\n' "$0" "$(jq -r .id <<<"$resp")"
}

cmd_status() {
  local id="${1:?usage: status <interaction_id>}"
  print_result "$(api GET "/interactions/$id")"
}

cmd_wait() {
  local id="${1:?usage: wait <interaction_id> [timeout_seconds]}"
  local timeout="${2:-1800}" waited=0 resp st
  while :; do
    resp="$(api GET "/interactions/$id")"
    st="$(jq -r '.status' <<<"$resp")"
    [[ "$st" != "in_progress" && "$st" != "queued" ]] && break
    (( waited >= timeout )) && { printf 'still %s after %ss\n' "$st" "$waited"; return 0; }
    sleep 15; waited=$((waited + 15))
    printf '  ... %s (%ss)\n' "$st" "$waited" >&2
  done
  print_result "$resp"
}

cmd_steps() {
  local id="${1:?usage: steps <interaction_id>}"
  api GET "/interactions/$id" | jq -r '
    (.steps // [])[] |
    if .type == "code_execution_call" then "$ \((.arguments.code // "") | tostring | .[0:300])"
    elif .type == "code_execution_result" then "  → \((.result // "") | tostring | .[0:300])"
    elif .type == "function_call" then "⚙ \(.name): \((.arguments.path // .arguments.toolSummary // .arguments) | tostring | .[0:200])"
    elif .type == "function_result" then "  → \((.result // "") | tostring | .[0:200])"
    elif .type == "thought" then "· \(((.summary // []) | map(.text // "") | join(" ")) | .[0:200])"
    elif .type == "model_output" or .type == "message" then "\n=== report ===\n\((.content // []) | map(.text // "") | join("\n"))"
    else "\(.type)" end'
}

cmd_stream() {
  local id="${1:?usage: stream <interaction_id> [last_event_id]}"
  local last="${2:-}" url="$API/interactions/$id?stream=true"
  [[ -n "$last" ]] && url="${url}&last_event_id=${last}"
  curl -NsS "$url" \
    -H "x-goog-api-key: $GEMINI_API_KEY" \
    -H "Api-Revision: 2026-05-20"
}

cmd_follow() {
  local id="${1:?usage: follow <interaction_id> \"<task>\"}"
  local task="${2:?usage: follow <interaction_id> \"<task>\"}"
  local env_id; env_id="$(api GET "/interactions/$id" | jq -r '.environment_id')"
  [[ -n "$env_id" && "$env_id" != "null" ]] || die "no environment_id on $id"
  local payload
  payload="$(jq -n \
    --arg agent "$AGENT_ID" --arg input "$task" --arg prev "$id" \
    --argjson env "$(environment_json "$env_id")" \
    '{agent: $agent, input: $input, previous_interaction_id: $prev, environment: $env,
      background: true}')"
  local resp; resp="$(api POST "/interactions" "$payload")"
  jq -e '.id' >/dev/null <<<"$resp" || { echo "$resp" >&2; die "follow-up failed"; }
  record_run "$resp" "[follow-up on $id] $task"
  jq -r '"follow-up dispatched\ninteraction: \(.id)\nstatus: \(.status)"' <<<"$resp"
}

cmd_cancel() {
  local id="${1:?usage: cancel <interaction_id>}"
  api POST "/interactions/$id:cancel" '{}' | jq -r '.status // .'
}

cmd_runs() {
  [[ -d "$RUN_DIR" ]] || { echo "no runs recorded in $RUN_DIR"; return 0; }
  jq -r '"\(.dispatched_at)  \(.id)  \(.task[0:70])"' "$RUN_DIR"/*.json | sort
}

cmd_info() { api GET "/agents/$AGENT_ID" | jq '.'; }

case "${1:-}" in
  dispatch) shift; cmd_dispatch "$@" ;;
  status)   shift; cmd_status "$@" ;;
  wait)     shift; cmd_wait "$@" ;;
  steps)    shift; cmd_steps "$@" ;;
  stream)   shift; cmd_stream "$@" ;;
  follow)   shift; cmd_follow "$@" ;;
  cancel)   shift; cmd_cancel "$@" ;;
  runs)     shift; cmd_runs "$@" ;;
  info)     shift; cmd_info "$@" ;;
  *) cat >&2 <<EOF
usage: $0 <command>
  dispatch "<task>"              start a task on the $AGENT_ID cloud agent
  status <id>                    current status + output
  wait <id> [timeout_seconds]    poll until finished (default 1800)
  steps <id>                     step-by-step trace of the run
  stream <id> [last_event_id]    live SSE progress/events (supports reconnect)
  follow <id> "<task>"           continue in the same sandbox
  cancel <id>                    cancel a running interaction
  runs                           list locally recorded dispatches
  info                           show the stored agent definition
env: GEMINI_API_KEY (required), GITHUB_TOKEN (optional, enables push),
     FOUNDRY_AGENT_ID, FOUNDRY_AGENT_MAX_TOKENS, FOUNDRY_AGENT_RUN_DIR
EOF
    exit 1 ;;
esac
