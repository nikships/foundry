import AgentAvatar from '../../components/AgentAvatar.js';
import { BUILTIN_AGENTS, StepFooter } from './shared.js';
import styles from './RosterScreen.module.css';

const HINTS: Record<string, string> = {
  planner: 'Breaks a prompt into an ordered, reviewable task list.',
  builder: 'Implements each task inside its own isolated worktree.',
  scout: 'Finds the files, patterns, and owners that matter.',
  reviewer: 'Blocks the merge until the change reads clean.',
  documenter: 'Records intent, decisions, and follow-ups in the PR.',
};

const ACCENTS: Record<string, string> = {
  planner: 'var(--cyan)',
  builder: 'var(--purple)',
  scout: 'var(--amber)',
  reviewer: 'var(--green)',
  documenter: 'var(--blue)',
};

export default function RosterScreen(): React.JSX.Element {
  return (
    <div className={styles.rs}>
      <div className={styles.rsBody}>
        <div className={styles.rsIntro}>
          <p className="ob-eyebrow">03 — The roster</p>
          <h1 className="ob-title">Meet the crew</h1>
          <p className="ob-lead">
            Built-in agents cover plan, build, scout, review, and docs. Edit them, or bring your
            own. Each one can ride a different CLI.
          </p>
          <div className={styles.rsRule} aria-hidden />
          <p className={styles.rsStat}>Five specialists. One request. Isolated git worktrees.</p>
          <div className={styles.rsFlow} aria-hidden>
            {BUILTIN_AGENTS.map((a, i) => (
              <span key={a.name} className={styles.rsFlowItem}>
                {i > 0 && <span className={styles.rsFlowArrow}>→</span>}
                <span className={styles.rsFlowName} style={{ color: ACCENTS[a.name] }}>
                  {a.name}
                </span>
              </span>
            ))}
          </div>
          <p className={styles.rsClarify}>
            Pipelines wire them in sequence — each phase runs in order, leaves a typed envelope, and
            is judged by code before the next begins.
          </p>
        </div>

        <div className={styles.rsListWrap}>
          <div className={styles.rsListhead}>
            <span>Agents</span>
            <span className={styles.rsListheadRight}>Any CLI</span>
          </div>
          <ol className={styles.rsLanes}>
            <span className={styles.rsConnector} aria-hidden />
            {BUILTIN_AGENTS.map((agent, idx) => (
              <li
                key={agent.name}
                className={styles.rsLane}
                style={
                  {
                    borderLeftColor: ACCENTS[agent.name],
                    ['--accent' as string]: ACCENTS[agent.name],
                    ['--i' as string]: String(idx),
                  } as React.CSSProperties
                }
              >
                <span className={styles.rsNum}>{String(idx + 1).padStart(2, '0')}</span>
                <span className={styles.rsAvatarWrap}>
                  <AgentAvatar name={agent.name} size={36} />
                </span>
                <span className={styles.rsMain}>
                  <span className={styles.rsNameRow}>
                    <span className={styles.rsName}>{agent.name}</span>
                    <span className={styles.rsSep}>/</span>
                    <span className={styles.rsRole}>{agent.role}</span>
                  </span>
                  <span className={styles.rsHint}>{HINTS[agent.name]}</span>
                </span>
                <span className={styles.rsCli}>
                  <span
                    className={styles.rsDot}
                    style={{ background: ACCENTS[agent.name] }}
                    aria-hidden
                  />
                  any CLI
                </span>
              </li>
            ))}
          </ol>
          <p className={styles.rsFootnote}>
            Tune names, prompts, and harnesses in the Roster after setup. The factory runs whatever
            you wire — these five are just a sharp default.
          </p>
        </div>
      </div>

      <StepFooter />
    </div>
  );
}
