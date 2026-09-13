/**
 * Text / Voice switch plus the in-chat YOLO control. YOLO used to occupy its
 * own padded header; it now trails these buttons on the same row so the chat
 * does not grow a second chrome band for a one-line status.
 */

import { MessageSquare, Mic, MicOff, Square } from 'lucide-react';
import { useSmithChatUI } from '../../stores/smith-chat-ui.js';
import styles from './SmithModeBar.module.css';

export default function SmithModeBar({
  trailing,
}: {
  trailing: React.ReactNode;
}): React.JSX.Element {
  const { mode, setMode, state, stop, toggleMute } = useSmithChatUI();
  const connected = state.status === 'live' || state.status === 'connecting';
  return (
    <div className={styles.bar}>
      <div className={styles.modes} role="group" aria-label="Smith mode">
        <button
          type="button"
          aria-pressed={mode === 'text'}
          onClick={() => setMode('text')}
          data-testid="smith-mode-text"
        >
          <MessageSquare size={14} /> Text
        </button>
        <button
          type="button"
          aria-pressed={mode === 'voice'}
          onClick={() => setMode('voice')}
          data-testid="smith-mode-voice"
        >
          <Mic size={14} /> Voice
        </button>
      </div>
      <div className={styles.trailing}>{trailing}</div>
      {connected ? (
        <div className={styles.connection}>
          {state.status === 'live' ? (
            <button
              type="button"
              onClick={toggleMute}
              aria-pressed={state.muted}
              aria-label={state.muted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {state.muted ? <MicOff size={13} /> : <Mic size={13} />}
              {state.muted ? 'Mic muted' : 'Mic on'}
            </button>
          ) : (
            <span role="status">Connecting</span>
          )}
          <button
            type="button"
            onClick={stop}
            aria-label="End voice session"
            title="End voice session"
          >
            <Square size={12} /> End
          </button>
        </div>
      ) : null}
    </div>
  );
}
