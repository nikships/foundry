# Pipelines redesign — every pass, side by side

`pipelines-redesign-gallery.html` is a single self-contained file. Open it
directly — no server, no build, no network. It carries three complete designs,
each one **live and interactive**, not a screenshot.

| Pass | What it is |
|---|---|
| **01 · Magic Patterns, repo not given** | Generated from a written brief alone. Its own Tailwind palette, and a `role` field on phases that does not exist in `PhaseDef`. |
| **02 · Magic Patterns, repo linked** | Same tool, same brief — but the prompt opened with the bare repository URL, so it read the codebase. Real Foundry tokens, the real phase union, the real builtin pipelines. |
| **03 · Hand-built** | The code actually running on this branch: `PipelinesScreen` (ladder) and `PipelinesBoardScreen` (stage board) over a seeded in-memory backend. |

Passes 01 and 02 differ by one line in the prompt. That is the whole lesson —
Magic Patterns has GitHub access, so give it the repo link and it designs
against your real system instead of guessing at one.

## Caveats

- Pass 02's `Ship Gate` and `Docs Refresh` pipelines are **invented**. The real
  builtins contain no checkpoint phase, so it synthesised one to demonstrate the
  stage board. `Full SDLC` and `Refine → Build → Ship` are genuine.
- Edits in any pass are held in memory and reset on reload.
- Passes 01 and 02 are Magic Patterns output built as-is. They are reference,
  not shippable Foundry code — only pass 03 is.

## Regenerating

The gallery is generated, not hand-written. Passes 01 and 02 are built from
Magic Patterns artifacts (design `v2ihhwqzaekrqgkpu5omqi`); pass 03 is a
single-file build of `src/renderer/showcase`. It is `.prettierignore`d because
it is a 2.3 MB bundle.

## Deleting

This whole directory comes out when a direction is picked, along with the
losing option and `src/renderer/showcase/`.
