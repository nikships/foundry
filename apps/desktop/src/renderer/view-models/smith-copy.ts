/**
 * Operator-facing Smith copy shared by Settings and the chat screen.
 *
 * Smith now needs a signed-in provider the way a run does. The empty-catalog
 * hint and the chat cold-open both point at Settings → Providers rather than
 * inventing a second sentence.
 */

/** Shown when Smith (or its model picker) has no reachable provider. */
export const SMITH_NO_PROVIDER_COPY =
  'Smith needs a signed-in provider. Connect one in Settings → Providers.';

/**
 * Second paragraph of the Smith empty state: what full user-level access
 * covers. Text and voice share the same conversation, so the sentence names
 * both — and the approval rule, so a first-time operator knows nothing
 * privileged runs without their say-so.
 */
export const SMITH_USER_ACCESS_COPY =
  'Ask about your assigned Linear tickets, start an orchestrator plan, or run a saved pipeline — by text here or by voice. Every privileged step waits on your approval.';

/** Label above the composer quick prompts. */
export const SMITH_QUICK_PROMPTS_LABEL = 'Try asking Smith…';

/**
 * Why a key proposal over voice points at the desktop card. Spoken secrets
 * would land in transcripts and model context; the masked card keeps the
 * value inside the approval answer main consumes once and never echoes.
 */
export const SMITH_SECRET_VOICE_COPY =
  'API keys are entered only in the masked card here — never spoken aloud over voice.';

/**
 * What "returns a plan ID immediately" means for the operator. Planning is
 * async: Smith hands back the handle right away and the plan (or failure)
 * arrives as progress, so polling or asking for status is the workflow —
 * never waiting silently for an outcome.
 */
export const SMITH_ORCHESTRATOR_ASYNC_COPY =
  'Planning runs in the background. Smith hands back a plan ID right away — ask for its status any time.';

/** Empty assigned-work result: valid, not an error. */
export const SMITH_ASSIGNED_EMPTY_COPY = 'No tickets are assigned to you right now.';
