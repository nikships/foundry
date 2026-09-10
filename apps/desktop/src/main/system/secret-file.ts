/**
 * One encrypted secret file per credential. The encryption key stays in the
 * OS credential store through Electron safeStorage; JSON settings never carry
 * the value, and the file is useless off this Mac.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';

export interface SecretCodec {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export interface SecretStore {
  has(): boolean;
  get(): string | null;
  set(value: string): void;
  clear(): void;
}

export class SecretFileStore implements SecretStore {
  constructor(
    private readonly file: string,
    private readonly codec: SecretCodec,
    /** Names the credential in errors, e.g. "Linear API key". */
    private readonly label: string,
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
        `The saved ${this.label} could not be decrypted; remove it and save it again`,
      );
    }
  }

  set(value: string): void {
    this.requireEncryption();
    const encrypted = this.codec.encrypt(value);
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

export const electronSafeStorage: SecretCodec = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value),
};
