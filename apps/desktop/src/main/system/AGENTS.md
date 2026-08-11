# src/main/system

This directory owns launch environment resolution, process control, doctor
checks, notifications, and dock badges. It does not own pipeline logic.
Doctor failures are advisory; the app still starts. Notification and badge
settings are respected, while run completion is settled by `finish()` in the
engine.

## Launch PATH

A GUI launch inherits launchd's minimal PATH, so `resolveEnv()` must complete
before any CLI lookup or spawn and its result is cached. It uses `$SHELL -ilc`
(not `-lc`) with marker fencing because profile files may print banners. Every
spawn uses `spawnEnv()`, including commands, catalog, one-shot, SDK, process
helpers, and the CLI `which` lookup. An ENOENT-shaped tail with
`exitCode === null` means the binary was not found, not that the command ran
and failed.

## Process safety

Tracked children are registered with argv and the trace process row. Before
signalling a persisted pid, verify the current `ps` command still matches the
recorded argv; pids can be recycled. Kill children before parents and keep the
registry/trace lifecycle in sync. Do not add an untracked spawn site.
