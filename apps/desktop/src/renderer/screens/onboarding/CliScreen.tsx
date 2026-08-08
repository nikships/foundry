import { CLI_VENDOR_IDS } from '@shared/types.js';
import type { CliDescriptor, CliVendor } from '@shared/types.js';
import { CliIcon } from '../../components/BrandIcon.js';
import { useOnboarding } from './OnboardingContext.js';
import { StepFooter } from './shared.js';
import styles from './CliScreen.module.css';

type Tone = 'ok' | 'warn' | 'bad' | 'idle';

function statusFor(
  vendor: CliVendor,
  checks: ReturnType<typeof useOnboarding>['checks'],
): { label: string; tone: Tone } {
  const ok = checks.find((c) => c.id === `cli:${vendor}`)?.ok;
  const authed = checks.find((c) => c.id === `auth:${vendor}`)?.ok;
  if (ok === false) return { label: 'Not installed', tone: 'bad' };
  if (authed === false) return { label: 'Needs sign-in', tone: 'warn' };
  if (ok) return { label: 'Ready', tone: 'ok' };
  return { label: 'Detected at setup', tone: 'idle' };
}

export default function CliScreen(): React.JSX.Element {
  const { clis, checks, defaultCli, pickCli, error } = useOnboarding();

  const descriptors: CliDescriptor[] = clis.length
    ? clis
    : CLI_VENDOR_IDS.map((id) => ({ id, label: id }) as CliDescriptor);

  const ordered: CliDescriptor[] = CLI_VENDOR_IDS.map(
    (id) => descriptors.find((d) => d.id === id) ?? ({ id, label: id } as CliDescriptor),
  );

  const readyCount = ordered.filter((d) => checks.find((c) => c.id === `cli:${d.id}`)?.ok).length;
  const selectedDesc =
    ordered.find((d) => d.id === defaultCli) ??
    ({ id: defaultCli, label: defaultCli } as CliDescriptor);

  return (
    <div className={styles.obCli}>
      <div className={styles.obCliHead}>
        <p className="ob-eyebrow">Agent CLIs</p>
        <h1 className="ob-title">Choose your default harness</h1>
        <p className="ob-lead">
          Foundry drives five CLIs. The default is what new agents and command detection use. You
          can still mix vendors per agent in the Roster.
        </p>
      </div>

      <div className={styles.obHarness}>
        <div className={styles.obHarnessHead}>
          <span>Harness</span>
          <span>
            {readyCount} of {ordered.length} detected
          </span>
        </div>

        <div className={styles.obHarnessList} role="radiogroup" aria-label="Default harness">
          {ordered.map((cli) => {
            const selected = cli.id === defaultCli;
            const { label, tone } = statusFor(cli.id, checks);
            const hint = cli.binary ? cli.binary : cli.id;
            return (
              <button
                key={cli.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`${styles.obHarnessRow} ${selected ? styles.on : ''}`}
                onClick={() => void pickCli(cli.id)}
              >
                <span className={styles.obHarnessIcon} aria-hidden>
                  <CliIcon vendor={cli.id} size={22} />
                </span>

                <span className={styles.obHarnessMain}>
                  <span className={styles.obHarnessName}>{cli.label}</span>
                  <span className={styles.obHarnessStatus}>
                    <span className={`${styles.obDot} ${`ob-dot-${tone}`}`} aria-hidden />
                    <span className={styles.obStatusText}>{label}</span>
                    <span className={`${styles.obHint} mono`}>· {hint}</span>
                  </span>
                </span>

                <span className={styles.obHarnessTail}>
                  {selected ? (
                    <span className={styles.obBadge}>Default</span>
                  ) : (
                    <span className={styles.obPick}>Set default</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.obHarnessFacts}>
        <div className={styles.obFactsRow}>
          <span className={styles.obFactsK}>Default</span>
          <span className={`${styles.obFactsV} mono`}>
            {selectedDesc.binary ?? selectedDesc.id}
          </span>
          {selectedDesc.supportsRpc ? (
            <span className={`${styles.obPill} ${styles.ok}`}>RPC — live tool stream</span>
          ) : (
            <span className={styles.obPill}>One-shot</span>
          )}
          {selectedDesc.docsUrl ? (
            <span className={`${styles.obDocs} mono`}>{selectedDesc.docsUrl}</span>
          ) : null}
        </div>

        <div className={styles.obFactsRow}>
          <span className={styles.obFactsK}>Auth</span>
          <span className={styles.obFactsV}>
            {selectedDesc.authEnvVars?.length ? (
              selectedDesc.authEnvVars.map((k) => (
                <span key={k} className={`${styles.obEnv} mono`}>
                  {k}
                </span>
              ))
            ) : (
              <span className="faint">No env keys declared</span>
            )}
          </span>
        </div>

        {selectedDesc.caveats?.length ? (
          <div className={styles.obFactsRow}>
            <span className={styles.obFactsK}>Caveats</span>
            <span className={`${styles.obFactsV} faint`}>{selectedDesc.caveats.join(' · ')}</span>
          </div>
        ) : null}

        <div className={styles.obFactsLegend}>
          <span className={styles.obLegend}>
            <span className={`${styles.obDot} ${styles.obDotOk}`} /> Ready
          </span>
          <span className={styles.obLegend}>
            <span className={`${styles.obDot} ${styles.obDotWarn}`} /> Needs sign-in
          </span>
          <span className={styles.obLegend}>
            <span className={`${styles.obDot} ${styles.obDotBad}`} /> Not installed
          </span>
          <span className={styles.obLegend}>
            <span className={`${styles.obDot} ${styles.obDotIdle}`} /> Detected
          </span>
          <span className={`${styles.obLegendNote} faint`}>
            Per-agent overrides live in the Roster.
          </span>
        </div>
      </div>

      {error && <p className={styles.obErr}>{error}</p>}

      <StepFooter />
    </div>
  );
}
