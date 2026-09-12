import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { micCapture, pcmBase64, SpeakerQueue } from '../../src/renderer/utils/live-audio.js';

afterEach(() => vi.unstubAllGlobals());

function audioHarness() {
  const sources: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  }[] = [];
  const copied: Float32Array[] = [];
  const context = {
    currentTime: 7,
    state: 'running',
    destination: {},
    close: vi.fn(async () => undefined),
    createAnalyser: () => ({
      connect: vi.fn(),
      getFloatTimeDomainData: (out: Float32Array) => out.fill(0.125),
    }),
    createBuffer: (_channels: number, count: number, rate: number) => ({
      duration: count / rate,
      copyToChannel: (samples: Float32Array) => copied.push(samples),
    }),
    createBufferSource: () => {
      const source = {
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        onended: null as (() => void) | null,
      };
      sources.push(source);
      return source;
    },
  };
  vi.stubGlobal('window', {
    AudioContext: class {
      constructor() {
        return context;
      }
    },
  });
  return { context, sources, copied };
}

describe('live speaker audio', () => {
  it('decodes signed little-endian PCM and schedules chunks on the audio clock', () => {
    const { sources, copied } = audioHarness();
    const speaking = vi.fn();
    const queue = new SpeakerQueue(speaking);
    queue.play('AIAAQP9/'); // -32768, 16384, 32767 — asymmetric signed samples.
    queue.play('AAA=');
    expect([...copied[0]]).toEqual([-1, 0.5, 32767 / 32768]);
    expect(sources[0].start).toHaveBeenCalledWith(7);
    expect(sources[1].start).toHaveBeenCalledWith(7 + 3 / 24000);
    expect(queue.level()).toBe(0.5);
    sources[0].onended?.();
    expect(speaking).not.toHaveBeenCalledWith(false);
    sources[1].onended?.();
    expect(speaking).toHaveBeenLastCalledWith(false);
    expect(queue.level()).toBe(0);
  });

  it('interrupts all scheduled sources and restarts at the current clock, not the old queue tail', () => {
    const { context, sources } = audioHarness();
    const speaking = vi.fn();
    const queue = new SpeakerQueue(speaking);
    queue.play(pcmBase64(new ArrayBuffer(48000)));
    queue.play(pcmBase64(new ArrayBuffer(48000)));
    queue.clear();
    for (const source of sources) {
      expect(source.stop).toHaveBeenCalledOnce();
      expect(source.disconnect).toHaveBeenCalledOnce();
      expect(source.onended).toBeNull();
    }
    expect(speaking).toHaveBeenLastCalledWith(false);
    context.currentTime = 7.2;
    queue.play('AAA=');
    expect(sources[2].start).toHaveBeenCalledWith(7.2);
    queue.close();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('round-trips byte buffers across the base64 chunk boundary', () => {
    const bytes = Uint8Array.from({ length: 32773 }, (_, i) => i % 251);
    expect(Buffer.from(pcmBase64(bytes.buffer), 'base64')).toEqual(Buffer.from(bytes));
  });
});

describe('live microphone', () => {
  it('releases a permission grant that arrives after the session was stopped', async () => {
    let grant!: (stream: unknown) => void;
    const stop = vi.fn();
    const ctor = vi.fn();
    vi.stubGlobal('window', { AudioContext: ctor });
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      },
    });
    const mic = micCapture();
    const starting = mic.start(vi.fn());
    mic.stop();
    grant({ getTracks: () => [{ stop }] });
    await starting;
    expect(stop).toHaveBeenCalledOnce();
    expect(ctor).not.toHaveBeenCalled();
  });

  it('preserves 48→16 kHz sample counts across render quanta without zero glitches', () => {
    let Processor!: new () => { process: (inputs: Float32Array[][]) => boolean };
    const chunks: Int16Array[] = [];
    runInNewContext(
      readFileSync(new URL('../../src/renderer/utils/live-worklet.js', import.meta.url), 'utf8'),
      {
        AudioWorkletProcessor: class {
          port = { postMessage: (chunk: Int16Array) => chunks.push(chunk) };
        },
        registerProcessor: (_name: string, ctor: typeof Processor) => {
          Processor = ctor;
        },
      },
    );
    const processor = new Processor();
    // 48 blocks × 128 frames = 6144 input frames = exactly 2048 output samples.
    for (let i = 0; i < 48; i++)
      processor.process([[new Float32Array(128).fill(i < 24 ? 0.5 : -0.25)]]);
    expect(chunks).toHaveLength(2);
    expect([...chunks[0]]).toEqual(Array(1024).fill(16383));
    expect([...chunks[1]]).toEqual(Array(1024).fill(-8191));
  });
});
