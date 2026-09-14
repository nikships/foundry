/**
 * Smith's live voice session: one GPT-Live WebRTC connection, its mic and
 * speaker plumbing, and client delegation into the same Smith chat.
 *
 * The voice model (`gpt-live-1`) speaks and listens. When it delegates, its
 * spoken output transcript — the concise optimized work statement it just
 * said aloud — is sent through the ordinary `smith.send` into the same
 * `SmithChatSession` the Smith UI drives, where it lands verbatim as the
 * visible operator row. The raw input transcript stays display-only in the
 * overlay and is never sent; an empty model statement asks the model to
 * restate rather than falling back to raw speech. Settled text is returned
 * with `session.commentary.append` so the voice model can narrate it. A
 * proposal that needs a secret is never approved by voice — the masked
 * desktop card owns the key.
 *
 * All state is refs inside one `useRef` bundle plus `useState` only for what
 * the overlay renders, so reconnects and view changes never remount the
 * session.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SmithChatState, SmithScreenContext } from '@shared/ipc-contract.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import {
  EMPTY_SETTLE_WATCH,
  foldSettleWatch,
  friendlyVoiceError,
  selectVoiceDelegationQuery,
  settledAnswerText,
  settledWorkPrompt,
} from '../view-models/smith-voice-view.js';

export type VoiceStatus = 'idle' | 'connecting' | 'live' | 'error';

export interface SmithVoiceState {
  status: VoiceStatus;
  /** One-line human sentence for the error state; never a raw exception. */
  error: string | null;
  /** Live transcription of what the operator said, for the overlay. */
  inputText: string;
  outputText: string;
  speaking: boolean;
  muted: boolean;
  /** A delegated Smith turn is running. */
  smithRunning: boolean;
  /** A proposal card is waiting; the voice layer can read and answer it. */
  proposalPending: boolean;
}

type LiveEvent = {
  type?: string;
  delta?: string;
  content?: string;
  usage?: unknown;
  session?: { id?: string };
  delegation?: { id?: string; target?: string };
};

/**
 * How much of the running transcripts the overlay keeps. The raw input stays
 * display-only; delegation sends the model's spoken optimized statement
 * through the ordinary Smith send path, never the raw speech.
 */
const MAX_TRANSCRIPT_CHARS = 4000;
const DATA_CHANNEL = 'oai-events';

function errorMessage(e: unknown): string {
  return friendlyVoiceError(e);
}

function waitForIce(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = (): void => {
      if (peer.iceGatheringState === 'complete') {
        peer.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    };
    peer.addEventListener('icegatheringstatechange', onChange);
  });
}

export function useSmithVoice(): {
  state: SmithVoiceState;
  start: () => Promise<void>;
  stop: () => void;
  toggleMute: () => void;
  readLevel: () => number;
  setScreenContext: (screen: SmithScreenContext) => void;
} {
  const { smithProjectId } = useApp();
  const scopeId = smithProjectId ?? undefined;

  const [state, setState] = useState<SmithVoiceState>({
    status: 'idle',
    error: null,
    inputText: '',
    outputText: '',
    speaking: false,
    muted: false,
    smithRunning: false,
    proposalPending: false,
  });

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const samplesRef = useRef(new Float32Array(256));
  const screenRef = useRef<SmithScreenContext | null>(null);
  const settleWatchRef = useRef(EMPTY_SETTLE_WATCH);
  const aliveRef = useRef(false);
  const generationRef = useRef(0);
  const mutedRef = useRef(false);
  const readyRef = useRef(false);
  const transcriptRef = useRef({ input: '', output: '', finished: true });
  const timeoutRef = useRef<number | undefined>(undefined);
  const speakingTimerRef = useRef<number | undefined>(undefined);
  const delegationRef = useRef<string | null>(null);
  const stoppingRef = useRef(false);

  const patch = useCallback((next: Partial<SmithVoiceState>) => {
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  const sendEvent = useCallback((event: Record<string, unknown>): void => {
    const channel = channelRef.current;
    if (!channel || channel.readyState !== 'open') return;
    channel.send(JSON.stringify(event));
  }, []);

  const teardown = useCallback((): void => {
    generationRef.current++;
    window.clearTimeout(timeoutRef.current);
    window.clearTimeout(speakingTimerRef.current);
    stoppingRef.current = true;
    aliveRef.current = false;
    mutedRef.current = false;
    readyRef.current = false;
    delegationRef.current = null;
    settleWatchRef.current = EMPTY_SETTLE_WATCH;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current.remove();
      audioRef.current = null;
    }
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    setState({
      status: 'idle',
      error: null,
      inputText: '',
      outputText: '',
      speaking: false,
      muted: false,
      smithRunning: false,
      proposalPending: false,
    });
  }, []);

  const failSession = useCallback(
    (error: unknown): void => {
      teardown();
      patch({ status: 'error', error: errorMessage(error) });
    },
    [patch, teardown],
  );

  const startWork = useCallback(
    async (outputText: string, delegationId: string): Promise<void> => {
      const generation = generationRef.current;
      const current = (): boolean => generation === generationRef.current;
      // GPT-Live's spoken statement is the optimized Smith query. The raw
      // input transcript is display-only: an empty statement never falls
      // back to raw speech, it asks the model to restate a concrete query.
      const query = selectVoiceDelegationQuery({ input: '', output: outputText });
      if (!query) {
        sendEvent({
          type: 'session.commentary.append',
          delegation_id: delegationId,
          content:
            'I did not speak a concrete work query. Restate it as a concise, self-contained Smith request, then delegate again.',
        });
        return;
      }
      if (settleWatchRef.current.delegated || settleWatchRef.current.running) {
        sendEvent({
          type: 'session.commentary.append',
          delegation_id: delegationId,
          content: 'I am already working. Wait or ask me to stop first.',
        });
        return;
      }
      settleWatchRef.current = { delegated: true, running: true };
      delegationRef.current = delegationId;
      // Voice delegation rides the ordinary text composer path: the model's
      // optimized work statement lands verbatim as the visible operator row.
      const result = await api.smith
        .send(scopeId, query, screenRef.current ?? { route: 'runs' })
        .catch((error: unknown) => {
          if (current()) settleWatchRef.current = EMPTY_SETTLE_WATCH;
          throw error;
        });
      if (!current()) return;
      if (result == null) {
        settleWatchRef.current = EMPTY_SETTLE_WATCH;
        sendEvent({
          type: 'session.commentary.append',
          delegation_id: delegationId,
          content: 'I cannot start work in this scope.',
        });
        return;
      }
      patch({ smithRunning: true });
    },
    [patch, scopeId, sendEvent],
  );

  const absorbEvent = useCallback(
    (event: LiveEvent): void => {
      if (event.type === 'session.started') {
        readyRef.current = true;
        window.clearTimeout(timeoutRef.current);
        patch({ status: 'live' });
        return;
      }
      if (event.type === 'session.closed') {
        teardown();
        return;
      }
      if (event.type === 'session.input_transcript.delta' && event.delta) {
        if (transcriptRef.current.finished) {
          transcriptRef.current = { input: '', output: '', finished: false };
          patch({ outputText: '' });
        }
        transcriptRef.current.input = (transcriptRef.current.input + event.delta).slice(
          -MAX_TRANSCRIPT_CHARS,
        );
        patch({ inputText: transcriptRef.current.input });
        return;
      }
      if (event.type === 'session.output_transcript.delta' && event.delta) {
        transcriptRef.current.output = (transcriptRef.current.output + event.delta).slice(
          -MAX_TRANSCRIPT_CHARS,
        );
        patch({ outputText: transcriptRef.current.output, speaking: true });
        window.clearTimeout(speakingTimerRef.current);
        speakingTimerRef.current = window.setTimeout(() => patch({ speaking: false }), 800);
        return;
      }
      if (event.type === 'session.delegation.created' && event.delegation?.id) {
        // Snapshot the optimized statement, then reset the ref so a later
        // turn can never reuse a previous statement. The next input delta
        // starts the new turn fresh; the overlay display is separate state.
        const optimized = transcriptRef.current.output;
        transcriptRef.current.finished = true;
        transcriptRef.current.output = '';
        void startWork(optimized, event.delegation.id).catch((error: unknown) => {
          failSession(error);
        });
      }
    },
    [failSession, patch, startWork, teardown],
  );

  const absorbSmithProgress = useCallback(
    (next: SmithChatState) => {
      if (!aliveRef.current || next.projectId !== scopeId) return;
      const folded = foldSettleWatch(settleWatchRef.current, next);
      settleWatchRef.current = folded.next;
      patch({ smithRunning: next.running });
      if (folded.settled) {
        const text = next.error
          ? `Your work failed: ${next.error}`
          : settledAnswerText(next.transcript) ||
            'The turn ended without a written answer. Do not claim success.';
        sendEvent({
          type: 'session.commentary.append',
          delegation_id: delegationRef.current,
          content: settledWorkPrompt(text).slice(0, 1800),
        });
        delegationRef.current = null;
      }
    },
    [patch, scopeId, sendEvent],
  );

  useEffect(() => {
    const offProgress = api.on('smith-progress', (data) => {
      const next = data as SmithChatState | null;
      if (next) absorbSmithProgress(next);
    });
    const offProposals = api.on('smith-proposals-changed', () => {
      const generation = generationRef.current;
      void api.smith
        .proposalsList()
        .then((proposals) => {
          if (aliveRef.current && generation === generationRef.current)
            patch({ proposalPending: proposals.some((p) => p.projectId === scopeId) });
        })
        .catch(() => undefined);
    });
    return () => {
      offProgress();
      offProposals();
    };
  }, [absorbSmithProgress, patch, scopeId]);

  const start = useCallback(async (): Promise<void> => {
    if (aliveRef.current) return;
    const generation = ++generationRef.current;
    const current = (): boolean => generation === generationRef.current;
    aliveRef.current = true;
    stoppingRef.current = false;
    transcriptRef.current = { input: '', output: '', finished: true };
    patch({ status: 'connecting', error: null, inputText: '' });
    const fail = (error: unknown): void => {
      if (!current()) return;
      failSession(error);
    };
    timeoutRef.current = window.setTimeout(
      () => fail(new Error('Connecting took too long. Check your network and try again.')),
      30000,
    );
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!current()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      for (const track of stream.getTracks()) peer.addTrack(track, stream);

      const playback = document.createElement('audio');
      playback.autoplay = true;
      audioRef.current = playback;
      peer.addEventListener('track', (event) => {
        playback.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void playback.play().catch(() => undefined);
        try {
          const Ctor = window.AudioContext;
          const context = new Ctor();
          audioContextRef.current = context;
          const source = context.createMediaStreamSource(playback.srcObject as MediaStream);
          const analyser = context.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          analyserRef.current = analyser;
        } catch {
          /* metering is best-effort */
        }
      });

      const channel = peer.createDataChannel(DATA_CHANNEL);
      channelRef.current = channel;
      channel.addEventListener('message', ({ data }) => {
        if (!current()) return;
        try {
          absorbEvent(JSON.parse(String(data)) as LiveEvent);
        } catch (error) {
          fail(error);
        }
      });
      channel.addEventListener('close', () => {
        if (current() && aliveRef.current && !stoppingRef.current) {
          fail(new Error('The live session ended. Your microphone is off. Reconnect to continue.'));
        }
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIce(peer);
      if (!current()) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error('Missing local SDP offer');
      const created = await api.gptLive.createSession(sdp);
      if (!current()) return;
      if ('error' in created) throw new Error(created.error);
      await peer.setRemoteDescription({ type: 'answer', sdp: created.sdp });
      void api.smith
        .proposalsList()
        .then((proposals) => {
          if (current()) patch({ proposalPending: proposals.some((p) => p.projectId === scopeId) });
        })
        .catch(() => undefined);
    } catch (error) {
      fail(error);
    }
  }, [absorbEvent, failSession, patch, scopeId]);

  const setScreenContext = useCallback((screen: SmithScreenContext) => {
    screenRef.current = screen;
  }, []);

  useEffect(() => teardown, [scopeId, teardown]);

  const toggleMute = useCallback(() => {
    if (!peerRef.current || !readyRef.current) return;
    mutedRef.current = !mutedRef.current;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !mutedRef.current;
    });
    try {
      sendEvent({
        type: mutedRef.current ? 'session.input_audio.mute' : 'session.input_audio.unmute',
      });
      patch({ muted: mutedRef.current });
    } catch (error) {
      failSession(error);
    }
  }, [failSession, patch, sendEvent]);

  const readLevel = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(samplesRef.current);
    const energy = samplesRef.current.reduce((sum, value) => sum + value * value, 0);
    return Math.min(1, Math.sqrt(energy / samplesRef.current.length) * 4);
  }, []);

  return { state, start, stop: teardown, toggleMute, readLevel, setScreenContext };
}
