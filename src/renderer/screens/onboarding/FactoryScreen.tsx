import { SceneArt, StepFooter } from './shared.js';
import styles from './FactoryScreen.module.css';

/* ── diagrams ────────────────────────────────────────────────────────── */

function PipelineDiagram(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 240 118"
      className={styles.obFacDiagram}
      role="img"
      aria-label="Conveyor of pipeline phases being reordered"
    >
      {/* reorder arc */}
      <path
        d="M46 30 C 46 12, 118 12, 118 30"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1"
        opacity="0.7"
        className={styles.obFacDash}
      />
      <path d="M118 30 l -4 -6 l 8 0 z" fill="var(--accent)" opacity="0.82" />
      <text
        x="60"
        y="12"
        className={styles.obFacMono}
        fill="var(--text-faint)"
        fontSize="6.5"
        letterSpacing="1.4"
      >
        SWAP
      </text>
      {/* phase blocks */}
      {[
        { x: 20, label: 'PLAN', c: 'var(--accent)' },
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
            className={styles.obFacMono}
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
        stroke="var(--accent)"
        strokeWidth="1"
        opacity="0.42"
        className={styles.obFacDashSlow}
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
            className={styles.obFacRoller}
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
      className={styles.obFacDiagram}
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
        className={styles.obFacMono}
        fill="var(--text-faint)"
        fontSize="6.5"
        letterSpacing="1.35"
      >
        AGENT REPLY
      </text>
      {[
        { y: 36, k: 'status', t: 'enum', c: 'var(--accent)' },
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
          <text x={140} y={f.y + 2.6} className={styles.obFacMono} fill="var(--text)" fontSize="7">
            {f.k}
          </text>
          <text
            x={140}
            y={f.y + 2.6}
            className={styles.obFacMono}
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
        className={styles.obFacMono}
        fill="var(--green)"
        fontSize="6.5"
        letterSpacing="1.35"
      >
        PARSE OK → COUNTS
      </text>
      <text
        x="10"
        y="98"
        className={styles.obFacMono}
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
      className={styles.obFacDiagram}
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
          <text x={128} y={r.y + 1} className={styles.obFacMono} fill="var(--text)" fontSize="7">
            {r.k}
          </text>
          <text
            x={228}
            y={r.y + 1}
            textAnchor="end"
            className={styles.obFacMono}
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
          className={styles.obFacMono}
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
        className={styles.obFacMono}
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
  return (
    <div className={styles.obFactory}>
      <div className={styles.obFactoryScroll}>
        <div className={styles.obFactoryInner}>
          {/* headline */}
          <div className={styles.obFacHead}>
            <div className={styles.obFacKicker}>
              <span className={styles.obFacRule} aria-hidden />
              <p className={`${styles.obFacEyebrow} eyebrow`}>
                <span className="index">02</span>How it works
              </p>
              <span className={`${styles.obFacStep} mono`} aria-label="Step 2 of 6">
                02 / 06
              </span>
            </div>
            <h1 className={styles.obFacTitle}>
              The factory floor
              <span className={styles.obFacTitleAccent}> — a run is a pipeline of phases.</span>
            </h1>
            <p className={styles.obFacLead}>
              Agents propose; code disposes. Every phase hands a <em>typed envelope</em> to the next
              station, and <em>gates leave evidence</em> you can read later. Reorder the line
              without rewriting scripts.
            </p>
          </div>

          {/* scene — pipeline blueprint */}
          <div className={styles.obFacScene} aria-hidden>
            <SceneArt path="scenes/pipeline-designer.png" className={styles.obFacSceneArt} />
          </div>

          {/* assembly track — keep the live motion */}
          <div className={styles.obFacTrack} aria-hidden>
            <div className={styles.obFacTrackLine} />
            <span className={styles.obFacTrackDot} />
            <div className={styles.obFacTrackNodes}>
              <span className={styles.obFacNode} style={{ borderColor: 'var(--accent)' }} />
              <span className={styles.obFacNode} style={{ borderColor: 'var(--purple)' }} />
              <span className={styles.obFacNode} style={{ borderColor: 'var(--green)' }} />
            </div>
          </div>

          {/* concepts — blueprint concepts now above, diagrams below */}
          <div className={styles.obFacConcepts}>
            <SceneArt path="concepts/pipeline.png" className={styles.obFacConceptArt} />
            <SceneArt path="concepts/envelope.png" className={styles.obFacConceptArt} />
            <SceneArt path="concepts/gate.png" className={styles.obFacConceptArt} />
          </div>

          {/* diagrams — keep the flat SVG language */}
          <div className={styles.obFacGrid}>
            <article
              className={styles.obFacFig}
              style={{
                ['--accent' as string]: 'var(--accent)',
                ['--accent-dim' as string]: 'var(--accent-dim)',
              }}
            >
              <span className={styles.obFacAccent} aria-hidden />
              <div className={styles.obFacMeta}>
                <span className={styles.obFacIndex}>01</span>
                <span className={`${styles.obFacCaption} mono`}>RUN.PHASES[] · EDITABLE</span>
              </div>
              <div className={styles.obFacArt}>
                <PipelineDiagram />
              </div>
              <h2 className={styles.obFacH2}>Pipelines are data</h2>
              <p className={styles.obFacBody}>
                Reorder phases, swap agents, add a reviewer. No scripts to rewrite.
              </p>
            </article>

            <article
              className={styles.obFacFig}
              style={{
                ['--accent' as string]: 'var(--purple)',
                ['--accent-dim' as string]: 'var(--purple-dim)',
              }}
            >
              <span className={styles.obFacAccent} aria-hidden />
              <div className={styles.obFacMeta}>
                <span className={styles.obFacIndex}>02</span>
                <span className={`${styles.obFacCaption} mono`}>ENVELOPE&lt;T&gt; · VALIDATED</span>
              </div>
              <div className={styles.obFacArt}>
                <EnvelopeDiagram />
              </div>
              <h2 className={styles.obFacH2}>Typed envelopes</h2>
              <p className={styles.obFacBody}>
                Every agent reply is structured. Code decides if it counts.
              </p>
            </article>

            <article
              className={styles.obFacFig}
              style={{
                ['--accent' as string]: 'var(--green)',
                ['--accent-dim' as string]: 'var(--green-dim)',
              }}
            >
              <span className={styles.obFacAccent} aria-hidden />
              <div className={styles.obFacMeta}>
                <span className={styles.obFacIndex}>03</span>
                <span className={`${styles.obFacCaption} mono`}>GATE.REPORT · AUDITABLE</span>
              </div>
              <div className={styles.obFacArt}>
                <GateDiagram />
              </div>
              <h2 className={styles.obFacH2}>Gates leave evidence</h2>
              <p className={styles.obFacBody}>
                A green gate says what it checked, not only that it passed.
              </p>
            </article>
          </div>
        </div>
      </div>

      <StepFooter />
    </div>
  );
}
