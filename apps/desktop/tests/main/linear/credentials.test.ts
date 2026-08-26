import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
    decryptString: (value: Buffer) => value.toString().split('').reverse().join(''),
  },
}));

const { LinearCredentialStore } = await import('../../../src/main/linear/credentials.js');
const { SettingsStore } = await import('../../../src/main/store/settings.js');

describe('LinearCredentialStore', () => {
  it('round-trips through an encrypted file without persisting the secret in settings', () => {
    const support = tempDir('foundry-linear-credentials-');
    const file = join(support, 'credentials', 'linear-api-key.bin');
    const codec = {
      available: () => true,
      encrypt: (value: string) => Buffer.from(value.split('').reverse().join('')),
      decrypt: (value: Buffer) => value.toString().split('').reverse().join(''),
    };
    const credentials = new LinearCredentialStore(file, codec);
    const settings = new SettingsStore(support);
    const apiKey = 'lin_api_real_secret_value';

    credentials.set(apiKey);
    settings.patch({ linearStatusMapping: { started: 's1', completed: 's2', failed: 's3' } });

    expect(credentials.has()).toBe(true);
    expect(credentials.get()).toBe(apiKey);
    expect(readFileSync(file, 'utf8')).not.toContain(apiKey);
    expect(readFileSync(join(support, 'settings.json'), 'utf8')).not.toContain(apiKey);
    credentials.clear();
    expect(credentials.has()).toBe(false);
  });

  it('fails closed when OS encryption is unavailable', () => {
    const credentials = new LinearCredentialStore(join(tempDir('foundry-linear-'), 'key'), {
      available: () => false,
      encrypt: () => Buffer.alloc(0),
      decrypt: () => '',
    });
    expect(() => credentials.set('secret')).toThrow('Secure credential storage is unavailable');
  });
});
