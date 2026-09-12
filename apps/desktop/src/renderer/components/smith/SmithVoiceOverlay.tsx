import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Square, X, ArrowUpRight } from 'lucide-react';
import type { SmithScreenContext } from '@shared/ipc-contract.js';
import { useSmithVoice, type SmithVoiceState } from '../../hooks/useSmithVoice.js';
import { useEscapeToClose } from '../../hooks/useEscapeToClose.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { VoiceOrb } from './VoiceOrb.js';
import styles from './SmithVoiceOverlay.module.css';

function voicePresentation(state: SmithVoiceState): { title: string; detail: string } {
  if (state.status === 'error')
    return { title: 'Let’s reconnect', detail: 'Your microphone is off' };
  if (state.status === 'connecting')
    return { title: 'Connecting to Smith', detail: 'Preparing a secure voice session' };
  if (state.status === 'idle')
    return { title: 'Think out loud', detail: 'Your voice. The same Smith.' };
  if (state.speaking)
    return {
      title: 'Smith is speaking',
      detail: state.muted ? 'Unmute to join the conversation' : 'You can interrupt anytime',
    };
  if (state.muted)
    return { title: 'Microphone muted', detail: 'Smith stays connected while you take a moment' };
  if (state.smithRunning)
    return {
      title: 'Smith is working',
      detail: 'Your chosen model is on it. You can keep talking.',
    };
  return { title: 'I’m listening', detail: 'Speak naturally. No need to hold a button.' };
}

interface VoicePanelContentProps {
  state: SmithVoiceState;
  presentation: { title: string; detail: string };
  live: boolean;
  connecting: boolean;
  closeRef: React.RefObject<HTMLButtonElement | null>;
  close: () => void;
  start: () => Promise<void>;
  stop: () => void;
  toggleMute: () => void;
  settings: () => void;
  readLevel: () => number;
  onOpenSmith: () => void;
}

function VoicePanelContent({
  state,
  presentation,
  live,
  connecting,
  closeRef,
  close,
  start,
  stop,
  toggleMute,
  settings,
  readLevel,
  onOpenSmith,
}: VoicePanelContentProps): React.JSX.Element {
  return (
    <>
      <header className={styles.head}>
        <h3 className={styles.title}>
          Smith <span>/ Voice</span>
        </h3>
        <span className={cx(styles.pill, live && styles.pillLive)}>
          {live ? 'Live' : 'Gemini Live'}
        </span>
        <button
          ref={closeRef}
          type="button"
          className={styles.close}
          onClick={close}
          aria-label="Close Smith voice"
          data-testid="smith-voice-close"
        >
          <X size={16} />
        </button>
      </header>
      <div className={styles.stage} data-speaking={state.speaking}>
        <VoiceOrb active={live || connecting} speaking={state.speaking} readLevel={readLevel} />
        <div className={styles.status} role="status" data-testid="smith-voice-status">
          {presentation.title}
        </div>
        <p className={styles.detail}>{presentation.detail}</p>
      </div>
      {state.error ? (
        <p className={styles.errorText} role="alert">
          {state.error}
        </p>
      ) : (
        <div className={styles.caption}>
          <p className={styles.lineLabel}>{state.outputText ? 'Smith' : 'Start a conversation'}</p>
          <p className={styles.line}>
            {state.outputText || '“Help me think through my next change.”'}
          </p>
          {state.inputText && (
            <div className={styles.heard}>
              <span className={styles.lineLabel}>You</span>
              <p>{state.inputText}</p>
            </div>
          )}
        </div>
      )}
      {state.proposalPending && (
        <button
          type="button"
          className={styles.notice}
          onClick={() => {
            // On the Smith screen onOpenSmith is a no-op navigation; close reveals the full-page chat.
            close();
            onOpenSmith();
          }}
        >
          A proposal needs your review <ArrowUpRight size={14} />
        </button>
      )}
      {state.smithRunning && (
        <p className={styles.workNote}>Work continues in Smith chat, even if you end voice.</p>
      )}
      <div className={styles.actions}>
        {live && (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={state.muted}
            onClick={toggleMute}
            data-testid="smith-voice-mute"
          >
            {state.muted ? <MicOff size={15} /> : <Mic size={15} />}
            {state.muted ? 'Unmute' : 'Mute mic'}
          </Button>
        )}
        {live || connecting ? (
          <Button size="sm" variant="danger" onClick={stop} data-testid="smith-voice-stop">
            <Square size={12} />
            {connecting ? 'Cancel' : 'End session'}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            onClick={() => void start()}
            data-testid="smith-voice-start"
          >
            <Mic size={15} />
            {state.status === 'error' ? 'Try again' : 'Start voice'}
          </Button>
        )}
        {!live && !connecting && (
          <Button size="sm" variant="ghost" onClick={settings}>
            Voice settings <ArrowUpRight size={14} />
          </Button>
        )}
      </div>
      <footer className={styles.footer}>
        <span className={styles.micDot} data-on={live && !state.muted} />
        {live
          ? state.muted
            ? 'Mic muted · Closing this panel keeps voice connected.'
            : 'Mic on · Closing this panel keeps voice connected.'
          : 'Audio is sent to Gemini only while voice is connected.'}
      </footer>
    </>
  );
}

export default function SmithVoiceOverlay({
  screenContext,
  onOpenSmith,
  onOpenSettings,
  variant,
}: {
  screenContext: SmithScreenContext;
  onOpenSmith: () => void;
  onOpenSettings: (pane: string) => void;
  variant: 'popover' | 'fullscreen';
}): React.JSX.Element {
  const { state, start, stop, toggleMute, readLevel, setScreenContext } = useSmithVoice();
  const [open, setOpen] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const presentation = voicePresentation(state);
  const live = state.status === 'live';
  const connecting = state.status === 'connecting';

  useEffect(() => {
    setScreenContext(screenContext);
  }, [screenContext, setScreenContext]);
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);
  const close = useCallback(() => {
    setOpen(false);
    launcherRef.current?.focus();
  }, []);
  useEscapeToClose(close, open);
  const settings = (): void => {
    close();
    onOpenSettings('integrations');
  };

  const content = (
    <VoicePanelContent
      state={state}
      presentation={presentation}
      live={live}
      connecting={connecting}
      closeRef={closeRef}
      close={close}
      start={start}
      stop={stop}
      toggleMute={toggleMute}
      settings={settings}
      readLevel={readLevel}
      onOpenSmith={onOpenSmith}
    />
  );

  return (
    <div className={styles.anchor}>
      {open &&
        (variant === 'fullscreen' ? (
          <div className={styles.fullscreen} data-testid="smith-voice-fullscreen">
            <section
              id="smith-voice-panel"
              className={cx(styles.panel, styles.panelFullscreen)}
              role="dialog"
              aria-modal="true"
              aria-label="Smith voice"
              data-testid="smith-voice-panel"
            >
              {content}
            </section>
          </div>
        ) : (
          <section
            id="smith-voice-panel"
            className={styles.panel}
            role="dialog"
            aria-label="Smith voice"
            data-testid="smith-voice-panel"
          >
            {content}
          </section>
        ))}
      <button
        ref={launcherRef}
        type="button"
        className={cx(styles.launcher, live && styles.launcherLive)}
        aria-expanded={open}
        aria-controls="smith-voice-panel"
        aria-label={
          live
            ? state.muted
              ? 'Smith voice connected, microphone muted'
              : 'Smith voice live, microphone on'
            : 'Open Smith voice mode'
        }
        data-testid="smith-voice-launcher"
        title={live ? 'Smith voice is live' : 'Smith voice mode'}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {state.muted ? <MicOff size={15} /> : <Mic size={15} />}
        {live && <span className={styles.liveDot} />}
      </button>
    </div>
  );
}
