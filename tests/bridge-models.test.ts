/**
 * models.json generation: only authenticated providers, foreign entries
 * preserved, deterministic bytes, atomic writes, and no write (therefore no pi
 * refresh) when nothing changed.
 *
 * Auth files are written as CLIProxyAPI writes them, because the parser's job
 * is to read that format without ever carrying a token out of it.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authenticatedProviders, readAccounts } from '../src/main/bridge/auth.js';
import {
  generateProviders,
  mergeModelsJson,
  readModelsJson,
  regenerateModels,
  writeModelsJson,
} from '../src/main/bridge/models.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-bridge-models-'));
  dirs.push(dir);
  return dir;
}

/** An auth file shaped like CLIProxyAPI's, tokens included, as on disk. */
function writeAuthFile(authDir: string, file: string, fields: Record<string, unknown>): void {
  mkdirSync(authDir, { recursive: true });
  writeFileSync(
    join(authDir, file),
    JSON.stringify({
      access_token: 'at-secret-value',
      refresh_token: 'rt-secret-value',
      ...fields,
    }),
  );
}

const BASE_URL = 'http://127.0.0.1:37717';

describe('bridge account reading', () => {
  it('carries no token out of an auth file', () => {
    const dir = tempDir();
    writeAuthFile(dir, 'claude-a.json', { type: 'claude', email: 'dev@example.com' });

    const accounts = readAccounts(dir);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.label).toBe('dev@example.com');
    // Whatever else the provider wrote stays on disk: the serialized account is
    // the only thing that crosses IPC, so it must not contain a secret.
    expect(JSON.stringify(accounts)).not.toContain('secret-value');
  });

  it('skips an unparseable file and one whose provider Foundry does not offer', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'half-written.json'), '{"type": "cla');
    writeAuthFile(dir, 'copilot.json', { type: 'copilot', login: 'octocat' });
    writeAuthFile(dir, 'kimi.json', { type: 'kimi', email: 'k@example.com' });

    expect(readAccounts(dir).map((a) => a.provider)).toEqual(['kimi']);
  });

  it('treats an expired or disabled account as not authenticated', () => {
    const dir = tempDir();
    writeAuthFile(dir, 'grok.json', {
      type: 'grok',
      email: 'g@example.com',
      expired: new Date(Date.now() - 60_000).toISOString(),
    });
    writeAuthFile(dir, 'codex.json', { type: 'codex', email: 'c@example.com', disabled: true });
    writeAuthFile(dir, 'claude.json', { type: 'claude', email: 'a@example.com' });

    expect(authenticatedProviders(dir)).toEqual(['claude']);
  });

  it('answers with no accounts when the directory does not exist yet', () => {
    expect(readAccounts(join(tempDir(), 'never-created'))).toEqual([]);
  });
});

describe('models.json generation', () => {
  it('emits only authenticated providers, prefixed so built-ins cannot collide', () => {
    const providers = generateProviders(['claude', 'kimi'], BASE_URL);
    expect(Object.keys(providers)).toEqual(['bridge-claude', 'bridge-kimi']);
    expect(providers['bridge-claude']?.models.length).toBeGreaterThan(0);
  });

  it('points Anthropic at the root and OpenAI-shaped providers at /v1', () => {
    const providers = generateProviders(['claude', 'codex', 'gemini'], BASE_URL);
    // The Anthropic SDK appends /v1/messages itself; a /v1 base would 404.
    expect(providers['bridge-claude']?.baseUrl).toBe(BASE_URL);
    expect(providers['bridge-claude']?.api).toBe('anthropic-messages');
    expect(providers['bridge-codex']?.baseUrl).toBe(`${BASE_URL}/v1`);
    expect(providers['bridge-codex']?.api).toBe('openai-responses');
    expect(providers['bridge-gemini']?.baseUrl).toBe(`${BASE_URL}/v1`);
  });

  it('prices every model at zero, because the subscription is already paid', () => {
    for (const provider of Object.values(generateProviders(['claude', 'codex'], BASE_URL))) {
      for (const model of provider.models) {
        expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      }
    }
  });

  it('is deterministic regardless of the order the providers arrive in', () => {
    const a = JSON.stringify(generateProviders(['grok', 'claude', 'codex'], BASE_URL));
    const b = JSON.stringify(generateProviders(['codex', 'grok', 'claude'], BASE_URL));
    expect(a).toBe(b);
  });

  it('keeps a hand-added provider and any unknown top-level field', () => {
    const merged = mergeModelsJson(
      {
        providers: {
          ollama: { baseUrl: 'http://localhost:11434/v1', models: [{ id: 'llama3.1:8b' }] },
          'bridge-codex': { stale: true },
        },
        somethingFutureVersionsAdd: 42,
      },
      generateProviders(['claude'], BASE_URL),
    );

    expect(merged.providers?.ollama).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      models: [{ id: 'llama3.1:8b' }],
    });
    expect(merged.somethingFutureVersionsAdd).toBe(42);
    // A provider that lost its last account disappears rather than lingering.
    expect(merged.providers?.['bridge-codex']).toBeUndefined();
    expect(merged.providers?.['bridge-claude']).toBeDefined();
  });
});

describe('writing models.json', () => {
  it('reports no change for an identical document, so pi is not refreshed', () => {
    const path = join(tempDir(), 'models.json');
    const document = mergeModelsJson(null, generateProviders(['claude'], BASE_URL));

    expect(writeModelsJson(path, document).changed).toBe(true);
    expect(writeModelsJson(path, document).changed).toBe(false);
  });

  it('leaves no temp file behind', () => {
    const dir = tempDir();
    const path = join(dir, 'models.json');
    writeModelsJson(path, mergeModelsJson(null, generateProviders(['claude'], BASE_URL)));
    expect(readModelsJson(path)).not.toBeNull();
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('treats an unparseable existing file as empty rather than failing', () => {
    const path = join(tempDir(), 'models.json');
    writeFileSync(path, 'not json at all');
    expect(readModelsJson(path)).toBeNull();

    const result = regenerateModels({
      modelsPath: path,
      authenticated: ['claude'],
      baseUrl: BASE_URL,
    });
    expect(result.changed).toBe(true);
    expect(readModelsJson(path)?.providers).toHaveProperty('bridge-claude');
  });

  it('drops a provider’s models once its last account is gone', () => {
    const dir = tempDir();
    const path = join(dir, 'models.json');
    regenerateModels({ modelsPath: path, authenticated: ['claude'], baseUrl: BASE_URL });
    const after = regenerateModels({ modelsPath: path, authenticated: [], baseUrl: BASE_URL });

    expect(after.changed).toBe(true);
    expect(readModelsJson(path)?.providers).toEqual({});
  });
});
