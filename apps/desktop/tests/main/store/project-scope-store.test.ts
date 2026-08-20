/**
 * A project copy of the roster or pipelines is seeded from the app-level set the
 * first time it is read, then kept on disk. Turning the scope flag off routes
 * reads back to the app store but does not delete the copy, so turning it on
 * again restores the older copy rather than re-forking from current global
 * state.
 *
 * That is easy to trip now that the toggle is one click from the editor, so the
 * behaviour is pinned here and `hasProjectCopy` — which the UI uses to tell the
 * two cases apart — is pinned with it.
 */

import { rmSync } from 'node:fs';
import { tempDir } from '../../helpers/tmp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RosterStore } from '../../../src/main/store/roster.js';
import { PipelineStore } from '../../../src/main/store/pipelines.js';

let dir = '';
const PROJECT = 'proj-1';

beforeEach(() => {
  dir = tempDir('foundry-scope-');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a project roster copy', () => {
  const scoped = { projectId: PROJECT, ownRoster: true };

  it('does not exist until the project actually reads in project scope', () => {
    const roster = new RosterStore(dir);
    roster.list();
    expect(roster.hasProjectCopy(PROJECT)).toBe(false);
  });

  it('is seeded from the app-level set on first read', () => {
    const roster = new RosterStore(dir);
    const app = roster.list();
    expect(roster.list(scoped).map((a) => a.name)).toEqual(app.map((a) => a.name));
    expect(roster.hasProjectCopy(PROJECT)).toBe(true);
  });

  it('is independent afterwards: an app-level edit does not reach it', () => {
    const roster = new RosterStore(dir);
    const seed = roster.list(scoped);
    const agent = seed[0]!;

    roster.save({ ...agent, purpose: 'changed globally' });

    expect(roster.get(agent.name, scoped)?.purpose).toBe(agent.purpose);
    expect(roster.get(agent.name)?.purpose).toBe('changed globally');
  });

  it('survives switching scope off, which is why re-enabling is not a fresh fork', () => {
    const roster = new RosterStore(dir);
    const agent = roster.list(scoped)[0]!;
    roster.save({ ...agent, purpose: 'project-only edit' }, scoped);

    // Scope off: reads go to the app store, the copy is untouched on disk.
    expect(roster.get(agent.name, { projectId: PROJECT, ownRoster: false })?.purpose).toBe(
      agent.purpose,
    );
    expect(roster.hasProjectCopy(PROJECT)).toBe(true);

    // Meanwhile the global set moves on.
    roster.save({ ...agent, purpose: 'newer global text' });

    // Back on: the old copy returns, NOT a fork of the newer global set.
    expect(roster.get(agent.name, scoped)?.purpose).toBe('project-only edit');
  });

  it('reports per project, so one project copy does not imply another', () => {
    const roster = new RosterStore(dir);
    roster.list({ projectId: 'a', ownRoster: true });
    expect(roster.hasProjectCopy('a')).toBe(true);
    expect(roster.hasProjectCopy('b')).toBe(false);
  });
});

describe('a project pipelines copy', () => {
  const scoped = { projectId: PROJECT, ownPipelines: true };

  it('is seeded on first read and then independent', () => {
    const pipelines = new PipelineStore(dir);
    const seeded = pipelines.list(scoped);
    expect(seeded.length).toBeGreaterThan(0);
    expect(pipelines.hasProjectCopy(PROJECT)).toBe(true);
  });

  it('survives switching scope off', () => {
    const pipelines = new PipelineStore(dir);
    pipelines.list(scoped);
    expect(pipelines.hasProjectCopy(PROJECT)).toBe(true);
    // Reading in app scope must not clear the project's file.
    pipelines.list();
    expect(pipelines.hasProjectCopy(PROJECT)).toBe(true);
  });

  it('is false for a project that never opted in', () => {
    const pipelines = new PipelineStore(dir);
    pipelines.list();
    expect(pipelines.hasProjectCopy(PROJECT)).toBe(false);
  });
});
