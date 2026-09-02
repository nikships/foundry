/**
 * Provider / Companion status design body for Smith's chat.
 *
 * Reports connection, auth, error, and whether a direct API key exists, plus
 * the Bridge and the paired Companion devices.
 *
 * Metadata only, by construction: the artifact type carries no key value, no
 * masked prefix, and no pairing payload, and main refuses a spec that smuggles
 * one. A key is entered only in the masked approval card and a QR payload
 * shown only in a renderer-local private display — neither is ever part of a
 * card, the transcript, or persisted chat state.
 */

import type { ProviderStatusDef, ProviderStatusEntry } from '@shared/types.js';
import {
  bridgeStatusLine,
  providerConnectionLabel,
  providerKeyLabel,
  providerStatusSummary,
} from '../../view-models/smith-artifact-view.js';
import { cx } from '../ui/cx.js';
import styles from './SmithProviderStatusDesign.module.css';

function ProviderRow({ provider }: { provider: ProviderStatusEntry }): React.JSX.Element {
  const connectionLabel = providerConnectionLabel(provider.connection);
  const accounts = provider.accounts ?? [];

  return (
    <li
      className={styles.providerRow}
      data-testid={`provider-row-${provider.connection}`}
      aria-label={`${provider.label} (${connectionLabel})`}
    >
      <div className={styles.providerHead}>
        <span className={styles.providerLabel}>{provider.label}</span>
        <span
          className={cx(styles.connectionBadge, styles[`connectionBadge_${provider.connection}`])}
          data-testid="provider-connection"
        >
          {connectionLabel}
        </span>
        {provider.loginInFlight && <span className={styles.inFlight}>sign-in in flight</span>}
        <span
          className={cx(styles.keyBadge, provider.keyPresent && styles.keyBadgePresent)}
          data-testid="provider-key"
        >
          {providerKeyLabel(provider.keyPresent)}
        </span>
      </div>
      {provider.error && (
        <span className={styles.providerError} data-testid="provider-error">
          {provider.error}
        </span>
      )}
      {accounts.length > 0 && (
        <ul className={styles.accountList} data-testid="provider-accounts">
          {accounts.map((account) => (
            <li key={account.label} className={styles.account}>
              <span className={styles.accountLabel}>{account.label}</span>
              {account.disabled && <span className={styles.accountFlag}>disabled</span>}
              {account.expired && <span className={styles.accountFlag}>expired</span>}
              {!account.expired && account.expiresAt && (
                <span className={styles.accountMeta}>expires {account.expiresAt}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function ProviderStatusDesign({
  status,
  compact,
}: {
  status: ProviderStatusDef;
  compact?: boolean;
}): React.JSX.Element {
  const summary = providerStatusSummary(status);
  const bridgeLine = bridgeStatusLine(status);
  const providers = status.providers ?? [];
  const devices = status.companion?.devices ?? [];

  return (
    <div
      className={cx(styles.status, compact && styles.compact)}
      data-testid="provider-status-design"
    >
      <div className={styles.summaryBar} data-testid="provider-status-summary">
        <span className={styles.summaryText}>{summary}</span>
      </div>

      {status.bridge && (
        <div className={styles.section} data-testid="provider-status-bridge">
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Bridge</span>
            <span
              className={cx(
                styles.stateBadge,
                status.bridge.running ? styles.stateBadgeOn : styles.stateBadgeOff,
              )}
            >
              {status.bridge.running ? 'Running' : 'Stopped'}
            </span>
          </div>
          <span className={styles.sectionLine}>{bridgeLine}</span>
        </div>
      )}

      {providers.length > 0 && (
        <div className={styles.section} data-testid="provider-status-providers">
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Providers ({providers.length})</span>
          </div>
          <ul className={styles.providerList}>
            {providers.map((provider) => (
              <ProviderRow key={provider.id} provider={provider} />
            ))}
          </ul>
        </div>
      )}

      {status.companion && (
        <div className={styles.section} data-testid="provider-status-companion">
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Companion</span>
            <span
              className={cx(
                styles.stateBadge,
                status.companion.running ? styles.stateBadgeOn : styles.stateBadgeOff,
              )}
            >
              {status.companion.running ? 'Serving' : 'Stopped'}
            </span>
            {status.companion.protocolVersion !== undefined && (
              <span className={styles.protocolBadge}>
                protocol v{status.companion.protocolVersion}
              </span>
            )}
          </div>
          {status.companion.origin && (
            <span className={cx(styles.sectionLine, 'mono')}>{status.companion.origin}</span>
          )}
          {status.companion.detail && (
            <span className={styles.sectionLine}>{status.companion.detail}</span>
          )}
          {devices.length > 0 ? (
            <ul className={styles.deviceList} data-testid="companion-devices">
              {devices.map((device) => (
                <li key={device.deviceId} className={styles.device}>
                  <span className={styles.deviceName}>{device.name}</span>
                  {device.pairedAt && (
                    <span className={styles.deviceMeta}>paired {device.pairedAt}</span>
                  )}
                  <span className={styles.deviceMeta}>
                    {device.lastSeenAt ? `last seen ${device.lastSeenAt}` : 'never seen'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <span className={styles.sectionLine} data-testid="companion-no-devices">
              No paired devices.
            </span>
          )}
          <span className={styles.privacyNote} data-testid="companion-privacy-note">
            Pairing codes and the QR payload are shown only in the private pairing display, never in
            this chat.
          </span>
        </div>
      )}
    </div>
  );
}
