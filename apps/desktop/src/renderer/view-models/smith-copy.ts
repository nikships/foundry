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
  'Ask about your assigned Linear tickets, start an orchestrator plan, or run a saved pipeline — by text here or by voice. App actions wait for approval unless you enable YOLO mode for this chat.';

export const SMITH_YOLO_WARNING =
  'Smith will execute app actions and save definitions without approval cards in this chat, including requests sent by voice. It can delete data, run commands, change credentials, publish or merge code, and close the app. API key entry and Companion pairing still use private cards. Project boundaries and validation stay on. This mode resets on New chat or app restart. Enable it only for work you trust.';

export const SMITH_YOLO_OFF_COPY =
  'Smith asks for approval before app actions. Direct checkout access is unchanged.';

export const SMITH_YOLO_ACTIVE_COPY =
  'YOLO is on for this chat: app actions run without approval. Key entry and pairing still need private cards. Turn it off to require approval for the next action; work already started continues. New chat or app restart turns it off.';

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
