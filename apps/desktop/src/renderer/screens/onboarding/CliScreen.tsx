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
  const { clis, checks, error } = useOnboarding();

  const descriptors: CliDescriptor[] = clis.length
    ? clis
    : CLI_VENDOR_IDS.map((id) => ({ id, label: id }) as CliDescriptor);

  const selectedDesc =
    descriptors.find((d) => d.id === 'droid') ??
    ({ id: 'droid', label: 'Factory Droid', binary: 'droid' } as CliDescriptor);

  const { label, tone } = statusFor('droid', checks);
  const hint = selectedDesc.binary ? selectedDesc.binary : 'droid';

  return (
    <div className={styles.obCli}>
      <div className={styles.obCliHead}>
        <p className="ob-eyebrow">Agent CLI</p>
        <h1 className="ob-title">Agent harness setup</h1>
        <p className="ob-lead">
          Foundry drives Factory Droid to run agent phases with live JSON-RPC tool streaming.
        </p>
      </div>

      <div className={styles.obHarness}>
        <div className={styles.obHarnessHead}>
          <span>Harness</span>
          <span>Factory Droid</span>
        </div>

        <div className={styles.obHarnessList}>
          <div className={`${styles.obHarnessRow} ${styles.on}`}>
            <span className={styles.obHarnessIcon} aria-hidden>
              <CliIcon vendor="droid" size={22} />
            </span>

            <span className={styles.obHarnessMain}>
              <span className={styles.obHarnessName}>Factory Droid</span>
              <span className={styles.obHarnessStatus}>
                <span className={`${styles.obDot} ${`ob-dot-${tone}`}`} aria-hidden />
                <span className={styles.obStatusText}>{label}</span>
                <span className={`${styles.obHint} mono`}>· {hint}</span>
              </span>
            </span>

            <span className={styles.obHarnessTail}>
              <span className={styles.obBadge}>Default</span>
            </span>
          </div>
        </div>
      </div>

      <div className={styles.obHarnessFacts}>
        <div className={styles.obFactsRow}>
          <span className={styles.obFactsK}>Harness</span>
          <span className={`${styles.obFactsV} mono`}>
            {selectedDesc.binary ?? selectedDesc.id}
          </span>
          <span className={`${styles.obPill} ${styles.ok}`}>RPC — live tool stream</span>
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
              <span className="faint">No env keys set</span>
            )}
          </span>
        </div>

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
        </div>
      </div>

      {error && <p className={styles.obErr}>{error}</p>}

      <StepFooter />
    </div>
  );
}
