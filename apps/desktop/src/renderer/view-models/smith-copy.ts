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
