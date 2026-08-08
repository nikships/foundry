import { CLI_VENDOR_IDS } from '@shared/types.js';
import type { CliDescriptor, CliVendor } from '@shared/types.js';
import { CliIcon } from '../../components/BrandIcon.js';
import { useOnboarding } from './OnboardingContext.js';

type Tone = 'ok' | 'warn' | 'bad' | 'idle';

function statusFor(vendor: CliVendor, checks: ReturnType<typeof useOnboarding>['checks']): { label: string; tone: Tone } {
  const ok = checks.find((c) => c.id === `cli:${vendor}`)?.ok;
  const authed = checks.find((c) => c.id === `auth:${vendor}`)?.ok;
  if (ok === false) return { label: 'Not installed', tone: 'bad' };
  if (authed === false) return { label: 'Needs sign-in', tone: 'warn' };
  if (ok) return { label: 'Ready', tone: 'ok' };
  return { label: 'Detected at setup', tone: 'idle' };
}

export default function CliScreen(): React.JSX.Element {
  const { next, back, clis, checks, defaultCli, pickCli, error } = useOnboarding();

  const descriptors: CliDescriptor[] = clis.length
    ? clis
    : (CLI_VENDOR_IDS.map((id) => ({ id, label: id } as CliDescriptor)));

  const ordered: CliDescriptor[] = CLI_VENDOR_IDS.map(
    (id) => descriptors.find((d) => d.id === id) ?? ({ id, label: id } as CliDescriptor),
  );

  const readyCount = ordered.filter((d) => checks.find((c) => c.id === `cli:${d.id}`)?.ok).length;
  const selectedDesc =
    ordered.find((d) => d.id === defaultCli) ?? ({ id: defaultCli, label: defaultCli } as CliDescriptor);

  return (
    <div className="ob-cli">
      <div className="ob-cli-head">
        <p className="ob-eyebrow">Agent CLIs</p>
        <h1 className="ob-title">Choose your default harness</h1>
        <p className="ob-lead">
          Foundry drives five CLIs. The default is what new agents and command detection use. You can
          still mix vendors per agent in the Roster.
        </p>
      </div>

      <div className="ob-harness">
        <div className="ob-harness-head">
          <span>Harness</span>
          <span>
            {readyCount} of {ordered.length} detected
          </span>
        </div>

        <div className="ob-harness-list" role="radiogroup" aria-label="Default harness">
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
                className={`ob-harness-row ${selected ? 'on' : ''}`}
                onClick={() => void pickCli(cli.id)}
              >
                <span className="ob-harness-icon" aria-hidden>
                  <CliIcon vendor={cli.id} size={22} />
                </span>

                <span className="ob-harness-main">
                  <span className="ob-harness-name">{cli.label}</span>
                  <span className="ob-harness-status">
                    <span className={`ob-dot ob-dot-${tone}`} aria-hidden />
                    <span className="ob-status-text">{label}</span>
                    <span className="ob-hint mono">· {hint}</span>
                  </span>
                </span>

                <span className="ob-harness-tail">
                  {selected ? <span className="ob-badge">Default</span> : <span className="ob-pick">Set default</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="ob-harness-facts">
        <div className="ob-facts-row">
          <span className="ob-facts-k">Default</span>
          <span className="ob-facts-v mono">{selectedDesc.binary ?? selectedDesc.id}</span>
          {selectedDesc.supportsRpc ? <span className="ob-pill ok">RPC — live tool stream</span> : <span className="ob-pill">One-shot</span>}
          {selectedDesc.docsUrl ? <span className="ob-docs mono">{selectedDesc.docsUrl}</span> : null}
        </div>

        <div className="ob-facts-row">
          <span className="ob-facts-k">Auth</span>
          <span className="ob-facts-v">
            {selectedDesc.authEnvVars?.length ? (
              selectedDesc.authEnvVars.map((k) => (
                <span key={k} className="ob-env mono">
                  {k}
                </span>
              ))
            ) : (
              <span className="faint">No env keys declared</span>
            )}
          </span>
        </div>

        {selectedDesc.caveats?.length ? (
          <div className="ob-facts-row">
            <span className="ob-facts-k">Caveats</span>
            <span className="ob-facts-v faint">{selectedDesc.caveats.join(' · ')}</span>
          </div>
        ) : null}

        <div className="ob-facts-legend">
          <span className="ob-legend">
            <span className="ob-dot ob-dot-ok" /> Ready
          </span>
          <span className="ob-legend">
            <span className="ob-dot ob-dot-warn" /> Needs sign-in
          </span>
          <span className="ob-legend">
            <span className="ob-dot ob-dot-bad" /> Not installed
          </span>
          <span className="ob-legend">
            <span className="ob-dot ob-dot-idle" /> Detected
          </span>
          <span className="ob-legend-note faint">Per-agent overrides live in the Roster.</span>
        </div>
      </div>

      {error && <p className="ob-err">{error}</p>}

      <div className="ob-foot">
        <button className="btn ghost" onClick={back} type="button">
          Back
        </button>
        <span className="ob-grow" />
        <button className="btn primary" onClick={next} type="button">
          Continue
        </button>
      </div>

      <style>{`
        .ob-cli{
          flex:1; min-height:0;
          display:flex; flex-direction:column;
          gap: var(--s5);
          padding: var(--s3) var(--s6) var(--s6);
          max-width: 860px;
          width:100%;
          margin: 0 auto;
          overflow:auto;
        }
        .ob-cli-head{ max-width: 62ch; }
        .ob-cli-head .ob-eyebrow{ margin-bottom: var(--s2); }
        .ob-cli-head .ob-title{ margin-bottom: var(--s2); }
        .ob-cli-head .ob-lead{ margin-bottom: 0; }

        .ob-harness{
          border: 1px solid var(--line);
          border-radius: var(--r-lg);
          background: var(--bg-panel);
          overflow:hidden;
        }
        .ob-harness-head{
          display:flex; align-items:center; justify-content:space-between;
          padding: var(--s3) var(--s4);
          border-bottom: 1px solid var(--line);
          background: color-mix(in srgb, var(--bg-void) 55%, var(--bg-panel) 45%);
          font-family: var(--font-mono);
          font-size: 11px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--text-faint);
        }
        .ob-harness-list{ display:flex; flex-direction:column; }
        .ob-harness-row{
          position:relative;
          display:grid;
          grid-template-columns: 40px 1fr auto;
          align-items:center;
          gap: var(--s4);
          width:100%;
          padding: 14px var(--s4);
          border:0;
          border-top: 1px solid var(--line);
          background: transparent;
          color: inherit;
          font: inherit;
          text-align:left;
          cursor: default;
          transition: background 140ms var(--ease);
        }
        .ob-harness-row:first-child{ border-top:0; }
        .ob-harness-row:hover{ background: var(--bg-hover); }
        .ob-harness-row:focus-visible{ outline:none; background: var(--bg-hover); box-shadow: inset 0 0 0 1px var(--cyan-dim); }
        .ob-harness-row.on{ background: var(--bg-raised); }
        .ob-harness-row::before{
          content:'';
          position:absolute; left:0; top:0; bottom:0;
          width:2px; background: var(--cyan);
          transform: scaleY(0);
          transform-origin: center;
          transition: transform 180ms var(--ease);
        }
        .ob-harness-row.on::before{ transform: scaleY(1); }

        .ob-harness-icon{
          width:40px; height:40px;
          border:1px solid var(--line-strong);
          border-radius: var(--r);
          background: var(--bg-void);
          display:grid; place-items:center;
          flex:none;
        }
        .ob-harness-row.on .ob-harness-icon{
          border-color: color-mix(in srgb, var(--cyan) 22%, var(--line) 78%);
        }
        .ob-harness-main{ min-width:0; display:flex; flex-direction:column; gap:4px; }
        .ob-harness-name{
          font-family: var(--font-mono);
          font-size: 14px;
          font-weight:600;
          letter-spacing:-0.01em;
          color: var(--text);
          line-height:1.2;
        }
        .ob-harness-status{
          display:flex; align-items:center; gap: var(--s2);
          font-size: var(--text-xs);
          color: var(--text-dim);
          line-height:1.35;
        }
        .ob-status-text{ font-size: var(--text-xs); }
        .ob-hint{
          font-size: 11px;
          color: var(--text-faint);
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        }
        .ob-dot{ width:6px; height:6px; border-radius: var(--r-full); flex:none; }
        .ob-dot-ok{ background: var(--green); box-shadow: 0 0 0 3px var(--green-dim); }
        .ob-dot-warn{ background: var(--amber); box-shadow: 0 0 0 3px var(--amber-dim); }
        .ob-dot-bad{ background: var(--red); box-shadow: 0 0 0 3px var(--red-dim); }
        .ob-dot-idle{ background: var(--text-faint); box-shadow: 0 0 0 3px var(--line); }

        .ob-harness-tail{ display:flex; align-items:center; flex:none; }
        .ob-badge{
          display:inline-flex; align-items:center;
          padding: 3px 8px;
          border-radius: var(--r-full);
          border:1px solid color-mix(in srgb, var(--cyan) 22%, transparent);
          background: color-mix(in srgb, var(--cyan-dim) 70%, transparent);
          color: var(--cyan);
          font-family: var(--font-mono);
          font-size:10px; font-weight:700;
          letter-spacing:0.10em; text-transform:uppercase;
          line-height:1; white-space:nowrap;
        }
        .ob-pick{
          font-family: var(--font-mono);
          font-size:10px; font-weight:600;
          letter-spacing:0.10em; text-transform:uppercase;
          color: var(--text-faint);
          opacity:0;
          transition: opacity 140ms var(--ease), color 140ms var(--ease);
          white-space:nowrap;
        }
        .ob-harness-row:hover .ob-pick{ opacity:1; color: var(--text-dim); }
        .ob-harness-row.on .ob-pick{ display:none; }

        .ob-harness-facts{
          border:1px solid var(--line);
          border-radius: var(--r);
          background: transparent;
          overflow:hidden;
        }
        .ob-facts-row{
          display:flex; flex-wrap:wrap; align-items:center; gap: var(--s2) var(--s3);
          padding: var(--s3) var(--s4);
          border-top: 1px solid var(--line);
          font-size: var(--text-xs);
          line-height:1.5;
        }
        .ob-facts-row:first-child{ border-top:0; }
        .ob-facts-k{
          font-family: var(--font-mono);
          font-size:10px; font-weight:700;
          letter-spacing:0.10em; text-transform:uppercase;
          color: var(--text-faint);
          min-width: 56px;
        }
        .ob-facts-v{ display:flex; flex-wrap:wrap; align-items:center; gap:6px; color: var(--text-dim); min-width:0; }
        .ob-facts-v.mono{ font-family: var(--font-mono); font-size:11px; }
        .ob-docs.mono{
          font-size:11px; color: var(--text-faint);
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width: 32ch;
        }
        .ob-env{
          font-size:11px; padding:3px 7px;
          border-radius: var(--r-full);
          background: var(--bg-raised);
          border:1px solid var(--line);
          color: var(--text-dim);
          line-height:1;
        }
        .ob-pill{
          font-size:11px; font-weight:600;
          padding:3px 8px; border-radius: var(--r-full);
          border:1px solid var(--line);
          background: var(--bg-raised); color: var(--text-dim);
          line-height:1;
        }
        .ob-pill.ok{
          background: var(--green-dim);
          border-color: color-mix(in srgb, var(--green) 18%, transparent);
          color: var(--green);
        }
        .ob-facts-legend{
          display:flex; flex-wrap:wrap; align-items:center; gap: 10px 14px;
          padding: var(--s3) var(--s4);
          border-top: 1px solid var(--line);
        }
        .ob-legend{ display:inline-flex; align-items:center; gap:6px; font-size:11px; color: var(--text-faint); }
        .ob-legend-note{ margin-left:auto; font-size:11px; }

        .ob-err{
          padding: var(--s3) var(--s4);
          border-radius: var(--r);
          background: color-mix(in srgb, var(--red-dim) 80%, transparent);
          border: 1px solid color-mix(in srgb, var(--red) 18%, transparent);
          border-left: 2px solid var(--red);
          color: var(--red);
          font-size: var(--text-sm);
          line-height: var(--leading);
        }

        @media (max-width: 640px){
          .ob-cli{ padding: var(--s3) var(--s4) var(--s4); }
          .ob-harness-row{ grid-template-columns: 36px 1fr; }
          .ob-harness-tail{ grid-column: 1 / -1; justify-content:flex-start; padding-left: 44px; }
          .ob-facts-legend{ flex-direction:column; align-items:flex-start; }
          .ob-legend-note{ margin-left:0; }
        }
      `}</style>
    </div>
  );
}
