/**
 * Pure helpers for the manual "Open PR…" form.
 *
 * Draft title/body live in `@shared/pr-draft` so the companion host cannot
 * invent a different formula.
 */

export {
  defaultPrBody,
  defaultPrTitle,
  manualPrDraft,
  prDraftFromEnvelope,
  selectPrEnvelope,
  type PrDraft,
  type PrDraftSource,
  type ResolvedPrDraft,
} from '@shared/pr-draft.js';
