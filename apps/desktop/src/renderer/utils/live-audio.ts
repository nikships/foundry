/**
 * PCM audio plumbing for the live voice session. Two small classes, no React:
 * capture resamples the mic to the 16 kHz little-endian mono PCM16 the Live
 * API requires, and playback schedules the 24 kHz PCM16 the model returns on
 * the WebAudio clock so chunks join without clicks.
 *
 * The capture worklet lives in `live-worklet.js`, referenced by URL so Vite
 * emits it as a separate file the worklet thread loads same-origin.
 */

/** The Live API's input format: raw PCM, little-endian, 16-bit, mono, 16 kHz. */
export const INPUT_MIME = 'audio/pcm;rate=16000';
/** The Live API's output format: the same but at 24 kHz. */
export const OUTPUT_RATE = 24000;

export interface MicCapture {
  start(onChunk: (pcm: ArrayBuffer) => void): Promise<void>;
  setMuted(muted: boolean): void;
  stop(): void;
}

interface AudioContextWindow extends Window {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

/**
 * One live mic capture. `start` resolves once chunks flow; `stop` releases the
 * mic so the macOS permission indicator goes dark between voice sessions.
 */
export function micCapture(): MicCapture {
  let context: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  let stopped = false;
  let muted = false;

  return {
    async start(onChunk): Promise<void> {
      const win = window as AudioContextWindow;
      const Ctor = win.AudioContext ?? win.webkitAudioContext;
      if (!Ctor) throw new Error('this browser has no WebAudio');
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (stopped) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      context = new Ctor({ sampleRate: 48000 });
      const source = context.createMediaStreamSource(stream);
      // Explicit-URL import: Vite emits the worklet as its own file and
      // rewrites this URL for dev and build alike.
      await context.audioWorklet.addModule(new URL('./live-worklet.js', import.meta.url));
      if (stopped) return;
      node = new AudioWorkletNode(context, 'foundry-pcm-capture');
      node.port.onmessage = (event: MessageEvent<Int16Array>) => {
        if (!muted && !stopped) onChunk(event.data.buffer as ArrayBuffer);
      };
      source.connect(node);
      await context.resume();
    },
    setMuted(value): void {
      muted = value;
      stream?.getAudioTracks().forEach((track) => {
        track.enabled = !value;
      });
    },
    stop(): void {
      stopped = true;
      node?.port.close();
      node?.disconnect();
      node = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      void context?.close().catch(() => undefined);
      context = null;
    },
  };
}

/**
 * One live playback queue. Chunks are decoded onto the WebAudio clock at the
 * moment they arrive, so consecutive chunks schedule back-to-back regardless
 * of when they landed, and `clear` (an interruption) drops everything queued.
 */
export class SpeakerQueue {
  private context: AudioContext | null = null;
  private nextAt = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private analyser: AnalyserNode | null = null;
  private samples = new Float32Array(256);

  constructor(private readonly onSpeaking: (speaking: boolean) => void = () => undefined) {}

  /** Read actual speaker amplitude, rather than the arrival rate of network chunks. */
  level(): number {
    if (!this.analyser || this.sources.size === 0) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    const energy = this.samples.reduce((sum, value) => sum + value * value, 0);
    return Math.min(1, Math.sqrt(energy / this.samples.length) * 4);
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      const win = window as AudioContextWindow;
      const Ctor = win.AudioContext ?? win.webkitAudioContext;
      if (!Ctor) throw new Error('this browser has no WebAudio');
      this.context = new Ctor({ sampleRate: OUTPUT_RATE });
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.connect(this.context.destination);
    }
    return this.context;
  }

  /** Schedules one base64 PCM16 chunk; returns false when it decoded to nothing. */
  play(base64: string): boolean {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const samples = new Float32Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    if (samples.length === 0) return false;
    const context = this.ensureContext();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    const buffer = context.createBuffer(1, samples.length, OUTPUT_RATE);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser!);
    this.sources.add(source);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
      if (this.sources.size === 0) this.onSpeaking(false);
    };
    const now = context.currentTime;
    this.nextAt = Math.max(this.nextAt, now);
    source.start(this.nextAt);
    this.nextAt += buffer.duration;
    this.onSpeaking(true);
    return true;
  }

  /** An interruption: stop and drop everything queued. */
  clear(): void {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.nextAt = 0;
    this.onSpeaking(false);
  }

  close(): void {
    this.clear();
    const context = this.context;
    this.context = null;
    this.analyser = null;
    void context?.close().catch(() => undefined);
  }
}

/** Base64 of one PCM chunk, the wire format `sendRealtimeInput` expects. */
export function pcmBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
