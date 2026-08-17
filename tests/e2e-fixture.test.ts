/**
 * Headless check that the Electron UI fixture is well-formed.
 *
 * Playwright specs launch the real window; this suite stays inside
 * `npm run check` so a broken seed fails the fast gate without a GUI.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, projectDbPath } from '../src/main/trace/db.js';
import { E2E_REQUEST, E2E_RUN_ID, E2E_TRANSCRIPT, seedOnboardedFixture } from './e2e/seed.js';

interface SeededSettings {
  onboarded: boolean;
  clis: { droid: { path: string } };
}

interface SeededProject {
  id: string;
  path: string;
}

interface SeededRun {
  run_id: string;
  status: string;
  request: string;
}

describe('e2e fixture seed', () => {
  it('writes onboarded settings, a git project, and a finished inspector run', () => {
    const fixture = seedOnboardedFixture();

    const settings = JSON.parse(
      readFileSync(join(fixture.supportDir, 'settings.json'), 'utf8'),
    ) as SeededSettings;
    expect(settings.onboarded).toBe(true);
    expect(settings.clis.droid.path).toBe(fixture.fakeDroidPath);
    expect(existsSync(fixture.fakeDroidPath)).toBe(true);

    const projects = JSON.parse(
      readFileSync(join(fixture.supportDir, 'projects.json'), 'utf8'),
    ) as SeededProject[];
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe(fixture.projectId);
    expect(projects[0]!.path).toBe(fixture.projectPath);
    expect(existsSync(join(fixture.projectPath, '.git'))).toBe(true);

    const db = openDb(projectDbPath(fixture.supportDir, fixture.projectPath));
    try {
      const run = db
        .prepare('SELECT run_id, status, request FROM runs WHERE run_id = ?')
        .get(E2E_RUN_ID) as SeededRun | undefined;
      expect(run).toBeDefined();
      expect(run!.status).toBe('accepted');
      expect(run!.request).toBe(E2E_REQUEST);

      const texts = db
        .prepare(`SELECT payload_json FROM events WHERE run_id = ? AND type = 'assistant_text'`)
        .all(E2E_RUN_ID) as { payload_json: string }[];
      expect(texts.some((row) => row.payload_json.includes(E2E_TRANSCRIPT))).toBe(true);
    } finally {
      db.close();
    }
  });
});
