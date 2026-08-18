---
name: clear-local-data
description: >-
  Wipe all local Foundry state so the installed app launches as a first-time
  user: userData (traces, settings, provider credentials), caches, preferences,
  and updater artifacts. Keeps /Applications/Foundry.app installed.
disable-model-invocation: true
---

# clear-local-data — reset Foundry to a fresh user

Deletes every trace of local Foundry state on macOS. After this the packaged app
starts at onboarding with no projects, no settings, and no signed-in providers.

**This is destructive and there is no backup.** The user invoked the skill, so do
not offer to back anything up and do not ask them to reconsider. Do ask which
scope they want if it is not obvious (see [Scope](#scope)).

## Scope

Three independent layers. Default to 1 + 2. Only do 3 if the user asks for it.

1. **Packaged app state** — the installed `/Applications/Foundry.app`. Always in scope.
2. **macOS per-app sidecars** — caches, prefs, saved state, updater downloads. Always in scope.
3. **Project leftovers** — `.foundry-worktrees/` and `foundry/*` branches in registered
   repos. Not needed for a fresh-user launch; these are engine artifacts. Ask first,
   because removing a worktree destroys uncommitted work inside it.

Dev state (`npm run dev`) lands in `~/Library/Application Support/Electron/` instead,
under a nested `foundry/` dir. Wipe that only if the user runs the dev build.

## Do not delete

- `/Applications/Foundry.app` — the install itself. Only state is in scope.
- `~/.cli-proxy-api/` and any `cli-proxy-api` process whose `-config` points there.
  That is the user's standalone CLIProxyAPI / DroidProxy, not Foundry's. Foundry
  deliberately never writes there (`src/main/bridge/AGENTS.md`), and killing it
  breaks unrelated tooling.
- `~/Library/Application Support/Electron/` wholesale. That directory is shared by
  every unbranded Electron dev app on the machine. Only its nested `foundry/` dir
  is Foundry's.
- Orca worktrees under `~/orca/workspaces/`, and `orca/terminal-history/` files that
  merely have "foundry" in their path. Those belong to the terminal app.

## Procedure

### 1. Stop the app first

State must not be rewritten mid-wipe, and the app holds a single-instance lock plus
an open SQLite WAL. Quit it, then confirm.

```bash
osascript -e 'tell application "Foundry" to quit' 2>/dev/null; sleep 3
pkill -f "/Applications/Foundry.app" 2>/dev/null
pkill -f "Foundry.app/Contents/Resources/bridge/cli-proxy-api" 2>/dev/null
sleep 2
pgrep -fl "/Applications/Foundry.app" || echo "stopped"
```

The bridge pattern is scoped to the app bundle on purpose. A bare
`pkill -f cli-proxy-api` would also kill the user's own DroidProxy instance.

### 2. Delete app state

`~/Library/Application Support/foundry/` is Electron's `userData` for
`appId: com.foundry.app`. Everything below it goes, including the nested `foundry/`
dir that `main.ts` builds with `join(app.getPath('userData'), 'foundry')`:

- `projects.json`, `settings.json` (the `onboarded` flag), `roster.json`,
  `pipelines.json`, `envelopes.json`, and per-project `project.json`
- per-project `trace.db` + `-wal` + `-shm`
- `bridge/config.yaml` and the provider OAuth credentials beside it
- `smith/foundry.sock`
- pi agent runtime state, `.updaterId`, and Chromium session/local storage

```bash
rm -rf "$HOME/Library/Application Support/foundry"
```

### 3. Delete the macOS sidecars

```bash
rm -rf "$HOME/Library/Caches/com.foundry.app" \
       "$HOME/Library/Caches/com.foundry.app.ShipIt" \
       "$HOME/Library/Caches/foundry-updater"

rm -f  "$HOME/Library/Preferences/com.foundry.app.plist"
rm -f  "$HOME"/Library/Preferences/ByHost/com.foundry.app.ShipIt.*.plist

rm -rf "$HOME/Library/Saved Application State/com.foundry.app.savedState" \
       "$HOME/Library/HTTPStorages/com.foundry.app" \
       "$HOME/Library/HTTPStorages/com.foundry.app.binarycookies" \
       "$HOME/Library/WebKit/com.foundry.app" \
       "$HOME/Library/Logs/Foundry"

rm -f  "$HOME/Library/Application Support/com.apple.sharedfilelist/com.apple.LSSharedFileList.ApplicationRecentDocuments/com.foundry.app.sfl4"
rm -f  "$HOME"/Library/Application\ Support/CrashReporter/Foundry_*.plist
```

`foundry-updater` holds the pending DMG/zip from `electron-updater`; leaving it
behind can make a fresh install immediately think an update is staged.

**Then flush the prefs daemon.** `cfprefsd` caches preferences in memory and will
happily write the deleted plist back to disk:

```bash
defaults delete com.foundry.app 2>/dev/null
killall -u "$USER" cfprefsd 2>/dev/null
```

### 4. Project leftovers (only if asked)

```bash
cd <registered-repo>
git worktree list                       # confirm what is there before removing
git worktree remove --force .foundry-worktrees/<runId>
git branch --list 'foundry/*' 'foundry-ready/*'
git branch -D <branch>
```

Never hand-edit `.foundry-worktrees/` — the engine owns it (`engine/worktree.ts`).
`git worktree remove --force` discards uncommitted changes in that worktree, which
is why this layer is opt-in.

### 5. Verify

```bash
find "$HOME/Library" -maxdepth 4 -iname "*foundry*" 2>/dev/null \
  | grep -vi -e droidproxy -e "orca/terminal-history" \
  || echo "clean: zero Foundry state remaining"

ls -d /Applications/Foundry.app        # must still exist
```

The two `grep -v` filters are the known false positives. If anything else shows
up, read the path before deleting it — do not widen the pattern blindly.

## Report back

State what was killed, what was deleted, what was deliberately left alone and why,
and that the next launch starts at onboarding with **no providers signed in**, so
Settings → Providers needs re-auth. If `find` still shows non-Foundry hits, name
them so the user knows they were skipped on purpose rather than missed.

## Notes

- Case-insensitive HFS+/APFS means `Application Support/Foundry` and
  `Application Support/foundry` are the same directory. Do not "also" delete the
  other spelling and conclude the first attempt failed.
- If a wipe appears to have no effect on next launch, suspect `cfprefsd` (step 3)
  or a still-running helper process (step 1) before suspecting the paths.
