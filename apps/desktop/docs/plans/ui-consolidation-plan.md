# UI Consolidation — Implementation Plan

**Scope:** `apps/desktop/src/renderer`
**Date:** 2026-08-08
**Status:** Phases 1-3 shipped. Phase 4 items 1-3 (Field, useDebouncedSave, Button) shipped; items 4-7 and Phase 5 remain.

---

## 0) How to use this plan

Execute **top to bottom**. Each phase is independently shippable, ends with an acceptance check, and leaves `npm run check` green. Run everything from `apps/desktop/`, never the repo root.

```
npm run check   # typecheck → lint → format:check → knip → test → build → check:css → audit:deps
```

---

## 1) What was already done

Phases 1-3 landed in commit `2532d51`:

- **Phase 1 — Remove Murmur:** deleted `assets/brands/` (66 MB), `tokens-murmur.css`, `MurmurFlock`, `useBrand`, `useReducedMotion`, the brand IPC channel, the brand picker, and all brand plumbing across main/shared/preload. Prism is the only brand.
- **Phase 2 — Hoist inline CSS:** migrated ~35 inline `<style>` blocks to CSS modules. Added `localsConvention: 'camelCase'` to the Vite renderer config. OnboardingShell's shared `ob-*` classes moved to a global `onboarding.css`. Co-mounted `.field` / `.hint` / `.row` / `.modes` / `.mode` collisions resolved by scoping. Guard script `scripts/check-css-collisions.mjs` wired into `npm run check`.
- **Phase 3 — Bug fixes:** unified `KIND_COLOR` into `derive.ts:phaseKindColor` (PipelinesScreen was inverted). Added `useEscapeToClose` hook, adopted in `PromptPreview` and `DryRunSheet`. `TranscriptLane` now uses `derive.phaseDuration`.

---

## Phase 4 — Extract shared components

Only after Phases 1-3 (done). Extracting a component while its CSS still lives in five colliding `<style>` blocks means extracting the collision too — that no longer applies.

Ordered by verified value:

| #   | Extract                                                          | Target                               | Sites                            | Net lines |
| --- | ---------------------------------------------------------------- | ------------------------------------ | -------------------------------- | --------- |
| 1   | `<Field label hint error>` + `TextInput` / `Select` / `Textarea` | `components/ui/Field.tsx`            | 39 `field`, 43 `hint`            | ~95       |
| 2   | `useDebouncedSave`                                               | `hooks/useDebouncedSave.ts`          | Pipelines, Roster, Settings      | ~52       |
| 3   | `<Button variant size>`                                          | `components/ui/Button.tsx`           | 22 `btn sm` + variants           | ~30       |
| 4   | `ModalShell` (scrim + sheet + Esc)                               | `components/ui/ModalShell.tsx`       | Interrupt, DryRun, PromptPreview | ~26       |
| 5   | `CodeBlock` (mono `pre`)                                         | `components/ui/CodeBlock.tsx`        | 6 files, verbatim CSS            | ~20       |
| 6   | `SegmentedControl`                                               | `components/ui/SegmentedControl.tsx` | PhaseEditor, BoundaryEditor      | ~11       |
| 7   | `useConfirmAction`                                               | `hooks/useConfirmAction.ts`          | 9 `window.confirm`               | ~30       |

### 4.1 Notes per item

**`Field`** must spread `className` and support the existing escape hatches: `field-warn` and `field-note ok` (Settings), `span2` grid span (Roster), and the `mono` input variant. Without those it will not cover all 39 sites.

**`useDebouncedSave`** is the highest-risk item. All three call sites use `JSON.stringify` dirty-checking plus a flush-on-unmount that re-saves pending edits. Getting the flush wrong **silently loses user edits** when switching pipeline or agent. Parameterise `delay` (Settings 400 ms, Pipelines/Roster 350 ms), `validate?`, `compare`, `save`, `onSuccess`, `onError`. Keep `plain()` at the call site per the `api.ts` invariant. Test by typing fast and navigating away mid-debounce.

**`ModalShell`** needs `dismissible={false}` for `InterruptSheet`, which must not close on backdrop click and maps Escape to `answer('reject')`. z-index (90 vs 100) and blur (6px vs 8px) become props or tokens.

**`SegmentedControl`** is the cleanest win: `.modes` / `.mode` / `.mode.on` are byte-identical between `PhaseEditor.tsx:510-512` and `BoundaryEditor.tsx:97-100`, differing only by a `margin-bottom` and a `:hover`.

**`useConfirmAction`** should keep `window.confirm` inside the hook. Swapping to an async dialog changes UX and is a separate decision. Only the `try/catch` → `setErrors` → `refresh` plumbing gets deduped; per-site guards like `selected.builtin` stay at the call site.

---

## Phase 5 — Dead CSS sweep

After Phase 1 removed `tokens-murmur.css`, these Prism selectors have **zero** `className` matches anywhere in `.tsx` (verified by grep):

| File                                | Selector                                 | Lines |
| ----------------------------------- | ---------------------------------------- | ----- |
| `design/prism/prism.css`            | `.glass`                                 | 53-65 |
| `design/prism/prism.css`            | `.glass-strong`                          | 70-73 |
| `design/prism/prism.css`            | `.glass::after`, `.cinema .frame::after` | 83-97 |
| `design/prism/prism-animations.css` | reduced-motion rules for the above       | 18-28 |

`.cinema` and `.frame` are relics of the PrismField background removed in `094b077` / `7ab6214`. `.glass` was documented as "opt-in via `.glass`" and never opted into.

`.dim` in `tokens-base.css:103-105` **is not dead** — verify before deleting. The earlier grep matched substrings (`sum-dim`, `pl-tr-meta-dim`); re-check for a standalone `dim` token in a `className` list.

Keep `.prism-header-rule` — used at `App.tsx:168`.

**Expected reduction: ~30 lines.**

---

## Totals (remaining)

| Phase                 | Lines    |
| --------------------- | -------- |
| 4 — Shared components | ~264     |
| 5 — Dead CSS          | ~30      |
| **Remaining**         | **~294** |

---

## Risk register (remaining)

| Risk                                               | Phase | Severity | Mitigation                                                                     |
| -------------------------------------------------- | ----- | -------- | ------------------------------------------------------------------------------ |
| `useDebouncedSave` flush bug loses in-flight edits | 4     | **High** | Mirror existing cleanup semantics exactly; test fast-typing then immediate nav |

---

## Commit sequence (remaining)

```
1. refactor: extract Field / Button / ModalShell / ...  (7 commits, one per component)
2. chore: drop dead .glass and .cinema selectors
```

`npm run check` green at every step.
