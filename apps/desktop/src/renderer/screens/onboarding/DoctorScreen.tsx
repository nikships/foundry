import { CLI_VENDOR_IDS } from '@shared/types.js';
import { CliIcon } from '../../components/BrandIcon.js';
import DoctorList from '../../components/DoctorList.js';
import { useOnboarding } from './OnboardingContext.js';

export default function DoctorScreen(): React.JSX.Element {
  const { next, back, checks, checking, recheck, canLeaveDoctor, doctorHint, defaultCliLabel, error } = useOnboarding();
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
    <div className="ob-doc">
      <div className="ob-doc-body">
        {/* ── left: narrative, chips, telemetry ───────────────────── */}
        <div className="ob-doc-intro">
          <p className="ob-eyebrow">Environment — 5 / 6</p>
          <h1 className="ob-title">Make the floor safe</h1>
          <p className="ob-lead">
            Default CLI is <strong>{defaultCliLabel}</strong>. It and <strong>git</strong> block the rest of setup until they
            work. Other harnesses are informational — install one later and it appears here automatically.
          </p>

          <div className="ob-doc-meta">
            <span className="ob-doc-meta-label">Harnesses</span>
            <span className="ob-doc-meta-count">
              {readyVendors} ready · {badVendors} unavailable · {CLI_VENDOR_IDS.length - readyVendors - badVendors} idle
            </span>
          </div>

          <div className="ob-status-row" role="list" aria-label="CLI harness status">
            {CLI_VENDOR_IDS.map((id, idx) => {
              const cliOk = checks.find((c) => c.id === `cli:${id}`)?.ok;
              const authOk = checks.find((c) => c.id === `auth:${id}`)?.ok;
              const ready = cliOk && authOk;
              const bad = cliOk === false || authOk === false;
              return (
                <div
                  key={id}
                  role="listitem"
                  className={`ob-status-chip ${ready ? 'ok' : bad ? 'bad' : ''}`}
                  title={`${id}${ready ? ' — ready' : bad ? ' — needs attention' : ' — idle'}`}
                  style={{ ['--i' as string]: String(idx) }}
                >
                  <CliIcon vendor={id} size={18} />
                  <span className="ob-mark">{ready ? '✓' : bad ? '✕' : '·'}</span>
                </div>
              );
            })}
          </div>

          {/* probe trace — flat ruled figure, not a card */}
          <div className="ob-doc-telemetry" aria-hidden>
            <div className="ob-doc-telemetry-head">
              <span>probe trace</span>
              <span>
                {checks.length} signals · {blocking.length} blocking
              </span>
            </div>
            <svg viewBox="0 0 320 72" preserveAspectRatio="none" className="ob-doc-telemetry-svg">
              {[0, 18, 36, 54, 72].map((y) => (
                <line key={y} x1="0" y1={y} x2="320" y2={y} stroke="var(--line)" strokeWidth={0.5} />
              ))}
              {(() => {
                const bars = [3, 7, 5, 11, 8, 14, 9, 6, 12, 17, 13, 9, 15, 21, 16, 12, 18, 24, 19, 14];
                const pts = bars.map((v, i) => `${(i / (bars.length - 1)) * 320},${72 - v * 2.6}`).join(' ');
                return (
                  <>
                    <polyline points={pts} fill="none" stroke="var(--cyan)" strokeWidth={1.05} opacity={0.9} />
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
                      <circle key={i} cx={(i / (bars.length - 1)) * 320} cy={72 - bars[i] * 2.6} r={1.7} fill="var(--cyan)" />
                    ))}
                  </>
                );
              })()}
            </svg>
            <div className="ob-doc-telemetry-foot">
              <span>darwin · arm64</span>
              <span>path resolution ok</span>
              <span className="ob-doc-telemetry-live">
                <span className="ob-doc-live-dot" />
                live
              </span>
            </div>
          </div>

          <p className="ob-doc-clarify faint">
            Only <strong>{defaultCliLabel}</strong> and git are blocking. A fourth CLI can stay uninstalled — the factory still runs.
          </p>
        </div>

        {/* ── right: diagnostics panel ────────────────────────────── */}
        <div className="ob-doc-panelWrap">
          <div className="ob-doc-panel">
            <div className="ob-doc-panel-head">
              <span className="ob-doc-panel-title">
                Diagnostics <em>· {checks.length} checks</em>
              </span>
              <button
                type="button"
                className="btn sm ghost ob-doc-recheck"
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
                  className={checking ? 'ob-doc-spin' : undefined}
                >
                  <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.75" stroke="currentColor" strokeWidth={1.45} strokeLinecap="round" />
                  <path d="M13.4 2.2v3h-3" stroke="currentColor" strokeWidth={1.45} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {checking ? 'Checking…' : 'Re-check'}
              </button>
            </div>

            <DoctorList checks={checks} onRecheck={() => void recheck()} />

            {blocking.length > 0 && (
              <div className="ob-doc-rule" data-tone="amber" role="status">
                <p className="ob-doc-rule-title">Blocked — cannot continue</p>
                <p className="ob-doc-rule-body">
                  <b>{blocking.map((c) => c.label).join(', ')}</b>
                  {blocking.length === 1 ? ' is failing' : ' are failing'}. Fix {blocking.length === 1 ? 'it' : 'them'} and
                  Re-check before continuing. Foundry will not start a run until the default CLI and git resolve.
                </p>
              </div>
            )}

            {error && (
              <div className="ob-doc-rule" data-tone="red" role="alert">
                <p className="ob-doc-rule-title">Last run</p>
                <p className="ob-doc-rule-body">{error}</p>
              </div>
            )}

            {canLeaveDoctor && (
              <div className="ob-doc-rule" data-tone="green" role="status">
                <p className="ob-doc-rule-title">Environment ready</p>
                <p className="ob-doc-rule-body">
                  All blocking checks pass. <b>Default CLI is {defaultCliLabel}</b> and git is configured — the factory will
                  run.
                </p>
              </div>
            )}
          </div>

          {!canLeaveDoctor && doctorHint && <p className="ob-doc-hint">{doctorHint}</p>}
        </div>
      </div>

      <div className="ob-foot">
        <button type="button" className="btn ghost" onClick={back}>
          Back
        </button>
        <span className="ob-grow" />
        <button
          type="button"
          className="btn primary"
          disabled={!canLeaveDoctor}
          title={doctorHint || undefined}
          onClick={next}
        >
          {checking ? 'Checking…' : 'Continue'}
        </button>
      </div>

      <style>{`
        .ob-doc{
          flex:1; min-height:0;
          display:flex; flex-direction:column;
          gap: var(--s6);
          padding: var(--s3) var(--s6) var(--s6);
          overflow:auto;
        }
        .ob-doc-body{
          flex:1; min-height:0;
          display:grid;
          grid-template-columns: minmax(320px, 0.92fr) minmax(420px, 1.08fr);
          gap: var(--s10);
          align-items:start;
        }

        /* ── intro ─────────────────────────────────────────────── */
        .ob-doc-intro{
          display:flex; flex-direction:column;
          min-width:0;
          position: sticky;
          top: 0;
          animation: ob-doc-in 480ms var(--ease) both;
        }
        .ob-doc-intro .ob-eyebrow{ margin-bottom: var(--s2); }
        .ob-doc-intro .ob-title{ margin-bottom: var(--s2); line-height: 1.02; letter-spacing: -0.03em; }
        .ob-doc-intro .ob-lead{ margin-bottom: 0; max-width: 46ch; }
        .ob-doc-intro .ob-lead strong{ color: var(--text); }

        .ob-doc-meta{
          margin-top: var(--s6);
          padding-bottom: var(--s2);
          border-bottom: 1px solid var(--line);
          display:flex; align-items:baseline; justify-content:space-between;
          gap: var(--s3);
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: var(--text-faint);
        }
        .ob-doc-meta-label{ color: var(--text-faint); }
        .ob-doc-meta-count{ color: var(--text-dim); letter-spacing: 0.08em; text-transform: none; font-size: 10.5px; }

        /* chips — flat, bordered, no card */
        .ob-status-row{
          display:flex; flex-wrap:wrap;
          gap: var(--s2);
          margin-top: var(--s3);
        }
        .ob-status-chip{
          display:inline-flex; align-items:center; gap: 7px;
          padding: 6px 10px;
          border-radius: var(--r-full);
          border:1px solid var(--line);
          background: var(--bg-raised);
          font-family: var(--font-mono);
          font-size: 11px;
          letter-spacing: 0.02em;
          color: var(--text-dim);
          transition: border-color 140ms var(--ease), background 140ms var(--ease), color 140ms var(--ease), transform 200ms var(--ease), opacity 200ms var(--ease);
          animation: ob-doc-chip 420ms var(--ease) both;
          animation-delay: calc(var(--i, 0) * 45ms + 120ms);
        }
        .ob-status-chip.ok{
          border-color: color-mix(in srgb, var(--green) 22%, var(--line) 78%);
          background: color-mix(in srgb, var(--bg-panel) 72%, var(--green-dim) 28%);
          color: var(--text);
        }
        .ob-status-chip.ok .ob-mark{ color: var(--green); font-weight: 700; }
        .ob-status-chip.bad{
          border-color: color-mix(in srgb, var(--red) 22%, var(--line) 78%);
          background: color-mix(in srgb, var(--bg-panel) 78%, var(--red-dim) 22%);
          color: var(--text);
        }
        .ob-status-chip.bad .ob-mark{ color: var(--red); font-weight: 700; }
        .ob-status-chip .ob-mark{
          font-size: 11px;
          line-height: 1;
          color: var(--text-faint);
          min-width: 12px;
          text-align:center;
        }

        /* telemetry — ruled, not boxed */
        .ob-doc-telemetry{
          margin-top: var(--s6);
          border-top: 1px solid var(--line-strong);
          padding-top: var(--s3);
          animation: ob-doc-in 520ms var(--ease) 180ms both;
        }
        .ob-doc-telemetry-head,
        .ob-doc-telemetry-foot{
          display:flex; justify-content:space-between; gap: var(--s3);
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--text-faint);
          line-height: 1;
        }
        .ob-doc-telemetry-svg{
          width:100%; height: 72px; display:block;
          margin: var(--s3) 0;
        }
        .ob-doc-telemetry-foot{
          border-top: 1px solid var(--line);
          padding-top: var(--s2);
          text-transform: none;
          letter-spacing: 0.06em;
          font-size: 10.5px;
        }
        .ob-doc-telemetry-live{
          display:inline-flex; align-items:center; gap: 5px;
          color: var(--cyan);
          text-transform: uppercase;
          letter-spacing: 0.14em;
          font-size: 10px;
        }
        .ob-doc-live-dot{
          width: 5px; height: 5px; border-radius: 50%;
          background: var(--cyan);
          box-shadow: 0 0 8px var(--cyan);
          animation: ob-doc-pulse 1.6s ease-in-out infinite;
        }
        .ob-doc-clarify{
          margin-top: var(--s5);
          font-size: var(--text-xs);
          line-height: var(--leading);
          max-width: 46ch;
          color: var(--text-faint);
        }
        .ob-doc-clarify strong{ color: var(--text-dim); font-weight: 600; }

        /* ── panel — single bordered container, hairlines inside ── */
        .ob-doc-panelWrap{
          display:flex; flex-direction:column;
          gap: var(--s2);
          min-width:0;
          animation: ob-doc-in 520ms var(--ease) 100ms both;
        }
        .ob-doc-panel{
          border: 1px solid var(--line);
          border-radius: var(--r-lg);
          background: var(--bg-panel);
          overflow:hidden;
          display:flex; flex-direction:column;
          min-width:0;
        }
        .ob-doc-panel-head{
          display:flex; align-items:center; justify-content:space-between;
          gap: var(--s3);
          padding: var(--s3) var(--s4);
          border-bottom: 1px solid var(--line);
        }
        .ob-doc-panel-title{
          font-family: var(--font-mono);
          font-size: 10.5px;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: var(--text-dim);
        }
        .ob-doc-panel-title em{
          font-style:normal;
          color: var(--text-faint);
          letter-spacing: 0.1em;
        }
        .ob-doc-recheck{
          gap: 6px;
        }
        .ob-doc-recheck:disabled{ opacity: 0.55; }

        /* DoctorList overrides — flatten the nested card into the panel's hairlines */
        .ob-doc-panel .doctor{
          margin: 0;
          padding: 0;
          border: 0;
          border-radius: 0;
          background: transparent;
        }
        .ob-doc-panel .doctor .head{
          display:none;
        }
        .ob-doc-panel .doctor ul{
          gap: 0;
        }
        .ob-doc-panel .doctor li{
          padding: var(--s3) var(--s4) var(--s3) calc(var(--s4) - 2px);
          border-bottom: 1px solid var(--line);
          border-left: 2px solid transparent;
          gap: var(--s3);
          align-items: center;
          transition: background 120ms var(--ease), border-left-color 120ms var(--ease);
          animation: ob-doc-row 380ms var(--ease) both;
        }
        .ob-doc-panel .doctor li:nth-child(1){ animation-delay: 0ms; }
        .ob-doc-panel .doctor li:nth-child(2){ animation-delay: 36ms; }
        .ob-doc-panel .doctor li:nth-child(3){ animation-delay: 72ms; }
        .ob-doc-panel .doctor li:nth-child(4){ animation-delay: 108ms; }
        .ob-doc-panel .doctor li:nth-child(5){ animation-delay: 144ms; }
        .ob-doc-panel .doctor li:nth-child(6){ animation-delay: 180ms; }
        .ob-doc-panel .doctor li:nth-child(7){ animation-delay: 216ms; }
        .ob-doc-panel .doctor li:nth-child(n+8){ animation-delay: 252ms; }
        .ob-doc-panel .doctor li:hover{ background: var(--bg-hover); }
        .ob-doc-panel .doctor li.bad{
          border-left-color: var(--red);
          background: color-mix(in srgb, var(--red-dim) 38%, transparent);
        }
        .ob-doc-panel .doctor li.bad:hover{
          background: color-mix(in srgb, var(--red-dim) 52%, transparent);
        }
        .ob-doc-panel .doctor .mark{
          width: 16px;
          display:grid; place-items:center;
          font-size: 13px;
          line-height: 1;
          flex:none;
        }
        .ob-doc-panel .doctor .text{
          gap: 2px;
        }
        .ob-doc-panel .doctor .text strong{
          font-size: var(--text-sm);
          font-weight: 600;
          letter-spacing: -0.01em;
          line-height: 1.25;
          color: var(--text);
        }
        .ob-doc-panel .doctor li.bad .text strong{ color: var(--text); }
        .ob-doc-panel .doctor em{
          font-size: 11px;
          color: var(--text-faint);
          line-height: 1.45;
          margin-top: 1px;
        }
        .ob-doc-panel .doctor li.bad em{ color: var(--text-dim); }
        .ob-doc-panel .doctor .btn{
          flex:none;
        }
        .ob-doc-panel .doctor .btn.sm{
          border-color: var(--line);
          background: var(--bg-raised);
        }
        .ob-doc-panel .doctor .btn.sm:hover:not(:disabled){
          border-color: var(--line-strong);
          background: var(--bg-hover);
        }

        /* rules — left-accent, not filled cards */
        .ob-doc-rule{
          padding: var(--s3) var(--s4) var(--s3) calc(var(--s4) - 2px);
          border-top: 1px solid var(--line);
          border-left: 2px solid var(--line-strong);
        }
        .ob-doc-rule[data-tone="amber"]{
          border-left-color: var(--amber);
          background: color-mix(in srgb, var(--amber-dim) 44%, transparent);
        }
        .ob-doc-rule[data-tone="red"]{
          border-left-color: var(--red);
          background: color-mix(in srgb, var(--red-dim) 44%, transparent);
        }
        .ob-doc-rule[data-tone="green"]{
          border-left-color: var(--green);
          background: color-mix(in srgb, var(--green-dim) 44%, transparent);
        }
        .ob-doc-rule-title{
          font-family: var(--font-mono);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          line-height: 1;
        }
        .ob-doc-rule[data-tone="amber"] .ob-doc-rule-title{ color: var(--amber); }
        .ob-doc-rule[data-tone="red"] .ob-doc-rule-title{ color: var(--red); }
        .ob-doc-rule[data-tone="green"] .ob-doc-rule-title{ color: var(--green); }
        .ob-doc-rule-body{
          margin-top: 6px;
          font-size: var(--text-sm);
          line-height: var(--leading);
          color: var(--text-dim);
        }
        .ob-doc-rule-body b{ color: var(--text); font-weight: 600; }

        .ob-doc-hint{
          padding-left: calc(var(--s4) + 2px);
          font-family: var(--font-mono);
          font-size: 11px;
          line-height: 1.5;
          color: var(--text-faint);
        }
        .ob-doc-spin{ animation: ob-doc-spin 1s linear infinite; transform-origin: center; }
        .ob-foot{ margin-top: auto; }

        @keyframes ob-doc-in{
          from{ opacity:0; transform: translateY(6px); }
          to{ opacity:1; transform:none; }
        }
        @keyframes ob-doc-chip{
          from{ opacity:0; transform: translateY(4px) scale(0.98); }
          to{ opacity:1; transform:none; }
        }
        @keyframes ob-doc-row{
          from{ opacity:0; transform: translateY(4px); }
          to{ opacity:1; transform:none; }
        }
        @keyframes ob-doc-spin{ to{ transform: rotate(360deg); } }
        @keyframes ob-doc-pulse{
          0%,100%{ opacity:1; transform: scale(1); }
          50%{ opacity:0.55; transform: scale(0.85); }
        }

        @media (max-width: 960px){
          .ob-doc{ padding: var(--s3) var(--s4) var(--s4); gap: var(--s5); }
          .ob-doc-body{
            grid-template-columns: 1fr;
            gap: var(--s6);
          }
          .ob-doc-intro{ position: static; }
          .ob-doc-telemetry-svg{ height: 64px; }
        }
        @media (max-width: 640px){
          .ob-doc-panel .doctor li{
            padding: var(--s3) var(--s3) var(--s3) calc(var(--s3) - 2px);
          }
          .ob-doc-rule{ padding-right: var(--s3); }
          .ob-doc-meta-count{ display:none; }
        }
        @media (prefers-reduced-motion: reduce){
          .ob-doc-intro, .ob-doc-panelWrap, .ob-status-chip, .ob-doc-panel .doctor li, .ob-doc-spin, .ob-doc-live-dot{
            animation: none !important;
          }
        }
      `}</style>
    </div>
  );
}
