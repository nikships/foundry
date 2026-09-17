/**
 * Smith's live voice session: one bidirectional Gemini Live connection, its
 * mic and speaker plumbing, and the bounded tool dispatch that keeps one
 * spoken identity over the same Smith chat.
 *
 * The voice model (`gemini-3.8-live-extended-thinking`, thinking level
 * `high`) speaks and listens with background reasoning. When the operator
 * asks for real work it calls `smith_work`, which routes the text into the
 * same `SmithChatSession` the Smith UI drives — the model chosen in the Smith
 * header does the work, and the transcript stays one conversation. Tools run
 * async-only on this model (`NON_BLOCKING`): a successful `smith_work`
 * response goes back `SILENT` so the model never re-acknowledges the receipt,
 * and the settled answer arrives later over `smith-progress`, gets folded into
 * a short text, and is injected back into the live session so the voice model
 * narrates it. Extended Thinking treats `turnComplete` as the end of a filler
 * utterance, not the end of the interaction — tool calls arrive while
 * `interactionStatus` is `IN_PROGRESS`. A spoken "let me check" that goes
 * `IDLE` with no tool call is recovered by sending `smith_work` from the
 * operator's last utterance, not by injecting a text nudge (that interrupt
 * is what used to kill the pending call). A tool call the server retracts
 * (`toolCallCancellation`, i.e. the operator barged in mid-call) cancels the
 * delegated turn it started. Mic chunks are held while the speaker is playing
 * so the model's own voice cannot barge in between a filler and its tool call.
 * The socket carries session-resumption handles so a dropped connection or a
 * GoAway resumes in place once instead of ending the session. Speaker voice
 * comes from Settings (`smithLiveVoice`); Random is resolved once per session
 * start. Full user-level access (compose prompts, assigned Linear work +
 * status, saved pipeline runs, context refresh, voice-key state) needs no new
 * voice tool: the operator asks aloud, the model calls `smith_work` with the
 * same capability phrasing as the text chips, and the one proposal queue
 * confirms every privileged step. A proposal that needs a secret is never
 * approved by voice — the masked desktop card owns the key.
 *
 * All state is refs inside one `useRef` bundle plus `useState` only for what
 * the overlay renders, so reconnects and view changes never remount the
 * session.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SmithChatState, SmithScreenContext } from '@shared/ipc-contract.js';
import type { SmithProposalAnswer } from '@shared/types.js';
import { DEFAULT_SMITH_LIVE_VOICE, resolveSmithLiveVoice } from '@shared/gemini-live-voices.js';
import type { FunctionResponseScheduling } from '@google/genai';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import {
  INPUT_MIME,
  micCapture,
  pcmBase64,
  SpeakerQueue,
  type MicCapture,
} from '../utils/live-audio.js';
import {
  appendTranscript,
  EMPTY_SETTLE_WATCH,
  foldSettleWatch,
  friendlyVoiceError,
  proposalSummary,
  settledAnswerText,
  settledWorkPrompt,
  shouldRecoverMissedWork,
  voiceInteractionStatus,
  voiceSecretRefusal,
  VOICE_TOOL_NAMES,
  voiceToolDeclarations,
  voiceToolResponseScheduling,
  workDelegated,
  workStartedResult,
  type VoiceTurnWatch,
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

type Session = {
  sendRealtimeInput: (params: {
    audio?: { data: string; mimeType: string };
    text?: string;
    audioStreamEnd?: boolean;
  }) => void;
  sendToolResponse: (params: {
    functionResponses: {
      id?: string;
      name?: string;
      error?: string;
      response?: Record<string, unknown>;
      /** How a NON_BLOCKING response is scheduled; SILENT skips the follow-up utterance. */
      scheduling?: FunctionResponseScheduling;
    }[];
  }) => void;
  close: () => void;
};

type ToolResult = { output?: Record<string, unknown>; error?: string };

const MAX_TRANSCRIPT_CHARS = 200;
/** Full operator utterance kept for a client-side `smith_work` recovery. */
const MAX_OPERATOR_WORK_CHARS = 2000;
/** After IDLE, wait this long for a straggler tool call before recovering. */
const STRAGGLER_TOOL_CALL_MS = 400;
/**
 * If the server never sends `interactionStatus`, wait this long after a
 * filler's `turnComplete` before treating the call as missed. Shorter than
 * this interrupts Extended Thinking while the tool call is still in flight.
 */
const FALLBACK_RECOVERY_MS = 2500;
/** Keep the mic gated this long after the last speaker chunk so a network
 * gap between audio frames cannot leak echo into VAD. */
const PLAYBACK_HOLD_MS = 250;

function errorMessage(e: unknown): string {
  return friendlyVoiceError(e);
}

const FRESH_TURN_WATCH: VoiceTurnWatch = { output: '', sawToolCall: false, armed: true };

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

  // The whole live session lives in refs: none of it participates in render,
  // and the refs keep the session alive across view navigation.
  const sessionRef = useRef<Session | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const speakerRef = useRef<SpeakerQueue | null>(null);
  const screenRef = useRef<SmithScreenContext | null>(null);
  const settleWatchRef = useRef(EMPTY_SETTLE_WATCH);
  const aliveRef = useRef(false);
  const generationRef = useRef(0);
  const mutedRef = useRef(false);
  const transcriptRef = useRef({ input: '', output: '', finished: true });
  const turnRef = useRef<VoiceTurnWatch>({ ...FRESH_TURN_WATCH });
  const readProposalRef = useRef<string | null>(null);
  const timeoutRef = useRef<number | undefined>(undefined);
  const nudgeTimerRef = useRef<number | undefined>(undefined);
  const holdTimerRef = useRef<number | undefined>(undefined);
  /** Drop mic chunks while the speaker is playing so echo cannot barge in. */
  const playbackHoldRef = useRef(false);
  /** Last operator utterance for a client-side smith_work recovery. */
  const operatorWorkRef = useRef('');
  /** Extended Thinking lifecycle; null until the server reports one. */
  const interactionRef = useRef<'in_progress' | 'idle' | null>(null);
  /** Live call id → tool name, kept until the session ends so a late server retraction still resolves. */
  const inflightRef = useRef(new Map<string, string>());
  /** The tool call id that started the current delegated turn, so only its retraction cancels it. */
  const delegatedCallRef = useRef<string | null>(null);
  const resumeHandleRef = useRef<string | null>(null);
  const reconnectingRef = useRef(false);
  /** Consecutive resume attempts that never reached live; reset on each good socket. */
  const reconnectAttemptsRef = useRef(0);
  /** Reconnects in flight, set by `start` so the session callbacks can reach it. */
  const reconnectRef = useRef<((dropMessage: string) => void) | null>(null);

  const patch = useCallback((next: Partial<SmithVoiceState>) => {
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  const teardown = useCallback((): void => {
    generationRef.current++;
    window.clearTimeout(timeoutRef.current);
    window.clearTimeout(nudgeTimerRef.current);
    window.clearTimeout(holdTimerRef.current);
    aliveRef.current = false;
    mutedRef.current = false;
    playbackHoldRef.current = false;
    operatorWorkRef.current = '';
    interactionRef.current = null;
    reconnectingRef.current = false;
    reconnectAttemptsRef.current = 0;
    reconnectRef.current = null;
    resumeHandleRef.current = null;
    readProposalRef.current = null;
    settleWatchRef.current = EMPTY_SETTLE_WATCH;
    inflightRef.current.clear();
    delegatedCallRef.current = null;
    turnRef.current = { ...FRESH_TURN_WATCH };
    micRef.current?.stop();
    micRef.current = null;
    speakerRef.current?.close();
    speakerRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
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

  /** The tool dispatch table; bounded to the four declared operations. */
  const dispatchTool = useCallback(
    async (name: string, args: Record<string, unknown>, callId?: string): Promise<ToolResult> => {
      const generation = generationRef.current;
      const current = (): boolean => generation === generationRef.current;
      if (name === VOICE_TOOL_NAMES.work) {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) return { error: 'There is no work request to start.' };
        if (settleWatchRef.current.delegated || settleWatchRef.current.running)
          return { error: 'I am already working. Wait or cancel first.' };
        // Arm before send so no settle edge can slip past; a quiet snapshot
        // before the turn registers leaves the pending watch alone.
        settleWatchRef.current = { delegated: true, running: false };
        const result = await api.smith
          .send(scopeId, text, screenRef.current ?? { route: 'runs' })
          .catch((error: unknown) => {
            if (current()) settleWatchRef.current = EMPTY_SETTLE_WATCH;
            throw error;
          });
        if (!current()) return { error: 'Voice session ended.' };
        if (result == null) {
          settleWatchRef.current = EMPTY_SETTLE_WATCH;
          return { error: 'I cannot start work in this scope.' };
        }
        if (!workDelegated(result, text)) {
          // The send was refused because the text chat is mid-turn — the IPC
          // answered with the other turn's snapshot. Never claim work started.
          settleWatchRef.current = EMPTY_SETTLE_WATCH;
          return {
            error:
              'I am already working on something else. Wait for it to finish or ask me to cancel first.',
          };
        }
        if (settleWatchRef.current.delegated)
          settleWatchRef.current = { delegated: true, running: true };
        delegatedCallRef.current = callId ?? null;
        patch({ smithRunning: true });
        return { output: workStartedResult() };
      }
      if (name === VOICE_TOOL_NAMES.cancel) {
        settleWatchRef.current = EMPTY_SETTLE_WATCH;
        delegatedCallRef.current = null;
        await api.smith.cancel(scopeId);
        if (!current()) return { error: 'Voice session ended.' };
        patch({ smithRunning: false });
        return { output: { cancelled: true } };
      }
      if (name === VOICE_TOOL_NAMES.proposalRead) {
        const proposals = (await api.smith.proposalsList()).filter((p) => p.projectId === scopeId);
        if (!current()) return { error: 'Voice session ended.' };
        readProposalRef.current = proposals[0]?.id ?? null;
        return { output: { summary: proposalSummary(proposals), count: proposals.length } };
      }
      if (name === VOICE_TOOL_NAMES.proposalAnswer) {
        if (typeof args.approved !== 'boolean')
          return { error: 'An explicit approval decision is required.' };
        const approved = args.approved === true;
        const proposals = (await api.smith.proposalsList()).filter((p) => p.projectId === scopeId);
        if (!current()) return { error: 'Voice session ended.' };
        if (proposals.length === 0) return { error: 'no proposal is waiting' };
        // Aired secrets would land in transcripts and model context. Voice
        // may reject a key proposal, but approving one must happen in the
        // masked desktop card, which is the only place the value is typed.
        if (approved && proposals[0].type === 'action' && proposals[0].secretRequest) {
          return { error: voiceSecretRefusal() };
        }
        if (proposals[0].id !== readProposalRef.current)
          return {
            error: 'Read the current proposal aloud and ask for confirmation before answering it.',
          };
        readProposalRef.current = null;
        const answer: SmithProposalAnswer = { approved };
        const result = await api.smith.answerProposal(proposals[0].id, answer);
        return result.ok ? { output: { answered: true, approved } } : { error: result.error };
      }
      return { error: `unknown tool: ${name}` };
    },
    [patch, scopeId],
  );

  /**
   * The server retracted calls the operator interrupted. Calls answered
   * already are gone from the model's side; the one retraction that matters is
   * `smith_work` — stop the turn it started so the chat and the model's world
   * stay the same.
   */
  const cancelVoiceToolCalls = useCallback(
    (ids: string[]): void => {
      let retractedWork = false;
      for (const id of ids) {
        if (
          inflightRef.current.get(id) === VOICE_TOOL_NAMES.work &&
          id === delegatedCallRef.current
        )
          retractedWork = true;
        inflightRef.current.delete(id);
      }
      if (retractedWork && settleWatchRef.current.delegated) {
        settleWatchRef.current = EMPTY_SETTLE_WATCH;
        delegatedCallRef.current = null;
        patch({ smithRunning: false });
        void api.smith.cancel(scopeId).catch(() => undefined);
      }
    },
    [patch, scopeId],
  );

  /**
   * Folds a tool call's function calls through the dispatch table and answers
   * each with its matching id, as the Live API's synchronous calling requires.
   */
  const answerToolCalls = useCallback(
    (functionCalls: { id?: string; name?: string; args?: Record<string, unknown> }[]): void => {
      for (const call of functionCalls) {
        const session = sessionRef.current;
        const generation = generationRef.current;
        if (call.id != null && call.name != null) inflightRef.current.set(call.id, call.name);
        void (async () => {
          const result: ToolResult =
            call.name != null
              ? await dispatchTool(call.name, call.args ?? {}, call.id).catch((error: unknown) => ({
                  error: errorMessage(error),
                }))
              : { error: 'no tool name' };
          if (generation !== generationRef.current) return;
          // A response needs the call's id, and it must go out on the session
          // it arrived on — a swapped socket (reconnect) or a stale write must
          // never take the live session down.
          if (session == null || session !== sessionRef.current) return;
          if (call.id == null || call.name == null) return;
          try {
            session.sendToolResponse({
              functionResponses: [
                {
                  id: call.id,
                  name: call.name,
                  scheduling: voiceToolResponseScheduling(call.name, result.error != null),
                  response: result.error != null ? { error: result.error } : (result.output ?? {}),
                },
              ],
            });
          } catch {
            // The socket died between dispatch and answer; the reconnect path
            // already owns the session's fate.
          }
        })().catch((error: unknown) => {
          if (generation === generationRef.current) failSession(error);
        });
      }
    },
    [dispatchTool, failSession],
  );

  /**
   * The model promised a lookup and the interaction is idle with no tool call.
   * Start `smith_work` from the operator's last utterance instead of injecting
   * a text nudge — `sendRealtimeInput` interrupts Extended Thinking and is
   * what used to strand the session on "I'm looking that up" with no query.
   */
  const recoverMissedWork = useCallback((): void => {
    const operatorText = operatorWorkRef.current.trim();
    if (!shouldRecoverMissedWork(turnRef.current, operatorText, settleWatchRef.current.delegated))
      return;
    turnRef.current.armed = false;
    void dispatchTool(VOICE_TOOL_NAMES.work, { text: operatorText }).catch(() => undefined);
  }, [dispatchTool]);

  const scheduleMissedWorkRecovery = useCallback(
    (delayMs: number): void => {
      window.clearTimeout(nudgeTimerRef.current);
      const generation = generationRef.current;
      nudgeTimerRef.current = window.setTimeout(() => {
        if (generation !== generationRef.current || !aliveRef.current) return;
        if (reconnectingRef.current || turnRef.current.sawToolCall) return;
        if (settleWatchRef.current.delegated) return;
        recoverMissedWork();
      }, delayMs);
    },
    [recoverMissedWork],
  );

  const holdMicForPlayback = useCallback((speaking: boolean): void => {
    window.clearTimeout(holdTimerRef.current);
    if (speaking) {
      playbackHoldRef.current = true;
      return;
    }
    holdTimerRef.current = window.setTimeout(() => {
      playbackHoldRef.current = false;
    }, PLAYBACK_HOLD_MS);
  }, []);

  /** One server message: audio out, transcriptions, interruptions, tool calls. */
  const absorb = useCallback(
    (message: {
      serverContent?: {
        modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
        inputTranscription?: { text?: string };
        outputTranscription?: { text?: string };
        interrupted?: boolean;
        turnComplete?: boolean;
        interactionStatus?: string;
        interaction_status?: string;
      };
      toolCall?: {
        functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[];
      };
      toolCallCancellation?: { ids?: string[] };
      sessionResumptionUpdate?: { newHandle?: string };
      goAway?: unknown;
      interactionStatus?: string;
      interaction_status?: string;
    }): void => {
      const content = message.serverContent;
      const status = voiceInteractionStatus(message);
      try {
        if (content?.interrupted) speakerRef.current?.clear();
        if (content?.modelTurn?.parts) {
          for (const part of content.modelTurn.parts) {
            const data = part.inlineData?.data;
            if (data && !content?.interrupted) speakerRef.current?.play(data);
          }
        }
      } catch {
        // One malformed audio chunk is not worth the session it arrived in.
      }
      if (content?.inputTranscription?.text) {
        if (transcriptRef.current.finished) {
          transcriptRef.current = { input: '', output: '', finished: false };
          operatorWorkRef.current = '';
          patch({ outputText: '' });
          // A fresh operator turn earns one more recovery if a promise slips again.
          turnRef.current = { ...FRESH_TURN_WATCH };
        }
        transcriptRef.current.input = appendTranscript(
          transcriptRef.current.input,
          content.inputTranscription.text,
        ).slice(-MAX_TRANSCRIPT_CHARS);
        operatorWorkRef.current = appendTranscript(
          operatorWorkRef.current,
          content.inputTranscription.text,
        ).slice(-MAX_OPERATOR_WORK_CHARS);
        patch({ inputText: transcriptRef.current.input });
      }
      if (content?.outputTranscription?.text) {
        transcriptRef.current.output = appendTranscript(
          transcriptRef.current.output,
          content.outputTranscription.text,
        ).slice(-600);
        turnRef.current.output += content.outputTranscription.text;
        patch({ outputText: transcriptRef.current.output });
      }
      if (message.sessionResumptionUpdate?.newHandle) {
        resumeHandleRef.current = message.sessionResumptionUpdate.newHandle;
      }
      if (message.toolCallCancellation?.ids?.length) {
        cancelVoiceToolCalls(message.toolCallCancellation.ids);
      }
      if (status === 'IN_PROGRESS') {
        // Filler finished; the tool call is still coming. Do not recover yet.
        interactionRef.current = 'in_progress';
        window.clearTimeout(nudgeTimerRef.current);
      }
      if (message.toolCall?.functionCalls?.length) {
        turnRef.current.sawToolCall = true;
        window.clearTimeout(nudgeTimerRef.current);
        answerToolCalls(message.toolCall.functionCalls);
      }
      if (content?.interrupted) {
        transcriptRef.current.finished = true;
        turnRef.current = { ...FRESH_TURN_WATCH, armed: turnRef.current.armed };
        window.clearTimeout(nudgeTimerRef.current);
      }
      if (content?.turnComplete) {
        transcriptRef.current.finished = true;
        // `turnComplete` only ends an utterance. Recover from a missed call
        // only when the server never reported IN_PROGRESS — otherwise wait
        // for IDLE so we do not interrupt a pending tool call.
        if (interactionRef.current !== 'in_progress') {
          scheduleMissedWorkRecovery(FALLBACK_RECOVERY_MS);
        }
      }
      if (status === 'IDLE') {
        interactionRef.current = 'idle';
        scheduleMissedWorkRecovery(STRAGGLER_TOOL_CALL_MS);
      }
      if (message.goAway) {
        // The server is about to close the socket; reconnect before it drops.
        reconnectRef.current?.(
          'The live session ended. Your microphone is off. Reconnect to continue.',
        );
      }
    },
    [answerToolCalls, cancelVoiceToolCalls, patch, scheduleMissedWorkRecovery],
  );

  /** One smith-progress push: settle detection plus running/proposal pills. */
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
        if (reconnectingRef.current || !sessionRef.current) return;
        try {
          sessionRef.current.sendRealtimeInput({
            text: settledWorkPrompt(text),
          });
        } catch {
          // The socket is gone; the answer still landed in Smith chat.
        }
      }
    },
    [patch, scopeId],
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
    transcriptRef.current = { input: '', output: '', finished: true };
    turnRef.current = { ...FRESH_TURN_WATCH };
    operatorWorkRef.current = '';
    interactionRef.current = null;
    playbackHoldRef.current = false;
    resumeHandleRef.current = null;
    reconnectingRef.current = false;
    reconnectAttemptsRef.current = 0;
    inflightRef.current.clear();
    delegatedCallRef.current = null;
    patch({ status: 'connecting', error: null, inputText: '', outputText: '' });
    const fail = (error: unknown): void => {
      if (!current()) return;
      failSession(error);
    };
    timeoutRef.current = window.setTimeout(
      () => fail(new Error('Connecting took too long. Check your network and try again.')),
      30000,
    );
    try {
      const mic = micCapture();
      const pendingChunks: ArrayBuffer[] = [];
      const setup = { complete: false };
      const ready = (): void => {
        const session = sessionRef.current;
        if (!current() || !setup.complete || !session) return;
        window.clearTimeout(timeoutRef.current);
        for (const chunk of pendingChunks.splice(0)) {
          session.sendRealtimeInput({ audio: { data: pcmBase64(chunk), mimeType: INPUT_MIME } });
        }
        reconnectAttemptsRef.current = 0;
        patch({ status: 'live' });
      };
      micRef.current = mic;
      await mic.start((chunk) => {
        if (!current() || mutedRef.current || playbackHoldRef.current) return;
        const session = sessionRef.current;
        try {
          if (session && setup.complete)
            session.sendRealtimeInput({ audio: { data: pcmBase64(chunk), mimeType: INPUT_MIME } });
          else {
            pendingChunks.push(chunk);
            if (pendingChunks.length > 32) pendingChunks.shift();
          }
        } catch (error) {
          fail(error);
        }
      });
      if (!current()) return;
      speakerRef.current = new SpeakerQueue((speaking) => {
        holdMicForPlayback(speaking);
        if (current()) patch({ speaking });
      });
      const settings = await api.settings.get().catch(() => null);
      if (!current()) return;
      // Resolve Random once per start so every utterance in this session shares a voice.
      const voiceName = resolveSmithLiveVoice(settings?.smithLiveVoice ?? DEFAULT_SMITH_LIVE_VOICE);
      const { GoogleGenAI, Modality, StartSensitivity, ThinkingLevel } =
        await import('@google/genai');
      if (!current()) return;

      /**
       * One socket connection — the initial start and every resume share it.
       * Each attempt mints its own single-use token; a resume adds the latest
       * session handle so the conversation continues where it dropped.
       */
      const openSession = async (resumeHandle?: string): Promise<Session> => {
        const minted = await api.geminiLive.mintToken();
        if ('error' in minted) throw new Error(minted.error);
        if (!current()) throw new Error('Voice session ended.');
        const ai = new GoogleGenAI({
          apiKey: minted.token,
          httpOptions: { apiVersion: 'v1alpha' },
        });
        setup.complete = false;
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(
          () => fail(new Error('Connecting took too long. Check your network and try again.')),
          30000,
        );
        // The callbacks below fire on the socket this call opens; `mine` lets
        // them recognize their own session before the awaited value lands.
        const mine: { session: Session | null } = { session: null };
        const session = await ai.live.connect({
          model: minted.model,
          callbacks: {
            onmessage: (message) => {
              if (current()) {
                try {
                  if (message.setupComplete) {
                    setup.complete = true;
                    ready();
                  }
                  absorb(message);
                } catch (error) {
                  fail(error);
                }
              }
            },
            onerror: () => {
              // Only the live session's own death reconnects — a stale or
              // mid-handshake socket's failure stays out of the way.
              if (mine.session != null && sessionRef.current === mine.session) {
                reconnect('The live connection dropped. Your microphone is off. Try again.');
              }
            },
            onclose: () => {
              if (mine.session != null && sessionRef.current === mine.session) {
                reconnect('The live session ended. Your microphone is off. Reconnect to continue.');
              }
            },
          },
          config: {
            responseModalities: [Modality.AUDIO],
            // Extended Thinking: low | medium | high only (minimal unsupported).
            thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName } },
            },
            systemInstruction: minted.systemInstruction,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            contextWindowCompression: { slidingWindow: {} },
            sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
            realtimeInputConfig: {
              automaticActivityDetection: {
                startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
                prefixPaddingMs: 200,
              },
            },
            tools: [{ functionDeclarations: voiceToolDeclarations() }],
          },
        });
        mine.session = session;
        return session;
      };

      /**
       * The socket dropped or is about to: close it, and resume once on a
       * fresh token. The mic and the speaker queue stay open across the swap,
       * so a brief drop reads as a pause, not a disconnect.
       */
      const reconnect = (dropMessage: string): void => {
        if (!current() || reconnectingRef.current) return;
        // A socket that dies before reaching live again only gets a few more
        // tries; after that the drop was real, not a flap.
        if (reconnectAttemptsRef.current >= 3) {
          failSession(new Error(dropMessage));
          return;
        }
        reconnectingRef.current = true;
        reconnectAttemptsRef.current += 1;
        const dead = sessionRef.current;
        sessionRef.current = null;
        dead?.close();
        speakerRef.current?.clear();
        patch({ status: 'connecting', speaking: false });
        void (async () => {
          try {
            const next = await openSession(resumeHandleRef.current ?? undefined);
            if (!current()) {
              next.close();
              return;
            }
            sessionRef.current = next;
            ready();
          } catch {
            if (current()) failSession(new Error(dropMessage));
          } finally {
            reconnectingRef.current = false;
          }
        })();
      };
      reconnectRef.current = reconnect;

      const session = await openSession();
      if (!current()) {
        session.close();
        return;
      }
      sessionRef.current = session;
      ready();
      void api.smith
        .proposalsList()
        .then((proposals) => {
          if (current()) patch({ proposalPending: proposals.some((p) => p.projectId === scopeId) });
        })
        .catch(() => undefined);
    } catch (error) {
      fail(error);
    }
  }, [absorb, holdMicForPlayback, patch, failSession, scopeId]);

  /** The overlay owns what the operator is looking at, pushed per delegation. */
  const setScreenContext = useCallback((screen: SmithScreenContext) => {
    screenRef.current = screen;
  }, []);

  // A voice connection is bound to one Smith scope; never carry its tools into another project.
  useEffect(() => teardown, [scopeId, teardown]);

  const toggleMute = useCallback(() => {
    if (!sessionRef.current) return;
    mutedRef.current = !mutedRef.current;
    micRef.current?.setMuted(mutedRef.current);
    try {
      if (mutedRef.current) sessionRef.current.sendRealtimeInput({ audioStreamEnd: true });
      patch({ muted: mutedRef.current });
    } catch (error) {
      failSession(error);
    }
  }, [patch, failSession]);
  const readLevel = useCallback(() => speakerRef.current?.level() ?? 0, []);

  return { state, start, stop: teardown, toggleMute, readLevel, setScreenContext };
}
