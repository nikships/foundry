/**
 * The mic-capture AudioWorklet for Smith's live voice session: resamples the
 * mic to the 16 kHz little-endian mono PCM16 the Live API requires.
 *
 * This ships as its own file (loaded by URL from `live-audio.ts`) rather than
 * a Blob URL because the sandboxed file:// renderer cannot fetch blob: URLs
 * at all — not for worklets, not even with `fetch` — so a Blob-built module
 * fails with "Unable to load a worklet's module". A same-origin file loads
 * under the existing `script-src 'self'` policy with no CSP change.
 */

/* global AudioWorkletProcessor, registerProcessor */

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
