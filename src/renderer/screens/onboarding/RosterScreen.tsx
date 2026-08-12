import AgentAvatar from '../../components/AgentAvatar.js';
import { BUILTIN_AGENTS, SceneArt, StepFooter } from './shared.js';
import styles from './RosterScreen.module.css';

const HINTS: Record<string, string> = {
  refiner: 'Rewrites a rough ask into a brief grounded in your repo.',
  planner: 'Breaks a prompt into an ordered, reviewable task list.',
  builder: 'Implements each task inside its own isolated worktree.',
  scout: 'Finds the files, patterns, and owners that matter.',
  finisher: 'Audits the result against the ship bar, then closes the gaps.',
  reviewer: 'Blocks the merge until the change reads clean.',
  documenter: 'Records intent, decisions, and follow-ups in the PR.',
};

/** Muted industrial accents — desaturated, readable on #020202, not brand orange. */
const ACCENTS: Record<string, string> = {
  refiner: '#b87a9e',
  planner: '#9b7ede',
  builder: '#4fa8b8',
  scout: '#d19a3d',
  finisher: '#5b8fd9',
  reviewer: '#e0605f',
  documenter: '#3cb87a',
};

export default function RosterScreen(): React.JSX.Element {
  return (
    <div className={styles.obRoster}>
      <div className={styles.obRosterBody}>
        <div className={styles.obRosterIntro}>
          <p className="ob-eyebrow eyebrow">
            <span className="index">03</span>The roster
          </p>
          <h1 className="ob-title">Meet the crew</h1>
          <p className="ob-lead">
            Built-in agents cover refine, plan, build, scout, polish, review, and docs. Edit them,
            or bring your own. Each one can ride a different CLI.
          </p>
          <div className={styles.obRosterDivider} aria-hidden />
          <p className={styles.obRosterStat}>
            Seven specialists. One request. Isolated git worktrees.
          </p>
          <div className={styles.obRosterFlow} aria-hidden>
            {BUILTIN_AGENTS.map((a, i) => (
              <span key={a.name} className={styles.obRosterFlowItem}>
                {i > 0 && <span className={styles.obRosterFlowArrow}>→</span>}
                <span className={styles.obRosterFlowName} style={{ color: ACCENTS[a.name] }}>
                  {a.name}
                </span>
              </span>
            ))}
          </div>
          <p className={styles.obRosterClarify}>
            Pipelines wire them in sequence — each phase runs in order, leaves a typed envelope, and
            is judged by code before the next begins.
          </p>
          <div className={styles.obRosterScene} aria-hidden>
            <SceneArt path="scenes/run-success.png" className={styles.obRosterSceneArt} />
          </div>
        </div>

        <div className={styles.obRosterListWrap}>
          <div className={styles.obRosterHeader}>
            <span>Agents</span>
            <span className={styles.obRosterHeaderRight}>Any CLI</span>
          </div>
          <ol className={styles.obRosterLanes}>
            <span className={styles.obRosterConnector} aria-hidden />
            {BUILTIN_AGENTS.map((agent, idx) => (
              <li
                key={agent.name}
                className={styles.obRosterRow}
                style={
                  {
                    borderLeftColor: ACCENTS[agent.name],
                    ['--accent' as string]: ACCENTS[agent.name],
                    ['--i' as string]: String(idx),
                  } as React.CSSProperties
                }
              >
                <span className={styles.obRosterNum}>{String(idx + 1).padStart(2, '0')}</span>
                <span className={styles.obRosterAvatarWrap}>
                  <AgentAvatar name={agent.name} size={36} />
                </span>
                <span className={styles.obRosterMain}>
                  <span className={styles.obRosterNameRow}>
                    <span className={styles.obRosterName}>{agent.name}</span>
                    <span className={styles.obRosterSep}>/</span>
                    <span className={styles.obRosterRole}>{agent.role}</span>
                  </span>
                  <span className={styles.obRosterHint}>{HINTS[agent.name]}</span>
                </span>
                <span className={styles.obRosterCli}>
                  <span
                    className={styles.obRosterDot}
                    style={{ background: ACCENTS[agent.name] }}
                    aria-hidden
                  />
                  any CLI
                </span>
              </li>
            ))}
          </ol>
          <p className={styles.obRosterFootnote}>
            Tune names, prompts, and harnesses in the Roster after setup. The factory runs whatever
            you wire — these seven are just a sharp default.
          </p>
        </div>
      </div>

      <StepFooter />
    </div>
  );
}
