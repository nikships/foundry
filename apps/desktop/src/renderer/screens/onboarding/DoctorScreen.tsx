import { CLI_VENDOR_IDS } from '@shared/types.js';
import { CliIcon } from '../../components/BrandIcon.js';
import DoctorList from '../../components/DoctorList.js';
import { useOnboarding } from './OnboardingContext.js';
import { StepFooter } from './shared.js';
import { Button } from '../../components/ui/Button.js';
import styles from './DoctorScreen.module.css';

export default function DoctorScreen(): React.JSX.Element {
  const { checks, checking, recheck, canLeaveDoctor, doctorHint, defaultCliLabel, error } =
    useOnboarding();
  const blocking = checks.filter((c) => !c.ok && c.blocking);
  const readyVendors = CLI_VENDOR_IDS.filter((id) => {
    const cliOk = checks.find((c) => c.id === `cli:${id}`)?.ok;
    const authOk = checks.find((c) => c.id === `auth:${id}`)?.ok;
    return cliOk && authOk;
  }).length;
  const badVendors = CLI_VENDOR_IDS.filter((id) => {
    const cliOk = checks.find((c) => c.id === `cli:${id}`)?.ok;
    const authOk = checks.find((c) => c.id === `auth:${id}`)?.ok;
    return cliOk === false || authOk === false;
  }).length;

  return (
    <div className={styles.obDoctor}>
      <div className={styles.obDoctorBody}>
        {/* ── left: narrative, chips, telemetry ───────────────────── */}
        <div className={styles.obDoctorIntro}>
          <p className="ob-eyebrow eyebrow">
            <span className="index">05</span>Environment — 5 / 6
          </p>
          <h1 className="ob-title">Make the floor safe</h1>
          <p className="ob-lead">
            Default CLI is <strong>{defaultCliLabel}</strong>. It and <strong>git</strong> block the
            rest of setup until they work. Other harnesses are informational — install one later and
            it appears here automatically.
          </p>

          <div className={styles.obDoctorMeta}>
            <span className={styles.obDoctorMetaLabel}>Harnesses</span>
            <span className={styles.obDoctorMetaCount}>
              {readyVendors} ready · {badVendors} unavailable ·{' '}
              {CLI_VENDOR_IDS.length - readyVendors - badVendors} idle
            </span>
          </div>

          <div className={styles.obStatusRow} role="list" aria-label="CLI harness status">
            {CLI_VENDOR_IDS.map((id, idx) => {
              const cliOk = checks.find((c) => c.id === `cli:${id}`)?.ok;
              const authOk = checks.find((c) => c.id === `auth:${id}`)?.ok;
              const ready = cliOk && authOk;
              const bad = cliOk === false || authOk === false;
              return (
                <div
                  key={id}
                  role="listitem"
                  className={`${styles.obStatusChip} ${ready ? styles.ok : bad ? styles.bad : ''}`}
                  title={`${id}${ready ? ' — ready' : bad ? ' — needs attention' : ' — idle'}`}
                  style={{ ['--i' as string]: String(idx) }}
                >
                  <CliIcon vendor={id} size={18} />
                  <span className={styles.obMark}>{ready ? '✓' : bad ? '✕' : '·'}</span>
                </div>
              );
            })}
          </div>

          {/* probe trace — flat ruled figure, not a card */}
          <div className={styles.obDoctorTelemetry} aria-hidden>
            <div className={styles.obDoctorTelemetryHead}>
              <span>probe trace</span>
              <span>
                {checks.length} signals · {blocking.length} blocking
              </span>
            </div>
            <svg
              viewBox="0 0 320 72"
              preserveAspectRatio="none"
              className={styles.obDoctorTelemetrySvg}
            >
              {[0, 18, 36, 54, 72].map((y) => (
                <line
                  key={y}
                  x1="0"
                  y1={y}
                  x2="320"
                  y2={y}
                  stroke="var(--line)"
                  strokeWidth={0.5}
                />
              ))}
              {(() => {
                const bars = [
                  3, 7, 5, 11, 8, 14, 9, 6, 12, 17, 13, 9, 15, 21, 16, 12, 18, 24, 19, 14,
                ];
                const pts = bars
                  .map((v, i) => `${(i / (bars.length - 1)) * 320},${72 - v * 2.6}`)
                  .join(' ');
                return (
                  <>
                    <polyline
                      points={pts}
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth={1.05}
                      opacity={0.9}
                    />
                    {bars.map((v, i) => (
                      <line
                        key={i}
                        x1={(i / (bars.length - 1)) * 320}
                        y1={72}
                        x2={(i / (bars.length - 1)) * 320}
                        y2={72 - v * 2.6}
                        stroke="var(--line-strong)"
                        strokeWidth={0.55}
                      />
                    ))}
                    {[4, 9, 14, 18].map((i) => (
                      <circle
                        key={i}
                        cx={(i / (bars.length - 1)) * 320}
                        cy={72 - bars[i] * 2.6}
                        r={1.7}
                        fill="var(--accent)"
                      />
                    ))}
                  </>
                );
              })()}
            </svg>
            <div className={styles.obDoctorTelemetryFoot}>
              <span>darwin · arm64</span>
              <span>path resolution ok</span>
              <span className={styles.obDoctorTelemetryLive}>
                <span className={styles.obDoctorLiveDot} />
                live
              </span>
            </div>
          </div>

          <p className={`${styles.obDoctorClarify} faint`}>
            Only <strong>{defaultCliLabel}</strong> and git are blocking. A fourth CLI can stay
            uninstalled — the factory still runs.
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

            <DoctorList checks={checks} onRecheck={() => void recheck()} />

            {blocking.length > 0 && (
              <div className={styles.obDoctorDivider} data-tone="amber" role="status">
                <p className={styles.obDoctorDividerTitle}>Blocked — cannot continue</p>
                <p className={styles.obDoctorDividerBody}>
                  <b>{blocking.map((c) => c.label).join(', ')}</b>
                  {blocking.length === 1 ? ' is failing' : ' are failing'}. Fix{' '}
                  {blocking.length === 1 ? 'it' : 'them'} and Re-check before continuing. Foundry
                  will not start a run until the default CLI and git resolve.
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
                  All blocking checks pass. <b>Default CLI is {defaultCliLabel}</b> and git is
                  configured — the factory will run.
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
