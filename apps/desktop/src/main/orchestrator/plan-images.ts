/**
 * In-memory planning-image checks. Main is the bound: the renderer may refuse
 * a paste early, but a planning turn only sees attachments that pass here.
 *
 * Bytes stay off disk and off `OrchestratorState`. This module never logs `data`.
 */

import {
  PLAN_IMAGE_MAX_BYTES,
  PLAN_IMAGE_MAX_COUNT,
  PLAN_IMAGE_MAX_TOTAL_BYTES,
  PLAN_IMAGE_MIME_TYPES,
  type PlanImageAttachment,
  type PlanImageMime,
} from '@shared/types.js';

const MAX_ENCODED_IMAGE_BYTES = Math.ceil(PLAN_IMAGE_MAX_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type PlanImagesCheck =
  { ok: true; images: PlanImageAttachment[] } | { ok: false; error: string };

export function validatePlanImages(images: unknown): PlanImagesCheck {
  if (images === undefined) return { ok: true, images: [] };
  if (!Array.isArray(images)) return { ok: false, error: 'Attach images as a list.' };
  if (images.length === 0) return { ok: true, images: [] };
  if (images.length > PLAN_IMAGE_MAX_COUNT) return { ok: false, error: 'Attach at most 8 images.' };

  const normalized: PlanImageAttachment[] = [];
  let totalBytes = 0;
  for (const item of images) {
    const checked = normalizePlanImage(item);
    if (!checked.ok) return checked;
    totalBytes += checked.bytes;
    if (totalBytes > PLAN_IMAGE_MAX_TOTAL_BYTES) {
      return { ok: false, error: 'Keep attached images under 12 MB total.' };
    }
    normalized.push(checked.image);
  }
  return { ok: true, images: normalized };
}

function normalizePlanImage(
  item: unknown,
): { ok: true; image: PlanImageAttachment; bytes: number } | { ok: false; error: string } {
  if (!isPlainObject(item)) return { ok: false, error: 'Attach images as a list.' };
  if (!isPlanImageMime(item.mediaType)) {
    return { ok: false, error: 'Use a PNG, JPEG, WebP, or GIF image.' };
  }
  if (typeof item.data !== 'string' || item.data.length === 0) {
    return { ok: false, error: 'The image was empty.' };
  }
  if (item.name !== undefined && typeof item.name !== 'string') {
    return { ok: false, error: 'Use a PNG, JPEG, WebP, or GIF image.' };
  }
  if (item.data.length > MAX_ENCODED_IMAGE_BYTES) {
    return { ok: false, error: 'Keep each image under 4 MB.' };
  }
  if (item.data.length % 4 !== 0 || !BASE64.test(item.data)) {
    return { ok: false, error: 'The image could not be read.' };
  }

  const bytes = Buffer.from(item.data, 'base64');
  if (bytes.toString('base64') !== item.data) {
    return { ok: false, error: 'The image could not be read.' };
  }
  if (bytes.length === 0) return { ok: false, error: 'The image was empty.' };
  if (bytes.length > PLAN_IMAGE_MAX_BYTES) {
    return { ok: false, error: 'Keep each image under 4 MB.' };
  }

  const image: PlanImageAttachment = { mediaType: item.mediaType, data: item.data };
  const name = item.name?.trim();
  if (name) image.name = name;
  return { ok: true, image, bytes: bytes.length };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlanImageMime(value: unknown): value is PlanImageMime {
  return (PLAN_IMAGE_MIME_TYPES as readonly string[]).includes(value as string);
}
