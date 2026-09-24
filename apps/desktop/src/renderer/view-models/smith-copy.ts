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
 * covers. The approval rule is in the same sentence so a first-time
 * operator knows nothing privileged runs without their say-so.
 */
export const SMITH_USER_ACCESS_COPY =
  'Ask about your assigned Linear tickets, have Smith compose a run plan, or run a saved pipeline. App actions wait for approval unless you enable YOLO mode for this chat.';

/** Label above the composer quick prompts. */
export const SMITH_QUICK_PROMPTS_LABEL = 'Try asking Smith…';

/**
 * What "returns a plan ID immediately" means for the operator. Planning is
 * async: Smith hands back the handle right away and the plan (or failure)
 * arrives as progress, so polling or asking for status is the workflow —
 * never waiting silently for an outcome.
 */
export const SMITH_COMPOSE_ASYNC_COPY =
  'Planning runs in the background. Smith hands back a plan ID right away — ask for its status any time.';

/** Empty assigned-work result: valid, not an error. */
export const SMITH_ASSIGNED_EMPTY_COPY = 'No tickets are assigned to you right now.';
