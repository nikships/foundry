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
  /** The secret Settings is currently showing. Refresh replaces it; redeem clears it. */
  private displayed: PendingSecret | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** The in-flight secret Settings is displaying, or null if none is live. */
  current(): { secret: string; expiresAt: string } | null {
    this.sweep();
    if (!this.displayed) return null;
    return this.project(this.displayed);
  }

  /**
   * Mints a fresh secret and marks it as the displayed one. Prior unexpired
   * secrets stay valid until used, so a phone that already scanned the previous
   * QR can still pair after a refresh.
   */
  issue(): { secret: string; expiresAt: string } {
    this.sweep();
    const secret = randomBytes(24).toString('base64url');
    const expiresAtMs = this.now() + PAIRING_SECRET_TTL_MS;
    const entry = { secret, expiresAtMs };
    this.pending.push(entry);
    this.displayed = entry;
    return this.project(entry);
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
    if (this.displayed && this.displayed.secret === secret) this.displayed = null;
    this.pending.splice(index, 1);
    return true;
  }

  /** Drops every outstanding secret; stopping the host revokes its QR. */
  clear(): void {
    this.pending = [];
    this.displayed = null;
  }

  private sweep(): void {
    const now = this.now();
    this.pending = this.pending.filter((entry) => entry.expiresAtMs > now);
    if (this.displayed && this.displayed.expiresAtMs <= now) this.displayed = null;
  }

  private project(entry: PendingSecret): { secret: string; expiresAt: string } {
    return { secret: entry.secret, expiresAt: new Date(entry.expiresAtMs).toISOString() };
  }
}
