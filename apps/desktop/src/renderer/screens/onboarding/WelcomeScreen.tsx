import { StepFooter } from './shared.js';
import styles from './WelcomeScreen.module.css';

const CONCEPTS = [
  [
    'Pipelines are data',
    'Agents run in ordered phases you can rearrange without rewriting scripts.',
  ],
  [
    'Replies are typed',
    'Every phase returns an envelope that code validates before work continues.',
  ],
  ['Gates leave evidence', 'Prompts, tools, checks, and diffs stay visible for your review.'],
] as const;

function RunDiagram(): React.JSX.Element {
  const stations = [
    { x: 44, label: 'REQUEST', color: 'var(--accent)' },
    { x: 190, label: 'AGENTS', color: 'var(--purple)' },
    { x: 336, label: 'GATES', color: 'var(--green)' },
    { x: 482, label: 'ACCEPT', color: 'var(--amber)' },
  ];

  return (
    <svg
      className={styles.diagram}
      viewBox="0 0 620 190"
      role="img"
      aria-label="A request moves through a pipeline of agents and evidence gates, then accepted work is merged or opened as a pull request"
    >
      <path className={styles.diagramTrack} d="M72 92 H552" />
      {stations.map((station, index) => (
        <g key={station.label}>
          <rect
            x={station.x}
            y="60"
            width="94"
            height="64"
            rx="3"
            className={styles.diagramStation}
          />
          <rect x={station.x} y="60" width="3" height="64" rx="1" fill={station.color} />
          <text x={station.x + 14} y="86" className={styles.diagramLabel}>
            {station.label}
          </text>
          <text x={station.x + 14} y="105" className={styles.diagramIndex}>
            0{index + 1}
          </text>
          {index < stations.length - 1 && (
            <path
              d={`M${station.x + 102} 92 h30 l-7 -5 m7 5 -7 5`}
              className={styles.diagramArrow}
            />
          )}
        </g>
      ))}
      <path d="M529 124 v28 h-48" className={styles.diagramBranch} />
      <path d="M529 124 v28 h48" className={styles.diagramBranch} />
      <text x="447" y="171" className={styles.diagramOutcome}>
        MERGE
      </text>
      <text x="555" y="171" className={styles.diagramOutcome}>
        PR
      </text>
    </svg>
  );
}

export default function WelcomeScreen(): React.JSX.Element {
  return (
    <div className={styles.obWelcome}>
      <div className={styles.obWelcomeBody}>
        <section className={styles.obWelcomeEditorial}>
          <p className={`${styles.obWelcomeEyebrow} eyebrow`}>
            <span className="index">01</span>Introducing
          </p>
          <h1 className={styles.obWelcomeWordmark}>Foundry</h1>
          <p className={styles.obWelcomeLead}>
            Describe a change. A crew of specialized agents carries it through an editable pipeline
            in an isolated worktree. You watch every phase and decide what ships.
          </p>

          <ul className={styles.obWelcomeConcepts}>
            {CONCEPTS.map(([title, body], index) => (
              <li key={title}>
                <span className={styles.conceptIndex}>0{index + 1}</span>
                <span>
                  <strong>{title}</strong>
                  <small>{body}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.obWelcomeVisual}>
          <p className={`${styles.visualLabel} mono`}>ONE REQUEST · REVIEWED CODE</p>
          <RunDiagram />
          <p className={styles.landingGuidance}>
            When a run is accepted you will merge or open a PR from the run page.
          </p>
        </section>
      </div>

      <StepFooter nextLabel="Begin setup" showBack={false} />
    </div>
  );
}
