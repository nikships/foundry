/**
 * User-uploaded agent marks: disk persistence under the app support dir,
 * file-path safety, size / MIME validation, and cleanup.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_MARKS_DIR,
  agentMarkFile,
  agentMarkPath,
  IMAGE_EMBLEM_PREFIX,
  MAX_AGENT_MARK_BYTES,
  removeAgentMark,
  saveAgentMark,
} from '../src/main/store/agent-marks.js';
import { tempDir } from './tmp.js';

describe('agent mark path parsing & safety', () => {
  it('extracts filename for valid image: emblems', () => {
    expect(agentMarkFile('image:abcdef0123456789.png')).toBe('abcdef0123456789.png');
  });

  it('rejects emblems without the image: prefix', () => {
    expect(agentMarkFile('anvil')).toBeNull();
    expect(agentMarkFile('monogram')).toBeNull();
    expect(agentMarkFile('builder')).toBeNull();
    expect(agentMarkFile('')).toBeNull();
  });

  it('rejects path traversal attempts in emblem filename', () => {
    expect(agentMarkFile('image:../etc/passwd')).toBeNull();
    expect(agentMarkFile('image:sub/dir.png')).toBeNull();
    expect(agentMarkFile('image:..\\windows\\system32')).toBeNull();
    expect(agentMarkFile('image:')).toBeNull();
  });

  it('resolves full disk path under the support directory', () => {
    const support = '/Users/test/Library/Application Support/foundry';
    expect(agentMarkPath(support, 'image:mark123.png')).toBe(
      join(support, AGENT_MARKS_DIR, 'mark123.png'),
    );
    expect(agentMarkPath(support, 'invalid')).toBeNull();
  });
});

describe('saveAgentMark', () => {
  it('saves a valid PNG image and returns the emblem identifier', () => {
    const dir = tempDir('mark-save-');
    const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const b64 = pngData.toString('base64');

    const result = saveAgentMark(dir, b64, 'image/png');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.emblem.startsWith(IMAGE_EMBLEM_PREFIX)).toBe(true);
    expect(result.emblem.endsWith('.png')).toBe(true);

    const fullPath = agentMarkPath(dir, result.emblem);
    expect(fullPath).not.toBeNull();
    expect(existsSync(fullPath!)).toBe(true);
    expect(readFileSync(fullPath!)).toEqual(pngData);
  });

  it('supports jpeg, webp, gif, and svg mime types', () => {
    const dir = tempDir('mark-mimes-');
    const b64 = Buffer.from('test content').toString('base64');

    const jpegRes = saveAgentMark(dir, b64, 'image/jpeg');
    expect(jpegRes.ok && jpegRes.emblem.endsWith('.jpg')).toBe(true);

    const webpRes = saveAgentMark(dir, b64, 'image/webp');
    expect(webpRes.ok && webpRes.emblem.endsWith('.webp')).toBe(true);

    const gifRes = saveAgentMark(dir, b64, 'image/gif');
    expect(gifRes.ok && gifRes.emblem.endsWith('.gif')).toBe(true);

    const svgRes = saveAgentMark(dir, b64, 'image/svg+xml');
    expect(svgRes.ok && svgRes.emblem.endsWith('.svg')).toBe(true);
  });

  it('rejects unsupported MIME types', () => {
    const dir = tempDir('mark-mime-err-');
    const b64 = Buffer.from('not an image').toString('base64');

    const result = saveAgentMark(dir, b64, 'text/plain');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('PNG, JPEG, WebP, GIF, or SVG');
    }
  });

  it('rejects empty image payloads', () => {
    const dir = tempDir('mark-empty-');
    const result = saveAgentMark(dir, '', 'image/png');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('empty');
    }
  });

  it('rejects oversized payloads (> 2 MB)', () => {
    const dir = tempDir('mark-oversize-');
    const oversized = Buffer.alloc(MAX_AGENT_MARK_BYTES + 10);
    const b64 = oversized.toString('base64');

    const result = saveAgentMark(dir, b64, 'image/png');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('under 2 MB');
    }
  });
});

describe('removeAgentMark', () => {
  it('removes an existing uploaded mark from disk', () => {
    const dir = tempDir('mark-remove-');
    const b64 = Buffer.from('sample').toString('base64');
    const saved = saveAgentMark(dir, b64, 'image/png');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const fullPath = agentMarkPath(dir, saved.emblem)!;
    expect(existsSync(fullPath)).toBe(true);

    const removed = removeAgentMark(dir, saved.emblem);
    expect(removed).toBe(true);
    expect(existsSync(fullPath)).toBe(false);
  });

  it('returns false when removing a nonexistent or invalid mark', () => {
    const dir = tempDir('mark-remove-noop-');
    expect(removeAgentMark(dir, 'image:nonexistent.png')).toBe(false);
    expect(removeAgentMark(dir, 'monogram')).toBe(false);
    expect(removeAgentMark(dir, 'image:../dangerous.png')).toBe(false);
  });
});
