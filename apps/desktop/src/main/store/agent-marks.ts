/**
 * User-uploaded agent marks. Stored under the app support dir so a packaged
 * app can write them (the bundled `assets/agents/` tree is read-only).
 *
 * The roster only keeps a pointer (`image:<file>`); the bytes live here.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const IMAGE_EMBLEM_PREFIX = 'image:';
export const AGENT_MARKS_DIR = 'agent-marks';
export const MAX_AGENT_MARK_BYTES = 2 * 1024 * 1024;

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
} as const;

export type AgentMarkMime = keyof typeof MIME_EXT;

export type AgentMarkSaveResult = { ok: true; emblem: string } | { ok: false; error: string };

export function isAgentMarkMime(mime: string): mime is AgentMarkMime {
  return mime in MIME_EXT;
}

export function agentMarkFile(emblem: string): string | null {
  if (!emblem.startsWith(IMAGE_EMBLEM_PREFIX)) return null;
  const file = emblem.slice(IMAGE_EMBLEM_PREFIX.length);
  if (!file || file !== basename(file) || file.includes('..')) return null;
  return file;
}

export function agentMarkPath(supportDir: string, emblem: string): string | null {
  const file = agentMarkFile(emblem);
  if (!file) return null;
  return join(supportDir, AGENT_MARKS_DIR, file);
}

export function saveAgentMark(
  supportDir: string,
  bytesB64: string,
  mime: string,
): AgentMarkSaveResult {
  if (!isAgentMarkMime(mime)) {
    return { ok: false, error: 'Use a PNG, JPEG, WebP, GIF, or SVG image.' };
  }
  // Base64 decoding never throws — it drops what it cannot read — so an
  // unusable payload arrives here as an empty buffer rather than an error.
  const bytes = Buffer.from(bytesB64, 'base64');
  if (!bytes.length) return { ok: false, error: 'The image was empty.' };
  if (bytes.length > MAX_AGENT_MARK_BYTES) {
    return { ok: false, error: 'Keep the image under 2 MB.' };
  }
  const file = `${randomBytes(8).toString('hex')}.${MIME_EXT[mime]}`;
  const dir = join(supportDir, AGENT_MARKS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), bytes);
  return { ok: true, emblem: `${IMAGE_EMBLEM_PREFIX}${file}` };
}

export function removeAgentMark(supportDir: string, emblem: string): boolean {
  const path = agentMarkPath(supportDir, emblem);
  if (!path || !existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
