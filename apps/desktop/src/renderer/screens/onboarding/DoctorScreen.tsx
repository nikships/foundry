import { ProviderIcon } from '../../components/media/BrandIcon.js';
import DoctorList from '../../components/readiness/DoctorList.js';
import { useOnboarding } from './OnboardingContext.js';
import { StepFooter } from './shared.js';
import { Button } from '../../components/ui/Button.js';
import styles from './DoctorScreen.module.css';

export default function DoctorScreen(): React.JSX.Element {
  const { checks, checking, recheck, canLeaveDoctor, doctorHint, bridge, models, error } =
    useOnboarding();
  const blocking = checks.filter((c) => !c.ok && c.blocking);
  const passing = checks.filter((c) => c.ok).length;
  const providers = bridge?.providers ?? [];
  const connected = providers.filter((p) => p.authenticated).length;
  const attention = providers.filter((p) => p.accounts.length > 0 && !p.authenticated).length;

  return (
    <div className={styles.obDoctor}>
      <div className={styles.obDoctorBody}>
        {/* ── left: narrative, chips, signal strip ─────────────────── */}
        <div className={styles.obDoctorIntro}>
          <div className={styles.obDoctorEyebrow}>
            <p className="ob-eyebrow eyebrow">
              <span className="index">03</span>Environment
            </p>
            <span className={styles.obDoctorRule} aria-hidden />
            <span className={styles.obDoctorStep}>03 / 04</span>
          </div>
          <h1 className="ob-title">Make the floor safe</h1>
          <p className="ob-lead">
            A <strong>usable model</strong> and <strong>git</strong> block the rest of setup until
            they work. Everything else is informational — install it later and it appears here
            automatically.
          </p>

          {/* The pass count is the number the whole step turns green, so it
              carries the scale rather than sitting inside a status line. */}
          <div className={styles.obDoctorScore} data-ready={canLeaveDoctor || undefined}>
            <span className={styles.obDoctorScoreNum}>
              {passing}
              <span className={styles.obDoctorScoreOf}>/{checks.length}</span>
            </span>
            <span className={styles.obDoctorScoreText}>
              <span className={styles.obDoctorScoreLabel}>checks passing</span>
              <span className={styles.obDoctorScoreState}>
                {blocking.length === 0
                  ? 'nothing is blocking'
                  : `${blocking.length} blocking ${blocking.length === 1 ? 'check' : 'checks'}`}
              </span>
            </span>
            <span className={styles.obDoctorScoreLive}>
              <span className={styles.obDoctorLiveDot} />
              {checking ? 'checking' : 'live'}
            </span>
          </div>

          <div className={styles.obDoctorSignals} aria-hidden>
            {checks.map((check) => (
              <span
                key={check.id}
                className={`${styles.obDoctorSignal} ${
                  check.ok ? styles.ok : check.blocking ? styles.bad : styles.warn
                }`}
                title={check.label}
              />
            ))}
          </div>

          <div className={styles.obDoctorMeta}>
            <span className={styles.obDoctorMetaLabel}>Providers</span>
            <span className={styles.obDoctorMetaCount}>
              {connected} connected · {attention} needs attention ·{' '}
              {providers.length - connected - attention} idle
            </span>
          </div>

          <div className={styles.obStatusRow} role="list" aria-label="Provider status">
            {providers.map((provider, idx) => {
              const bad = provider.accounts.length > 0 && !provider.authenticated;
              return (
                <div
                  key={provider.id}
                  role="listitem"
                  className={`${styles.obStatusChip} ${
                    provider.authenticated ? styles.ok : bad ? styles.bad : ''
                  }`}
                  title={`${provider.label}${
                    provider.authenticated
                      ? ' — connected'
                      : bad
                        ? ' — needs attention'
                        : ' — not connected'
                  }`}
                  style={{ ['--i' as string]: String(idx) }}
                >
                  <ProviderIcon provider={provider.icon} size={18} />
                  <span className={styles.obMark}>
                    {provider.authenticated ? '✓' : bad ? '✕' : '·'}
                  </span>
                </div>
              );
            })}
          </div>

          <dl className={styles.obDoctorFacts}>
            <div className={styles.obDoctorFact}>
              <dt>Models</dt>
              <dd>{models.length} reachable</dd>
            </div>
            <div className={styles.obDoctorFact}>
              <dt>Bridge</dt>
              <dd>{bridge?.running ? `serving on ${bridge.port}` : 'idle'}</dd>
            </div>
          </dl>

          <p className={`${styles.obDoctorClarify} faint`}>
            Only a <strong>usable model</strong> and git are blocking. An unconnected provider can
            stay that way — the factory still runs.
          </p>
        </div>

        {/* ── right: diagnostics panel ────────────────────────────── */}
        <div className={styles.obDoctorPanelWrap}>
          <div className={styles.obDoctorPanel}>
            <div className={styles.obDoctorPanelHead}>
              <span className={styles.obDoctorPanelTitle}>
                Diagnostics <em>· {checks.length} checks</em>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.obDoctorRecheck}
                onClick={() => void recheck()}
                disabled={checking}
                aria-label="Re-check environment"
              >
                <svg
                  width={12}
                  height={12}
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden
                  className={checking ? styles.obDoctorSpin : undefined}
                >
                  <path
                    d="M13.2 8a5.2 5.2 0 1 1-1.6-3.75"
                    stroke="currentColor"
                    strokeWidth={1.45}
                    strokeLinecap="round"
                  />
                  <path
                    d="M13.4 2.2v3h-3"
                    stroke="currentColor"
                    strokeWidth={1.45}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {checking ? 'Checking…' : 'Re-check'}
              </Button>
            </div>

            <DoctorList
              checks={checks}
              onRecheck={() => void recheck()}
              hideHeader
              checking={checking}
              animate
            />

            {blocking.length > 0 && (
              <div className={styles.obDoctorDivider} data-tone="amber" role="status">
                <p className={styles.obDoctorDividerTitle}>Blocked — cannot continue</p>
                <p className={styles.obDoctorDividerBody}>
                  <b>{blocking.map((c) => c.label).join(', ')}</b>
                  {blocking.length === 1 ? ' is failing' : ' are failing'}. Fix{' '}
                  {blocking.length === 1 ? 'it' : 'them'} and Re-check before continuing. Foundry
                  will not start a run without a usable model and git.
                </p>
              </div>
            )}

            {error && (
              <div className={styles.obDoctorDivider} data-tone="red" role="alert">
                <p className={styles.obDoctorDividerTitle}>Last run</p>
                <p className={styles.obDoctorDividerBody}>{error}</p>
              </div>
            )}

            {canLeaveDoctor && (
              <div className={styles.obDoctorDivider} data-tone="green" role="status">
                <p className={styles.obDoctorDividerTitle}>Environment ready</p>
                <p className={styles.obDoctorDividerBody}>
                  All blocking checks pass.{' '}
                  <b>
                    {models.length} model{models.length === 1 ? '' : 's'} reachable
                  </b>{' '}
                  and git is configured — the factory will run.
                </p>
              </div>
            )}
          </div>

          {!canLeaveDoctor && doctorHint && <p className={styles.obDoctorHint}>{doctorHint}</p>}
        </div>
      </div>

      <StepFooter
        nextLabel={checking ? 'Checking…' : 'Continue'}
        nextDisabled={!canLeaveDoctor}
        nextTitle={doctorHint || undefined}
      />
    </div>
  );
}
