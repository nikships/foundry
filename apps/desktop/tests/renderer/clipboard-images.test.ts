import { describe, expect, it } from 'vitest';
import {
  PLAN_IMAGE_MAX_BYTES,
  PLAN_IMAGE_MAX_COUNT,
  PLAN_IMAGE_MAX_TOTAL_BYTES,
  type PlanImageAttachment,
} from '@shared/types.js';
import {
  attachmentsFromClipboardSources,
  bytesToBase64,
  imageSourcesFromFileList,
  insertClipboardText,
  pastedImageName,
  type ClipboardImageSource,
} from '@renderer/utils/clipboard-images.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function pngBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(PNG_1X1, 'base64'));
}

function source(over: Partial<ClipboardImageSource> = {}): ClipboardImageSource {
  return { type: 'image/png', name: 'shot.png', bytes: pngBytes(), ...over };
}

function attachment(bytes = pngBytes()): PlanImageAttachment {
  return { mediaType: 'image/png', data: Buffer.from(bytes).toString('base64') };
}

describe('pastedImageName', () => {
  it('keeps a real filename', () => {
    expect(pastedImageName('shot.png', 1)).toBe('shot.png');
  });

  it('falls back for empty or generic OS paste names', () => {
    expect(pastedImageName(undefined, 1)).toBe('Pasted image 1');
    expect(pastedImageName('', 2)).toBe('Pasted image 2');
    expect(pastedImageName('image.png', 3)).toBe('Pasted image 3');
  });
});

describe('insertClipboardText', () => {
  it('replaces the snapshotted selection without reading the textarea later', () => {
    expect(insertClipboardText('before selected after', 'pasted', 7, 15)).toBe(
      'before pasted after',
    );
  });
});

describe('attachmentsFromClipboardSources', () => {
  it('accepts PNG, JPEG, WebP, and GIF', () => {
    const { attachments, errors } = attachmentsFromClipboardSources(
      [
        source({ type: 'image/png', name: 'a.png' }),
        source({ type: 'image/jpeg', name: 'b.jpg' }),
        source({ type: 'image/webp', name: 'c.webp' }),
        source({ type: 'image/gif', name: 'd.gif' }),
      ],
      [],
    );
    expect(errors).toEqual([]);
    expect(attachments.map((image) => image.mediaType)).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
    ]);
    expect(attachments[0]?.data).toBe(bytesToBase64(pngBytes()));
  });

  it('refuses SVG even when mixed with a valid image', () => {
    const { attachments, errors } = attachmentsFromClipboardSources(
      [source(), source({ type: 'image/svg+xml', name: 'icon.svg' })],
      [],
    );
    expect(attachments).toHaveLength(1);
    expect(errors).toEqual(['Use a PNG, JPEG, WebP, or GIF image.']);
  });

  it('refuses a nameless SVG whose type is empty', () => {
    const { attachments, errors } = attachmentsFromClipboardSources(
      [source({ type: '', name: 'icon.svg' })],
      [],
    );
    expect(attachments).toEqual([]);
    expect(errors).toEqual(['Use a PNG, JPEG, WebP, or GIF image.']);
  });

  it('ignores a text-only source list', () => {
    const { attachments, errors } = attachmentsFromClipboardSources(
      [{ type: 'text/plain', name: 'notes.txt', bytes: new Uint8Array([97]) }],
      [],
    );
    expect(attachments).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('skips empty bytes', () => {
    const { attachments, errors } = attachmentsFromClipboardSources(
      [source({ bytes: new Uint8Array() })],
      [],
    );
    expect(attachments).toEqual([]);
    expect(errors).toEqual(['The image was empty.']);
  });

  it('refuses a per-image payload over 4 MB', () => {
    const { attachments, errors } = attachmentsFromClipboardSources(
      [source({ bytes: new Uint8Array(PLAN_IMAGE_MAX_BYTES + 1) })],
      [],
    );
    expect(attachments).toEqual([]);
    expect(errors).toEqual(['Keep each image under 4 MB.']);
  });

  it('refuses a paste that would exceed 12 MB total', () => {
    const chunk = new Uint8Array(PLAN_IMAGE_MAX_BYTES);
    const { attachments, errors } = attachmentsFromClipboardSources(
      [
        source({ name: 'a.png', bytes: chunk }),
        source({ name: 'b.png', bytes: chunk }),
        source({ name: 'c.png', bytes: chunk }),
        source({ name: 'd.png', bytes: new Uint8Array(1) }),
      ],
      [],
    );
    expect(attachments).toHaveLength(3);
    expect(errors).toEqual(['Keep attached images under 12 MB total.']);
    expect(
      attachments.reduce((sum, image) => sum + Buffer.from(image.data, 'base64').length, 0),
    ).toBe(PLAN_IMAGE_MAX_TOTAL_BYTES);
  });

  it('counts images attached by earlier pastes toward the total byte limit', () => {
    const chunk = new Uint8Array(PLAN_IMAGE_MAX_BYTES);
    const { attachments, errors } = attachmentsFromClipboardSources(
      [source({ bytes: chunk }), source({ bytes: new Uint8Array(1) })],
      [attachment(chunk), attachment(chunk)],
    );
    expect(attachments).toHaveLength(1);
    expect(errors).toEqual(['Keep attached images under 12 MB total.']);
  });

  it('refuses surplus images once eight are attached', () => {
    const { attachments, errors } = attachmentsFromClipboardSources(
      Array.from({ length: 3 }, (_, i) => source({ name: `extra-${i}.png` })),
      Array.from({ length: PLAN_IMAGE_MAX_COUNT - 1 }, () => attachment()),
    );
    expect(attachments).toHaveLength(1);
    expect(errors).toEqual(['Attach at most 8 images.']);
    expect(attachments[0]?.name).toBe('extra-0.png');
  });

  it('numbers unnamed pastes from one, counting already attached images', () => {
    const { attachments } = attachmentsFromClipboardSources(
      [source({ name: '' }), source({ name: 'image.png' })],
      [attachment(), attachment()],
    );
    expect(attachments.map((image) => image.name)).toEqual(['Pasted image 3', 'Pasted image 4']);
  });

  it('maps a File-list snapshot into clipboard sources', () => {
    const bytes = pngBytes();
    expect(
      imageSourcesFromFileList([
        { type: 'image/png', name: 'shot.png', size: bytes.length, bytes },
      ]),
    ).toEqual([{ type: 'image/png', name: 'shot.png', bytes }]);
  });
});
