/**
 * Short, generated UI tones. No samples on disk: each cue is a handful of
 * sine/triangle blips through Web Audio, quiet enough to sit under a run
 * without competing with OS notifications.
 */

import type { AgentSoundCue } from '../view-models/agent-sound-cues.js';

interface Tone {
  freq: number;
  duration: number;
  delay?: number;
  type?: OscillatorType;
  gain?: number;
}

const MASTER = 0.22;

const CUES: Record<AgentSoundCue, Tone[]> = {
  'orchestrator-ping': [
    { freq: 880, duration: 0.055, gain: 0.09 },
    { freq: 1320, duration: 0.07, delay: 0.06, gain: 0.07 },
  ],
  'plan-proposed': [
    { freq: 523.25, duration: 0.09, gain: 0.08 },
    { freq: 659.25, duration: 0.1, delay: 0.08, gain: 0.08 },
    { freq: 783.99, duration: 0.16, delay: 0.17, gain: 0.09 },
  ],
  'phase-success': [
    { freq: 587.33, duration: 0.06, gain: 0.07 },
    { freq: 880, duration: 0.09, delay: 0.055, gain: 0.06 },
  ],
  'phase-fail': [
    { freq: 233.08, duration: 0.12, type: 'triangle', gain: 0.08 },
    { freq: 174.61, duration: 0.16, delay: 0.1, type: 'triangle', gain: 0.07 },
  ],
  'run-accepted': [
    { freq: 523.25, duration: 0.1, gain: 0.08 },
    { freq: 659.25, duration: 0.1, delay: 0.09, gain: 0.08 },
    { freq: 783.99, duration: 0.12, delay: 0.18, gain: 0.08 },
    { freq: 1046.5, duration: 0.2, delay: 0.28, gain: 0.09 },
  ],
  'run-rejected': [
    { freq: 392, duration: 0.12, type: 'triangle', gain: 0.08 },
    { freq: 311.13, duration: 0.18, delay: 0.11, type: 'triangle', gain: 0.07 },
  ],
  'run-failed': [
    { freq: 196, duration: 0.16, type: 'triangle', gain: 0.09 },
    { freq: 146.83, duration: 0.22, delay: 0.14, type: 'triangle', gain: 0.08 },
  ],
  'needs-you': [
    { freq: 784, duration: 0.09, gain: 0.09 },
    { freq: 1175, duration: 0.14, delay: 0.12, gain: 0.08 },
  ],
};

const CUE_SPAN: Record<AgentSoundCue, number> = Object.fromEntries(
  (Object.keys(CUES) as AgentSoundCue[]).map((cue) => [cue, cueSpan(CUES[cue])]),
) as Record<AgentSoundCue, number>;

let context: AudioContext | null = null;
let queue: Promise<void> = Promise.resolve();
let queued = 0;

export function unlockAgentSounds(): void {
  const ctx = getContext();
  if (ctx?.state === 'suspended') void ctx.resume();
}

export function playAgentSound(cue: AgentSoundCue): void {
  if (queued > 6) return;
  queued += 1;
  queue = queue
    .then(() => playNow(cue))
    .catch(() => undefined)
    .finally(() => {
      queued -= 1;
    });
}

function playNow(cue: AgentSoundCue): Promise<void> {
  const ctx = getContext();
  if (!ctx) return Promise.resolve();
  if (ctx.state === 'suspended') void ctx.resume();
  const start = ctx.currentTime;
  for (const tone of CUES[cue]) scheduleTone(ctx, start, tone);
  return wait(CUE_SPAN[cue] * 1000 + 40);
}

function scheduleTone(ctx: AudioContext, start: number, tone: Tone): void {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = tone.type ?? 'sine';
  osc.frequency.value = tone.freq;
  const when = start + (tone.delay ?? 0);
  const peak = MASTER * (tone.gain ?? 0.08);
  const attack = 0.008;
  const release = Math.max(0.03, tone.duration * 0.35);
  amp.gain.setValueAtTime(0, when);
  amp.gain.linearRampToValueAtTime(peak, when + attack);
  amp.gain.exponentialRampToValueAtTime(0.0001, when + tone.duration + release);
  osc.connect(amp);
  amp.connect(ctx.destination);
  osc.start(when);
  osc.stop(when + tone.duration + release + 0.01);
}

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctor) return null;
  context ??= new Ctor();
  return context;
}

function cueSpan(tones: Tone[]): number {
  return tones.reduce((span, tone) => Math.max(span, (tone.delay ?? 0) + tone.duration + 0.08), 0);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
