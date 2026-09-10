import { join } from 'node:path';
import { electronSafeStorage, SecretFileStore, type SecretCodec } from '../system/secret-file.js';

export type { SecretCodec };

export interface LinearCredentials {
  has(): boolean;
  get(): string | null;
  set(apiKey: string): void;
  clear(): void;
}

/** One encrypted secret file; see `system/secret-file.ts` for the contract. */
export class LinearCredentialStore extends SecretFileStore implements LinearCredentials {
  constructor(file: string, codec: SecretCodec) {
    super(file, codec, 'Linear API key');
  }
}

export function linearCredentials(supportDir: string): LinearCredentialStore {
  return new LinearCredentialStore(
    join(supportDir, 'credentials', 'linear-api-key.bin'),
    electronSafeStorage,
  );
}
