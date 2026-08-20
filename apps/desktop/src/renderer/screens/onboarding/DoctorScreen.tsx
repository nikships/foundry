import { ProviderIcon } from '../../components/media/BrandIcon.js';
import DoctorList from '../../components/readiness/DoctorList.js';
import { useOnboarding } from './OnboardingContext.js';
import { SceneArt, StepFooter } from './shared.js';
import { Button } from '../../components/ui/Button.js';
import styles from './DoctorScreen.module.css';

export default function DoctorScreen(): React.JSX.Element {
  const { checks, checking, recheck, canLeaveDoctor, doctorHint, bridge, models, error } =
    useOnboarding();
  const blocking = checks.filter((c) => !c.ok && c.blocking);
  const providers = bridge?.providers ?? [];
  const connected = providers.filter((p) => p.authenticated).length;
  const attention = providers.filter((p) => p.accounts.length > 0 && !p.authenticated).length;

  return (
    <div className={styles.obDoctor}>
      <div className={styles.obDoctorBody}>
        {/* ── left: narrative, chips, signal strip ─────────────────── */}
        <div className={styles.obDoctorIntro}>
          <p className="ob-eyebrow eyebrow">
            <span className="index">05</span>Environment — 5 / 6
          </p>
          <h1 className="ob-title">Make the floor safe</h1>
          <p className="ob-lead">
            A <strong>usable model</strong> and <strong>git</strong> block the rest of setup until
            they work. Everything else is informational — install it later and it appears here
            automatically.
          </p>

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

          {/* One segment per check, read straight off the run — no synthetic
              series: a figure that invented its own numbers would be the one
              part of this screen the operator could not trust. */}
          <div className={styles.obDoctorTelemetry} aria-hidden>
            <div className={styles.obDoctorTelemetryHead}>
              <span>check results</span>
              <span>
                {checks.length} signals · {blocking.length} blocking
              </span>
            </div>
            <div className={styles.obDoctorSignals}>
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
            <div className={styles.obDoctorTelemetryFoot}>
              <span>{models.length} models reachable</span>
              <span>{bridge?.running ? `bridge on ${bridge.port}` : 'bridge idle'}</span>
              <span className={styles.obDoctorTelemetryLive}>
                <span className={styles.obDoctorLiveDot} />
                {checking ? 'checking' : 'live'}
              </span>
            </div>
          </div>

          <p className={`${styles.obDoctorClarify} faint`}>
            Only a <strong>usable model</strong> and git are blocking. An unconnected provider can
            stay that way — the factory still runs.
          </p>
          <div className={styles.obDoctorScene} aria-hidden>
            <SceneArt path="scenes/empty-state.png" className={styles.obDoctorSceneArt} />
          </div>
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
