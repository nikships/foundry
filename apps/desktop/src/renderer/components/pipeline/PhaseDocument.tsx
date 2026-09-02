/**
 * The document a phase wrote, rendered as Markdown.
 *
 * A plan phase's envelope is its receipt; the file it declared in `artifacts`
 * is the actual deliverable, and reading it as escaped JSON in a report card
 * is reading the receipt instead of the work. Fetched on demand for the same
 * reason as the prompt: it is prose-sized and belongs to no poll.
 */

import { useEffect, useState } from 'react';
import type { RunArtifactReason, RunArtifactResult } from '@shared/ipc-contract.js';
import { api } from '../../api.js';
import MarkdownText from '../common/MarkdownText.js';
import { CodeBlock } from '../ui/CodeBlock.js';
import styles from './PhaseDocument.module.css';

const REASON_COPY: Record<RunArtifactReason, string> = {
  no_artifacts: 'This phase declared no documents.',
  run_not_found: 'This run is no longer in the trace.',
  worktree_gone: 'This run’s worktree is gone, so its documents cannot be read.',
  not_found: 'The declared file is not on disk.',
  unreadable: 'The file could not be read.',
  not_text: 'Not a text document.',
};

/** Markdown is rendered; anything else is shown as the source it is. */
function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function bytesLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export default function PhaseDocument({
  projectId,
  phaseId,
}: {
  projectId: string;
  phaseId: string;
}): React.JSX.Element {
  const [result, setResult] = useState<RunArtifactResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void api.runs
      .artifactsFor(projectId, phaseId)
      .then((next) => {
        if (cancelled) return;
        setResult(next);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setResult(null);
        setError(e.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, phaseId]);

  if (loading) return <p className={`faint ${styles.padded}`}>Loading document…</p>;
  if (error) {
    return (
      <p className={`${styles.inlineError} ${styles.padded}`} role="alert">
        {error}
      </p>
    );
  }
  if (!result) return <p className={`faint ${styles.padded}`}>No document to show.</p>;

  return (
    <>
      {result.reason && !result.files.length && (
        <p className={`faint ${styles.padded}`}>{REASON_COPY[result.reason]}</p>
      )}
      {result.files.map((file) => (
        <article key={file.path} className={styles.doc} data-testid="phase-document">
          <div className={`spread ${styles.docHead}`}>
            <span className="mono">{file.path}</span>
            <span className="faint">
              {bytesLabel(file.bytes)}
              {file.truncated ? ' · truncated' : ''}
            </span>
          </div>
          <div className={`${styles.docBody} selectable`}>
            {isMarkdown(file.path) ? (
              <MarkdownText text={file.content} />
            ) : (
              <CodeBlock maxHeight={640}>{file.content}</CodeBlock>
            )}
          </div>
        </article>
      ))}
      {result.missing.map((entry) => (
        <p key={entry.path} className={`faint ${styles.padded}`}>
          <span className="mono">{entry.path}</span> — {REASON_COPY[entry.reason]}
        </p>
      ))}
    </>
  );
}
