/**
 * The providers the Bridge can log into, and how each one reaches pi.
 *
 * One table rather than three: the login flag, the `type` field CLIProxyAPI
 * writes into its auth files, and the pi API kind are all facets of the same
 * provider, and splitting them across modules is how a provider ends up
 * loggable but unreachable. The models themselves are not listed here — they
 * come from the CLIProxyAPI catalog `fetch:bridge` vendors next to the binary.
 *
 * GitHub Copilot is deliberately absent. The vendored CLIProxyAPI has no
 * Copilot login flow — CLIProxyAPI serves Copilot from a second, separate
 * gateway process — so listing it here would offer a login that cannot happen.
 * Copilot arrives with that gateway or not at all.
 */

/** Providers Foundry can authenticate through the Bridge. */
export type BridgeProviderId = 'claude' | 'codex' | 'gemini' | 'kimi' | 'grok';

export const BRIDGE_PROVIDER_IDS: readonly BridgeProviderId[] = [
  'claude',
  'codex',
  'gemini',
  'kimi',
  'grok',
] as const;

/** pi's API kinds, named here so `models.ts` never spells one wrong. */
export type BridgeApi =
  'anthropic-messages' | 'openai-responses' | 'openai-completions' | 'google-generative-ai';

export interface BridgeProviderDef {
  id: BridgeProviderId;
  /** Shown in Settings; never derived from the id. */
  label: string;
  /** The flag that starts this provider's OAuth flow on the Bridge binary. */
  loginFlag: string;
  /**
   * `type` values CLIProxyAPI writes into an auth file for this provider.
   * Several are historical aliases; an unrecognised type is an account Foundry
   * does not claim rather than a parse failure.
   */
  authTypes: readonly string[];
  api: BridgeApi;
  /**
   * Whether pi should reach this provider at `<bridge>/v1` or at the root.
   *
   * The Anthropic SDK appends `/v1/messages` to whatever base URL it is given,
   * so an anthropic-messages entry pointing at `/v1` would request
   * `/v1/v1/messages` and 404. OpenAI-compatible kinds want the `/v1` prefix.
   */
  baseUrlSuffix: '' | '/v1';
  /** Icon key the renderer maps to a provider mark. */
  icon: string;
}

export const BRIDGE_PROVIDERS: readonly BridgeProviderDef[] = [
  {
    id: 'claude',
    label: 'Claude',
    loginFlag: '-claude-login',
    authTypes: ['claude'],
    api: 'anthropic-messages',
    baseUrlSuffix: '',
    icon: 'claude',
  },
  {
    id: 'codex',
    label: 'ChatGPT (Codex)',
    loginFlag: '-codex-login',
    authTypes: ['codex'],
    api: 'openai-responses',
    baseUrlSuffix: '/v1',
    icon: 'openai',
  },
  {
    id: 'gemini',
    label: 'Gemini (Antigravity)',
    // CLIProxyAPI's Gemini subscription flow is the Antigravity one; the auth
    // files it writes still carry gemini-shaped types, which is why both are
    // claimed below.
    loginFlag: '-antigravity-login',
    authTypes: ['antigravity', 'gemini', 'gemini-cli'],
    // Routed as OpenAI chat-completions rather than google-generative-ai: the
    // Antigravity executor answers on the chat-completions path, and pi's
    // Google API kind would build v1beta URLs the Bridge does not serve.
    api: 'openai-completions',
    baseUrlSuffix: '/v1',
    icon: 'gemini',
  },
  {
    id: 'kimi',
    label: 'Kimi',
    loginFlag: '-kimi-login',
    authTypes: ['kimi'],
    api: 'openai-completions',
    baseUrlSuffix: '/v1',
    icon: 'kimi',
  },
  {
    id: 'grok',
    label: 'Grok',
    loginFlag: '-xai-login',
    authTypes: ['grok', 'grok-cli', 'xai'],
    api: 'openai-completions',
    baseUrlSuffix: '/v1',
    icon: 'grok',
  },
] as const;

export function bridgeProvider(id: string): BridgeProviderDef | undefined {
  return BRIDGE_PROVIDERS.find((provider) => provider.id === id);
}

/**
 * Narrows an arbitrary string to a provider id.
 *
 * The IPC layer needs this rather than a cast: the value it receives ends up in
 * a spawn argument and in a filesystem path, so it has to be checked against
 * the table instead of trusted.
 */
export function isBridgeProvider(id: string): id is BridgeProviderId {
  return BRIDGE_PROVIDER_IDS.some((known) => known === id);
}

/** The provider that claims this auth file's `type`, or undefined. */
export function providerForAuthType(type: string): BridgeProviderDef | undefined {
  const needle = type.trim().toLowerCase();
  return BRIDGE_PROVIDERS.find((provider) => provider.authTypes.includes(needle));
}

/**
 * The pi provider id a Bridge provider's models are registered under.
 *
 * Prefixed so a Bridge entry can never collide with, or silently override, a
 * built-in pi provider the operator authenticated directly: `anthropic` stays
 * the operator's own Anthropic key, and `bridge-claude` is the subscription.
 */
export function piProviderId(id: BridgeProviderId): string {
  return `bridge-${id}`;
}

/** True for a pi provider id this module owns. Used to preserve foreign entries. */
export function isBridgeProviderId(providerId: string): boolean {
  return BRIDGE_PROVIDER_IDS.some((id) => piProviderId(id) === providerId);
}
