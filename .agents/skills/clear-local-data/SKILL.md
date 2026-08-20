---
name: clear-local-data
description: >-
  Wipe all local Foundry state so the installed app launches as a first-time
  user: userData (traces, settings, provider credentials), caches, preferences,
  updater artifacts, plus .foundry-worktrees/ and foundry/* / foundry-ready/*
  branches in registered repos. Keeps /Applications/Foundry.app installed.
disable-model-invocation: true
---

# clear-local-data — reset Foundry to a fresh user

Deletes every trace of local Foundry state on macOS, including engine worktrees
and `foundry/*` / `foundry-ready/*` branches. After this the packaged app starts
at onboarding with no projects, no settings, and no signed-in providers.

**This is destructive and there is no backup.** The user invoked the skill, so do
not offer to back anything up and do not ask them to reconsider. Do not ask
whether to clear project leftovers — that is always in scope.

## What to run

Do not retype the wipe. Execute the skill script and report its output.

```bash
bash .agents/skills/clear-local-data/scripts/clear-local-data.sh
```

Pass `--dev` only if the user is resetting the `npm run dev` build as well. That
wipes `~/Library/Application Support/Electron/foundry` (not the shared
`Electron/` directory).

The script stops Foundry, snapshots registered repos from `projects.json` plus
leftover `.foundry-worktrees/` dirs, deletes packaged userData and macOS
sidecars, force-removes Foundry worktrees and `foundry/*` / `foundry-ready/*`
branches, flushes `cfprefsd`, and verifies.

## Do not delete

- `/Applications/Foundry.app` — the install itself.
- `~/.cli-proxy-api/` and any `cli-proxy-api` process whose `-config` points
  there (standalone DroidProxy, not Foundry's).
- `~/Library/Application Support/Electron/` wholesale. Only its nested
  `foundry/` dir is Foundry's, and only with `--dev`.
- Orca worktrees under `~/orca/workspaces/`, and `orca/terminal-history/` files
  that merely have "foundry" in their path.

Never hand-edit `.foundry-worktrees/` — the engine owns it. Never `pkill -f
cli-proxy-api` unscoped.

## Report back

Relay what the script killed, deleted (including each worktree and branch), and
left alone. Next launch starts at onboarding with **no providers signed in**, so
Settings → Providers needs re-auth. If verify still shows non-Foundry hits, name
them so the user knows they were skipped on purpose.

## Notes

- Case-insensitive HFS+/APFS means `Application Support/Foundry` and
  `Application Support/foundry` are the same directory.
- If a wipe appears to have no effect on next launch, suspect `cfprefsd` or a
  still-running helper before suspecting the paths.
