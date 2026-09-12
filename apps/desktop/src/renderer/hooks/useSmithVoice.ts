/**
 * Smith's live voice session: one bidirectional Gemini Live connection, its
 * mic and speaker plumbing, and the bounded tool dispatch that keeps one
 * spoken identity over the same Smith chat.
 *
 * The voice model (`gemini-3.1-flash-live-preview`, thinking level `high`)
 * speaks and listens. When the operator asks for real work it calls
 * `smith_work`, which routes the text into the same `SmithChatSession`
 * the Smith UI drives — the model chosen in the Smith header does the work,
 * and the transcript stays one conversation. The tool returns immediately
 * (Live API function calling is synchronous, a Smith turn is not); the
 * settled answer arrives later over `smith-progress`, gets folded into a
 * short text, and is injected back into the live session so the voice model
 * can narrate it.
 *
 * All state is refs inside one `useRef` bundle plus `useState` only for what
 * the overlay renders, so reconnects and view changes never remount the
 * session.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SmithChatState, SmithScreenContext } from '@shared/ipc-contract.js';
import type { SmithProposalAnswer } from '@shared/types.js';
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
  EMPTY_SETTLE_WATCH,
  foldSettleWatch,
  friendlyVoiceError,
  proposalSummary,
  settledAnswerText,
  settledWorkPrompt,
  VOICE_TOOL_NAMES,
  voiceToolDeclarations,
  workStartedResult,
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
    }[];
  }) => void;
  close: () => void;
};

type ToolResult = { output?: Record<string, unknown>; error?: string };

const MAX_TRANSCRIPT_CHARS = 200;

function errorMessage(e: unknown): string {
  return friendlyVoiceError(e);
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
  const readProposalRef = useRef<string | null>(null);
  const timeoutRef = useRef<number | undefined>(undefined);

  const patch = useCallback((next: Partial<SmithVoiceState>) => {
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  const teardown = useCallback((): void => {
    generationRef.current++;
    window.clearTimeout(timeoutRef.current);
    aliveRef.current = false;
    mutedRef.current = false;
    readProposalRef.current = null;
    settleWatchRef.current = EMPTY_SETTLE_WATCH;
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
    async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
      const generation = generationRef.current;
      const current = (): boolean => generation === generationRef.current;
      if (name === VOICE_TOOL_NAMES.work) {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) return { error: 'There is no work request to start.' };
        if (settleWatchRef.current.delegated || settleWatchRef.current.running)
          return { error: 'I am already working. Wait or cancel first.' };
        settleWatchRef.current = { delegated: true, running: true };
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
        patch({ smithRunning: settleWatchRef.current.running });
        return { output: workStartedResult() };
      }
      if (name === VOICE_TOOL_NAMES.cancel) {
        settleWatchRef.current = EMPTY_SETTLE_WATCH;
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
   * Folds a tool call's function calls through the dispatch table and answers
   * each with its matching id, as the Live API's synchronous calling requires.
   */
  const answerToolCalls = useCallback(
    (functionCalls: { id?: string; name?: string; args?: Record<string, unknown> }[]): void => {
      for (const call of functionCalls) {
        const session = sessionRef.current;
        const generation = generationRef.current;
        void (async () => {
          const result: ToolResult =
            call.name != null
              ? await dispatchTool(call.name, call.args ?? {}).catch((error: unknown) => ({
                  error: errorMessage(error),
                }))
              : { error: 'no tool name' };
          if (generation !== generationRef.current) return;
          session?.sendToolResponse({
            functionResponses: [
              {
                ...(call.id != null ? { id: call.id } : {}),
                ...(call.name != null ? { name: call.name } : {}),
                ...(result.error != null
                  ? { response: { error: result.error } }
                  : { response: result.output ?? {} }),
              },
            ],
          });
        })().catch((error: unknown) => {
          if (generation === generationRef.current) failSession(error);
        });
      }
    },
    [dispatchTool, failSession],
  );

  /** One server message: audio out, transcriptions, interruptions, tool calls. */
  const absorb = useCallback(
    (message: {
      serverContent?: {
        modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
        inputTranscription?: { text?: string };
        outputTranscription?: { text?: string };
        interrupted?: boolean;
        turnComplete?: boolean;
      };
      toolCall?: {
        functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[];
      };
    }): void => {
      const content = message.serverContent;
      if (content?.interrupted) speakerRef.current?.clear();
      if (content?.modelTurn?.parts) {
        for (const part of content.modelTurn.parts) {
          const data = part.inlineData?.data;
          if (data && !content?.interrupted) speakerRef.current?.play(data);
        }
      }
      if (content?.inputTranscription?.text) {
        if (transcriptRef.current.finished) {
          transcriptRef.current = { input: '', output: '', finished: false };
          patch({ outputText: '' });
        }
        transcriptRef.current.input = (
          transcriptRef.current.input + content.inputTranscription.text
        ).slice(-MAX_TRANSCRIPT_CHARS);
        patch({ inputText: transcriptRef.current.input });
      }
      if (content?.outputTranscription?.text) {
        transcriptRef.current.output = (
          transcriptRef.current.output + content.outputTranscription.text
        ).slice(-600);
        patch({ outputText: transcriptRef.current.output });
      }
      if (content?.turnComplete || content?.interrupted) transcriptRef.current.finished = true;
      if (message.toolCall?.functionCalls?.length) {
        answerToolCalls(message.toolCall.functionCalls);
      }
    },
    [answerToolCalls, patch],
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
        try {
          sessionRef.current?.sendRealtimeInput({
            text: settledWorkPrompt(text),
          });
        } catch (error) {
          failSession(error);
        }
      }
    },
    [patch, scopeId, failSession],
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
      const minted = await api.geminiLive.mintToken();
      if (!current()) return;
      if ('error' in minted) throw new Error(minted.error);
      const mic = micCapture();
      const pendingChunks: ArrayBuffer[] = [];
      let setupComplete = false;
      const ready = (): void => {
        const session = sessionRef.current;
        if (!current() || !setupComplete || !session) return;
        window.clearTimeout(timeoutRef.current);
        for (const chunk of pendingChunks.splice(0)) {
          session.sendRealtimeInput({ audio: { data: pcmBase64(chunk), mimeType: INPUT_MIME } });
        }
        patch({ status: 'live' });
      };
      micRef.current = mic;
      await mic.start((chunk) => {
        if (!current() || mutedRef.current) return;
        const session = sessionRef.current;
        try {
          if (session && setupComplete)
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
        if (current()) patch({ speaking });
      });
      const { GoogleGenAI, Modality, ThinkingLevel } = await import('@google/genai');
      if (!current()) return;
      const ai = new GoogleGenAI({
        apiKey: minted.token,
        httpOptions: { apiVersion: 'v1alpha' },
      });
      const session = await ai.live.connect({
        model: minted.model,
        callbacks: {
          onmessage: (message) => {
            if (current()) {
              try {
                if (message.setupComplete) {
                  setupComplete = true;
                  ready();
                }
                absorb(message);
              } catch (error) {
                fail(error);
              }
            }
          },
          onerror: () => {
            fail(new Error('The live connection dropped. Your microphone is off. Try again.'));
          },
          onclose: () => {
            fail(
              new Error('The live session ended. Your microphone is off. Reconnect to continue.'),
            );
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          systemInstruction: minted.systemInstruction,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: { slidingWindow: {} },
          tools: [{ functionDeclarations: voiceToolDeclarations() }],
        },
      });
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
  }, [absorb, patch, failSession, scopeId]);

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
