# FOU-350 Plan — Remove user-facing PR writer selector (run_260911_b00a2f)

## Goal

Remove the `prAgent` user-facing setting and all selector/search/picker/validation
plumbing built only for it, while keeping pipelines' explicitly named agents and all
automatic + manual PR behavior working. Legacy `settings.json` files containing
`prAgent` must still load, with the obsolete key discarded.

Out of scope (do NOT touch): removing all Foundry PR capability; the `pr_writer`
builtin agent; pipelines that name `agent: 'pr_writer'`; automatic PR recording
(`executor.ts`, `operations.ts`); manual PR draft helpers in `@shared/pr-draft.js`;
`apps/website` fixtures; `specs/` audit docs.

## File-by-file changes

### 1. `apps/desktop/src/shared/types.ts`

- Delete the constant + comment (currently ~lines 48–49):
  ```ts
  /** Default roster name for the PR writer setting. */
  export const DEFAULT_PR_AGENT = 'pr_writer';
  ```
- In `interface AppSettings` (~lines 309–315), delete the field + doc comment:
  ```ts
  /**
   * Roster name used when a pipeline (or later UI) needs a PR writer.
   * Defaults to the shipped `pr_writer` builtin.
   */
  prAgent: string;
  ```
- Leave everything from `// ── Pull requests (via the gh CLI)` down (`PullRequest`,
  `GhStatus`, `PR_TEMPLATE_SEARCH_PATHS`, `PR_FALLBACK_HEADINGS`, etc.) untouched.
- Leave `builtin-agents.ts` (`name: 'pr_writer'`) and `builtin-pipelines.ts`
  (`agent: 'pr_writer'`) untouched.

### 2. `apps/desktop/src/main/store/settings.ts`

- Line 10: change
  `import { DEFAULT_PR_AGENT, type AppSettings, type LinearStatusMapping } from '@shared/types.js';`
  to
  `import type { AppSettings, type LinearStatusMapping } from '@shared/types.js';`
  (keep existing style — type-only import).
- Delete lines ~20–21:
  ```ts
  /** Same shape a roster agent name has: the setting names one of them. */
  const PR_AGENT_NAME = /^[a-z][a-z0-9_-]*$/;
  ```
- In `appSettingsSchema` (~lines 28–31), delete:
  ```ts
  prAgent: z
    .string()
    .min(1)
    .regex(PR_AGENT_NAME, 'lowercase letters, digits, dash, underscore; must start with a letter'),
  ```
- In `defaultSettings()` (~line 62), delete `prAgent: DEFAULT_PR_AGENT,`.
- In `migrate()` (~lines 111–113), delete:
  ```ts
  if (!isNonEmptyString(merged.prAgent) || !PR_AGENT_NAME.test(merged.prAgent)) {
    merged.prAgent = DEFAULT_PR_AGENT;
  }
  ```
- Do NOT add a special-case strip for `prAgent`. `migrate()` builds `merged` from
  `{ ...base }` then copies only `Object.keys(base)`, so once `prAgent` is gone
  from `defaultSettings()` any stored legacy key is naturally dropped without a
  schema error. The existing `isNonEmptyString` helper stays (used by
  helper/healing/smith models).
- Do NOT touch `roster.ts` `SHIPPED_PR_WRITER` / `'pr_writer'` refresh logic.

### 3. `apps/desktop/src/renderer/view-models/pr-draft.ts`

- Current header comment says "Writer-picker options stay renderer-only." —
  update to reflect removal, e.g.:
  `Draft title/body live in '@shared/pr-draft' so the companion host cannot invent a different formula.`
- Delete `import type { AgentDef } from '@shared/types.js';`.
- Delete `export interface PrWriterOption`, `export function prWriterOptions(...)`,
  and `export function isKnownPrWriter(...)` (currently lines ~21–68).
- Keep the re-export block (`defaultPrBody`, `defaultPrTitle`, `manualPrDraft`,
  `prDraftFromEnvelope`, `selectPrEnvelope`, types) exactly as-is.

### 4. `apps/desktop/src/renderer/view-models/settings-search.tsx`

- `SETTINGS_PANES`, models entry (~line 40): remove `pr writer` from keywords.
  Current:
  `'model catalog hide reachable default helper healing reasoning effort smith chat pr writer compaction context retries'`
  becomes:
  `'model catalog hide reachable default helper healing reasoning effort smith chat compaction context retries'`
- `SETTINGS_SECTIONS` (~lines 176–180): delete the whole entry:
  ```tsx
  {
    pane: 'models',
    label: 'Pull requests',
    note: 'Who drafts a PR when a pipeline asks for one.',
    keywords: 'pr writer draft roster agent',
  },
  ```
- Leave `sectionId()`, `searchSettings()`, `paneMatchesQuery()` logic untouched.

### 5. `apps/desktop/src/renderer/screens/SettingsScreen.tsx`

- Line 27: delete
  `import { isKnownPrWriter, prWriterOptions } from '../view-models/pr-draft.js';`
- Delete the `Section` block (~lines 1846–1868):
  ```tsx
  <Section label="Pull requests" note="Who drafts a PR when a pipeline asks for one.">
    ... Field label="PR writer" ... Dropdown value={settings.prAgent}
    options={prWriterOptions(agents, settings.prAgent)} ... onChange={(next) => void set({ prAgent: next })} ...
  </Section>
  ```
  including the `isKnownPrWriter(...)` error prop ("Not in this project's roster…").
- Keep `import { Dropdown }` — still used at ~lines 2215, 2374. After deletion,
  run `npm run lint` / `typecheck`; if `agents` from `useApp()` destructuring
  (line 268) becomes unused elsewhere in the file, keep the destructuring only if
  still referenced — otherwise remove just that binding, not the whole hook call.
  (Grep shows `agents` referenced only at line 1855 in current file for this
  feature, so verify remaining usages before deciding.)

### 6. `apps/desktop/src/renderer/mockFoundry.ts`

- In `defaultMockSettings()` (~line 238), delete `prAgent: 'pr_writer',`.
- No other mock change; the mock `settings.patch` spread-merge keeps working with
  the narrower `AppSettings`.

### 7. `apps/desktop/tests/main/store/settings-store.test.ts`

- Line 12: delete `import { DEFAULT_PR_AGENT } from '../../../src/shared/types.js';`.
- Delete the whole `describe('prAgent', ...)` block (~lines 340–369: defaults,
  missing-field, custom writer, invalid-name, garbage-repair tests).
- Replace with a regression block, e.g. `describe('legacy prAgent', ...)`:
  1. `migrate({ ...defaultSettings(), prAgent: 'my_writer' })` (cast as
     `Record<string, unknown>` extra key) contains no `prAgent` key
     (`expect('prAgent' in migrated).toBe(false)`) and preserves other values.
  2. `seed()` a `settings.json` containing `prAgent: 'pr_writer'` (and one with
     garbage `prAgent: 'PR Writer'`) → `store.get()` loads without throwing and
     has no `prAgent` key.
  3. `store.patch({ prAgent: 'x' } as never)` is rejected or at minimum never
     persists `prAgent` — assert `'prAgent' in store.get()` is false after the
     attempt. Prefer asserting the patch path strips/ignores the unknown key
     consistent with zod strictness (check what `appSettingsSchema.safeParse`
     does with unknown keys; if it strips, `patch` succeeds but does not store;
     pin whichever behavior `safeParse` gives, but the key must never persist).
- Extend/keep the existing `describe('obsolete settings')` style: optionally add
  `'prAgent'` to a legacy-drop assertion alongside `terminalApp`/`codingAgent`,
  but keep the dedicated legacy block above as the primary coverage.

### 8. `apps/desktop/tests/renderer/pr-draft.test.ts`

- Lines ~6–9: remove `isKnownPrWriter` and `prWriterOptions` from the import,
  leaving `defaultPrBody, defaultPrTitle, manualPrDraft, prDraftFromEnvelope,
  selectPrEnvelope`.
- Delete the `describe('prWriterOptions', ...)` block (~lines 184–210), both `it`s.
- Keep all draft-helper tests untouched. Fixture strings such as
  `'Add a settings selector for the PR writer.'` are test-data titles for draft
  helpers, not the selector — leave them (do not churn test data).

### 9. Optional but recommended: `apps/desktop/tests/renderer/settings-search.test.ts`

- Add regression coverage that the selector is undiscoverable:
  ```ts
  expect(searchSettings('pr writer')).toEqual(
    expect.not.arrayContaining([expect.objectContaining({ sectionId: 'pull-requests' })]),
  );
  // stronger: no hit titled 'Pull requests' at all
  expect(searchSettings('pull requests').some((h) => h.title === 'Pull requests')).toBe(false);
  expect(searchSettings('pr writer').some((h) => h.title === 'Pull requests')).toBe(false);
  ```
- Existing `it.each` tables (`smith/reasoning effort/compaction`, retention/orphan)
  stay green; no other search test references the PR section today.

## What NOT to change

- `shared/builtin-agents.ts` (`pr_writer` agent), `shared/builtin-pipelines.ts`
  (`agent: 'pr_writer'`), `main/store/roster.ts` shipped-writer refresh,
  `main/engine/runners/agent.ts`, `executor.ts:945`, `operations.ts:340`,
  `@shared/pr-draft.js`, `main/ipc/prs.ts`, `RosterScreen.tsx:60` PR-writer label,
  `apps/website/**`, `specs/**` audit docs, `tests/main/engine/executor.test.ts`
  and `builtins.test.ts` / `pipelines-migrate.test.ts` / `roster-rename.test.ts`
  references to the `pr_writer` agent (those name the agent, not the setting).

## Verification (builder must run)

1. `rg -n "prAgent|DEFAULT_PR_AGENT|prWriterOptions|isKnownPrWriter|PR_AGENT_NAME" apps/desktop/src apps/desktop/tests`
   → expect zero matches. (A second pass with `PR writer` / `Pull requests`
   should show only intentional agent/roster/docs hits, never Settings UI,
   search registry, or settings schema.)
2. `npm run typecheck` — clean (catches leftover `settings.prAgent` reads,
   unused `agents` binding, stale imports).
3. `npm run lint` — clean (catches unused `Dropdown`/`AgentDef` imports if any).
4. Focused tests:
   `npx vitest run apps/desktop/tests/main/store/settings-store.test.ts`
   `npx vitest run apps/desktop/tests/renderer/pr-draft.test.ts`
   `npx vitest run apps/desktop/tests/renderer/settings-search.test.ts`
5. Full gate if time permits: `npm run check` (typecheck, lint, format:check,
   knip, test:coverage, build, check:css, check:docs, check:files,
   check:duplicate, audit:deps). At minimum run 2–4 plus a manual smoke:
   Settings → Models pane renders with no "Pull requests" section; rail search
   for "pr writer" yields no Pull-requests hit; a run on a builtin pipeline
   still opens its `open_pr` phase with the `pr_writer` agent and manual
   "Open PR…" draft helpers still produce title/body.
6. Legacy-settings manual check: write a temp `settings.json` with
   `"prAgent": "my_writer"` merged into current defaults, load via
   `SettingsStore.get()` / `migrate()` — loads fine, key absent afterwards.

## Ordering

1. Shared types → store (schema/defaults/migrate) → pr-draft view-model →
   settings-search → SettingsScreen → mockFoundry → tests.
2. Grep-verify zero forbidden tokens, then typecheck → lint → focused vitest →
   full check.
