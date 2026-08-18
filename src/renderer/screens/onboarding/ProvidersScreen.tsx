import { useState } from 'react';
import {
  BRIDGE_UNAVAILABLE_COPY,
  type BridgeProviderInfo,
  type BridgeState,
} from '@shared/ipc-contract.js';
import { ProviderIcon } from '../../components/BrandIcon.js';
import { Button } from '../../components/ui/Button.js';
import { Dropdown } from '../../components/ui/Dropdown.js';
import { Field, TextInput } from '../../components/ui/Field.js';
import { useOnboarding } from './OnboardingContext.js';
import { StepFooter } from './shared.js';
import styles from './ProvidersScreen.module.css';

type Tone = 'ok' | 'warn' | 'bad' | 'idle';

/**
 * Providers offered a direct-key row here, keyed by pi's own provider id — the
 * id `bridge.setApiKey` hands to pi's credential store. Kept short on purpose:
 * onboarding needs one working credential, not a tour of every provider pi
 * knows. Settings → Providers is where the full set lives.
 */
const KEY_PROVIDERS: { id: string; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google AI Studio' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'xai', label: 'xAI' },
];

function statusFor(provider: BridgeProviderInfo): { label: string; tone: Tone } {
  if (provider.loginInFlight) return { label: 'Waiting on your browser', tone: 'warn' };
  if (provider.accounts.some((account) => account.expired)) {
    return { label: 'Sign-in expired', tone: 'bad' };
  }
  if (provider.accounts.length && provider.accounts.every((account) => account.disabled)) {
    return { label: 'Every account disabled', tone: 'bad' };
  }
  if (provider.authenticated) return { label: 'Connected', tone: 'ok' };
  return { label: 'Not connected', tone: 'idle' };
}

export default function ProvidersScreen(): React.JSX.Element {
  const {
    bridge,
    models,
    hasUsableModel,
    providersHint,
    providerBusy,
    connectProvider,
    cancelProviderLogin,
    startBridge,
    saveProviderKey,
    refreshProviders,
    error,
  } = useOnboarding();
  const [keyProvider, setKeyProvider] = useState(KEY_PROVIDERS[0]!.id);
  const [keyDraft, setKeyDraft] = useState('');

  const providers = bridge?.providers ?? [];
  const bridgeReady = bridge?.running === true;

  return (
    <div className={styles.obProviders}>
      <div className={styles.obProvidersHead}>
        <p className="ob-eyebrow eyebrow">
          <span className="index">04</span>Providers
        </p>
        <h1 className="ob-title">Give the factory a model</h1>
        <p className="ob-lead">
          Foundry runs every agent phase in-process on pi. Sign in with a subscription you already
          pay for, or store a provider API key. Keys are held by pi on this Mac, never in
          Foundry&rsquo;s settings.
        </p>
      </div>

      <div className={styles.obProviderPanel}>
        <div className={styles.obProviderPanelHead}>
          <span>Subscriptions</span>
          <span>
            {bridge
              ? bridgeReady
                ? `bridge on ${bridge.port}`
                : 'bridge not running'
              : 'checking…'}
          </span>
        </div>

        {!bridgeReady && (
          <div className={styles.obProviderNotice}>
            <span>{bridgeNotice(bridge)}</span>
            <Button
              type="button"
              size="sm"
              disabled={!!providerBusy}
              onClick={() => void startBridge()}
            >
              {providerBusy === 'bridge' ? 'Starting…' : 'Start it'}
            </Button>
          </div>
        )}

        <div className={styles.obProviderList}>
          {providers.map((provider) => {
            const { label, tone } = statusFor(provider);
            const connected = provider.authenticated;
            return (
              <div
                key={provider.id}
                className={`${styles.obProviderRow} ${connected ? styles.on : ''}`}
                data-testid={`onboarding-provider-${provider.id}`}
              >
                <span className={styles.obProviderIcon} aria-hidden>
                  <ProviderIcon provider={provider.icon} size={22} />
                </span>

                <span className={styles.obProviderMain}>
                  <span className={styles.obProviderName}>{provider.label}</span>
                  <span className={styles.obProviderStatus}>
                    <span
                      className={`${styles.obDot} ${styles[`obDot${cap(tone)}`]}`}
                      aria-hidden
                    />
                    <span className={styles.obStatusText}>{label}</span>
                    {provider.accounts[0] && (
                      <span className={`${styles.obHint} mono`}>
                        · {provider.accounts[0].label}
                      </span>
                    )}
                  </span>
                </span>

                <span className={styles.obProviderTail}>
                  {provider.loginInFlight ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void cancelProviderLogin(provider.id)}
                    >
                      Cancel
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant={connected ? undefined : 'primary'}
                      disabled={!!providerBusy || !bridgeReady}
                      title={bridgeReady ? undefined : 'Start the bridge first.'}
                      onClick={() => void connectProvider(provider.id)}
                    >
                      {providerBusy === provider.id
                        ? 'Opening…'
                        : connected
                          ? 'Reconnect'
                          : 'Connect'}
                    </Button>
                  )}
                </span>
              </div>
            );
          })}
          {!providers.length && (
            <p className={styles.obProviderEmpty}>
              This build offers no subscription providers. An API key still gets you a model.
            </p>
          )}
        </div>
      </div>

      <div className={styles.obProviderPanel}>
        <div className={styles.obProviderPanelHead}>
          <span>API key</span>
          <span>stored by pi</span>
        </div>
        <div className={styles.obKeyForm}>
          <Field label="Provider">
            <Dropdown
              aria-label="API key provider"
              value={keyProvider}
              options={KEY_PROVIDERS.map((provider) => ({
                value: provider.id,
                label: provider.label,
              }))}
              onChange={setKeyProvider}
            />
          </Field>
          <Field label="Key" htmlFor="onboarding-provider-key">
            <TextInput
              id="onboarding-provider-key"
              aria-label="Provider API key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              mono
              value={keyDraft}
              placeholder="paste a key"
              onChange={(e) => setKeyDraft(e.target.value)}
            />
          </Field>
          <Button
            type="button"
            disabled={!!providerBusy || !keyDraft.trim()}
            onClick={() =>
              void (async () => {
                await saveProviderKey(keyProvider, keyDraft);
                setKeyDraft('');
              })()
            }
          >
            {providerBusy === `key:${keyProvider}` ? 'Saving…' : 'Save key'}
          </Button>
        </div>
      </div>

      <div className={styles.obProviderFacts}>
        <div className={styles.obFactsRow}>
          <span className={styles.obFactsK}>Models</span>
          <span className={`${styles.obFactsV} mono`} data-testid="onboarding-model-count">
            {models.length}
          </span>
          <span className={`${styles.obPill} ${hasUsableModel ? styles.ok : ''}`}>
            {hasUsableModel ? 'ready to run' : 'none reachable'}
          </span>
          <span className={styles.obFactsTail}>
            <Button type="button" variant="ghost" size="sm" onClick={() => void refreshProviders()}>
              Refresh
            </Button>
          </span>
        </div>
        <div className={styles.obFactsLegend}>
          <span className={styles.obLegend}>
            <span className={`${styles.obDot} ${styles.obDotOk}`} /> Connected
          </span>
          <span className={styles.obLegend}>
            <span className={`${styles.obDot} ${styles.obDotWarn}`} /> Waiting
          </span>
          <span className={styles.obLegend}>
            <span className={`${styles.obDot} ${styles.obDotBad}`} /> Needs attention
          </span>
          <span className={styles.obLegend}>
            <span className={`${styles.obDot} ${styles.obDotIdle}`} /> Not connected
          </span>
        </div>
      </div>

      {error && <p className={styles.obErr}>{error}</p>}

      <StepFooter
        nextDisabled={!hasUsableModel}
        nextTitle={providersHint || undefined}
        hint={providersHint}
      />
    </div>
  );
}

/**
 * Why subscriptions are unavailable, and what to do about it.
 *
 * `detail` states only the remedy, so the reason is prefixed here rather than
 * duplicated into it — the same split the doctor's Bridge check uses.
 */
function bridgeNotice(bridge: BridgeState | null): string {
  if (!bridge) return 'Checking for the provider bridge…';
  const reason = bridge.reason
    ? BRIDGE_UNAVAILABLE_COPY[bridge.reason]
    : 'the bridge is not serving';
  const detail = bridge.detail ? `: ${bridge.detail}` : '';
  return `${reason}${detail}. Subscription logins need it; API keys do not.`;
}

/** `ok` → `Ok`, so a tone maps onto its CSS-module dot class. */
function cap(tone: Tone): string {
  return tone.charAt(0).toUpperCase() + tone.slice(1);
}
