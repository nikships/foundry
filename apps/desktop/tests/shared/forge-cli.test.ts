import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORGE_PROVIDER,
  forgeCliNotReadyBody,
  forgeCliNotReadyTitle,
  isForgeProviderPreference,
} from '../../src/shared/forge-cli.js';

describe('forge provider preference', () => {
  it('defaults to auto', () => {
    expect(DEFAULT_FORGE_PROVIDER).toBe('auto');
  });

  it('accepts auto, github, and gitlab', () => {
    expect(isForgeProviderPreference('auto')).toBe(true);
    expect(isForgeProviderPreference('github')).toBe(true);
    expect(isForgeProviderPreference('gitlab')).toBe(true);
    expect(isForgeProviderPreference('bitbucket')).toBe(false);
    expect(isForgeProviderPreference('')).toBe(false);
  });
});

describe('forge CLI empty-state copy', () => {
  it('titles GitHub vs GitLab from the CLI name', () => {
    expect(forgeCliNotReadyTitle('gh')).toBe('GitHub CLI not ready');
    expect(forgeCliNotReadyTitle('glab')).toBe('GitLab CLI not ready');
    expect(forgeCliNotReadyTitle()).toBe('GitHub CLI not ready');
  });

  it('keeps the CLI detail when Forge is forced', () => {
    expect(
      forgeCliNotReadyBody({
        cli: 'glab',
        detail: 'GitLab CLI (glab) is not installed or not on PATH',
        preference: 'gitlab',
      }),
    ).toBe('GitLab CLI (glab) is not installed or not on PATH');
  });

  it('points Auto-misclassified GitHub at Settings → Forge', () => {
    const body = forgeCliNotReadyBody({
      cli: 'gh',
      detail: 'GitHub CLI (gh) is not installed or not on PATH',
      preference: 'auto',
    });
    expect(body).toContain('GitHub CLI (gh) is not installed or not on PATH');
    expect(body).toContain('Settings → Integrations');
    expect(body).toContain('GitLab');
  });
});
