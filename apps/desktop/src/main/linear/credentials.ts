import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safeStorage } from 'electron';

export interface SecretCodec {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export interface LinearCredentials {
  has(): boolean;
  get(): string | null;
  set(apiKey: string): void;
  clear(): void;
}

/**
 * One encrypted secret file. The encryption key stays in the OS credential
 * store through Electron safeStorage; settings.json only carries workflow IDs.
 */
export class LinearCredentialStore implements LinearCredentials {
  constructor(
    private readonly file: string,
    private readonly codec: SecretCodec,
  ) {}

  has(): boolean {
    return existsSync(this.file);
  }

  get(): string | null {
    if (!this.has()) return null;
    this.requireEncryption();
    try {
      return this.codec.decrypt(readFileSync(this.file));
    } catch {
      throw new Error(
        'The saved Linear API key could not be decrypted; remove it and save it again',
      );
    }
  }

  set(apiKey: string): void {
    this.requireEncryption();
    const encrypted = this.codec.encrypt(apiKey);
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp-${process.pid}`;
    try {
      writeFileSync(temp, encrypted, { mode: 0o600 });
      renameSync(temp, this.file);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }

  private requireEncryption(): void {
    if (!this.codec.available()) {
      throw new Error('Secure credential storage is unavailable on this Mac');
    }
  }
}

const electronSafeStorage: SecretCodec = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value),
};

export function linearCredentials(supportDir: string): LinearCredentialStore {
  return new LinearCredentialStore(
    join(supportDir, 'credentials', 'linear-api-key.bin'),
    electronSafeStorage,
  );
}
