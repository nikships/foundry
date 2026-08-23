/**
 * Whether a chosen model may be used, and what to say when it may not.
 *
 * Smith never runs on a model the operator did not pick. "Whichever model this
 * install reaches first" is not a default, it is an unanswered question, and
 * an interface that presents it as a choice is describing a coin flip. So the
 * rule is: an unset or unreachable choice blocks the conversation and says so.
 *
 * Both sides of the IPC seam read this one module. The renderer uses it to
 * disable the composer before a turn is spent, and main uses it to refuse at
 * session open, so the button and the enforcement cannot disagree about what
 * counts as a usable choice.
 */

/** The sentinel a picker stores for "not chosen"; never sent to a provider. */
export const MODEL_UNSET = 'inherit';

export const MODEL_UNSET_MESSAGE = 'No model is selected. Choose one to start the conversation.';

export function modelUnavailableMessage(chosen: string): string {
  return `${chosen} is not available to this install. Choose a model that is.`;
}

/**
 * Why `chosen` cannot be used, or null when it can.
 *
 * `available` empty means the catalog has not loaded or no provider is
 * connected. That is not a bad choice, so a set model is not called
 * unreachable on the strength of an empty list — the "connect a provider"
 * copy already covers that state, and main refuses at open regardless.
 */
export function modelChoiceBlock(
  chosen: string | null | undefined,
  available: readonly string[],
): string | null {
  if (!chosen || chosen === MODEL_UNSET) return MODEL_UNSET_MESSAGE;
  if (available.length === 0) return null;
  const reachable = available.some((id) => id === chosen || id.endsWith(`:${chosen}`));
  return reachable ? null : modelUnavailableMessage(chosen);
}
