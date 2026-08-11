### Root Cause

In `src/renderer/hooks/usePipelineDraft.ts`, `selected` is computed via `useMemo` from `pipelines` (`pipelines.find(...)`). The `useEffect` that initializes the local pipeline draft has `[selected]` in its dependency array:

```tsx
useEffect(() => {
  if (selected) {
    setDraft(clonePipeline(selected));
    setActivePhase(null);
  } else {
    setDraft(null);
    setActivePhase(null);
  }
}, [selected]);
```

When clicking **Add New Agent**, **Command**, or **Checkpoint**:

1. `insertPhase(kind)` appends the phase to the draft and calls `setActivePhase(index)`.
2. `openPhase` sets `sheet = 'phase'`, opening `SideSheet` on the right side of the screen.
3. `insertPhase`'s call to `updateDraft` schedules a 600ms debounced auto-save (`scheduleSave`).
4. 600ms later, auto-save fires `commitSave`, saving the pipeline and calling `refreshAll()`.
5. `refreshAll()` updates `pipelines` in the `useApp` store with fresh array data from SQLite.
6. `usePipelineDraft` re-computes `selected` from the new `pipelines` array, creating a new object reference for `selected`.
7. The `useEffect([selected])` runs and executes `setActivePhase(null)`.
8. `SideSheet`'s `open` prop (`sheet === 'phase' && activePhaseObj !== null && activePhase !== null`) becomes `false`.
9. The side panel automatically closes after ~0.5s and the screen layout snaps back.

---

### Proposed Fix

Modify `usePipelineDraft.ts` to track the previously loaded pipeline ID with a `ref` (`prevSelectedIdRef`). `setDraft` and `setActivePhase(null)` will only execute when switching to a different pipeline (`prevSelectedIdRef.current !== selected.id`) or when `draft` is `null`, preventing auto-saves from clearing `activePhase` and closing the drawer.

#### Code Changes (`src/renderer/hooks/usePipelineDraft.ts`):

```tsx
const prevSelectedIdRef = useRef<string | null>(null);

// Initialize or reset draft when selected pipeline changes
useEffect(() => {
  if (selected) {
    if (prevSelectedIdRef.current !== selected.id || draft === null) {
      prevSelectedIdRef.current = selected.id;
      setDraft(clonePipeline(selected));
      setActivePhase(null);
    }
  } else {
    prevSelectedIdRef.current = null;
    setDraft(null);
    setActivePhase(null);
  }
}, [selected, draft]);
```

---

### Validation Plan

1. Run `npm run typecheck` to verify TypeScript strict checks.
2. Run `npm test` to verify Vitest test suites.
3. Run `npm run check` (typecheck + lint + format:check + knip + test + build + check:css + audit:deps).
