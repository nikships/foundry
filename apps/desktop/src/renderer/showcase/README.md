# Pipelines redesign — review surface

Two complete replacements for the Pipelines page, running side by side so a
direction can be picked from working software rather than screenshots.

```bash
cd apps/desktop
npm run dev:showcase     # http://localhost:5175
```

`#option-a` and `#option-b` deep-link straight to a direction.

## What is here

|                            |                                                                                |
| -------------------------- | ------------------------------------------------------------------------------ |
| **Option A · Ladder**      | `screens/PipelinesScreen.tsx` + `components/PhaseLadder.tsx`                   |
| **Option B · Stage board** | `screens/PipelinesBoardScreen.tsx` + `components/StageBoard.tsx`               |
| Shared behaviour           | `hooks/usePipelineDraft.ts`                                                    |
| Shared presentation        | `components/PhaseEditor.tsx`, `components/PhaseGlyphs.tsx`, `pipeline-view.ts` |

Both options are presentations of one hook, so selection, auto-save, live
validation, dry run, acceptance and the phase contracts are the _same code_ in
each. Only the shape differs. A behaviour that works in one and not the other
is a bug, not a design difference.

## Production vs. review

- **Production**: `App.tsx` renders Option A. Swapping to Option B is a one-line
  import change — the props are identical.
- **Review only**: everything in `src/renderer/showcase/`. It is not routed from
  the app, not packaged by electron-builder, and has its own vite config
  (`vite.showcase.config.ts`) and entry.
- **Seeded backend**: `showcase/mock.ts` installs a stateful in-memory
  `window.foundry` before `api.ts` can install the plain web mock. Edits persist
  for the session and reset on reload. Its `showcaseValidate` is a deliberately
  small subset of the real validator — enough to demonstrate error and warning
  states, not a substitute for `store/pipelines.validate`.

## After the decision

Delete the losing option, its CSS module and its tests, delete
`src/renderer/showcase/`, `vite.showcase.config.ts` and the two `*:showcase`
scripts, and drop the showcase entry from `knip.json`. If Option A loses, point
`App.tsx` at `PipelinesBoardScreen` first. `usePipelineDraft` stays either way.
