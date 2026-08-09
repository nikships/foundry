# AGENTS.md — src/main/system

Process control, doctor checks, notifications. No pipeline logic here.

Doctor checks are advisory — app starts even when they fail.
Notifications/dock badge must respect user settings; `finish()` settles status

- notification + banner together.

## PATH (`env.ts`)

A GUI launch inherits launchd's `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, where
node, npm, pnpm, yarn, bun, cargo, go, uv, gradle and every agent CLI are
invisible. `resolveEnv()` asks the login shell once at startup (`$SHELL -ilc`,
answer fenced by markers because rc files print banners) and caches it.

- **Every** spawn uses `spawnEnv()` — `engine/commands.ts`, `system/procs.ts`,
  `droid/oneshot.ts`, `droid/client.ts`, `droid/catalog.ts`, and the `which`
  in `cli/index.ts`. A new spawn site that uses `process.env` reintroduces the
  bug for whichever feature it powers.
- `resolveEnv()` must be awaited **before** anything spawns: `findCli` caches
  its answer, so resolving late caches a wrong one for the session.
- `-ilc`, not `-lc`: PATH usually lives in `.zshrc`, which a non-interactive
  login shell never reads.
- `exitCode === null` + an ENOENT-shaped tail means the binary was never found.
  That is a PATH problem, not a failing command, and the two must not be
  conflated in anything a human reads.
