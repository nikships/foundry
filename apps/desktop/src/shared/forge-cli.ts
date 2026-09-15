/**
 * Shared forge CLI copy and the app-level host preference. Backend status
 * already carries `cli: 'gh' | 'glab'`; the renderer should not fork strings
 * ad hoc.
 */

export type ForgeCliName = 'gh' | 'glab';

/** Which forge CLI Foundry uses for PRs/MRs. `auto` classifies from the project git remote. */
export type ForgeProviderPreference = 'auto' | 'github' | 'gitlab';
export const FORGE_PROVIDER_SETTINGS = ['auto', 'github', 'gitlab'] as unknown as readonly [
  ForgeProviderPreference,
  ...ForgeProviderPreference[],
];

export const DEFAULT_FORGE_PROVIDER: ForgeProviderPreference = 'auto';

export function isForgeProviderPreference(value: unknown): value is ForgeProviderPreference {
  return (
    typeof value === 'string' && (FORGE_PROVIDER_SETTINGS as readonly string[]).includes(value)
  );
}

export function forgeCliNotReadyTitle(cli?: ForgeCliName): string {
  return cli === 'glab' ? 'GitLab CLI not ready' : 'GitHub CLI not ready';
}

/**
 * Empty-state body when the chosen forge CLI is unavailable. Auto may have
 * picked GitHub for a self-hosted GitLab remote, so mention Settings.
 */
export function forgeCliNotReadyBody(input: {
  cli?: ForgeCliName;
  detail?: string;
  preference?: ForgeProviderPreference;
}): string {
  const detail = input.detail?.trim() ?? '';
  if (input.preference === 'github' || input.preference === 'gitlab') {
    return detail;
  }
  const other = input.cli === 'glab' ? 'GitHub' : 'GitLab';
  const hint = `Auto picked this host from the git remote. If this should be ${other}, set Forge in Settings → Integrations.`;
  return detail ? `${detail} ${hint}` : hint;
}

export function forgeCliCheckingHint(): string {
  return 'Checking the forge CLI…';
}

export function forgeCliLoadingListHint(): string {
  return 'Asking the forge CLI for open pull requests…';
}
