import { StepFooter } from './shared.js';
import styles from './WelcomeScreen.module.css';

const CONCEPTS = [
  [
    'Pipelines are data',
    'Agents run in ordered phases you can rearrange without rewriting scripts.',
  ],
  ['Replies are typed', 'Every phase returns a report that code validates before work continues.'],
  ['Checks leave evidence', 'Prompts, tools, checks, and diffs stay visible for your review.'],
] as const;

const MARKS = ['Native macOS', 'Agents in-process', 'Worktree isolation'] as const;

/* Illustrative trace rows. Shape and vocabulary match the Inspector's real
   transcript so the first screen is not selling something the app never shows. */
const EVIDENCE = [
  { glyph: '▸', kind: 'phase', text: 'planner · plan', meta: '1m 34s' },
  { glyph: '⚙', kind: 'tool', text: 'edit: src/engine/executor.ts', meta: '+42 −7' },
  { glyph: '⛨', kind: 'gate', text: 'tests · typecheck · boundaries', meta: 'pass' },
] as const;

const STATIONS = [
  { label: 'REQUEST', sub: 'your prompt', color: 'var(--accent)' },
  { label: 'AGENTS', sub: 'ordered phases', color: 'var(--purple)' },
  { label: 'CHECKS', sub: 'checks + diffs', color: 'var(--green)' },
  { label: 'ACCEPT', sub: 'you decide', color: 'var(--amber)' },
] as const;

/* Geometry for the run diagram, in viewBox units. Four station cards on one
   baseline, so the arrow gaps are identical and the pulse that travels them
   can share a single dash period. */
const CARD_W = 140;
const CARD_H = 96;
const CARD_GAP = 36;
const CARD_TOP = 54;
const BASELINE = CARD_TOP + CARD_H / 2;
const cardX = (index: number): number => 26 + index * (CARD_W + CARD_GAP);

function RunDiagram(): React.JSX.Element {
  const lastX = cardX(STATIONS.length - 1) + CARD_W / 2;

  return (
    <svg
      className={styles.diagram}
      viewBox="0 0 720 228"
      role="img"
      aria-label="A request moves through a pipeline of agents and evidence checks, then accepted work is merged or opened as a pull request"
    >
      {STATIONS.slice(0, -1).map((station, index) => {
        const from = cardX(index) + CARD_W + 6;
        const to = cardX(index + 1) - 6;
        return (
          <g key={`link-${station.label}`}>
            <line x1={from} y1={BASELINE} x2={to} y2={BASELINE} className={styles.link} />
            <line
              x1={from}
              y1={BASELINE}
              x2={to}
              y2={BASELINE}
              className={styles.linkPulse}
              style={{ animationDelay: `${index * 0.42}s` }}
            />
            <path
              d={`M${to - 5} ${BASELINE - 3.5} L${to} ${BASELINE} L${to - 5} ${BASELINE + 3.5}`}
              className={styles.linkHead}
            />
          </g>
        );
      })}

      {STATIONS.map((station, index) => {
        const x = cardX(index);
        return (
          <g key={station.label}>
            <rect
              x={x}
              y={CARD_TOP}
              width={CARD_W}
              height={CARD_H}
              rx="3"
              className={styles.station}
              style={{ animationDelay: `${index * 1.35}s` }}
            />
            <rect x={x} y={CARD_TOP} width="3" height={CARD_H} fill={station.color} />
            <text x={x + 18} y={CARD_TOP + 28} className={styles.stationIndex}>
              0{index + 1}
            </text>
            <text x={x + 18} y={CARD_TOP + 50} className={styles.stationLabel}>
              {station.label}
            </text>
            <text x={x + 18} y={CARD_TOP + 70} className={styles.stationSub}>
              {station.sub}
            </text>
          </g>
        );
      })}

      <path
        d={`M${lastX} ${CARD_TOP + CARD_H} v30 M${lastX - 58} 180 H${lastX + 58} M${lastX - 58} 180 v12 M${lastX + 58} 180 v12`}
        className={styles.branch}
      />
      <text x={lastX - 58} y="210" className={styles.outcome}>
        MERGE
      </text>
      <text x={lastX + 58} y="210" className={styles.outcome}>
        PR
      </text>
    </svg>
  );
}

export default function WelcomeScreen(): React.JSX.Element {
  return (
    <div className={styles.obWelcome}>
      <div className={styles.hero}>
        <section className={styles.editorial}>
          <div className={styles.eyebrowRow}>
            <p className={`${styles.eyebrow} eyebrow`}>
              <span className="index">01</span>Introducing
            </p>
            <span className={styles.rule} aria-hidden />
            <span className={styles.stepCount}>01 / 04</span>
          </div>

          <h1 className={styles.wordmark}>
            Foundry
            <span className={styles.caret} aria-hidden />
          </h1>

          <p className={styles.lead}>
            Describe a change. A crew of specialized agents carries it through an editable pipeline
            in an <strong>isolated worktree</strong>. You watch every phase and{' '}
            <strong>decide what ships</strong>.
          </p>

          <ul className={styles.marks}>
            {MARKS.map((mark) => (
              <li key={mark} className={styles.mark}>
                {mark}
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.stage}>
          <div className={styles.stagePanel}>
            <div className={styles.stageGrid} aria-hidden />
            <div className={styles.stageHead}>
              <span>One request · reviewed code</span>
              <span className={styles.live}>
                <span className={styles.liveDot} aria-hidden />
                live
              </span>
            </div>
            <div className={styles.stageBody}>
              <RunDiagram />
            </div>
            <div className={styles.evidence}>
              <p className={styles.evidenceLabel}>every phase leaves a trace</p>
              <ul className={styles.evidenceList}>
                {EVIDENCE.map((row, index) => (
                  <li
                    key={row.text}
                    className={styles.evidenceRow}
                    data-kind={row.kind}
                    style={{ ['--i' as string]: String(index) }}
                  >
                    <span className={styles.evidenceGlyph} aria-hidden>
                      {row.glyph}
                    </span>
                    <span className={styles.evidenceText}>{row.text}</span>
                    <span className={styles.evidenceMeta}>{row.meta}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className={styles.guidance}>
              When a run is accepted you will merge or open a PR from the run page.
            </p>
          </div>
        </section>
      </div>

      <ul className={styles.band}>
        {CONCEPTS.map(([title, body], index) => (
          <li key={title} className={styles.bandItem} style={{ ['--i' as string]: String(index) }}>
            <span className={styles.bandIndex}>0{index + 1}</span>
            <strong className={styles.bandTitle}>{title}</strong>
            <small className={styles.bandBody}>{body}</small>
          </li>
        ))}
      </ul>

      <StepFooter nextLabel="Begin setup" showBack={false} />
    </div>
  );
}
