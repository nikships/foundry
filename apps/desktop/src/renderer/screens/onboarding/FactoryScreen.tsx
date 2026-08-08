import { useOnboarding } from './OnboardingContext.js';

/* ── diagrams ────────────────────────────────────────────────────────── */

function PipelineDiagram(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 240 118"
      className="ob-fac-diagram"
      role="img"
      aria-label="Conveyor of pipeline phases being reordered"
    >
      {/* reorder arc */}
      <path
        d="M46 30 C 46 12, 118 12, 118 30"
        fill="none"
        stroke="var(--cyan)"
        strokeWidth="1"
        opacity="0.7"
        className="ob-fac-dash"
      />
      <path d="M118 30 l -4 -6 l 8 0 z" fill="var(--cyan)" opacity="0.82" />
      <text
        x="60"
        y="12"
        className="ob-fac-mono"
        fill="var(--text-faint)"
        fontSize="6.5"
        letterSpacing="1.4"
      >
        SWAP
      </text>
      {/* phase blocks */}
      {[
        { x: 20, label: 'PLAN', c: 'var(--cyan)' },
        { x: 92, label: 'BUILD', c: 'var(--purple)' },
        { x: 164, label: 'TEST', c: 'var(--amber)' },
      ].map((b) => (
        <g key={b.label}>
          <rect
            x={b.x}
            y={38}
            width={52}
            height={34}
            fill="var(--bg-raised)"
            stroke="var(--line-strong)"
            strokeWidth="1"
            rx="2"
          />
          <rect x={b.x} y={38} width={2.5} height={34} rx="1" fill={b.c} />
          <text
            x={b.x + 10}
            y={53}
            className="ob-fac-mono"
            fill="var(--text)"
            fontSize="7"
            letterSpacing="1.1"
          >
            {b.label}
          </text>
          <line
            x1={b.x + 10}
            y1={59}
            x2={b.x + 36}
            y2={59}
            stroke="var(--line-strong)"
            strokeWidth="1"
          />
          <line x1={b.x + 10} y1={64} x2={b.x + 26} y2={64} stroke="var(--line)" strokeWidth="1" />
          <g fill="var(--text-faint)" opacity="0.9">
            <circle cx={b.x + 44} cy={45} r="1" />
            <circle cx={b.x + 48} cy={45} r="1" />
            <circle cx={b.x + 44} cy={49} r="1" />
            <circle cx={b.x + 48} cy={49} r="1" />
          </g>
        </g>
      ))}
      {/* conveyor */}
      <line x1="4" y1="78" x2="236" y2="78" stroke="var(--line)" strokeWidth="1" />
      <line x1="4" y1="86" x2="236" y2="86" stroke="var(--line)" strokeWidth="1" />
      <line
        x1="4"
        y1="82"
        x2="236"
        y2="82"
        stroke="var(--cyan)"
        strokeWidth="1"
        opacity="0.42"
        className="ob-fac-dash-slow"
      />
      {[18, 58, 98, 138, 178, 218].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy={96} r="7" fill="none" stroke="var(--line)" strokeWidth="1" />
          <line
            x1={cx}
            y1={96}
            x2={cx}
            y2={89}
            stroke="var(--text-faint)"
            strokeWidth="1"
            className="ob-fac-roller"
          />
        </g>
      ))}
      <line
        x1="4"
        y1="110"
        x2="236"
        y2="110"
        stroke="var(--line)"
        strokeWidth="1"
        strokeDasharray="1 5"
      />
    </svg>
  );
}

function EnvelopeDiagram(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 240 118"
      className="ob-fac-diagram"
      role="img"
      aria-label="Typed envelope wired into schema"
    >
      <rect
        x="10"
        y="30"
        width="74"
        height="50"
        rx="2"
        fill="var(--bg-raised)"
        stroke="var(--purple)"
        strokeWidth="1"
        opacity="0.96"
      />
      <path
        d="M10 30 L47 56 L84 30"
        fill="none"
        stroke="var(--purple)"
        strokeWidth="1"
        opacity="0.52"
      />
      <path
        d="M10 80 L36 58 M84 80 L58 58"
        fill="none"
        stroke="var(--line-strong)"
        strokeWidth="1"
      />
      <text
        x="10"
        y="24"
        className="ob-fac-mono"
        fill="var(--text-faint)"
        fontSize="6.5"
        letterSpacing="1.35"
      >
        AGENT REPLY
      </text>
      {[
        { y: 36, k: 'status', t: 'enum', c: 'var(--cyan)' },
        { y: 55, k: 'patch', t: 'diff', c: 'var(--purple)' },
        { y: 74, k: 'notes', t: 'str', c: 'var(--amber)' },
      ].map((f) => (
        <g key={f.k}>
          <path
            d={`M84 55 C 108 55, 106 ${f.y}, 132 ${f.y}`}
            fill="none"
            stroke={f.c}
            strokeWidth="1"
            opacity="0.62"
          />
          <circle cx={132} cy={f.y} r="2" fill={f.c} />
          <text x={140} y={f.y + 2.6} className="ob-fac-mono" fill="var(--text)" fontSize="7">
            {f.k}
          </text>
          <text
            x={140}
            y={f.y + 2.6}
            className="ob-fac-mono"
            fill="var(--text-faint)"
            fontSize="7"
            dx="34"
          >
            :{f.t}
          </text>
          <line x1={140} y1={f.y + 6} x2={222} y2={f.y + 6} stroke="var(--line)" strokeWidth="1" />
        </g>
      ))}
      <circle cx={84} cy={55} r={2.4} fill="var(--purple)" />
      <text
        x="140"
        y="98"
        className="ob-fac-mono"
        fill="var(--green)"
        fontSize="6.5"
        letterSpacing="1.35"
      >
        PARSE OK → COUNTS
      </text>
      <text
        x="10"
        y="98"
        className="ob-fac-mono"
        fill="var(--text-faint)"
        fontSize="6.5"
        letterSpacing="1.35"
      >
        SCHEMA
      </text>
      <line
        x1="10"
        y1="104"
        x2="120"
        y2="104"
        stroke="var(--line)"
        strokeWidth="1"
        strokeDasharray="1 5"
      />
      <line
        x1="140"
        y1="104"
        x2={230}
        y2={104}
        stroke="var(--green)"
        strokeWidth="1"
        opacity="0.4"
      />
    </svg>
  );
}

function GateDiagram(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 240 118"
      className="ob-fac-diagram"
      role="img"
      aria-label="Gate checkpoint with evidence ledger"
    >
      <line x1={18} y1={16} x2={18} y2={96} stroke="var(--line-strong)" strokeWidth="1" />
      <rect
        x={13}
        y={94}
        width={10}
        height={4}
        rx="1"
        fill="var(--bg-raised)"
        stroke="var(--line-strong)"
        strokeWidth="1"
      />
      <line x1={18} y1={40} x2={96} y2={40} stroke="var(--green)" strokeWidth={1.5} />
      {[30, 44, 58, 72, 86].map((x) => (
        <line
          key={x}
          x1={x}
          y1={36}
          x2={x + 6}
          y2={44}
          stroke="var(--green)"
          strokeWidth="1"
          opacity={0.42}
        />
      ))}
      <circle cx={18} cy={40} r={3} fill="var(--bg-void)" stroke="var(--green)" strokeWidth="1" />
      {[
        { y: 58, k: 'lint', v: '0 err' },
        { y: 74, k: 'tests', v: '128/128' },
        { y: 90, k: 'diff', v: 'scoped' },
      ].map((r) => (
        <g key={r.k}>
          <path
            d={`M112 ${r.y - 3} l 3 3.5 l 5.5 -6`}
            fill="none"
            stroke="var(--green)"
            strokeWidth={1.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <text x={128} y={r.y + 1} className="ob-fac-mono" fill="var(--text)" fontSize="7">
            {r.k}
          </text>
          <text
            x={228}
            y={r.y + 1}
            textAnchor="end"
            className="ob-fac-mono"
            fill="var(--text-dim)"
            fontSize="7"
          >
            {r.v}
          </text>
          <line x1={112} y1={r.y + 6} x2={228} y2={r.y + 6} stroke="var(--line)" strokeWidth="1" />
        </g>
      ))}
      <g opacity={0.92}>
        <rect
          x={112}
          y={16}
          width={60}
          height={16}
          rx={2}
          fill="none"
          stroke="var(--green)"
          strokeWidth="1"
        />
        <text
          x={119}
          y={27}
          className="ob-fac-mono"
          fill="var(--green)"
          fontSize="7"
          letterSpacing={1.6}
        >
          GATE PASS
        </text>
      </g>
      <text
        x={180}
        y={27}
        className="ob-fac-mono"
        fill="var(--text-faint)"
        fontSize="6.5"
        letterSpacing={1.2}
      >
        +EVIDENCE
      </text>
      <line
        x1={18}
        y1={110}
        x2={228}
        y2={110}
        stroke="var(--line)"
        strokeWidth="1"
        strokeDasharray="1 5"
      />
    </svg>
  );
}

/* ── screen ─────────────────────────────────────────────────────────── */

export default function FactoryScreen(): React.JSX.Element {
  const { next, back } = useOnboarding();

  return (
    <div className="ob-factory">
      <div className="ob-factory-scroll">
        <div className="ob-factory-inner">
          {/* headline */}
          <div className="ob-fac-head">
            <div className="ob-fac-kicker">
              <span className="ob-fac-rule" aria-hidden />
              <span className="ob-fac-eyebrow">How it works</span>
              <span className="ob-fac-step mono" aria-label="Step 2 of 6">
                02 / 06
              </span>
            </div>
            <h1 className="ob-fac-title">
              The factory floor
              <span className="ob-fac-title-accent"> — a run is a pipeline of phases.</span>
            </h1>
            <p className="ob-fac-lead">
              Agents propose; code disposes. Every phase hands a <em>typed envelope</em> to the next
              station, and <em>gates leave evidence</em> you can read later. Reorder the line
              without rewriting scripts.
            </p>
          </div>

          {/* assembly track */}
          <div className="ob-fac-track" aria-hidden>
            <div className="ob-fac-track-line" />
            <span className="ob-fac-track-dot" />
            <div className="ob-fac-track-nodes">
              <span className="ob-fac-node" style={{ borderColor: 'var(--cyan)' }} />
              <span className="ob-fac-node" style={{ borderColor: 'var(--purple)' }} />
              <span className="ob-fac-node" style={{ borderColor: 'var(--green)' }} />
            </div>
          </div>

          {/* concepts — flat open figures, not cards */}
          <div className="ob-fac-grid">
            <article
              className="ob-fac-fig"
              style={{
                ['--accent' as string]: 'var(--cyan)',
                ['--accent-dim' as string]: 'var(--cyan-dim)',
              }}
            >
              <span className="ob-fac-accent" aria-hidden />
              <div className="ob-fac-meta">
                <span className="ob-fac-index">01</span>
                <span className="ob-fac-caption mono">RUN.PHASES[] · EDITABLE</span>
              </div>
              <div className="ob-fac-art">
                <PipelineDiagram />
              </div>
              <h2 className="ob-fac-h2">Pipelines are data</h2>
              <p className="ob-fac-body">
                Reorder phases, swap agents, add a reviewer. No scripts to rewrite.
              </p>
            </article>

            <article
              className="ob-fac-fig"
              style={{
                ['--accent' as string]: 'var(--purple)',
                ['--accent-dim' as string]: 'var(--purple-dim)',
              }}
            >
              <span className="ob-fac-accent" aria-hidden />
              <div className="ob-fac-meta">
                <span className="ob-fac-index">02</span>
                <span className="ob-fac-caption mono">ENVELOPE&lt;T&gt; · VALIDATED</span>
              </div>
              <div className="ob-fac-art">
                <EnvelopeDiagram />
              </div>
              <h2 className="ob-fac-h2">Typed envelopes</h2>
              <p className="ob-fac-body">
                Every agent reply is structured. Code decides if it counts.
              </p>
            </article>

            <article
              className="ob-fac-fig"
              style={{
                ['--accent' as string]: 'var(--green)',
                ['--accent-dim' as string]: 'var(--green-dim)',
              }}
            >
              <span className="ob-fac-accent" aria-hidden />
              <div className="ob-fac-meta">
                <span className="ob-fac-index">03</span>
                <span className="ob-fac-caption mono">GATE.REPORT · AUDITABLE</span>
              </div>
              <div className="ob-fac-art">
                <GateDiagram />
              </div>
              <h2 className="ob-fac-h2">Gates leave evidence</h2>
              <p className="ob-fac-body">
                A green gate says what it checked, not only that it passed.
              </p>
            </article>
          </div>
        </div>
      </div>

      <div className="ob-fac-foot">
        <div className="ob-fac-progress" aria-label="Step 2 of 6">
          <div className="ob-fac-ticks">
            {Array.from({ length: 6 }).map((_, i) => (
              <span
                key={i}
                className={`ob-fac-tick ${i === 1 ? 'on' : ''} ${i < 1 ? 'done' : ''}`}
              />
            ))}
          </div>
          <span className="ob-fac-progress-label mono">Factory floor</span>
        </div>
        <div className="ob-fac-actions">
          <button type="button" className="btn ghost" onClick={back}>
            Back
          </button>
          <button type="button" className="btn primary" onClick={next}>
            Continue
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
              <path
                d="M4 3 L9 7 L4 11"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <style>{`
        .ob-factory {
          flex: 1; min-height: 0;
          display: flex; flex-direction: column;
          overflow: hidden;
          position: relative;
        }
        .ob-factory-scroll {
          flex: 1; min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
        }
        .ob-factory-inner {
          width: 100%;
          max-width: 1180px;
          margin: 0 auto;
          padding: var(--s6) var(--s6) var(--s10);
          display: flex; flex-direction: column;
          gap: var(--s6);
        }

        /* headline */
        .ob-fac-head {
          max-width: 760px;
          animation: ob-fac-in 520ms var(--ease) both;
        }
        .ob-fac-kicker {
          display: flex; align-items: center; gap: var(--s3);
          margin-bottom: var(--s4);
        }
        .ob-fac-rule {
          width: 28px; height: 1px; background: var(--cyan); flex: 0 0 28px;
        }
        .ob-fac-eyebrow {
          font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase;
          font-weight: 600; color: var(--cyan);
        }
        .ob-fac-step {
          margin-left: auto;
          font-size: 11px; letter-spacing: 0.14em; color: var(--text-faint);
        }
        .ob-fac-title {
          font-size: clamp(1.9rem, 3.4vw, 2.9rem);
          font-weight: 620; letter-spacing: -0.032em; line-height: 1.06;
          color: var(--text);
          text-wrap: balance;
        }
        .ob-fac-title-accent {
          font-weight: 400; color: var(--text-faint);
          letter-spacing: -0.02em;
        }
        .ob-fac-lead {
          margin-top: var(--s4);
          font-size: clamp(14px, 1.55vw, 17px);
          line-height: 1.72; color: var(--text-dim);
          max-width: 62ch;
        }
        .ob-fac-lead em {
          font-style: normal; color: var(--text); font-weight: 500;
          border-bottom: 1px solid var(--line-strong);
          padding-bottom: 1px;
        }

        /* assembly track */
        .ob-fac-track {
          position: relative;
          height: 36px;
          margin: var(--s1) 0 calc(-1 * var(--s4));
          animation: ob-fac-in 520ms var(--ease) 120ms both;
        }
        .ob-fac-track-line {
          position: absolute; left: 0; right: 0; top: 50%;
          height: 1px; background: var(--line);
        }
        .ob-fac-track-dot {
          position: absolute; top: 50%; margin-top: -2px;
          width: 4px; height: 4px; border-radius: 50%;
          background: var(--cyan);
          box-shadow: 0 0 10px var(--cyan);
          animation: ob-fac-dot 7s linear infinite;
        }
        .ob-fac-track-nodes {
          position: absolute; inset: 0;
          display: grid; grid-template-columns: repeat(3, 1fr);
          align-items: center;
        }
        .ob-fac-node {
          width: 7px; height: 7px; transform: rotate(45deg);
          background: var(--bg-void);
          border: 1px solid var(--line-strong);
          margin-left: -3px;
        }
        .ob-fac-node:first-child { margin-left: -1px; }

        /* figures — open, flat, diagram first */
        .ob-fac-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 0;
          border-top: 1px solid var(--line);
          animation: ob-fac-in 560ms var(--ease) 200ms both;
        }
        .ob-fac-fig {
          position: relative;
          padding: var(--s6) var(--s6) var(--s2) var(--s5);
          border-left: 1px solid var(--line);
          border-bottom: 1px solid transparent;
          display: flex; flex-direction: column;
          min-width: 0;
        }
        .ob-fac-fig:first-child { border-left-color: transparent; }
        .ob-fac-accent {
          position: absolute; left: -1px; top: 0;
          width: 1px; height: 56px; background: var(--accent);
          opacity: 0.95;
        }
        .ob-fac-fig:first-child .ob-fac-accent { left: 0; }
        .ob-fac-meta {
          display: flex; align-items: baseline; gap: var(--s2);
          margin-bottom: var(--s4);
        }
        .ob-fac-index {
          font-family: var(--font-mono);
          font-size: 11px; letter-spacing: 0.18em; font-weight: 600;
          color: var(--accent);
        }
        .ob-fac-caption {
          font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
          color: var(--text-faint);
        }
        .ob-fac-art {
          margin-bottom: var(--s4);
          border-bottom: 1px solid var(--line-faint);
          padding-bottom: var(--s4);
        }
        .ob-fac-diagram {
          width: 100%; height: auto; display: block;
        }
        .ob-fac-mono { font-family: var(--font-mono); }
        .ob-fac-h2 {
          font-size: 17px; font-weight: 600; letter-spacing: -0.018em;
          color: var(--text);
          padding-bottom: var(--s2);
          border-bottom: 1px solid var(--line);
        }
        .ob-fac-body {
          margin-top: var(--s3);
          font-size: 13.5px; line-height: 1.6; color: var(--text-dim);
          max-width: 32ch;
        }

        /* motion details */
        .ob-fac-dash { stroke-dasharray: 4 6; animation: ob-fac-flow 1.4s linear infinite; }
        .ob-fac-dash-slow { stroke-dasharray: 4 6; animation: ob-fac-flow 1.8s linear infinite; }
        .ob-fac-roller { transform-box: fill-box; transform-origin: center; animation: ob-fac-spin 2.2s linear infinite; }

        /* footer */
        .ob-fac-foot {
          flex: 0 0 auto;
          display: flex; align-items: center; justify-content: space-between;
          gap: var(--s4);
          padding: var(--s4) var(--s6);
          border-top: 1px solid var(--line);
          background: color-mix(in srgb, var(--bg-panel) 92%, transparent);
          backdrop-filter: blur(8px);
        }
        .ob-fac-progress {
          display: flex; align-items: center; gap: var(--s3);
          min-width: 0;
        }
        .ob-fac-ticks { display: flex; align-items: center; gap: 6px; }
        .ob-fac-tick {
          display: block; height: 2px; width: 18px; border-radius: 999px;
          background: var(--line-strong);
          transition: background var(--fast) var(--ease), width var(--fast) var(--ease);
        }
        .ob-fac-tick.done { background: var(--line-strong); opacity: 0.9; }
        .ob-fac-tick.on { width: 32px; background: var(--cyan); box-shadow: 0 0 10px var(--cyan-dim); }
        .ob-fac-progress-label {
          font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
          color: var(--text-faint);
          white-space: nowrap;
        }
        .ob-fac-actions { display: flex; align-items: center; gap: var(--s2); }

        @keyframes ob-fac-in {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: none; }
        }
        @keyframes ob-fac-dot {
          from { left: 0; }
          to { left: calc(100% - 4px); }
        }
        @keyframes ob-fac-flow {
          to { stroke-dashoffset: -20; }
        }
        @keyframes ob-fac-spin {
          to { transform: rotate(360deg); }
        }

        @media (prefers-reduced-motion: reduce) {
          .ob-fac-head, .ob-fac-track, .ob-fac-grid { animation: none !important; }
          .ob-fac-dash, .ob-fac-dash-slow, .ob-fac-roller, .ob-fac-track-dot { animation: none !important; }
        }

        @media (max-width: 960px) {
          .ob-factory-inner { padding: var(--s4) var(--s4) var(--s8); }
          .ob-fac-track { display: none; }
          .ob-fac-grid {
            grid-template-columns: 1fr;
            border-top: none;
          }
          .ob-fac-fig {
            border-left: 1px solid var(--line) !important;
            border-bottom: 1px solid var(--line);
            padding: var(--s5) var(--s4) var(--s5) var(--s5);
          }
          .ob-fac-fig:first-child { border-top: 1px solid var(--line); }
          .ob-fac-accent { height: 44px; }
          .ob-fac-h2 { font-size: 16.5px; }
        }
        @media (max-width: 560px) {
          .ob-fac-foot { flex-wrap: wrap; }
          .ob-fac-progress-label { display: none; }
        }
      `}</style>
    </div>
  );
}
