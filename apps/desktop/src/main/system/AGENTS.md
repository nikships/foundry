# AGENTS.md — src/main/system

Process control, doctor checks, notifications. No pipeline logic here.

Doctor checks are advisory — app starts even when they fail. Never invent a
CLI flag/auth path (Junie has no headless flag; check `~/.junie/allowlist.json`).
Notifications/dock badge must respect user settings; `finish()` settles status

- notification + banner together.
