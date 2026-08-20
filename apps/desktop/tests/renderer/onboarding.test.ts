import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string =>
  readFileSync(join(here, '../..', 'src/renderer', path), 'utf8');

describe('onboarding', () => {
  const shared = read('screens/onboarding/shared.tsx');
  const welcome = read('screens/onboarding/WelcomeScreen.tsx');
  const shell = read('screens/onboarding/OnboardingShell.tsx');
  const roster = read('screens/RosterScreen.tsx');

  it('has exactly four steps and keeps each setup gate', () => {
    const stepRows = shared.match(/\{ id: '[^']+', label: '[^']+' \}/g) ?? [];
    expect(stepRows).toEqual([
      "{ id: 'welcome', label: 'Welcome' }",
      "{ id: 'providers', label: 'Providers' }",
      "{ id: 'doctor', label: 'Ready' }",
      "{ id: 'project', label: 'Project' }",
    ]);
    expect(shell).toContain('providers: ProvidersScreen');
    expect(shell).toContain('doctor: DoctorScreen');
    expect(shell).toContain('project: ProjectScreen');
  });

  it('uses one concept diagram and gives the exact accepted-run landing guidance', () => {
    expect(welcome.match(/<svg/g)).toHaveLength(1);
    expect(welcome).toContain(
      'When a run is accepted you will merge or open a PR from the run page.',
    );
  });

  it('moves meet-the-crew detail to the roster editor empty state', () => {
    const emptyState = roster.slice(roster.indexOf('{!draft &&'));
    expect(emptyState).toContain('Meet the crew');
    expect(emptyState).toContain('CREW.map');
    expect(emptyState).toContain('Create your first agent');
  });
});
