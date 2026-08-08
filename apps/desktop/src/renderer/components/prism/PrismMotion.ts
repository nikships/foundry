/**
 * PrismMotion — port of OrbMotion (black-glass-orb-app) to TypeScript.
 * Seeded, asymmetric envelopes, queued direction flips. No DOM imports.
 */

// FNV-1a 32-bit, matches Swift's hashSeed.
function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class PrismMotion {
  readonly phase: number;
  readonly timeOffset: number;
  spin = 0;
  spinVelocity = 0;
  spinDirection: 1 | -1 = 1;
  audioSmooth = 0;
  audioFast = 0;
  private prevAudio = 0;
  private flipQueued = false;
  private oscillatorSign: 1 | -1 | 0 = 1;
  private lastTime: number | null = null;

  constructor(seed: string) {
    const h = fnv1a32(seed);
    this.phase = (h % 100000) / 100000;
    this.timeOffset = ((h >>> 8) % 20000) / 1000;
  }

  update(time: number, audio: number): void {
    const dt = this.lastTime != null ? Math.min(0.1, Math.max(0, time - this.lastTime)) : 0;
    this.lastTime = time;
    const level = Math.min(1, Math.max(0, audio));

    const smoothResp = level > this.audioSmooth ? 0.11 : 0.3;
    const smoothK = dt > 0 ? 1 - Math.exp(-dt / smoothResp) : 0;
    this.audioSmooth += (level - this.audioSmooth) * smoothK;

    const fastResp = level > this.audioFast ? 0.04 : 0.18;
    const fastK = dt > 0 ? 1 - Math.exp(-dt / fastResp) : 0;
    this.audioFast += (level - this.audioFast) * fastK;

    const variance = (6.31 * this.phase) % 1;
    const osc = Math.sin(time * (0.45 + 0.2 * variance) + this.phase);
    const sign = osc > 0 ? 1 : osc < 0 ? -1 : 0;
    if (sign !== this.oscillatorSign) {
      this.oscillatorSign = sign as 1 | -1 | 0;
      this.flipQueued = true;
    }
    if (this.flipQueued && this.audioFast < 0.08) {
      this.spinDirection *= -1;
      this.flipQueued = false;
    }

    const base = 0.18 + 0.22 * Math.abs(Math.sin(time * 0.09 + this.phase));
    const targetVel = this.spinDirection * (base + 1.2 * this.audioSmooth);
    const velK = dt > 0 ? 1 - Math.exp(-dt / 0.35) : 0;
    this.spinVelocity += (targetVel - this.spinVelocity) * velK;

    const attack = Math.max(0, this.audioFast - this.prevAudio);
    this.prevAudio = this.audioFast;
    this.spinVelocity += this.spinDirection * Math.min(6 * attack, 1.4) * dt * 14;

    this.spin += this.spinVelocity * dt;
  }
}
