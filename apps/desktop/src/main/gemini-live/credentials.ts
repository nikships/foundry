/**
 * The stored Gemini API key behind Smith's live voice layer. Same contract and
 * same storage discipline as the Linear key: one encrypted file under
 * `<supportDir>/credentials/`, key material in the OS credential store, never
 * settings.json, a transcript, or anything the renderer can read. Only the
 * ephemeral tokens minted from it cross the IPC seam.
 */

import { join } from 'node:path';
import { electronSafeStorage, SecretFileStore, type SecretCodec } from '../system/secret-file.js';

export interface GeminiLiveCredentials {
  has(): boolean;
  get(): string | null;
  set(apiKey: string): void;
  clear(): void;
}

/** One encrypted secret file; see `system/secret-file.ts` for the contract. */
export class GeminiLiveCredentialStore extends SecretFileStore implements GeminiLiveCredentials {
  constructor(file: string, codec: SecretCodec) {
    super(file, codec, 'Gemini API key');
  }
}

export function geminiLiveCredentials(supportDir: string): GeminiLiveCredentialStore {
  return new GeminiLiveCredentialStore(
    join(supportDir, 'credentials', 'gemini-live-api-key.bin'),
    electronSafeStorage,
  );
}
