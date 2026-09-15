/**
 * Shared forge CLI copy for UI empty states / hints. Backend status already
 * carries `cli: 'gh' | 'glab'`; the renderer should not fork strings ad hoc.
 */

export type ForgeCliName = 'gh' | 'glab';

export function forgeCliNotReadyTitle(cli?: ForgeCliName): string {
  return cli === 'glab' ? 'GitLab CLI not ready' : 'GitHub CLI not ready';
}

export function forgeCliCheckingHint(): string {
  return 'Checking the forge CLI…';
}

export function forgeCliLoadingListHint(): string {
  return 'Asking the forge CLI for open pull requests…';
}
