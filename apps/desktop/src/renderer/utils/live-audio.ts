/**
 * PCM audio plumbing for the live voice session. Two small classes, no React:
 * capture resamples the mic to the 16 kHz little-endian mono PCM16 the Live
 * API requires, and playback schedules the 24 kHz PCM16 the model returns on
 * the WebAudio clock so chunks join without clicks.
 *
 * The worklet source is built from a Blob URL so no bundler-specific `?worklet`
 * import is needed and the capture code ships inside this module.
 */

const WORKLET_SRC = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(1024);
    this.filled = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;
    // Linear-interpolate 48 kHz → 16 kHz: three input frames per output frame.
    const step = channel.length / 3;
    for (let i = 0; i < step; i++) {
      const at = i * 3;
      const sample = channel[at] * 0.77 + channel[at + 1] * 0.1155 + channel[at + 2] * 0.1155;
      this.buffer[this.filled++] = Math.max(-1, Math.min(1, sample)) * 32767;
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer);
        this.buffer = new Int16Array(1024);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('foundry-pcm-capture', PcmCapture);
`;

/** The Live API's input format: raw PCM, little-endian, 16-bit, mono, 16 kHz. */
export const INPUT_MIME = 'audio/pcm;rate=16000';
/** The Live API's output format: the same but at 24 kHz. */
export const OUTPUT_RATE = 24000;

export interface MicCapture {
  start(onChunk: (pcm: ArrayBuffer) => void): Promise<void>;
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

  return {
    async start(onChunk): Promise<void> {
      const win = window as AudioContextWindow;
      const Ctor = win.AudioContext ?? win.webkitAudioContext;
      if (!Ctor) throw new Error('this browser has no WebAudio');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      context = new Ctor({ sampleRate: 48000 });
      const source = context.createMediaStreamSource(stream);
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      node = new AudioWorkletNode(context, 'foundry-pcm-capture');
      node.port.onmessage = (event: MessageEvent<Int16Array>) => {
        onChunk(event.data.buffer as ArrayBuffer);
      };
      source.connect(node);
    },
    stop(): void {
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

  private ensureContext(): AudioContext {
    if (!this.context) {
      const win = window as AudioContextWindow;
      const Ctor = win.AudioContext ?? win.webkitAudioContext;
      if (!Ctor) throw new Error('this browser has no WebAudio');
      this.context = new Ctor({ sampleRate: OUTPUT_RATE });
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
    source.connect(context.destination);
    const now = context.currentTime;
    this.nextAt = Math.max(this.nextAt, now);
    source.start(this.nextAt);
    this.nextAt += buffer.duration;
    return true;
  }

  /** An interruption: stop and drop everything queued. */
  clear(): void {
    this.nextAt = 0;
  }

  close(): void {
    this.clear();
    const context = this.context;
    this.context = null;
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
