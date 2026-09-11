/**
 * Smith's live voice session: one bidirectional Gemini Live connection, its
 * mic and speaker plumbing, and the bounded tool dispatch that makes voice a
 * layer over the real Smith chat rather than a second brain.
 *
 * The voice model (`gemini-3.1-flash-live-preview`, thinking level `high`)
 * speaks and listens. When the operator asks for real work it calls
 * `smith_delegate`, which routes the text into the same `SmithChatSession`
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
  VOICE_TOOL_NAMES,
  voiceToolDeclarations,
} from '../view-models/smith-voice-view.js';

export type VoiceStatus = 'idle' | 'connecting' | 'live' | 'error';

export interface SmithVoiceState {
  status: VoiceStatus;
  /** One-line human sentence for the error state; never a raw exception. */
  error: string | null;
  /** Live transcription of what the operator said, for the overlay. */
  inputText: string;
  /** A delegated Smith turn is running. */
  smithRunning: boolean;
  /** A proposal card is waiting; the voice layer can read and answer it. */
  proposalPending: boolean;
}

type Session = {
  sendRealtimeInput: (params: {
    audio?: { data: string; mimeType: string };
    text?: string;
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
  setScreenContext: (screen: SmithScreenContext) => void;
} {
  const { smithProjectId } = useApp();
  const scopeId = smithProjectId ?? undefined;

  const [state, setState] = useState<SmithVoiceState>({
    status: 'idle',
    error: null,
    inputText: '',
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

  const patch = useCallback((next: Partial<SmithVoiceState>) => {
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  /** The tool dispatch table; bounded to the four declared operations. */
  const dispatchTool = useCallback(
    async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
      if (name === VOICE_TOOL_NAMES.delegate) {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) return { error: 'nothing to delegate' };
        const result = await api.smith.send(scopeId, text, screenRef.current ?? { route: 'runs' });
        settleWatchRef.current = { delegated: true, running: true };
        patch({ smithRunning: true });
        return {
          output: {
            started: true,
            detail:
              result != null
                ? 'Delegated to the Smith chat. I will summarize the result when it settles.'
                : 'This scope has no Smith chat session.',
          },
        };
      }
      if (name === VOICE_TOOL_NAMES.cancel) {
        await api.smith.cancel(scopeId);
        settleWatchRef.current = EMPTY_SETTLE_WATCH;
        patch({ smithRunning: false });
        return { output: { cancelled: true } };
      }
      if (name === VOICE_TOOL_NAMES.proposalRead) {
        const proposals = await api.smith.proposalsList();
        return { output: { summary: proposalSummary(proposals), count: proposals.length } };
      }
      if (name === VOICE_TOOL_NAMES.proposalAnswer) {
        const approved = args.approved === true;
        const proposals = await api.smith.proposalsList();
        if (proposals.length === 0) return { error: 'no proposal is waiting' };
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
        void (async () => {
          const result =
            call.name != null
              ? await dispatchTool(call.name, call.args ?? {})
              : { error: 'no tool name' };
          sessionRef.current?.sendToolResponse({
            functionResponses: [
              {
                ...(call.id != null ? { id: call.id } : {}),
                ...(call.name != null ? { name: call.name } : {}),
                ...(result.error != null
                  ? { error: result.error }
                  : { response: result.output ?? {} }),
              },
            ],
          });
        })();
      }
    },
    [dispatchTool],
  );

  /** One server message: audio out, transcriptions, interruptions, tool calls. */
  const absorb = useCallback(
    (message: {
      serverContent?: {
        modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
        inputTranscription?: { text?: string };
        outputTranscription?: { text?: string };
        interrupted?: boolean;
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
          if (data) speakerRef.current?.play(data);
        }
      }
      if (content?.inputTranscription?.text) {
        patch({
          inputText: content.inputTranscription.text.slice(-MAX_TRANSCRIPT_CHARS),
        });
      }
      if (message.toolCall?.functionCalls?.length) {
        answerToolCalls(message.toolCall.functionCalls);
      }
    },
    [answerToolCalls, patch],
  );

  /** One smith-progress push: settle detection plus running/proposal pills. */
  const absorbSmithProgress = useCallback(
    (next: SmithChatState) => {
      if (next.projectId !== scopeId) return;
      const folded = foldSettleWatch(settleWatchRef.current, next);
      settleWatchRef.current = folded.next;
      patch({ smithRunning: next.running });
      if (folded.settled) {
        const text = settledAnswerText(next.transcript);
        if (text) sessionRef.current?.sendRealtimeInput({ text });
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
      void api.smith
        .proposalsList()
        .then((proposals) => patch({ proposalPending: proposals.length > 0 }));
    });
    return () => {
      offProgress();
      offProposals();
    };
  }, [absorbSmithProgress, patch]);

  const teardown = useCallback((): void => {
    aliveRef.current = false;
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
      smithRunning: false,
      proposalPending: false,
    });
  }, []);

  const stop = useCallback((): void => {
    teardown();
  }, [teardown]);

  const start = useCallback(async (): Promise<void> => {
    if (sessionRef.current) return;
    aliveRef.current = true;
    patch({ status: 'connecting', error: null, inputText: '' });
    try {
      const minted = await api.geminiLive.mintToken();
      if ('error' in minted) throw new Error(minted.error);
      const mic = micCapture();
      const pendingChunks: ArrayBuffer[] = [];
      micRef.current = mic;
      await mic.start((chunk) => {
        const session = sessionRef.current;
        if (session)
          session.sendRealtimeInput({ audio: { data: pcmBase64(chunk), mimeType: INPUT_MIME } });
        else if (aliveRef.current) pendingChunks.push(chunk);
      });
      speakerRef.current = new SpeakerQueue();
      const { GoogleGenAI, Modality, ThinkingLevel } = await import('@google/genai');
      const ai = new GoogleGenAI({
        apiKey: minted.token,
        httpOptions: { apiVersion: 'v1alpha' },
      });
      const session = await ai.live.connect({
        model: minted.model,
        callbacks: {
          onmessage: (message) => {
            if (aliveRef.current) absorb(message);
          },
          onerror: () => {
            if (aliveRef.current) patch({ status: 'error', error: 'The live connection dropped.' });
          },
          onclose: () => {
            if (aliveRef.current) patch({ status: 'error', error: 'The live session closed.' });
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          systemInstruction: minted.systemInstruction,
          inputAudioTranscription: {},
          tools: [{ functionDeclarations: voiceToolDeclarations() }],
        },
      });
      if (!aliveRef.current) {
        session.close();
        return;
      }
      sessionRef.current = session;
      // Chunks that arrived while the socket was opening are still fresh; the
      // session orders input server-side.
      for (const chunk of pendingChunks.splice(0)) {
        session.sendRealtimeInput({ audio: { data: pcmBase64(chunk), mimeType: INPUT_MIME } });
      }
      patch({ status: 'live' });
      void api.smith
        .proposalsList()
        .then((proposals) => patch({ proposalPending: proposals.length > 0 }));
    } catch (error) {
      teardown();
      patch({ status: 'error', error: errorMessage(error) });
    }
  }, [absorb, patch, teardown]);

  /** The overlay owns what the operator is looking at, pushed per delegation. */
  const setScreenContext = useCallback((screen: SmithScreenContext) => {
    screenRef.current = screen;
  }, []);

  useEffect(() => teardown, [teardown]);

  return { state, start, stop, setScreenContext };
}
