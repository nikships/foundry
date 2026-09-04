import { useEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import type { PlanChatMessage } from '@shared/ipc-contract.js';
import { cx } from '../ui/cx.js';
import styles from './PlanChat.module.css';

/**
 * The back-and-forth about an accepted proposal: ask the Orchestrator about a
 * trade-off, or have it revise the plan, without discarding and starting
 * over. Regenerate and Start stay where they were — this is the middle path
 * between them.
 */
export default function PlanChat({
  messages,
  replying,
  error,
  disabled,
  onSend,
}: {
  messages: PlanChatMessage[];
  /** True while a follow-up reply is being considered. */
  replying: boolean;
  /** Why the last message was refused, or empty. */
  error: string;
  disabled: boolean;
  onSend: (text: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages.length, replying]);

  const send = (): void => {
    const text = draft.trim();
    if (!text || replying || disabled) return;
    onSend(text);
    setDraft('');
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className={styles.chat} data-testid="plan-chat">
      {(messages.length > 0 || replying) && (
        <div ref={logRef} className={styles.log} data-testid="plan-chat-log">
          {messages.map((message) => (
            <div
              key={message.id}
              className={cx(
                styles.message,
                message.role === 'operator' ? styles.operator : styles.orchestrator,
              )}
              data-testid={`plan-chat-${message.role}`}
            >
              <p className={styles.messageText}>{message.text}</p>
              {message.revisedPlan && (
                <span className={styles.revised} data-testid="plan-chat-revised">
                  proposal revised
                </span>
              )}
            </div>
          ))}
          {replying && (
            <div className={cx(styles.message, styles.orchestrator)}>
              <p className={`${styles.messageText} ${styles.thinking}`}>
                The Orchestrator is considering…
              </p>
            </div>
          )}
        </div>
      )}
      <div className={styles.composer}>
        <textarea
          className={`textarea ${styles.input}`}
          value={draft}
          rows={1}
          placeholder="Ask about a trade-off, or request a change to this proposal…"
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Message the Orchestrator about this proposal"
          data-testid="plan-chat-input"
        />
        <button
          type="button"
          className={styles.send}
          disabled={disabled || replying || !draft.trim()}
          title={replying ? 'The Orchestrator is still replying' : 'Send (Enter)'}
          aria-label="Send message"
          onClick={send}
          data-testid="plan-chat-send"
        >
          <ArrowUp size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      {error && (
        <p className={styles.error} role="alert" data-testid="plan-chat-error">
          {error}
        </p>
      )}
    </div>
  );
}
