/**
 * Airgap mode: run droid with no Factory credential at all.
 *
 * `FACTORY_AIRGAP_ENABLED=1` makes the CLI short-circuit every auth path to a
 * synthetic identity (`airgapped-token` / `airgapped-org`) — no keyring read,
 * no `~/.factory/auth.v2.*`, no `whoami` call — and throw on any request aimed
 * at the Factory API. What is left is BYOK: the `customModels` in
 * `~/.factory/settings.json`, talking to the operator's own endpoints.
 *
 * The flag lives here rather than in `sdk/auth.ts` because three unrelated
 * layers need the same answer: daemon credentials, the model catalog, and the
 * doctor. One owner keeps them from disagreeing.
 *
 * Verified against droid CLI 0.197.0.
 */

/**
 * The credential an airgapped daemon expects. Its value is not checked — the
 * daemon accepts any non-empty string once airgap is on — but an empty one is
 * rejected before the short-circuit, so a placeholder is still required.
 */
export const AIRGAP_TOKEN = 'airgapped-token';

let enabled = false;

/** Mirror of `AppSettings.airgapMode`. Set on launch and on every save. */
export function setAirgapMode(value: boolean): void {
  enabled = value;
}

export function airgapEnabled(): boolean {
  return enabled;
}

/** `FACTORY_AIRGAP_ENABLED` overlay for `spawnEnv`, or empty when airgap is off. */
export function airgapEnvForSpawn(): Record<string, string> {
  return enabled ? { FACTORY_AIRGAP_ENABLED: '1' } : {};
}

/** Test seam: drop module state so suites cannot leak the flag into the next case. */
export function __resetAirgapModeForTest(): void {
  enabled = false;
}
