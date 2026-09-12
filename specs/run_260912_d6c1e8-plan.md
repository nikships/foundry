# Plan — Smith full user-level access via text + voice (run_260912_d6c1e8)

## 0. Objective

Expand Smith (text chat + Live Voice) to full user-level access for:

1. **Initiating orchestrator prompts** (plan / message / cancel / list / get / accept / discard).
2. **Checking Linear tickets for current assigned work + status** (assignee-aware search + detail + workflow states + `linear_start`).
3. **Running saved pipelines** (already exists — verify, document, add assigned-work→pipeline happy path; no new channel).
4. Any other seam needed for parity: `smith_projects.refresh_context`, `smith_providers.gemini_live_*`.

Observable behavior on completion: every named capability is invocable from both Smith text chat and Smith Live Voice (`smith_work` → same `SmithChatSession`), gated by the existing immediate/approval/secure proposal model, with scope, risks/edge cases, and acceptance evidence.

**No new voice domain tools.** Voice is an audio facade over text (see §2). All work lands in `smith_runs` / `smith_projects` / `smith_providers` + Linear stack.

---

## 1. Evidence-backed survey (what Smith can / cannot do today)

Sources inspected in this worktree (all paths relative to repo root):

| Capability | Text today | Voice today | Evidence |
|---|---|---|---|
| Run saved pipeline (`start`) | ✅ immediate-gated approval | ✅ via `smith_work` → proposal → `smith_proposal_read`/`smith_proposal_answer` | `apps/desktop/src/main/smith/run-tools.ts:33-50` (`start`, `linear_start` in `SMITH_RUN_OPERATIONS` + `ACTION_CHANNELS` → `IPC.runsStart` / `IPC.linearStartRun`); `run-tools.ts:195-205` `resolveGatedArgs` requires `pipelineId+request` / `pipelineId+issueId`; pipeline discovery via `smith_list(kind:'pipeline')` in `entity-tools.ts:30-40` + `smith_show`. Voice path: `apps/desktop/src/renderer/view-models/smith-voice-view.ts:33-46` (`smith_work` routes "runs, pipelines, agents, projects…"), `apps/desktop/src/renderer/hooks/useSmithVoice.ts:18-36`. |
| Linear issue inspection (`linear_issues` / `linear_issue` / `linear_workflow_states`) | ✅ immediate reads | ✅ via `smith_work` | `run-tools.ts:55-120` (`isLinearRunReadOperation` + `linearRunRead` → `IPC.linearIssues` / `IPC.linearIssue` / `IPC.linearWorkflowStates`); `apps/desktop/src/main/ipc/linear.ts:35-52` zod-validated handlers; `apps/desktop/src/main/linear/client.ts:112-120` `RECENT_ISSUES_QUERY` + `SEARCH_ISSUES_QUERY`. |
| Linear **assigned-to-me** filter + assignee identity | ❌ missing | ❌ missing (same tool) | `client.ts:80-120`: `ISSUE_SUMMARY_FIELDS`/`ISSUE_FIELDS` have **no** `assignee { … }`; `LinearClient.issues(query)` (line 163) only branches recent vs. search, never `assignee:{isMe:{eq:true}}`. `apps/desktop/src/shared/types.ts:737-750` `LinearIssueSnapshot` has **no** `assignee` field. So Smith can search by key/title but cannot answer "what is assigned to me". |
| Orchestrator prompts (plan/message/cancel/list/get/accept/discard) | ❌ completely missing from executable tools | ❌ missing (same tool) | `apps/desktop/src/main/smith/capability-coverage.ts:159-166` declares 7 mappings (`orchestrator_plan`, `orchestrator_message`, `orchestrator_cancel` → approval; `orchestrator_list`, `orchestrator_get` → read; `orchestrator_accept`, `orchestrator_discard` → approval; all `tool:'smith_runs'`). But `run-tools.ts:15-50` `SMITH_RUN_OPERATIONS` omits all 7, so `parseOperation` rejects them (`unknown operation`). IPC exists and works from UI: `apps/desktop/src/shared/ipc-contract.ts:812-851` + `apps/desktop/src/main/ipc/orchestrator.ts:28-113`. |
| Project `refresh_context` | ❌ missing | ❌ missing | `capability-coverage.ts:63` = `approve('smith_projects','refresh_context')` for `IPC.projectsRefreshContext`, but `apps/desktop/src/main/smith/project-tools.ts:16-42` `SMITH_PROJECT_OPERATIONS` omits `refresh_context` and `ACTIONS` has no entry. |
| Provider `gemini_live_state` / `gemini_live_set_api_key` / `gemini_live_clear_api_key` | ❌ missing | ❌ missing (voice-key seam) | `capability-coverage.ts:126-128` maps them under `smith_providers`, but `apps/desktop/src/main/smith/provider-tools.ts:14-30` `SMITH_PROVIDER_OPERATIONS` omits all `gemini_live_*`. Note `geminiLiveMintToken` (line 129, `secure`) is intentionally **excluded** from Smith tools — renderer-only mint, key never crosses seam. Do NOT add it. |
| Voice plumbing | ✅ facade works | ✅ | `useSmithVoice.ts:1-50` header comment + `smith-voice-view.ts:17-68` declares exactly 4 sync tools (`smith_work`, `smith_cancel`, `smith_proposal_read`, `smith_proposal_answer`). `settledWorkPrompt` injects settled Smith text back into Live session. Expanding Smith text tools automatically empowers voice. Secret proposals rejected over audio: `useSmithVoice.ts:198-212` (`secretRequest` → masked desktop card; Android `SmithVoiceTools.kt:49` validates same). |
| Present artifacts multimodally | ✅ | ✅ | `apps/desktop/src/main/smith/present-tools.ts:33-65` 15 kinds (`pipeline_design`, `run_summary`, etc.) render cards in transcript without approval; in voice they appear on desktop while voice narrates summary. No change needed; use for orchestrator/Linear summaries. |

**Conclusion:** Running saved pipelines already works (contrary to request premise — verify, don't rebuild). The real gaps are (a) 7 orchestrator ops, (b) Linear assignee awareness, (c) `refresh_context`, (d) `gemini_live_*` (minus mint).

---

## 2. Architecture notes the builder must respect

- **Process separation:** `shared/ipc-contract.ts` → `main/ipc/*` → `preload/bridge.ts` → `renderer/api.ts`. No generic channel passthrough. Renderer never imports `fs`/`child_process`/`electron`/`src/main`. Preload imports only shared contracts. Shared stays process-neutral. (ESLint zone rules enforce.)
- **Smith tool pattern** (`apps/desktop/src/main/smith/tool-helpers.ts`): `immediate(deps, channel, …args)` for reads; `proposeAction(deps, {operation,title,summary,args,risk,execute,secretRequest?})` for gated writes. `rejectSecretFields(params)` must stay first in provider tools. `RISKS` badges: `write` default, `destructive`/`git`/`external`/`credential`/`shell` where warranted.
- **Voice delegation:** Do NOT add domain tools to `voiceToolDeclarations()` or `VOICE_TOOLS`. Voice calls `smith_work(text)` → `SmithChatSession` (operator-selected model) → same `smith_runs`/`smith_projects`/`smith_providers` tools → proposal queue → `smith_proposal_read`/`smith_proposal_answer` for approval. Long orchestrator turns: `orchestrator_plan` returns `{planId}` immediately; progress arrives on `orchestrator-progress`; Smith later uses `orchestrator_get` to narrate status. Secrets (Bridge/Linear/Tavily/Gemini keys) are never spoken; voice approval of a `secretRequest` proposal must direct operator to desktop masked card.
- **`capability-coverage.ts` is docs-only**, not a router. Runtime dispatch uses typed domain tools. But `apps/desktop/tests/main/smith/smith-capability-coverage.test.ts` asserts every non-`smith:`/`event:` IPC channel is classified exactly once — so any new/changed IPC signature must keep coverage in sync (no new channels needed here except possibly none; verify test still passes).
- **Single Electron-instance lock, SQLite via Tracer, `resolveEnv`/`spawnEnv`** — untouched by this plan.

---

## 3. Implementation — ordered work items

### Work item A — Orchestrator operations in `smith_runs` (highest priority)

**File:** `apps/desktop/src/main/smith/run-tools.ts`

**A1. Extend `SMITH_RUN_OPERATIONS`** (after `'linear_start'`, keep alpha-ish grouping):

```ts
export const SMITH_RUN_OPERATIONS = [
  ...RUN_AGENT_OPERATIONS,
  'list',
  // ... existing ...
  'linear_start',
  'orchestrator_plan',
  'orchestrator_message',
  'orchestrator_cancel',
  'orchestrator_list',
  'orchestrator_get',
  'orchestrator_accept',
  'orchestrator_discard',
] as const;
```

**A2. Extend type aliases:**

```ts
type OrchestratorReadOperation = 'orchestrator_list' | 'orchestrator_get';
type RunActionOperation = Exclude<
  RunOperation,
  'list' | 'live_tail' | RunReadOperation | LinearRunReadOperation | OrchestratorReadOperation | RunAgentOperation
>;
```

Add to `ACTION_CHANNELS: Record<RunActionOperation,string>`:

```ts
orchestrator_plan: IPC.orchestratorPlan,
orchestrator_message: IPC.orchestratorMessage,
orchestrator_cancel: IPC.orchestratorCancel,
orchestrator_accept: IPC.orchestratorAccept,
orchestrator_discard: IPC.orchestratorDiscard,
```

Add to `RISKS: Partial<Record<RunOperation, SmithActionRisk>>`:

```ts
orchestrator_plan: 'write',      // spends an agent turn on operator model (coverage comment)
orchestrator_message: 'write',   // same
orchestrator_cancel: 'write',
orchestrator_accept: 'write',    // creates run exactly-once via proposals.accept
orchestrator_discard: 'destructive',
```

**A3. Extend tool JSON-schema `parameters.properties`:**

```ts
prompt: { type: 'string' },          // reuse existing `text`? see A4 — use `prompt` for plan text, `text` for follow-up
model: { type: 'string' },
reasoningEffort: { type: 'string', enum: ['low','medium','high'] },
planId: { type: 'string' },
plan: { type: 'object' },           // operator overrides for accept (GeneratedRunPlan)
```

Keep `additionalProperties:false`, `required:['operation']`. Reuse existing `projectId`, `text` fields where present; add only missing ones (`planId`, `model`, `reasoningEffort`, `prompt`, `plan`).

**A4. Dispatch logic in `smithRunsTool().execute`:**

- After `if (isLinearRunReadOperation(...))` add:

```ts
if (isOrchestratorReadOperation(op)) return orchestratorRead(deps, op, params, projectId);
```

where `projectId` is the already-resolved scope (`requireProjectId`). Implement:

```ts
function isOrchestratorReadOperation(op: RunOperation): op is OrchestratorReadOperation {
  return op === 'orchestrator_list' || op === 'orchestrator_get';
}
function orchestratorRead(deps, op, params, projectId) {
  if (op === 'orchestrator_list') return immediate(deps, IPC.orchestratorList, projectId);
  const planId = stringField(params, 'planId');
  return planId
    ? immediate(deps, IPC.orchestratorGet, planId)
    : Promise.resolve(json({ ok:false, error:'planId is required' }));
}
```

Note `orchestrator_list` is project-scoped (handler takes `projectId`), `orchestrator_get` is global by `planId` (see `orchestrator.ts:94-100`). Place the `requireProjectId` scope resolution **before** this branch (it already is for list path) — `orchestrator_list` needs it; `orchestrator_get` tolerates it (All-projects scope must supply explicit `projectId` per `requireProjectId` semantics — acceptable; document in description that `projectId` is required for list, optional-but-harmless for get).

- Gated actions go through existing `resolveGatedArgs` + `proposeAction` tail. Extend `resolveGatedArgs` with (before the generic `runId` fallthrough):

```ts
if (op === 'orchestrator_plan') {
  const prompt = stringField(params,'prompt') ?? stringField(params,'request') ?? stringField(params,'text');
  if (!prompt) return { ok:false, error:'prompt is required' };
  const model = stringField(params,'model');               // optional override
  const reasoningEffort = stringField(params,'reasoningEffort'); // optional, validate enum
  if (reasoningEffort && !['low','medium','high'].includes(reasoningEffort))
    return { ok:false, error:'reasoningEffort must be low, medium, or high' };
  // model/effort resolved at execute-time (see A5); shownArgs records what model asked
  const shownArgs = { projectId, prompt, ...(model?{model}:{}), ...(reasoningEffort?{reasoningEffort}:{}) };
  return { ok:true, args:[projectId, prompt, model ?? null, reasoningEffort ?? null], shownArgs };
}
if (op === 'orchestrator_message') {
  const planId = stringField(params,'planId');
  const text = stringField(params,'text');
  if (!planId || !text) return { ok:false, error:'planId and text are required' };
  return { ok:true, args:[planId, text], shownArgs:{ planId, text } };
}
if (op === 'orchestrator_cancel' || op === 'orchestrator_discard') {
  const planId = stringField(params,'planId');
  if (!planId) return { ok:false, error:'planId is required' };
  return { ok:true, args:[planId], shownArgs:{ planId } };
}
if (op === 'orchestrator_accept') {
  const planId = stringField(params,'planId');
  if (!planId) return { ok:false, error:'planId is required' };
  const plan = field(params,'plan'); // optional GeneratedRunPlan override
  if (plan !== undefined && (typeof plan !== 'object' || plan === null))
    return { ok:false, error:'plan must be an object' };
  const input = plan === undefined ? { planId } : { planId, plan };
  return { ok:true, args: plan === undefined ? [planId] : [planId, plan], shownArgs: input };
}
```

**A5. Model/effort default resolution for `orchestrator_plan`.** `IPC.orchestratorPlan` requires `(projectId, prompt, model, reasoningEffort, images?)`. The tool must not force the model to guess. In the `proposeAction.execute` closure for `orchestrator_plan` (custom-case it rather than using generic `ACTION_CHANNELS` spread), resolve:

```ts
execute: async () => {
  let model = <from gated args>;
  let effort = <from gated args>;
  if (!model || !effort) {
    try {
      const state = await deps.invoke(IPC.smithState, projectId); // SmithChatState | null
      model = model ?? (state as any)?.model ?? (state as any)?.activeModel;
      effort = effort ?? (state as any)?.reasoningEffort ?? (state as any)?.activeReasoningEffort;
    } catch { /* fall through to settings */ }
  }
  if (!model || !effort) {
    const settings = await deps.invoke(IPC.settingsGet); // AppSettings
    model = model ?? (settings as any)?.defaultModel;
    effort = effort ?? (settings as any)?.defaultReasoningEffort;
  }
  return deps.invoke(IPC.orchestratorPlan, projectId, prompt, model, effort);
}
```

If settings lookup feels too broad, alternative accepted: require `model`+`reasoningEffort` and return `prompt/model/reasoningEffort are required` — but prefer fallback chain above (matches renderer `useOrchestratorPlan.ts:198-203` which uses current choice, itself defaulted from settings). Do NOT accept `images` from Smith (no image attachment path in chat tool); omit `images` arg (handler param is optional).

**A6. Update tool `description`** to document new ops, e.g. append: `orchestrator_plan(projectId?,prompt,model?,reasoningEffort?) starts a planning session and returns planId immediately (progress on orchestrator-progress); orchestrator_list(projectId?) / orchestrator_get(planId) read proposals; orchestrator_message(planId,text) follows up; orchestrator_accept(planId,plan?) creates the run exactly-once; orchestrator_cancel/orchestrator_discard(planId) abandon.`

**A7. Guardrails:** `orchestrator_accept` must route only through `IPC.orchestratorAccept` (never `IPC.runsStart` directly) — comment cites exactly-once `accepted_run_id` key (`orchestrator.ts:102-111`). `orchestrator_discard` on `accepted` rows returns `false` (idempotent) — surface result verbatim, do not retry as cancel.

**Verify A:** `npx vitest run apps/desktop/tests/main/smith/smith-run-pr-tools.test.ts` (extended, see §5) + manual `smith_runs({operation:'orchestrator_plan',…})` → proposal → approve → `{planId}`; `orchestrator_list`/`orchestrator_get` return rows.

---

### Work item B — Linear "my work + status" (assignee awareness)

**Files (in order):**

**B1. `apps/desktop/src/shared/types.ts` — extend `LinearIssueSnapshot` (after `state` field, ~line 746):**

```ts
/** Assignee when Linear returned one; null when unassigned; omitted on older snapshots. */
assignee?: { id: string; name: string } | null;
```

Keep optional+nullable for backward compat with persisted snapshots/traces (`trace/run-source.test.ts` fixtures must keep passing).

**B2. `apps/desktop/src/main/linear/client.ts`:**

- Extend `RawIssue` with `assignee?: { id?: unknown; name?: unknown } | null`.
- Add `assignee { id name }` to `ISSUE_SUMMARY_FIELDS` (so both summary + full queries gain it via interpolation).
- Extend `parseIssue` to include `assignee: parseAssignee(issue.assignee)` with:

```ts
function parseAssignee(a: RawIssue['assignee']): LinearIssueSnapshot['assignee'] {
  if (!a) return null;
  const id = typeof a.id === 'string' ? a.id : '';
  const name = typeof a.name === 'string' ? a.name.trim() : '';
  if (!id || !name) return null;
  return { id, name };
}
```

- Add assigned-only query. Preferred: single parametrized approach — add

```ts
const ASSIGNED_ISSUES_QUERY = `
  query LinearAssignedIssues($query: String) {
    issues(first: 25, filter: { and: [
      { assignee: { isMe: { eq: true } } },
      { or: [
        { identifier: { containsIgnoreCase: $query } },
        { title: { containsIgnoreCase: $query } }
      ] }
    ] }) { nodes { ${ISSUE_SUMMARY_FIELDS} } }
  }
`;
const ASSIGNED_RECENT_QUERY = `
  query LinearAssignedRecent {
    issues(first: 25, filter: { assignee: { isMe: { eq: true } } }) {
      nodes { ${ISSUE_SUMMARY_FIELDS} }
    }
  }
`;
```

(Simplify: if Linear rejects `$query:null` with `containsIgnoreCase`, use two queries and branch. Builder: test against mock transport first, then live key if available. Fallback accepted: `{ assignee: { isMe: { eq: true } } }` combined via `and` with the existing `or` only when trimmed query non-empty.)

- Change signature: `async issues(query = '', options?: { assignedOnly?: boolean })`. Branch:
  - `assignedOnly && trimmed` → `ASSIGNED_ISSUES_QUERY` with `{query: trimmed}`
  - `assignedOnly && !trimmed` → `ASSIGNED_RECENT_QUERY` with `{}`
  - else existing behavior.
- Keep `issue(id)` unchanged (now returns assignee too via `ISSUE_FIELDS` interpolation).

**B3. `apps/desktop/src/main/linear/service.ts` (`issues` method ~line 54):**

```ts
issues(query: string, options?: { assignedOnly?: boolean }): Promise<LinearIssueSnapshot[]> {
  return this.client().issues(query, options);
}
```

**B4. `apps/desktop/src/main/ipc/linear.ts` (`IPC.linearIssues` handler ~line 35):**

```ts
handle(IPC.linearIssues, (query: string, options?: { assigned?: boolean }): Promise<LinearIssueSnapshot[]> => {
  const parsed = z.string().trim().max(200).safeParse(query);
  if (!parsed.success) throw new Error('Linear issue search must be 200 characters or fewer');
  const assigned = options === undefined ? false : z.object({ assigned: z.boolean().optional() }).safeParse(options).success ? (options as {assigned?:boolean}).assigned ?? false : false;
  // Simpler preferred form:
  // const opts = z.object({ assigned: z.boolean().optional() }).safeParse(options ?? {}); 
  // return ctx.linear.issues(parsed.data, { assignedOnly: opts.success ? (opts.data.assigned ?? false) : false });
  return ctx.linear.issues(parsed.data, { assignedOnly: assigned });
});
```

Keep backward compat: single-string callers (renderer, existing Smith tool) still work; second arg optional. Validate with zod, never throw on absent options.

**B5. `apps/desktop/src/shared/ipc-contract.ts` (`linear.issues` ~line 709-710):** update signature + doc:

```ts
/** Empty query browses recent accessible issues; text filters key/title. `assigned:true` limits to viewer. */
issues(query: string, options?: { assigned?: boolean }): Promise<LinearIssueSnapshot[]>;
```

This is a type-only additive change; `MainInvoker`/`preload`/`api` pass-through needs no logic change (verify `apps/desktop/src/renderer/api.ts` linear section forwards `...args`).

**B6. `apps/desktop/src/main/smith/run-tools.ts` — expose in `smith_runs`:**

- Add `assigned: { type:'boolean' }` to `parameters.properties`.
- In `linearRunRead`, `linear_issues` branch:

```ts
if (op === 'linear_issues') {
  const query = field(params,'query');
  if (query !== undefined && typeof query !== 'string')
    return Promise.resolve(json({ ok:false, error:'query must be a string' }));
  const assigned = field(params,'assigned');
  if (assigned !== undefined && typeof assigned !== 'boolean')
    return Promise.resolve(json({ ok:false, error:'assigned must be a boolean' }));
  return immediate(deps, IPC.linearIssues, query ?? '', assigned ? { assigned:true } : undefined);
  // If immediate() with trailing undefined drops arg, use explicit branch:
  // return assigned ? immediate(deps, IPC.linearIssues, query ?? '', { assigned:true })
  //                  : immediate(deps, IPC.linearIssues, query ?? '');
}
```

Check `immediate()` spread semantics before choosing form (must preserve single-arg call when `assigned` falsy so old main handlers/tests with 1-arg mock still match).

- Update `smith_runs` description: `linear_issues(query?,assigned?) — assigned:true limits to issues assigned to the Linear viewer (my work); …`.

**B7. Status determination:** no new tool needed — `state {id name type}` + `labels` + `comments` already returned. Document the recommended Smith prompt pattern in description: "to report status, call `linear_issues` (or with `assigned:true`), then `linear_issue(issueId)` for detail and `linear_workflow_states(teamId)` to interpret `state.type`." No code beyond B6.

**Verify B:** `npx vitest run apps/desktop/tests/main/linear/client.test.ts apps/desktop/tests/main/ipc/linear.test.ts apps/desktop/tests/shared/linear.test.ts`; new cases: assignee parsed, `assigned:true` sends `isMe` filter, backward-compat single-arg call.

---

### Work item C — Project seam: `refresh_context`

**File:** `apps/desktop/src/main/smith/project-tools.ts`

- Add `'refresh_context'` to `SMITH_PROJECT_OPERATIONS`.
- Add to `ACTIONS`: `refresh_context: { channel: IPC.projectsRefreshContext, risk: 'write', args: PROJECT_ID },` (risk `write` per coverage `approve`; check handler — context refresh recomputes cached card, no shell/git).
- Update `smithProjectsTool` description string to include `refresh_context(projectId)`.
- No `READS` entry (it's gated, not immediate).

**Verify C:** extend `apps/desktop/tests/main/smith/smith-project-tools.test.ts` — `refresh_context` proposes with `{projectId}` and invokes `IPC.projectsRefreshContext`.

---

### Work item D — Provider seam: `gemini_live_*` (voice-key management)

**File:** `apps/desktop/src/main/smith/provider-tools.ts`

- Add to `SMITH_PROVIDER_OPERATIONS`: `'gemini_live_state'`, `'gemini_live_set_api_key'`, `'gemini_live_clear_api_key'`. Do NOT add `gemini_live_mint_token`.
- Extend types:

```ts
type GeminiLiveProviderOperation = Extract<ProviderOperation, `gemini_live_${string}`>;
```

Include it in the early-return chain alongside linear/tavily:

```ts
if (isGeminiLiveProviderOperation(op)) return geminiLiveProviderOperation(deps, op);
```

Implement mirroring `linearProviderOperation`:

```ts
function isGeminiLiveProviderOperation(op: ProviderOperation): op is GeminiLiveProviderOperation {
  return op.startsWith('gemini_live_');
}
function geminiLiveProviderOperation(deps, op: GeminiLiveProviderOperation) {
  if (op === 'gemini_live_state') return immediate(deps, IPC.geminiLiveState);
  const channel = {
    gemini_live_set_api_key: IPC.geminiLiveSetApiKey,
    gemini_live_clear_api_key: IPC.geminiLiveClearApiKey,
  }[op];
  const label = op.replaceAll('_',' ');
  return proposeAction(deps, {
    operation: op, title: label, summary: `${label}.`, args: {},
    risk: op === 'gemini_live_set_api_key' ? 'credential' : 'credential',
    ...(op === 'gemini_live_set_api_key' ? { secretRequest: {
      kind:'api-key' as const, label:'Gemini API key for Live Voice',
      placeholder:'Enter Gemini API key' } } : {}),
    execute: (secret) => op === 'gemini_live_set_api_key'
      ? deps.invoke(channel, secret) : deps.invoke(channel),
  });
}
```

- Ensure `rejectSecretFields(params)` stays first (already is) so model can never inline the key.
- Update `smithProvidersTool` description to list new ops + note "key entered only in masked card; voice cannot speak secrets."

**Verify D:** extend `apps/desktop/tests/main/smith/smith-provider-companion-tools.test.ts` (or create `smith-provider-gemini-live.test.ts` if cleaner): state is immediate; set/clear propose with correct risks + `secretRequest` on set.

---

### Work item E — Voice parity (no code except prompts/tests)

- **No changes** to `voiceToolDeclarations()`, `VOICE_TOOL_NAMES`, `useSmithVoice.ts`, `gemini-live/service.ts`, Android `SmithVoiceTools.kt`. Confirm by grep that no domain operation is duplicated in voice layer.
- **System prompt:** check `apps/desktop/src/main/smith/smith-system-prompt.ts` (and any `SMITH_*_PROMPT` constants). If it enumerates `smith_runs` operations, append the 8 new operation names (`orchestrator_*` ×7 + `linear_issues.assigned`) + one-line usage ("for 'my tickets' pass `assigned:true`; for 'start planning X' use `orchestrator_plan` then poll `orchestrator_get`"). If prompt is generated from tool definitions, no edit needed — verify.
- **Present:** use `smith_present` for orchestrator/Linear summaries in voice (card on desktop + spoken summary). No code change; cover in acceptance script.

---

### Work item F — Docs / discoverability (small, required)

- If repo has Smith tool docs consumed by `npm run check:docs` (check `scripts/check-docs.mjs` allowlist), update the corresponding markdown (likely `references/` or `apps/desktop/src/main/smith/README.md` if present — locate via `grep -r "linear_start" --include="*.md"`). At minimum update the three tool `description` strings (A6/B6/C/D) since those are the model-facing docs.
- Do NOT change `capability-coverage.ts` mappings (they already anticipate the new ops). Verify `uncoveredSmithInvokeChannels()` still returns `[]`.

---

## 4. Tests to add / update (builder must implement)

1. `apps/desktop/tests/main/smith/smith-run-pr-tools.test.ts`:
   - `orchestrator_list` → `invoke` called with `(IPC.orchestratorList, 'session')`; missing `projectId` in All-scope errors.
   - `orchestrator_get` → `(IPC.orchestratorGet, planId)`; missing `planId` errors.
   - `orchestrator_plan` missing `prompt` errors; valid proposes with risk `write`, approve invokes `(IPC.orchestratorPlan, projectId, prompt, model, effort)` with fallback defaults mocked via `invoke` for `IPC.smithState`/`IPC.settingsGet`.
   - `orchestrator_message`/`cancel`/`accept`/`discard` propose + approve paths; `accept` without `plan` calls single-arg form; with `plan` object passes through; `discard` risk `destructive`.
   - `linear_issues` with `{assigned:true}` forwards options; without stays single-arg; non-boolean `assigned` errors.
   - Unknown-op still `unknown operation`; `SMITH_RUN_OPERATIONS` contains 7 new names.
2. `apps/desktop/tests/main/linear/client.test.ts`: assignee parsed (`{id,name}`), `null` when absent, `assignedOnly:true` sends `isMe` filter (assert request body contains `isMe`), recent vs search branching preserved.
3. `apps/desktop/tests/main/ipc/linear.test.ts`: `linear:issues` accepts `(query)` and `(query,{assigned:true})`; invalid query still throws; invalid options default to `false` not throw.
4. `apps/desktop/tests/main/smith/smith-project-tools.test.ts`: `refresh_context` approval path.
5. Provider tests: `gemini_live_state` immediate; `gemini_live_set_api_key` proposes with `secretRequest.kind==='api-key'`; `gemini_live_clear_api_key` proposes; `rejectSecretFields` still blocks inline `apiKey` param.
6. `renderer/smith-voice-view.test.ts`: no new voice tools (assert declaration names still exactly the 4); `settledWorkPrompt` folds an orchestrator `planId` answer (regression: long-turn narration path).
7. Existing suites must stay green: `smith-capability-coverage.test.ts`, `shared/linear.test.ts`, `trace/*`, `main/ipc/smith-router.test.ts`.

---

## 5. Verification (exact commands, from repo root in this worktree)

```bash
npm run typecheck
npm run lint
npx vitest run apps/desktop/tests/main/smith/smith-run-pr-tools.test.ts \
  apps/desktop/tests/main/linear/client.test.ts \
  apps/desktop/tests/main/ipc/linear.test.ts \
  apps/desktop/tests/main/smith/smith-capability-coverage.test.ts \
  apps/desktop/tests/main/smith/smith-project-tools.test.ts
npm run test:coverage   # authoritative; must stay green
npm run build           # electron-vite build must pass
```

Manual acceptance script (text chat, then repeat by voice via `smith_work`):

1. `smith_runs(operation:'linear_issues', assigned:true)` → only my tickets, each with `assignee`, `state`, `team`.
2. `smith_runs(operation:'linear_issue', issueId:'<one id>')` → title/status/comments; `linear_workflow_states(teamId)` interprets status.
3. `smith_runs(operation:'orchestrator_plan', projectId:'<id>', prompt:'Draft plan to fix <ticket>')` → approval card → approve → `{planId}` immediately; `orchestrator_get(planId)` polls; `orchestrator_message(planId,'prefer X')`; `orchestrator_accept(planId)` creates run exactly-once (double-accept returns same run); `orchestrator_discard` on a second plan tombstones.
4. `smith_runs(operation:'start', projectId, pipelineId, request)` and `linear_start(projectId,pipelineId,issueId)` still work (saved-pipeline regression).
5. `smith_projects(operation:'refresh_context', projectId)` proposes + refreshes.
6. `smith_providers(operation:'gemini_live_state')` reads; `gemini_live_set_api_key` raises masked card (never inline); voice attempt is redirected to desktop card.
7. Voice: speak "what's assigned to me?", "start planning X", "run pipeline Y" → `smith_work` handles, proposals read aloud via `smith_proposal_read`, approved via `smith_proposal_answer`, long plan narrated on settle.

---

## 6. Scope, risks & edge cases

- **Scope:** text+voice parity for orchestrator/Linear/pipelines + the two small seam alignments. No new IPC channels, no new voice tools, no Android changes, no Linear mutation beyond existing `linearStartRun`/`updateIssueState` paths.
- **Cost surprise:** `orchestrator_plan`/`message` spend operator-model turns — hence `approval` + `write` risk, never `immediate`. System prompt must tell Smith to confirm prompt text before proposing a plan.
- **Async UX:** plan/message return immediately; result arrives on `orchestrator-progress`. Smith must return `planId` to user right away and offer to check status (`orchestrator_get`) rather than blocking. Voice must not claim outcome before settle push.
- **Exactly-once accept:** concurrent/double `orchestrator_accept(planId)` shares one run via `accepted_run_id`. Smith must not fall back to `runs:start` for proposals.
- **Discard semantics:** discarding `accepted` returns `false` — surface, don't retry. `cancel` only stops generation; row remains for `get`/`discard`.
- **Linear filters:** `isMe` depends on viewer token; unconfigured key → existing auth error path. Empty-result is valid (no assigned work), not an error. `containsIgnoreCase` with empty var — use separate recent query to avoid GraphQL null-filter rejection. Persisted old snapshots lack `assignee` — code must treat `undefined` as unknown, not unassigned.
- **Secrets:** `set_api_key` variants (Bridge/Linear/Tavily/Gemini) always use `secretRequest`; `rejectSecretFields` blocks model-supplied keys; voice layer rejects secrets over audio. `geminiLiveMintToken` stays renderer-only — never expose to Smith.
- **Model/effort:** invalid `reasoningEffort` string must error before proposal; unknown `model` id surfaces from handler (`{error}`), not the tool.
- **All-projects scope:** `orchestrator_list`/`linear_issues` need explicit scope handling — `requireProjectId` already errors helpfully; Smith prompt should ask for project when ambiguous.

---

## 7. Acceptance evidence (what the builder's envelope must show)

- `SMITH_RUN_OPERATIONS` includes 7 orchestrator ops; `linear_issues` accepts `assigned`; `SMITH_PROJECT_OPERATIONS` includes `refresh_context`; `SMITH_PROVIDER_OPERATIONS` includes 3 `gemini_live_*` (no mint).
- `LinearIssueSnapshot.assignee` present; `LinearClient.issues` sends `assignee:{isMe:{eq:true}}` when flagged; `IPC.linearIssues` second-arg backward compatible.
- New/updated Vitest suites listed in §4 pass; `npm run typecheck`, `npm run lint`, `npm run test:coverage`, `npm run build` green (or failures quoted with cause).
- Manual text + voice acceptance transcript for §5 steps 1-7 (planId, assigned ticket id, pipeline run id quoted).

---

## 8. Explicit non-goals

- No Linear write operations beyond existing `linear_start` (no status mutation tool, no comment tool).
- No orchestrator image attachments from Smith.
- No autonomous auto-accept of plans or auto-run of pipelines without proposal approval.
- No changes to `capability-coverage.ts` modes, no new IPC channels, no voice-tool additions, no Android companion changes.

---

## 9. Build order

1. B1→B2 (client+types) → B3→B4→B5 (service/IPC/contract) → B6 (tool) — test Linear first (independent).
2. A (orchestrator tool) — biggest, test second.
3. C + D (project/provider one-liners) — fast.
4. E + F (prompt/docs strings).
5. §4 tests + §5 verification + acceptance transcript.
