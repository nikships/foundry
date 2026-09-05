#!/usr/bin/env bash
# Implements a freeform @droid comment: edit, commit, and push.
# Factory-AI/droid-action only handles fill / review / security; this is the
# coding-agent path. Invoked from .github/workflows/droid.yml.
set -euo pipefail

trigger_file="${DROID_TRIGGER_FILE:-/tmp/droid-trigger.txt}"
prompt_file="${DROID_PROMPT_FILE:-/tmp/droid-task-prompt.txt}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
issue_number="${ISSUE_NUMBER:?ISSUE_NUMBER is required}"
is_pr="${IS_PR:-false}"
run_url="${RUN_URL:-}"
model="${DROID_MODEL:-glm-5.3-flash}"

if [[ ! -s "$trigger_file" ]]; then
  echo "Trigger comment is empty; nothing to do."
  exit 0
fi

instruction="$(sed -E 's/@droid[[:space:]]*//Ig' "$trigger_file" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [[ -z "$instruction" ]]; then
  instruction="Implement the outstanding review comments on this pull request."
fi
short_instruction="$(printf '%s' "$instruction" | tr '\n' ' ' | cut -c1-72)"

tracking_id=""
final_status=0
cleanup() {
  local status="${1:-0}"
  if [[ -n "${tracking_id:-}" ]]; then
    local summary
    if [[ "$status" -eq 0 ]]; then
      summary="**Droid finished the task** —— [View job](${run_url})"
    else
      summary="**Droid failed** —— [View job](${run_url})

Exit status ${status}. Check the job log."
    fi
    gh api "repos/${repo}/issues/comments/${tracking_id}" -X PATCH -f body="$summary" >/dev/null || true
  fi
}
trap 'cleanup $?' EXIT

if [[ "$is_pr" == "true" ]]; then
  fork="$(gh pr view "$issue_number" --repo "$repo" --json isCrossRepository --jq '.isCrossRepository')"
  if [[ "$fork" == "true" ]]; then
    echo "Skipping cross-repository (fork) pull request."
    exit 0
  fi
  gh pr checkout "$issue_number"
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" == "HEAD" || "$branch" == "main" || "$branch" == "master" ]]; then
  branch="droid/task-${issue_number}"
  git checkout -B "$branch"
fi

tracking_body="Droid is working on your request…

[View job](${run_url})"
tracking_id="$(
  gh api "repos/${repo}/issues/${issue_number}/comments" \
    -f body="$tracking_body" \
    --jq '.id'
)"

{
  cat <<EOF
You are Droid running in GitHub Actions as a coding agent, not a reviewer.

Repository: ${repo}
Number: #${issue_number}
Is pull request: ${is_pr}
Current branch: ${branch}
Job: ${run_url}

The human tagged @droid with this request:

\`\`\`
EOF
  printf '%s\n' "$instruction"
  cat <<'EOF'
```

Raw comment (including the @droid mention):

```
EOF
  cat "$trigger_file"
  printf '\n'
  cat <<'EOF'
```

## What to do

Implement the request in this working tree. This is not a code review.

- If they asked to fix, address, or implement feedback (including a bare "fix"), read existing review comments and issue comments with `gh` and implement those code changes. Prioritize unresolved comments from factory-droid[bot]. Do not post another review.
- If they asked for something else, do that instead.
- Follow AGENTS.md and the closest nested AGENTS.md.
- Commit with this repo's title style: `[component] Brief description`.
- Push the current branch to origin. Do not force-push. Do not merge. Do not push to main or master.
- If this is an issue (not a PR) and there is no open PR yet, push the branch and open a PR with `gh pr create`.
- Do not use OpenAI models.

The GitHub CLI is authenticated via GH_TOKEN. Git remotes already use that token.
EOF
} >"$prompt_file"

final_status=0
droid exec --skip-permissions-unsafe -m "$model" -f "$prompt_file" || final_status=$?

if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  if ! git diff --cached --quiet; then
    commit_msg="$(mktemp)"
    {
      printf '[droid] %s\n\n' "$short_instruction"
      printf 'Made-with: @droid task on #%s\n' "$issue_number"
    } >"$commit_msg"
    git commit -F "$commit_msg"
    rm -f "$commit_msg"
  fi
fi

if [[ -n "$(git log --oneline '@{upstream}..HEAD' 2>/dev/null || true)" ]] ||
  ! git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
  git push -u origin "HEAD:${branch}"
fi

if [[ "$is_pr" != "true" ]]; then
  existing="$(gh pr list --repo "$repo" --head "$branch" --json number --jq '.[0].number // empty')"
  if [[ -z "$existing" ]]; then
    pr_body="$(mktemp)"
    {
      printf 'Implements @droid on #%s.\n\n' "$issue_number"
      printf '%s\n' "$instruction"
    } >"$pr_body"
    gh pr create --repo "$repo" --head "$branch" --title "[droid] ${short_instruction}" --body-file "$pr_body"
    rm -f "$pr_body"
  fi
fi

exit "$final_status"
