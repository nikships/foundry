#!/usr/bin/env bash
# Wipe packaged Foundry to a first-time user. Policy: ../SKILL.md
# Usage: clear-local-data.sh [--dev]
set -euo pipefail

DEV=0
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=1 ;;
    -h|--help)
      echo "Usage: $0 [--dev]"
      echo "  --dev  also wipe ~/Library/Application Support/Electron/foundry"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      echo "Usage: $0 [--dev]" >&2
      exit 2
      ;;
  esac
done

USER_DATA="$HOME/Library/Application Support/foundry"
DEV_FOUNDRY="$HOME/Library/Application Support/Electron/foundry"
APP="/Applications/Foundry.app"

shopt -s nullglob

echo "== stop =="
osascript -e 'tell application "Foundry" to quit' >/dev/null 2>&1 || true
sleep 3
pkill -f "/Applications/Foundry.app" 2>/dev/null || true
pkill -f "Foundry.app/Contents/Resources/bridge/cli-proxy-api" 2>/dev/null || true
sleep 2
if pgrep -fl "/Applications/Foundry.app" >/dev/null 2>&1; then
  echo "still running:"
  pgrep -fl "/Applications/Foundry.app" || true
  echo "abort: Foundry is still running" >&2
  exit 1
fi
echo "stopped"

repos_file="$(mktemp)"
trap 'rm -f "$repos_file"' EXIT

add_repo() {
  local r="$1"
  [ -n "$r" ] || return 0
  grep -Fxq "$r" "$repos_file" 2>/dev/null && return 0
  printf '%s\n' "$r" >>"$repos_file"
}

echo
echo "== snapshot repos =="
python3 - <<'PY' >>"$repos_file" || true
import json, os, sys
candidates = [
    os.path.expanduser("~/Library/Application Support/foundry/foundry/projects.json"),
    os.path.expanduser("~/Library/Application Support/foundry/projects.json"),
    os.path.expanduser("~/Library/Application Support/Electron/foundry/projects.json"),
]
seen = set()
for p in candidates:
    if not os.path.exists(p):
        continue
    try:
        data = json.load(open(p))
    except Exception as e:
        print(f"unreadable {p}: {e}", file=sys.stderr)
        continue
    items = data if isinstance(data, list) else data.get("projects", [])
    for proj in items:
        path = proj.get("path") if isinstance(proj, dict) else None
        if path and path not in seen:
            seen.add(path)
            print(path)
PY

search_roots=()
for d in "$HOME/repos" "$HOME/Projects" "$HOME/Developer" "$HOME/src" "$HOME/code"; do
  [ -d "$d" ] && search_roots+=("$d")
done
if [ "${#search_roots[@]}" -gt 0 ]; then
  while IFS= read -r wt; do
    [ -n "$wt" ] || continue
    case "$wt" in
      */orca/*) continue ;;
    esac
    add_repo "$(dirname "$wt")"
  done < <(find "${search_roots[@]}" -maxdepth 4 -type d -name '.foundry-worktrees' 2>/dev/null || true)
fi

# Dedupe (python may have appended duplicates vs find)
dedup="$(mktemp)"
sort -u "$repos_file" | grep -v '^#' | grep -v '^$' >"$dedup" || true
mv "$dedup" "$repos_file"

if [ ! -s "$repos_file" ]; then
  echo "(none found)"
else
  cat "$repos_file"
fi

echo
echo "== delete userData =="
if [ -e "$USER_DATA" ]; then
  rm -rf "$USER_DATA"
  echo "deleted: $USER_DATA"
else
  echo "absent: $USER_DATA"
fi
if [ "$DEV" -eq 1 ]; then
  if [ -e "$DEV_FOUNDRY" ]; then
    rm -rf "$DEV_FOUNDRY"
    echo "deleted: $DEV_FOUNDRY"
  else
    echo "absent: $DEV_FOUNDRY"
  fi
fi

echo
echo "== delete sidecars =="
delete_path() {
  local p
  for p in "$@"; do
    if [ -e "$p" ] || [ -L "$p" ]; then
      rm -rf "$p"
      echo "deleted: $p"
    fi
  done
}

delete_path \
  "$HOME/Library/Caches/com.foundry.app" \
  "$HOME/Library/Caches/com.foundry.app.ShipIt" \
  "$HOME/Library/Caches/foundry-updater" \
  "$HOME/Library/Preferences/com.foundry.app.plist" \
  "$HOME/Library/Saved Application State/com.foundry.app.savedState" \
  "$HOME/Library/HTTPStorages/com.foundry.app" \
  "$HOME/Library/HTTPStorages/com.foundry.app.binarycookies" \
  "$HOME/Library/WebKit/com.foundry.app" \
  "$HOME/Library/Logs/Foundry" \
  "$HOME/Library/Application Support/com.apple.sharedfilelist/com.apple.LSSharedFileList.ApplicationRecentDocuments/com.foundry.app.sfl4"

delete_path "$HOME"/Library/Preferences/ByHost/com.foundry.app.ShipIt.*.plist
delete_path "$HOME"/Library/Application\ Support/CrashReporter/Foundry_*.plist

defaults delete com.foundry.app >/dev/null 2>&1 || true
killall -u "$USER" cfprefsd >/dev/null 2>&1 || true
echo "flushed cfprefsd"

echo
echo "== project leftovers =="
clean_repo() {
  local repo="$1"
  echo "--- $repo ---"
  if [ ! -d "$repo" ]; then
    echo "skip (missing)"
    return 0
  fi
  if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [ -d "$repo/.foundry-worktrees" ]; then
      rm -rf "$repo/.foundry-worktrees"
      echo "deleted leftover dir: $repo/.foundry-worktrees"
    else
      echo "skip (not a git repo)"
    fi
    return 0
  fi

  local wt
  while IFS= read -r wt; do
    [ -n "$wt" ] || continue
    case "$wt" in
      *".foundry-worktrees"/*)
        echo "worktree remove --force $wt"
        git -C "$repo" worktree remove --force "$wt" || rm -rf "$wt"
        ;;
    esac
  done < <(git -C "$repo" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10)}' || true)

  if [ -d "$repo/.foundry-worktrees" ]; then
    local d
    for d in "$repo"/.foundry-worktrees/*; do
      [ -e "$d" ] || continue
      echo "leftover dir: $d"
      git -C "$repo" worktree remove --force "$d" 2>/dev/null || rm -rf "$d"
    done
  fi

  git -C "$repo" worktree prune >/dev/null || true

  local br
  while IFS= read -r br; do
    [ -n "$br" ] || continue
    echo "branch -D $br"
    git -C "$repo" branch -D "$br" || true
  done < <(git -C "$repo" branch --list 'foundry/*' 'foundry-ready/*' | sed 's/^[+* ]*//')

  rmdir "$repo/.foundry-worktrees" 2>/dev/null || rm -rf "$repo/.foundry-worktrees"
  echo "cleaned"
}

if [ ! -s "$repos_file" ]; then
  echo "(none)"
else
  while IFS= read -r repo; do
    [ -n "$repo" ] || continue
    case "$repo" in
      \#*) continue ;;
    esac
    clean_repo "$repo" || echo "failed: $repo"
  done <"$repos_file"
fi

echo
echo "== verify =="
leftovers="$(
  find "$HOME/Library" -maxdepth 4 -iname '*foundry*' 2>/dev/null \
    | grep -vi -e droidproxy -e 'orca/terminal-history' || true
)"
if [ -z "$leftovers" ]; then
  echo "clean: zero Foundry state remaining under ~/Library"
else
  echo "remaining under ~/Library:"
  printf '%s\n' "$leftovers"
fi

if [ -d "$APP" ]; then
  echo "kept: $APP"
else
  echo "missing: $APP (the install should still be there)" >&2
fi

if [ -s "$repos_file" ]; then
  while IFS= read -r repo; do
    [ -n "$repo" ] || continue
    case "$repo" in \#*) continue ;; esac
    [ -d "$repo" ] || continue
    echo "--- $repo ---"
    if git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      git -C "$repo" worktree list
      branches="$(git -C "$repo" branch --list 'foundry/*' 'foundry-ready/*' || true)"
      if [ -z "$branches" ]; then
        echo "no foundry/* or foundry-ready/* branches"
      else
        printf '%s\n' "$branches"
      fi
    fi
    if [ -e "$repo/.foundry-worktrees" ]; then
      echo "STILL PRESENT: $repo/.foundry-worktrees"
    else
      echo ".foundry-worktrees gone"
    fi
  done <"$repos_file"
fi

echo
echo "== left alone =="
echo "install: $APP"
echo "standalone CLIProxyAPI / DroidProxy: ~/.cli-proxy-api and any cli-proxy-api -config pointing there"
if [ "$DEV" -eq 0 ]; then
  echo "dev userData: $DEV_FOUNDRY (pass --dev to wipe)"
fi
echo "shared Electron dir: ~/Library/Application Support/Electron (not wholesale)"
echo "Orca: ~/orca/workspaces and orca/terminal-history"
echo
echo "Next launch starts at onboarding. Settings → Providers needs re-auth."
