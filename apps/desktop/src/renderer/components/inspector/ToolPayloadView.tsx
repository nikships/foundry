/**
 * Structured tool-call body for the run-detail timeline (and reusable anywhere
 * a tool row should not dump raw JSON). Fields as labeled rows, truncated
 * result preview, raw JSON only behind an explicit toggle.
 */

import { useMemo, useState } from 'react';
import type { EventRow } from '@shared/types.js';
import { CodeBlock } from '../ui/CodeBlock.js';
import JsonView from '../common/JsonView.js';
import { toolPayloadFromEvent } from './tool-payload.js';
import styles from './ToolPayloadView.module.css';

const RESULT_LINES = 14;

function TruncatedResult({ text }: { text: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => text.split('\n'), [text]);
  const hasMore = lines.length > RESULT_LINES;
  const visible = expanded || !hasMore ? text : lines.slice(0, RESULT_LINES).join('\n');

  return (
    <div className={styles.resultWrap}>
      <CodeBlock maxHeight={expanded ? 480 : 280} className={styles.result}>
        {visible}
      </CodeBlock>
      {hasMore && (
        <button type="button" className={styles.more} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : `Show ${lines.length - RESULT_LINES} more lines`}
        </button>
      )}
    </div>
  );
}

export default function ToolPayloadView({ event }: { event: EventRow }): React.JSX.Element {
  const [showRaw, setShowRaw] = useState(false);
  const model = useMemo(() => toolPayloadFromEvent(event), [event]);

  return (
    <div
      className={`${styles.wrap} ${model.failed ? styles.failed : ''}`}
      data-testid="tool-payload"
      data-kind={model.kind}
    >
      {model.fields.length > 0 && (
        <dl className={styles.fields}>
          {model.fields.map((field) => (
            <div key={field.label} className={styles.field}>
              <dt className={styles.label}>{field.label}</dt>
              <dd className={`mono selectable ${styles.value}`}>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {!model.fields.length && model.summary && (
        <p className={`mono selectable ${styles.summary}`}>{model.summary}</p>
      )}
      {model.result ? (
        <TruncatedResult text={model.result} />
      ) : (
        <p className={`faint ${styles.empty}`}>No output</p>
      )}
      {model.truncated && (
        <p className={`faint ${styles.truncated}`}>truncated here, full text in stream.jsonl</p>
      )}
      <button
        type="button"
        className={styles.rawToggle}
        onClick={() => setShowRaw((v) => !v)}
        aria-expanded={showRaw}
      >
        {showRaw ? 'Hide raw JSON' : 'Show raw JSON'}
      </button>
      {showRaw && (
        <div className={styles.raw} data-testid="tool-payload-raw">
          <JsonView value={model.raw} />
        </div>
      )}
    </div>
  );
}
