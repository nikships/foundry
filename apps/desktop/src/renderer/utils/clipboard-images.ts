/**
 * Pure clipboard-image parsing for the Orchestrator composer.
 *
 * Renderer tests run in Node, not jsdom, so paste handling is extracted here
 * and the React `onPaste` stays a thin snapshot of files/items.
 */

import {
  PLAN_IMAGE_MAX_BYTES,
  PLAN_IMAGE_MAX_COUNT,
  PLAN_IMAGE_MAX_TOTAL_BYTES,
  PLAN_IMAGE_MIME_TYPES,
  type PlanImageAttachment,
  type PlanImageMime,
} from '@shared/types.js';

const GENERIC_PASTE_NAMES = new Set([
  '',
  'image.png',
  'image.jpg',
  'image.jpeg',
  'image.webp',
  'image.gif',
]);

export interface ClipboardImageSource {
  type: string;
  name?: string;
  bytes: Uint8Array;
}

export function isPlanImageMime(type: string): type is PlanImageMime {
  return (PLAN_IMAGE_MIME_TYPES as readonly string[]).includes(type);
}

export function pastedImageName(filename: string | undefined, indexFromOne: number): string {
  const trimmed = filename?.trim() ?? '';
  if (!trimmed || GENERIC_PASTE_NAMES.has(trimmed.toLowerCase())) {
    return `Pasted image ${indexFromOne}`;
  }
  return trimmed;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function imageSourcesFromFileList(
  files: ReadonlyArray<{ type: string; name: string; size: number; bytes: Uint8Array }>,
): ClipboardImageSource[] {
  return files.map((file) => ({
    type: file.type,
    name: file.name,
    bytes: file.bytes,
  }));
}

export function attachmentsFromClipboardSources(
  sources: readonly ClipboardImageSource[],
  alreadyAttached: number,
): { attachments: PlanImageAttachment[]; errors: string[] } {
  const attachments: PlanImageAttachment[] = [];
  const errors: string[] = [];
  let remainingSlots = PLAN_IMAGE_MAX_COUNT - alreadyAttached;
  let remainingBytes = PLAN_IMAGE_MAX_TOTAL_BYTES;

  for (const source of sources) {
    if (!looksLikeImage(source)) continue;
    if (!isPlanImageMime(source.type) || isSvg(source)) {
      collectError(errors, 'Use a PNG, JPEG, WebP, or GIF image.');
      continue;
    }
    if (source.bytes.length === 0) {
      collectError(errors, 'The image was empty.');
      continue;
    }
    if (source.bytes.length > PLAN_IMAGE_MAX_BYTES) {
      collectError(errors, 'Keep each image under 4 MB.');
      continue;
    }
    if (remainingSlots <= 0) {
      collectError(errors, 'Attach at most 8 images.');
      continue;
    }
    if (source.bytes.length > remainingBytes) {
      collectError(errors, 'Keep attached images under 12 MB total.');
      continue;
    }

    remainingSlots -= 1;
    remainingBytes -= source.bytes.length;
    attachments.push({
      mediaType: source.type,
      data: bytesToBase64(source.bytes),
      name: pastedImageName(source.name, alreadyAttached + attachments.length + 1),
    });
  }

  return { attachments, errors };
}

function looksLikeImage(source: ClipboardImageSource): boolean {
  if (source.type.startsWith('image/')) return true;
  return Boolean(source.name && /\.(png|jpe?g|webp|gif|svg)$/i.test(source.name));
}

function isSvg(source: ClipboardImageSource): boolean {
  return source.type === 'image/svg+xml' || Boolean(source.name?.toLowerCase().endsWith('.svg'));
}

function collectError(errors: string[], message: string): void {
  if (!errors.includes(message)) errors.push(message);
}
