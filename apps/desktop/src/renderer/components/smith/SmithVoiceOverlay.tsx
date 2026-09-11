/**
 * Smith's live voice launcher and panel: one mic button docked in the
 * titlebar band beside the Smith chat launcher, mounted on every screen so
 * voice keeps running while the operator navigates. The panel that opens
 * above it shows live transcriptions and the state of the delegated work.
 *
 * Voice is a layer, not a second agent: the panel says so in its hints, and
 * everything the voice model does flows through the same Smith chat session
 * the text UI drives.
 */

import { useEffect, useState } from 'react';
import type { SmithScreenContext } from '@shared/ipc-contract.js';
import { useSmithVoice } from '../../hooks/useSmithVoice.js';
import { useEscapeToClose } from '../../hooks/useEscapeToClose.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { SmithEmblem } from '../layout/SidebarEmblems.js';
import styles from './SmithVoiceOverlay.module.css';

/** Mic glyph, drawn inline: one 16×16 path, no icon-package weight. */
function MicIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="5.5" y="1" width="5" height="8" rx="2.5" fill="currentColor" />
      <path
        d="M3.5 7a4.5 4.5 0 0 0 9 0M8 11.5V15M5.5 15h5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function statusPill(status: ReturnType<typeof useSmithVoice>['state']['status']): string {
  switch (status) {
    case 'live':
      return 'listening';
    case 'connecting':
      return 'connecting…';
    case 'error':
      return 'error';
    default:
      return 'off';
  }
}

export default function SmithVoiceOverlay({
  screenContext,
}: {
  /** What the operator is looking at; the voice layer sends it with each delegation. */
  screenContext: SmithScreenContext;
}): React.JSX.Element {
  const { state, start, stop, setScreenContext } = useSmithVoice();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setScreenContext(screenContext);
  }, [screenContext, setScreenContext]);

  useEscapeToClose(() => setOpen(false), open);

  const live = state.status === 'live';

  const toggle = (): void => {
    if (live) {
      stop();
      return;
    }
    setOpen(true);
    void start();
  };

  return (
    <div className={styles.anchor}>
      {open && (
        <div className={styles.panel} role="dialog" aria-label="Smith voice">
          <div className={styles.head}>
            <h3 className={styles.title}>
              <SmithEmblem aria-hidden /> Smith voice
            </h3>
            <span
              className={cx(
                styles.pill,
                live && styles.pillLive,
                state.status === 'error' && styles.pillError,
              )}
              data-testid="smith-voice-status"
            >
              {statusPill(state.status)}
            </span>
          </div>
          {state.status === 'error' && state.error && (
            <p className={cx(styles.line, styles.errorText)}>{state.error}</p>
          )}
          {state.status !== 'error' && (
            <>
              <div>
                <p className={styles.lineLabel}>You</p>
                <p className={cx(styles.line, state.inputText && styles.lineSpeaking)}>
                  {state.inputText || '—'}
                </p>
              </div>
              <div>
                <p className={styles.lineLabel}>Smith</p>
                <p className={cx(styles.line, state.outputText && styles.lineSpeaking)}>
                  {state.outputText || '—'}
                </p>
              </div>
            </>
          )}
          <p className={styles.hint}>
            {state.smithRunning
              ? 'A delegated turn is running on the Smith chat. Ask me to cancel it, or wait for the result.'
              : 'Ask me anything about Foundry. Real work goes to the Smith chat on the model you chose there.'}
          </p>
          <div className={styles.actions}>
            {live && (
              <Button size="sm" variant="danger" onClick={stop}>
                Stop
              </Button>
            )}
            {(state.status === 'idle' || state.status === 'error') && (
              <Button size="sm" variant="primary" onClick={() => void start()}>
                Connect
              </Button>
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        className={cx(styles.launcher, live && styles.launcherLive)}
        aria-expanded={live}
        aria-label={live ? 'Stop Smith voice mode' : 'Start Smith voice mode'}
        data-testid="smith-voice-launcher"
        title={live ? 'Smith voice is live' : 'Smith voice mode'}
        onClick={toggle}
      >
        <MicIcon />
      </button>
    </div>
  );
}
