# Plan: Paste images into the Orchestrator composer

## Goal

The Runs-screen Orchestrator chat box (`OrchestratedComposer` in `apps/desktop/src/renderer/screens/RunsScreen.tsx`, `data-testid="run-request"`) must accept pasted images, show removable previews, and send those pixels on every planning one-shot turn — including `PlanSession` correction retries — so the Orchestrator can actually see them.

## Non-goals

- Linear composer, Manual composer, Smith chat, Android companion planner.
- Companion HTTP `POST /v1/orchestrator/plans` stays text-only. Do not add an `images` field to `CompanionOrchestratorStartRequest`.
- Do not invent a new IPC channel. Optional 5th argument on existing `orchestrator:plan`. `apps/desktop/tests/main/ipc/ipc-surface.test.ts` must still see **134** invoke channels.
- Do not put image bytes on `OrchestratorState` / `orchestrator-progress`. That payload is cloned to the renderer.
- Do not write pasted images into the project checkout, a worktree, Application Support, or the trace DB.
- Do not log image payloads (no base64, no buffers).
- Do not import `@earendil-works/pi-ai` (or `/compat`). Pi types come only from `@earendil-works/pi-coding-agent` under `apps/desktop/src/main/pi/`.
- Do not add Playwright specs for clicking/pasting. Touch `apps/desktop/tests/e2e/runs.spec.ts` only if the stub would break; it should not.
- Do not call a model or the network in tests.
- Optional Pi `resizeImage` / `convertToPng`: skip. Main MIME/size caps are the required bound; those helpers pull Photon WASM and are not needed for this slice.

## Current behaviour (grounding)

- Composer is a text `textarea` with no `onPaste`. Nothing in the desktop renderer reads clipboard images.
- `useOrchestratorPlan.submit` and `startPlan` both refuse a whitespace-only prompt (`'a plan needs a request'` / early return). `composeBlocked` is `'Describe what to build'` when the textarea is empty.
- Planning path: renderer `api.orchestrator.plan(projectId, prompt, model, reasoningEffort)` → IPC `orchestrator:plan` → `startPlan` → `PlanSession` → `PanelSession.ask` → `OneShotSession.send(prompt: string)` → `promptUntilIdle` → `session.prompt(text, { expandPromptTemplates: false, source: 'extension' })` with no `images`.
- Pinned Pi SDK (`@earendil-works/pi-coding-agent` `0.84.4`) already accepts images:

  ```ts
  // dist/core/agent-session.d.ts
  interface PromptOptions {
    images?: ImageContent[];
    // ...
  }
  ```

  **Use the runtime type, not the docs.** `references/sdk.md` shows Anthropic-style `{ type, source: { type: 'base64', mediaType, data } }`. The actual `ImageContent` on this pin (via `PromptOptions['images']`) is:

  ```ts
  { type: 'image'; data: string; mimeType: string }
  ```

  That matches `session-format.md` / pi-ai `ImageContent`, not the sdk.md example. Map Foundry attachments onto `{ type: 'image', data, mimeType }` inside `src/main/pi/` only.

- `LinearComposer` has its own `useOrchestratorPlan` instance and calls `orchestrator.submit(brief)` with one argument. Keep that compiling; do not add paste there.
- App-level `useOrchestratorPlan` lives in `AppInner` so a planning session survives Runs unmount (Settings detour). Attachment state must live on that controller, not in `OrchestratedComposer` local `useState`, or a regenerate after navigation would drop the pixels.

## Shared contract

Put the clone-safe attachment type and the caps next to the other Orchestrator types in `apps/desktop/src/shared/types.ts` (side-effect free). Import them from IPC / renderer / main.

```ts
export const PLAN_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;
export type PlanImageMime = (typeof PLAN_IMAGE_MIME_TYPES)[number];

export const PLAN_IMAGE_MAX_COUNT = 8;
export const PLAN_IMAGE_MAX_BYTES = 4 * 1024 * 1024; // decoded, per image
export const PLAN_IMAGE_MAX_TOTAL_BYTES = 12 * 1024 * 1024; // decoded, all images

/** Clone-safe planning attachment. `data` is raw base64, no `data:` prefix. */
export interface PlanImageAttachment {
  mediaType: PlanImageMime;
  data: string;
  name?: string;
}
```

No SVG. Caps are contractual: main enforces them; renderer uses the same numbers for UX-only refusals.

### IPC (`apps/desktop/src/shared/ipc-contract.ts`)

Keep channel `orchestrator:plan`. Add an optional 5th argument — do **not** wrap the existing positional args in an object (that would break the e2e stub).

```ts
plan(
  projectId: string,
  prompt: string,
  model: string,
  reasoningEffort: ReasoningEffort,
  images?: PlanImageAttachment[],
): Promise<{ planId: string } | { error: string }>;
```

`OrchestratorState` is unchanged. Progress events stay small.

Update in lockstep (no new channel):

- `apps/desktop/src/main/ipc/orchestrator.ts` — pass `images` into `startPlan`.
- `apps/desktop/src/preload/bridge.ts` — forward the 5th arg.
- `apps/desktop/src/renderer/hooks/useOrchestratorPlan.ts` — see renderer section.
- `apps/desktop/src/renderer/mockFoundry.ts` — accept and **ignore** `images`; never copy them onto `notify('orchestrator-progress', …)`.

`api.ts` already JSON-roundtrips invoke args through `plain()`. Send base64 strings, never `Uint8Array` (JSON would drop the bytes).

## Main: validate, store in-memory, never broadcast

### New `apps/desktop/src/main/orchestrator/plan-images.ts`

Pure validator used by `startPlan`. No fs, no logging of `data`.

```ts
export function validatePlanImages(
  images: unknown,
): { ok: true; images: PlanImageAttachment[] } | { ok: false; error: string }
```

Rules:

1. Missing / `undefined` / empty array → `{ ok: true, images: [] }`.
2. Not an array → `'Attach images as a list.'`
3. Length `> PLAN_IMAGE_MAX_COUNT` → `'Attach at most 8 images.'`
4. Each element must be a plain object with `mediaType` in `PLAN_IMAGE_MIME_TYPES` and a non-empty string `data`. Optional `name` must be a string if present; strip it if empty. Reject SVG and anything else: `'Use a PNG, JPEG, WebP, or GIF image.'`
5. Decode with `Buffer.from(data, 'base64')`. Empty buffer → `'The image was empty.'` Per-image `bytes.length > PLAN_IMAGE_MAX_BYTES` → `'Keep each image under 4 MB.'`
6. Sum of decoded sizes `> PLAN_IMAGE_MAX_TOTAL_BYTES` → `'Keep attached images under 12 MB total.'`
7. Return normalized attachments (`mediaType`, `data`, `name?`). Do not keep unknown extra keys.

### `startPlan` (`apps/desktop/src/main/orchestrator/start.ts`)

```ts
export interface PlanStartInput {
  prompt: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  images?: PlanImageAttachment[];
}
```

Replace `if (!input.prompt.trim()) return { error: 'a plan needs a request' }` with:

1. `const checked = validatePlanImages(input.images);` if `!checked.ok` return `{ error: checked.error }` (user-visible, not a thrown click).
2. If `!input.prompt.trim() && checked.images.length === 0` return `{ error: 'a plan needs a request' }`.
3. Pass `images: checked.images` into `plans.start({ … })` only when `checked.images.length > 0`.

Companion `context.ts` `orchestrator.start` keeps calling `startPlan` with `{ prompt, model, reasoningEffort }` and no images, so a phone still needs a non-empty prompt.

### `PlanSession` (`apps/desktop/src/main/orchestrator/plan-session.ts`)

Add `images?: PlanImageAttachment[]` to `PlanSessionDeps` / `PlanStart`. Keep it **only** on `this.deps`. Do not add it to the `PanelSession` initial state, `clone`, or any `onChange` payload.

In the correction loop (`private ask`), every `this.panel.ask({…})` — attempt 1 and every retry — must pass the same images:

```ts
const turn = await this.panel.ask({
  oneShot: this.deps.oneShot,
  cwd: this.deps.projectPath,
  access: 'read',
  model,
  reasoningEffort: this.deps.reasoningEffort,
  systemPrompt: ORCHESTRATOR_PROMPT,
  outputFormat: planOutputFormat(),
  prompt: ask,
  ...(this.deps.images?.length ? { images: this.deps.images } : {}),
});
```

Do not drop images after the first attempt. A one-shot is one turn; each retry is a fresh session and needs the pixels again.

### Prompt text (`apps/desktop/src/main/orchestrator/plan.ts`)

Extend `PlanPromptInputs` with optional `attachedImageCount?: number`. In `buildPlanPrompt`, when `attachedImageCount > 0`, after `## Request`:

- If `inputs.request` is empty/whitespace, write `(see attached images)` rather than a blank heading.
- Add a short `## Attached images` note: `'N image(s) are attached to this turn. Treat them as the visual specification.'`

Never interpolate base64 into the prompt string. `PlanSession` passes `attachedImageCount: this.deps.images?.length ?? 0`.

## Vendor-neutral one-shot seam

Keep `oneshot.ts` free of Pi types.

```ts
export type OneShotImage = PlanImageAttachment; // or an identical { mediaType, data, name? }

export interface OneShotSession {
  send(prompt: string, images?: readonly OneShotImage[]): Promise<OneShotResult>;
}
```

Optional second argument — every existing `send(prompt)` call site stays valid (detection, setup, replan, readiness, healing, project-context).

### `AskTurn` / `PanelSession.ask` (`apps/desktop/src/main/session/panel-session.ts`)

```ts
export interface AskTurn {
  // existing fields…
  images?: readonly OneShotImage[];
}
```

`ask` forwards: `await session.send(input.prompt, input.images)`.

### `lazy-oneshot.ts`

Forward the second argument through the inner session:

```ts
async send(prompt: string, images?: readonly OneShotImage[]) {
  const session = (inner ??= (await ready())(opts));
  // abort-before-send path unchanged
  return session.send(prompt, images);
}
```

### `scripted-oneshot.ts` (`apps/desktop/tests/helpers/scripted-oneshot.ts`)

Record images so PlanSession tests can assert without Pi:

```ts
readonly prompts: string[];
readonly images: Array<readonly OneShotImage[] | undefined>;
```

`send(prompt, images?)` pushes both. Existing suites keep compiling.

### Pi mapping — only under `apps/desktop/src/main/pi/`

`promptUntilIdle` (`open-session.ts`) gains an optional images list and spreads it onto the existing prompt options:

```ts
export async function promptUntilIdle(
  session: PiAgentSession,
  text: string,
  afterIdle?: () => Promise<void>,
  images?: NonNullable<PromptOptions['images']>,
): Promise<{ stopReason: string; errorMessage?: string } | null> {
  await session.prompt(text, {
    expandPromptTemplates: false,
    source: 'extension',
    ...(images?.length ? { images } : {}),
  });
  // waitForIdle / error handling unchanged
}
```

Import `PromptOptions` from `@earendil-works/pi-coding-agent`, not pi-ai.

`pi-oneshot.ts` `send(prompt, images?)` maps Foundry → Pi **before** calling `promptUntilIdle`:

```ts
function toPiImages(
  images: readonly OneShotImage[],
): NonNullable<PromptOptions['images']> {
  return images.map((image) => ({
    type: 'image',
    data: image.data,
    mimeType: image.mediaType,
  }));
}
```

That is the load-bearing shape. Do **not** wrap `source: { type: 'base64', mediaType, data }`.

`pi-transport.ts` and `smith-transport.ts` keep calling `promptUntilIdle(session, text, …)` with no images.

## Renderer

Renderer tests run in Node, not jsdom. No `ClipboardEvent` / `DataTransfer`. Extract parsing to a pure helper and keep the React `onPaste` thin.

### New `apps/desktop/src/renderer/utils/clipboard-images.ts`

Pure functions only (no React, no DOM types required at runtime):

```ts
export interface ClipboardImageSource {
  type: string;       // MIME from the clipboard item / File
  name?: string;      // File.name when present
  bytes: Uint8Array;  // already read
}

export function isPlanImageMime(type: string): type is PlanImageMime;

export function pastedImageName(filename: string | undefined, indexFromOne: number): string;
// "shot.png" → "shot.png"; empty / "image.png" from some OS pastes with no real name → "Pasted image N"

export function bytesToBase64(bytes: Uint8Array): string;
// same char-code + btoa loop AgentIconPicker uses; Node 22 has btoa

export function attachmentsFromClipboardSources(
  sources: readonly ClipboardImageSource[],
  alreadyAttached: number,
): { attachments: PlanImageAttachment[]; errors: string[] };
```

`attachmentsFromClipboardSources` rules (UX; main still re-checks):

- Ignore non-allowlisted MIME (do not treat them as fatal if mixed with valid images; collect `'Use a PNG, JPEG, WebP, or GIF image.'` only when the paste contained image/* that we refuse, e.g. `image/svg+xml`, or a file whose type is empty but name ends in `.svg`).
- Skip zero-byte sources with `'The image was empty.'`
- Per-image / total / count caps using the shared constants; surplus images error rather than silently drop if the paste would exceed the cap.
- Names: `pastedImageName(source.name, alreadyAttached + acceptedIndex + 1)`.
- Do not insert clipboard text here. Text is the textarea's job.

Add a second tiny helper the paste handler can call with a file-list snapshot (so “image files on the clipboard” is tested without `File`):

```ts
export function imageSourcesFromFileList(
  files: ReadonlyArray<{ type: string; name: string; size: number; bytes: Uint8Array }>,
): ClipboardImageSource[];
```

That is just a map/filter — keep it if it makes the test table obvious; otherwise inline in `attachmentsFromClipboardSources`.

### `useOrchestratorPlan`

Attachment list lives on the controller so it survives Runs unmount and rides Plan / Regenerate:

```ts
export interface OrchestratorPlanController {
  // existing fields…
  images: PlanImageAttachment[];
  addImages(images: readonly PlanImageAttachment[]): void;
  removeImage(index: number): void;
  submit(prompt: string): Promise<void>; // sends this.images
  // discard() clears images; cancel() does not
}
```

- `submit`: allow `!prompt.trim()` when `images.length > 0`. Call `api.orchestrator.plan(projectId, prompt, choice.model, choice.reasoningEffort, images.length ? images : undefined)`.
- `discard()` (Discard button and successful Start run) clears images.
- `cancel()` (in-flight planning) does **not** clear images.
- The existing `useEffect` on `projectId` already resets planning; also clear images there.
- Linear's separate hook instance is unused for images; `submit(brief)` still works.

Do not store preview-only fields on the controller. A thumbnail is `data:${mediaType};base64,${data}`.

### `OrchestratedComposer` (`RunsScreen.tsx`)

1. `onPaste` on the `run-request` textarea:
   - Snapshot `clipboardData.files` / `items` of `kind === 'file'` whose `type` starts with `image/`.
   - If **no** image files: do not `preventDefault` (native text paste).
   - If one or more image files: `preventDefault` only after we know we will attach; read `arrayBuffer()` → `Uint8Array`, run `attachmentsFromClipboardSources`. Text in the same paste (`clipboardData.getData('text/plain')`) is inserted at the caret via `onRequestChange` (selectionStart/End). Non-image files are ignored.
2. Show a compact chip row under the textarea (before `.composerControls`). Each chip: ~32–40px thumb, name, remove. `data-testid="run-request-attachments"` on the row, `data-testid="run-request-attachment"` on each chip, remove control `data-testid="run-request-attachment-remove"`.
3. `composeBlocked`: `'Describe what to build'` only when **both** `!request.trim()` and `orchestrator.images.length === 0`. Image-only is allowed. Project-missing and base-sync blocks unchanged.
4. Cmd/Ctrl+Enter and **Plan run** / **Regenerate plan** / **Try again** call `orchestrator.submit(request)` which includes current images.
5. Paste refusals set a local attach error (same visual as `.planError`, `role="alert"`, `data-testid="run-request-attach-error"`). Do not throw from the click/paste handler. Main `{ error }` still lands in existing `planError`.
6. Successful `api.runs.start` already calls `onRequestChange('')` and `orchestrator.discard()` — that clears images. Discard button already calls `discard()`.

If `OrchestratedComposer` grows past the renderer complexity ceiling, extract a presentational `OrchestratorAttachments` in `apps/desktop/src/renderer/components/run/OrchestratorAttachments.tsx` + `.module.css`. Prefer that extract over stuffing branches into the screen.

### CSS (`RunsScreen.module.css` or the extracted module)

New locals only. Tokens (`--s*`, `--r-sm`, `--line`, `--bg-input`, `--text-dim`, `--text-faint`, `--red`, `--fast`, `--ease`). Do not redefine token classes (`check:css`). Chip row: wrap, 6px gap, 32–40px thumbs, `object-fit: cover`, 2px 6px label, remove `×` matching `PhaseEditor` removable chips. No new global keyframes.

## Spec

Update `specs/orchestrated-runs.md` in this same change:

- §1.1: textarea accepts pasted images; chips; image-only submit; empty text + no images still blocked.
- §2.2 prompt inputs: optional in-memory images on the planning session; forwarded on every ask including corrections; never on `OrchestratorState`.
- §2.6 IPC: `orchestrator:plan (projectId, prompt, model, reasoningEffort, images?) → { planId } | { error }`. Caps and allowlist. Companion HTTP remains text-only.

## Tests (no model, no network)

| File | What to pin |
| --- | --- |
| `apps/desktop/tests/renderer/clipboard-images.test.ts` **new** | PNG/JPEG/WebP/GIF accepted; SVG refused; mixed text is not the helper's job (no images from a text-only source list); filename vs `Pasted image N`; empty bytes; per-image 4 MB; total 12 MB; count 8 with `alreadyAttached`. |
| `apps/desktop/tests/main/orchestrator/plan-images.test.ts` **new** | `validatePlanImages` allowlist/size/count/empty/non-array; extra keys stripped. |
| `apps/desktop/tests/main/orchestrator/start-plan.test.ts` **new** | Stub `PanelRegistry.start`. Empty prompt + no images → `'a plan needs a request'`. Empty prompt + one valid PNG → `start()` called with that image. Invalid MIME/size → `{ error }` and `start` not called. Do not require a real PlanSession. |
| `apps/desktop/tests/main/orchestrator/plan-session.test.ts` | New cases: deps.images ride `send` on the first turn **and** on a correction retry (first turn `still not JSON`, second `submitted(validReply())`); both `oneShots.images[0]` and `[1]` equal the input. Snapshot JSON of `OrchestratorState` / last `onChange` payload must not contain the base64 (`not.toContain(pngData)`). Prompt text mentions attached images; image-only request uses `(see attached images)`. |
| `apps/desktop/tests/main/session/panel-session.test.ts` | `ask({ images })` forwards them to scripted `send`. |
| `apps/desktop/tests/helpers/scripted-oneshot.ts` | Record `images`; existing tests unchanged. |
| `apps/desktop/tests/main/pi/lazy-runtime.test.ts` | One case that `send('ask', images)` reaches the inner factory. |
| `apps/desktop/tests/main/pi/pi-oneshot.test.ts` | Scripted `AgentSession.prompt(text, options?)` records `options?.images`. New test: `send('look', [{ mediaType: 'image/png', data: 'aaaa' }])` calls prompt with `[{ type: 'image', data: 'aaaa', mimeType: 'image/png' }]` and **not** a `source` wrapper. Text-only send still omits `images`. |
| `apps/desktop/src/renderer/mockFoundry.ts` | Signature accepts optional images; progress payload has none. |
| `apps/desktop/tests/e2e/runs.spec.ts` | Leave as-is. Stub is `(_event, projectId, prompt, model, reasoningEffort) =>`; extra 5th arg is ignored. Existing text plan still works. |
| `apps/desktop/tests/main/ipc/ipc-surface.test.ts` | Still 134 channels. No edit unless a type import fails compile. |

Tiny 1×1 PNG base64 for fixtures (valid decoded bytes, well under the cap):

```ts
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
```

## Files to touch

**New**

- `apps/desktop/src/main/orchestrator/plan-images.ts`
- `apps/desktop/src/renderer/utils/clipboard-images.ts`
- `apps/desktop/src/renderer/components/run/OrchestratorAttachments.tsx` (+ `.module.css`) — extract if the screen would otherwise bloat
- `apps/desktop/tests/renderer/clipboard-images.test.ts`
- `apps/desktop/tests/main/orchestrator/plan-images.test.ts`
- `apps/desktop/tests/main/orchestrator/start-plan.test.ts`

**Edit**

- `apps/desktop/src/shared/types.ts` — attachment type + caps
- `apps/desktop/src/shared/ipc-contract.ts` — optional `images` on `orchestrator.plan`
- `apps/desktop/src/main/ipc/orchestrator.ts`
- `apps/desktop/src/main/orchestrator/start.ts`
- `apps/desktop/src/main/orchestrator/plan-session.ts`
- `apps/desktop/src/main/orchestrator/plan.ts`
- `apps/desktop/src/main/session/panel-session.ts`
- `apps/desktop/src/main/pi/oneshot.ts`
- `apps/desktop/src/main/pi/lazy-oneshot.ts`
- `apps/desktop/src/main/pi/pi-oneshot.ts`
- `apps/desktop/src/main/pi/open-session.ts`
- `apps/desktop/src/preload/bridge.ts`
- `apps/desktop/src/renderer/hooks/useOrchestratorPlan.ts`
- `apps/desktop/src/renderer/screens/RunsScreen.tsx`
- `apps/desktop/src/renderer/screens/RunsScreen.module.css` (or the extracted module)
- `apps/desktop/src/renderer/mockFoundry.ts`
- `apps/desktop/tests/helpers/scripted-oneshot.ts`
- `apps/desktop/tests/main/orchestrator/plan-session.test.ts`
- `apps/desktop/tests/main/session/panel-session.test.ts`
- `apps/desktop/tests/main/pi/pi-oneshot.test.ts`
- `apps/desktop/tests/main/pi/lazy-runtime.test.ts`
- `specs/orchestrated-runs.md`

**Do not touch**

- `LinearComposer.tsx`, `ManualComposer.tsx`, Smith, Android, companion HTTP types/routes, `context.ts` companion `start` (no images), `ipc-surface` channel count, e2e specs, website.

## Implementation order

1. Shared type + caps + IPC signature + preload + mockFoundry (typecheck green).
2. `plan-images.ts` + `startPlan` + start-plan tests.
3. One-shot seam (`oneshot` / `AskTurn` / lazy / scripted) + `promptUntilIdle` / `pi-oneshot` mapping + those tests.
4. `PlanSession` forwards images on every attempt + plan-session tests (including “not on state”).
5. Renderer helper + unit tests, then composer paste/chips/`composeBlocked`/`useOrchestratorPlan` lifetime.
6. `specs/orchestrated-runs.md`.
7. Format (Prettier: semicolons, single quotes, trailing commas, width 100) and type-only imports.

## Verification

```bash
npx vitest run \
  apps/desktop/tests/renderer/clipboard-images.test.ts \
  apps/desktop/tests/main/orchestrator/plan-images.test.ts \
  apps/desktop/tests/main/orchestrator/start-plan.test.ts \
  apps/desktop/tests/main/orchestrator/plan-session.test.ts \
  apps/desktop/tests/main/session/panel-session.test.ts \
  apps/desktop/tests/main/pi/pi-oneshot.test.ts \
  apps/desktop/tests/main/pi/lazy-runtime.test.ts \
  apps/desktop/tests/main/ipc/ipc-surface.test.ts

npm run typecheck
npm test
```

Acceptance (what must be true when the builder is done):

- Pasting a PNG/JPEG into `#run-request` attaches a removable preview; typed/pasted text still works.
- Plan run calls `orchestrator:plan` with those attachments; `PlanSession` forwards them on the initial ask and every correction retry.
- Image-only requests plan; empty text and no images still block with “Describe what to build”.
- Oversized / SVG / non-images are refused in the composer with a clear alert; `orchestrator-progress` never carries image bytes.
- `npm test` and `npm run typecheck` pass. Existing Runs e2e still plans with text.

## PR

- Title: `[orchestrator] Paste images into the composer`
- Body: follow `.github/pull_request_template.md` (summary, how verified, notes that IPC gained an optional `images` arg on `orchestrator:plan` without a new channel; blobs stay off progress).
