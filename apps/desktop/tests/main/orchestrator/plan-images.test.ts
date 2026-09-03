import { describe, expect, it } from 'vitest';
import { PLAN_IMAGE_MAX_BYTES, PLAN_IMAGE_MAX_COUNT } from '@shared/types.js';
import { validatePlanImages } from '../../../src/main/orchestrator/plan-images.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('validatePlanImages', () => {
  it('treats missing or empty lists as no images', () => {
    expect(validatePlanImages(undefined)).toEqual({ ok: true, images: [] });
    expect(validatePlanImages([])).toEqual({ ok: true, images: [] });
  });

  it('rejects a non-array payload', () => {
    expect(validatePlanImages({ mediaType: 'image/png', data: PNG_1X1 })).toEqual({
      ok: false,
      error: 'Attach images as a list.',
    });
  });

  it('accepts the allowlisted types and strips extra keys', () => {
    const checked = validatePlanImages([
      { mediaType: 'image/png', data: PNG_1X1, name: 'shot.png', extra: true },
      { mediaType: 'image/jpeg', data: PNG_1X1, name: '  ' },
      { mediaType: 'image/webp', data: PNG_1X1 },
      { mediaType: 'image/gif', data: PNG_1X1, name: 'anim.gif' },
    ]);
    expect(checked).toEqual({
      ok: true,
      images: [
        { mediaType: 'image/png', data: PNG_1X1, name: 'shot.png' },
        { mediaType: 'image/jpeg', data: PNG_1X1 },
        { mediaType: 'image/webp', data: PNG_1X1 },
        { mediaType: 'image/gif', data: PNG_1X1, name: 'anim.gif' },
      ],
    });
  });

  it('rejects SVG and unknown MIME', () => {
    expect(validatePlanImages([{ mediaType: 'image/svg+xml', data: PNG_1X1 }])).toEqual({
      ok: false,
      error: 'Use a PNG, JPEG, WebP, or GIF image.',
    });
    expect(validatePlanImages([{ mediaType: 'application/pdf', data: PNG_1X1 }])).toEqual({
      ok: false,
      error: 'Use a PNG, JPEG, WebP, or GIF image.',
    });
  });

  it('rejects empty decoded bytes', () => {
    expect(validatePlanImages([{ mediaType: 'image/png', data: '' }])).toEqual({
      ok: false,
      error: 'The image was empty.',
    });
  });

  it('rejects malformed and non-canonical base64', () => {
    expect(validatePlanImages([{ mediaType: 'image/png', data: 'not!' }])).toEqual({
      ok: false,
      error: 'The image could not be read.',
    });
    expect(validatePlanImages([{ mediaType: 'image/png', data: '/x==' }])).toEqual({
      ok: false,
      error: 'The image could not be read.',
    });
  });

  it('rejects more than eight images', () => {
    const images = Array.from({ length: PLAN_IMAGE_MAX_COUNT + 1 }, () => ({
      mediaType: 'image/png' as const,
      data: PNG_1X1,
    }));
    expect(validatePlanImages(images)).toEqual({
      ok: false,
      error: 'Attach at most 8 images.',
    });
  });

  it('rejects a per-image payload over 4 MB', () => {
    const data = Buffer.alloc(PLAN_IMAGE_MAX_BYTES + 1, 1).toString('base64');
    expect(validatePlanImages([{ mediaType: 'image/png', data }])).toEqual({
      ok: false,
      error: 'Keep each image under 4 MB.',
    });
  });

  it('rejects a combined payload over 12 MB', () => {
    const chunk = Buffer.alloc(PLAN_IMAGE_MAX_BYTES, 1).toString('base64');
    const leftover = Buffer.alloc(1, 1).toString('base64');
    expect(
      validatePlanImages([
        { mediaType: 'image/png', data: chunk },
        { mediaType: 'image/png', data: chunk },
        { mediaType: 'image/png', data: chunk },
        { mediaType: 'image/png', data: leftover },
      ]),
    ).toEqual({
      ok: false,
      error: 'Keep attached images under 12 MB total.',
    });
  });
});
