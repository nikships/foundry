#!/usr/bin/env bash
# Rebuild the warm sandbox snapshot and re-point the managed agent at it.
# Run this when dispatches start spending minutes on `npm ci`, or after a big
# dependency/toolchain change in nikships/foundry.
set -euo pipefail

API="https://generativelanguage.googleapis.com/v1beta"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEF="$SKILL_DIR/agent-definition.json"
AGENT_ID="$(jq -r '.id' "$DEF")"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
[[ -n "${GEMINI_API_KEY:-}" ]] || die "GEMINI_API_KEY is not set"
command -v jq >/dev/null || die "jq is required"

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "$API$path" -H "Content-Type: application/json" \
      -H "x-goog-api-key: $GEMINI_API_KEY" -d "$body"
  else
    curl -sS -X "$method" "$API$path" -H "x-goog-api-key: $GEMINI_API_KEY"
  fi
}

echo "1/4  provisioning a fresh sandbox and warming it (this takes several minutes)…"
setup_payload="$(jq -n --rawfile prompt "$SKILL_DIR/setup-prompt.md" '{
  agent: "antigravity-preview-05-2026",
  input: $prompt,
  background: true,
  agent_config: {type: "antigravity", model: "gemini-3.8-flash", max_total_tokens: 800000},
  environment: {
    type: "remote",
    sources: [{type: "repository", source: "https://github.com/nikships/foundry", target: "/workspace/foundry"}]
  }
}')"
resp="$(api POST "/interactions" "$setup_payload")"
iid="$(jq -r '.id // empty' <<<"$resp")"
[[ -n "$iid" ]] || { echo "$resp" >&2; die "could not start the warm-up interaction"; }
echo "     interaction: $iid"

echo "2/4  waiting for the warm-up to finish…"
waited=0
while :; do
  cur="$(api GET "/interactions/$iid")"
  st="$(jq -r '.status' <<<"$cur")"
  [[ "$st" != "in_progress" && "$st" != "queued" ]] && break
  (( waited > 3600 )) && die "warm-up still running after 60 minutes ($iid)"
  sleep 20; waited=$((waited + 20))
  printf '     … %s (%ss)\n' "$st" "$waited"
done
[[ "$(jq -r '.status' <<<"$cur")" == "completed" ]] || { jq -r '.status, .output_text' <<<"$cur"; die "warm-up did not complete"; }
env_id="$(jq -r '.environment_id' <<<"$cur")"
echo "     environment: $env_id"
jq -r '.output_text // ""' <<<"$cur" | tail -30

echo "3/4  replacing the managed agent $AGENT_ID…"
api DELETE "/agents/$AGENT_ID" >/dev/null || true
create_payload="$(jq --arg env "$env_id" '. + {base_environment: $env}' "$DEF")"
created="$(api POST "/agents" "$create_payload")"
jq -e '.id' >/dev/null <<<"$created" || { echo "$created" >&2; die "agent creation failed"; }

echo "4/4  done."
jq -r '"agent: \(.id)\nbase_environment: \(.base_environment // "?")"' <<<"$created"
