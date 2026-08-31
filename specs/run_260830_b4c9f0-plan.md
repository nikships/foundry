# Plan: Scope sidebar Activity to the selected project

## Goal

Sidebar Activity lists only the currently selected project's live + recent runs. Stop fan-out polling every project's trace DB. Clicking a row pins Inspector and never switches projects. Drop the redundant project-name meta once every row is in-project.

## Non-goals

- Do not change Inspector's picker (`InspectorScreen.tsx` already uses `useRunList(projectId, false)` and shows every unarchived run with `pipelineName · status · time`).
- Do not change the Runs screen, Smith all-projects chat, or `selectProject` on Smith receipt run links in `App.tsx`.
- Do not change `data-testid={`sidebar-run-${run.runId}`}` or e2e clicks against `seedOnboardedFixture()` (`inspector.spec.ts`, `smith.spec.ts`).
- Do not dump Inspector's full un-capped list into Activity.
- Do not key the feed off raw `selectedProjectId`. Empty stored id still falls back to `projects[0]` in `useApp()` (`app.tsx` 96–100); Activity must use `project` / `projectId` the same way Inspector does.

## Files to change

- `apps/desktop/src/renderer/view-models/activity-runs.ts` (new)
- `apps/desktop/src/renderer/stores/run.tsx`
- `apps/desktop/src/renderer/components/layout/Sidebar.tsx`
- `apps/desktop/tests/renderer/activity-runs.test.ts` (new)
- `apps/desktop/tests/renderer/sidebar-emblems.test.ts`
- `apps/desktop/tests/renderer/design-navigation.test.ts`
- `.factory/skills/foundry-ui/SKILL.md`

Do not change `App.tsx`, `InspectorScreen.tsx`, Runs, Smith, e2e specs, or `useRunList`'s public contract beyond what reuse already provides.

## 1. Extract a node-testable recency/filter helper

Renderer suites are `environment: 'node'` source/unit tests (see `vitest.config.ts`); there is no testing-library. Put the slice in a pure view-model so the filter/recency rules can be asserted without mounting React.

### `apps/desktop/src/renderer/view-models/activity-runs.ts` (new)

Export one function, default `recentLimit = 5`:

```ts
export function selectActivityRuns(
  runs: readonly RunRow[],
  projectId: string,
  recentLimit = 5,
): RunRow[]
```

Rules (same recency as today's `useAllProjectRuns`, plus the new project filter):

1. If `projectId` is empty, return `[]`.
2. Keep only rows whose `projectId` matches. A live run from any other project must not appear.
3. Of those, keep every `status === 'running'`, newest `startedAt` first (`localeCompare`, descending).
4. Then keep up to `recentLimit` finished rows (`status !== 'running'`), newest `endedAt ?? startedAt` first, same compare as today.
5. Return `[...running, ...finished]`. Do not cap live runs. Do not invent new status buckets (`queued` stays in the finished cap, as today).

Do not sort across projects, do not call the API, do not read `useApp()`.

## 2. Replace `useAllProjectRuns` with a selected-project hook

### `apps/desktop/src/renderer/stores/run.tsx`

Delete `useAllProjectRuns` (lines 164–226) entirely: repo-wide it is only exported here and called from Sidebar. After deletion, drop the now-unused `import { useApp } from './app.js'`.

Do **not** leave a renamed all-projects fan-out. Do **not** `Promise.all` `api.runs.list` across `projects.map(p => p.id)`.

Add a thin wrapper that reuses the existing single-project poller:

```ts
/** Selected-project Activity: every live run plus a short recency cap of finished runs. */
export function useActivityRuns(projectId: string, recentLimit = 5): { runs: RunRow[] } {
  const { runs } = useRunList(projectId, false);
  return {
    runs: useMemo(
      () => selectActivityRuns(runs, projectId, recentLimit),
      [runs, projectId, recentLimit],
    ),
  };
}
```

`useRunList` already:

- scopes to one id and calls `api.runs.list(projectId, includeArchived)` only;
- clears immediately when `!projectId` (`setRuns([])`, no schedule);
- polls 800ms if any run is live, else 4000ms;
- refreshes on `api.on('runs-changed')`.

That is the required “load and refresh only the selected project” behaviour. Do not restore the old hard 500ms all-projects cadence.

Stale-list on project switch: `useRunList` keeps the previous `runs` until the next tick. `selectActivityRuns(runs, projectId)` drops those rows because their `projectId` no longer matches, so the list follows the selection immediately (empty until the new project's list arrives). Do not change `useRunList` itself — Inspector's picker stays a full un-capped list.

Leave `useRun` and `useRunList` signatures, polling, and Inspector usage untouched.

## 3. Sidebar: selected-project feed, no project switch on click

### `apps/desktop/src/renderer/components/layout/Sidebar.tsx`

Imports and data:

- Replace `import { useAllProjectRuns } from '../../stores/run.js'` with `useActivityRuns`.
- Keep `const { projects, project, selectProject } = useApp()` — `selectProject` is still required for `chooseProject` (lines 166–169) and `projects` still feeds the picker.
- Also read `projectId` from `useApp()` (same resolved id Inspector uses, `project?.id ?? ''`).
- Replace `const { runs: pipelineRuns } = useAllProjectRuns()` with `const { runs: pipelineRuns } = useActivityRuns(projectId)`.

Presentation to **keep**:

- Hide Activity when collapsed or empty: `{!collapsed && pipelineRuns.length > 0 && (` (line 248).
- `data-testid={`sidebar-run-${run.runId}`}`.
- Live dot via `run.status === 'running'` + `statusColor` / `runDotLive`.
- Pin highlight: `view === 'inspector' && inspectorRunId === run.runId`.
- Primary label remains `run.request`.

Presentation to **change**:

- Drop `const projectName = projects.find(...)`.
- Meta (`styles.runMeta`): `{run.pipelineName} · {running ? statusWord(run.status) : since(run.endedAt ?? run.startedAt)}`. Pipeline name + recency/status; no second project label.
- `title`: `` `${run.request}\n${run.pipelineName} · ${statusWord(run.status)}` `` (drop `projectName`).
- Click: only `onOpenInspector?.(run.runId)`. Delete `if (run.projectId !== project?.id) selectProject(run.projectId)`.
- Props comment on `onOpenInspector` (line 123): replace “the run may live in any project” with a selected-project wording, e.g. “Pin the Inspector to a run from the selected project.”

Do not remove `selectProject` from the project picker path.

## 4. Tests

Renderer tests cannot mount Sidebar (no jsdom/testing-library). Cover the filter in a unit suite; pin the wiring with source-string asserts.

### `apps/desktop/tests/renderer/activity-runs.test.ts` (new)

Follow the `RunRow` factory style in `apps/desktop/tests/renderer/outcome-view.test.ts` (`function run(over: Partial<RunRow> = {}): RunRow`). Import `selectActivityRuns` from `@renderer/view-models/activity-runs.js`.

Cases that lock acceptance 1–2:

- Empty `projectId` → `[]` even if `runs` is non-empty.
- Two projects, each with live + finished rows: selecting A returns only A's live (newest first) then A's finished (newest first, capped); selecting B returns only B's.
- A live run whose `projectId` is not the selection does not appear.
- More than 5 finished in the selected project: only the 5 newest (`endedAt ?? startedAt`); older finished dropped.
- All live runs in the selected project are kept (no live cap), ahead of finished.
- Custom `recentLimit` is honoured.

### `apps/desktop/tests/renderer/sidebar-emblems.test.ts`

Keep `it('keeps Activity hidden when the rail is collapsed')` asserting `/!collapsed && pipelineRuns\.length > 0/`.

Add a wiring assert in the same `Sidebar wiring` describe (source of `sidebarSrc` is already loaded):

- `sidebarSrc` does not contain `useAllProjectRuns`.
- `sidebarSrc` contains `useActivityRuns(projectId)` (or a tight regex of that call).
- `sidebarSrc` does not contain `selectProject(run.projectId)`.

### `apps/desktop/tests/renderer/design-navigation.test.ts`

Keep the existing testid asserts (`data-testid={`sidebar-run-${run.runId}`}` at ~228–232 and ~257–263).

Add one example, e.g. `it('scopes sidebar Activity to the selected project')`, that reads `sidebarSrc` and asserts:

- no `useAllProjectRuns`;
- `useActivityRuns(projectId)` (selected-project id, not a projects fan-out);
- no `selectProject(run.projectId)`;
- click still calls `onOpenInspector?.(run.runId)`;
- meta uses `run.pipelineName` and does **not** look up `projects.find((p) => p.id === run.projectId)`;
- testid `sidebar-run-${run.runId}` still present.

Do not add Playwright coverage for the two-project matrix. Existing e2e against a single-project fixture must keep working unchanged.

## 5. Operator-facing copy

### `.factory/skills/foundry-ui/SKILL.md`

Lines 410–412 currently say:

> the Activity list while runs exist: one row per recent run across projects,
> `data-testid="sidebar-run-{runId}"`, each opening that run pinned in the
> Inspector.

Rewrite to selected-project wording, e.g. one row per live + recent run **of the currently selected project**; hidden when the rail is collapsed or there are no rows; click pins Inspector and does not change the project picker. Keep the `sidebar-run-{runId}` selector.

The table at line 215 (`Activity row → opens run pinned in Inspector`) can stay; it does not claim all-projects.

No other docs. `specs/` and `.factory/docs/` are historical.

## 6. PR / commit

The change is operator-visible. Commit and PR body must say Activity is now the selected project's live + recent runs, not an all-projects feed, and that row click no longer switches projects.

Suggested subject (≤72 chars):

`Scope sidebar Activity to the selected project's runs`

Suggested body:

```
Sidebar Activity listed live and recent runs from every project, polled
each trace DB, labelled the source project, and called selectProject on
click. It now follows useApp().projectId only: live runs plus five
finished, hidden when collapsed or empty, Inspector pin unchanged.
```

## Verification

From the repo root (worktree):

```bash
npm test
npm run typecheck
npm run lint
```

All three must pass.

Targeted while iterating:

```bash
npx vitest run apps/desktop/tests/renderer/activity-runs.test.ts apps/desktop/tests/renderer/sidebar-emblems.test.ts apps/desktop/tests/renderer/design-navigation.test.ts
```

Do not run e2e as a gate for this change. If you do, `inspector.spec.ts` / `smith.spec.ts` still click `sidebar-run-${fixture.runId}` on a single-project seed.

Manual check (not required for the phase, but this is the acceptance matrix):

1. Two projects with runs: select A → Activity shows only A's live + recent; select B → only B's; with no projects, Activity is absent.
2. A live run in the non-selected project does not appear.
3. Collapse the rail → Activity hidden; expand with rows → testids present; click a row → Inspector opens on that run and the project picker does not change.

## Implementation notes

- `projectId` from `useApp()` is `project?.id ?? ''`, and `project` is `projects.find(id === selectedProjectId) ?? projects[0] ?? null`. Using `selectedProjectId` alone would hide Activity when the stored id is empty but `projects[0]` is still selected in the picker.
- Two `useRunList` instances (Sidebar via `useActivityRuns`, Inspector via its own call) may poll the same project while Inspector is open. That is acceptable; do not introduce a shared cache.
- Keep `recentLimit` default 5 at both `selectActivityRuns` and `useActivityRuns` so callers can omit it.
- CSS modules (`Sidebar.module.css`) need no change; class names stay `runsSection` / `runItem` / `runMeta` / `runName`.
