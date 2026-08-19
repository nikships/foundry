/**
 * Short-lived pairing secrets: what the QR proves. Each secret is single-use
 * and expires on a clock, so a photographed QR goes stale on its own and a
 * replayed exchange finds the secret already spent. Deliberately in-memory —
 * a secret that survives an app restart is a secret nothing is displaying.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Long enough to open the phone camera and scan; short enough to go stale. */
export const PAIRING_SECRET_TTL_MS = 5 * 60_000;

interface PendingSecret {
  secret: string;
  expiresAtMs: number;
}

export class PairingSecrets {
  private pending: PendingSecret[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Mints a fresh secret. Prior unexpired secrets stay valid until used. */
  issue(): { secret: string; expiresAt: string } {
    this.sweep();
    const secret = randomBytes(24).toString('base64url');
    const expiresAtMs = this.now() + PAIRING_SECRET_TTL_MS;
    this.pending.push({ secret, expiresAtMs });
    return { secret, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /** Spends a secret. False for unknown, expired, or already-used. */
  redeem(secret: string): boolean {
    this.sweep();
    const candidate = Buffer.from(secret);
    const index = this.pending.findIndex((entry) => {
      const stored = Buffer.from(entry.secret);
      return stored.length === candidate.length && timingSafeEqual(stored, candidate);
    });
    if (index === -1) return false;
    this.pending.splice(index, 1);
    return true;
  }

  /** Drops every outstanding secret; stopping the host revokes its QR. */
  clear(): void {
    this.pending = [];
  }

  private sweep(): void {
    const now = this.now();
    this.pending = this.pending.filter((entry) => entry.expiresAtMs > now);
  }
}
