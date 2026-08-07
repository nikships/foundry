# Development workflow

Day-to-day loop for changes under `apps/desktop/`.

## Setup once

```bash
cd apps/desktop
npm install
# if electron binary missing:
node node_modules/electron/install.js
```

## Loop

1. **Branch** from `main` (default branch).
2. **Edit** the smallest set of files. Prefer shared types first when crossing the IPC boundary.
3. **Run** `npm run dev` to exercise UI changes, or `npm run engine:demo` for headless engine smoke.
4. **Verify** before finish (same gates as PR CI):
   ```bash
   npm run check
   ```
   Equivalent to typecheck, lint, format:check, knip, test, build, and audit.
5. **Commit** with a clear message. Keep app changes separate from skill-only docs when possible.
6. **PR** against `main` with what changed and how you verified. CI must stay green.

## Where code goes

| Change | Primary location |
|---|---|
| Pipeline / phase semantics | `src/main/engine/` |
| droid session / protocol | `src/main/droid/` |
| Persistence of runs | `src/main/trace/` |
| Settings, roster, pipelines JSON | `src/main/store/` |
| UI screens | `src/renderer/screens/` |
| Shared shapes / channels | `src/shared/` |

## Builtins

If you change `builtin-agents.ts` or `builtin-pipelines.ts`, remember user copies in the store must not be overwritten. Treat builtins as seeds only.

## Do not

- Import from `.claude/skills/sssf/` into the app
- Add Python to `apps/desktop/`
- Touch the base project checkout from the engine (worktrees only)
- Default a new phase status to success
