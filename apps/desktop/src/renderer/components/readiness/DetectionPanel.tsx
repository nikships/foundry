import type { DetectionState, DetectionProposal } from '@shared/ipc-contract.js';
import { modelLabel } from '@shared/model-label.js';
import { duration } from '../../utils/format.js';
import { Button } from '../ui/Button.js';
import { CodeBlock } from '../ui/CodeBlock.js';
import { cx } from '../ui/cx.js';
import PanelTranscript from './PanelTranscript.js';
import styles from './DetectionPanel.module.css';

const STATUS_LABEL: Record<DetectionState['status'], string> = {
  running: 'Reading the repo',
  verifying: 'Running what it found',
  done: 'Finished',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

const VERIFY_MARK: Record<DetectionProposal['verify'], { glyph: string; tone: string }> = {
  pending: { glyph: '·', tone: styles.wait },
  running: { glyph: '◌', tone: styles.wait },
  pass: { glyph: '✓', tone: styles.ok },
  fail: { glyph: '✕', tone: styles.failed },
};

function VerifyMark({ proposal }: { proposal: DetectionProposal }): React.JSX.Element {
  const { glyph, tone } = VERIFY_MARK[proposal.verify];
  return <span className={cx(styles.mark, tone)}>{glyph}</span>;
}

/**
 * The live view of an agent finding commands: what it is reading, what it
 * proposed, and what happened when each proposal was actually run.
 *
 * Every proposal is shown even when it fails to verify, because a command that
 * is right but unrunnable (a missing binary) and a command that is simply wrong
 * are different problems, and only one of them is the agent's fault.
 */
export default function DetectionPanel({
  state,
  onCancel,
  onAccept,
  onAcceptAll,
  showRaw,
  onToggleRaw,
}: {
  state: DetectionState;
  onCancel: () => void;
  onAccept: (proposal: DetectionProposal) => void;
  onAcceptAll: () => void;
  showRaw: boolean;
  onToggleRaw: () => void;
}): React.JSX.Element {
  const live = state.status === 'running' || state.status === 'verifying';
  const usable = state.proposals.filter((p) => p.verify !== 'running');

  return (
    <div className={`field ${styles.detection}`}>
      <label>
        {STATUS_LABEL[state.status]}
        <span className={`faint ${styles.model}`}>
          {state.model === 'inherit' ? '' : ` · ${modelLabel(state.model)}`}
        </span>
      </label>
      <span className="hint">{state.detail}</span>

      <PanelTranscript entries={state.entries} live={live} />

      {live && (
        <div className={`row ${styles.actions}`}>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}

      {state.proposals.length > 0 && (
        <div className={`commands ${styles.proposals}`}>
          {state.proposals.map((p) => (
            <div key={p.name} className={`row ${styles.found}`}>
              <VerifyMark proposal={p} />
              <span className={styles.name}>{p.name}</span>
              <code className={`mono ${styles.args}`}>{p.argv.join(' ')}</code>
              <span className={`faint ${styles.why}`}>
                {p.source}
                {p.verify === 'pass' && `, exit 0 in ${duration(p.durationMs)}`}
                {p.verify === 'fail' &&
                  (p.notFound
                    ? ', could not run: binary not found on PATH'
                    : `, exit ${p.exitCode ?? '—'} in ${duration(p.durationMs)}`)}
                {p.verify === 'running' && ', running…'}
              </span>
              <Button size="sm" disabled={p.verify === 'running'} onClick={() => onAccept(p)}>
                Use
              </Button>
            </div>
          ))}
          {usable.length > 1 && (
            <div className="row">
              <Button size="sm" onClick={onAcceptAll}>
                Use all {usable.length}
              </Button>
            </div>
          )}
        </div>
      )}

      {state.rejected.length > 0 && (
        <div className={styles.rejected}>
          {state.rejected.map((r, i) => (
            <div key={i} className={`${styles.line} ${styles.note}`}>
              Ignored: {r.reason}
            </div>
          ))}
        </div>
      )}

      {state.rawReply && (
        <>
          <button className={`linkish ${styles.rawToggle}`} onClick={onToggleRaw}>
            {showRaw ? 'Hide raw reply' : 'Show raw reply'}
          </button>
          {showRaw && (
            <CodeBlock maxHeight={220} className={styles.output}>
              {state.rawReply}
            </CodeBlock>
          )}
        </>
      )}
    </div>
  );
}
