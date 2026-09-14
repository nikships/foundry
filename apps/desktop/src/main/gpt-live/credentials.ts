/**
 * The stored OpenAI API key behind Smith's live voice layer. Same contract and
 * same storage discipline as the Linear key: one encrypted file under
 * `<supportDir>/credentials/`, key material in the OS credential store, never
 * settings.json, a transcript, or anything the renderer can read. The key
 * never crosses the IPC seam; main creates Live sessions with it.
 */

import { join } from 'node:path';
import { electronSafeStorage, SecretFileStore, type SecretCodec } from '../system/secret-file.js';

export interface GptLiveCredentials {
  has(): boolean;
  get(): string | null;
  set(apiKey: string): void;
  clear(): void;
}

/** One encrypted secret file; see `system/secret-file.ts` for the contract. */
export class GptLiveCredentialStore extends SecretFileStore implements GptLiveCredentials {
  constructor(file: string, codec: SecretCodec) {
    super(file, codec, 'OpenAI API key');
  }
}

export function gptLiveCredentials(supportDir: string): GptLiveCredentialStore {
  return new GptLiveCredentialStore(
    join(supportDir, 'credentials', 'gpt-live-api-key.bin'),
    electronSafeStorage,
  );
}
