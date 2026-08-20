/**
 * Paired devices and their tokens. The token itself is returned exactly once,
 * at the pair exchange; the desktop stores only its sha-256, so a copied
 * `companion.json` cannot impersonate a phone. Unpair deletes the row, which
 * is what revokes the token — there is no disabled state to resurrect.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { CompanionDevice } from '@shared/companion.js';
import { JsonStore } from '../store/json-store.js';

interface DeviceRecord {
  deviceId: string;
  name: string;
  tokenHash: string;
  pairedAt: string;
  lastSeenAt: string | null;
}

interface CompanionFile {
  /** Stable id of this desktop install, minted on first use. */
  desktopId: string;
  /**
   * The port the host last bound successfully. Reused on the next start so a
   * phone's stored `hostOrigin` survives a relaunch instead of 404ing forever.
   */
  lastPort: number | null;
  devices: DeviceRecord[];
}

/**
 * How stale a device's `lastSeenAt` may get before a request rewrites it. The
 * phone polls every couple of seconds; without this, every poll rewrote
 * `companion.json`. The stamp is operator-facing ("last seen"), not a session
 * clock, so half a minute of drift costs nothing.
 */
export const LAST_SEEN_DEBOUNCE_MS = 30_000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function emptyFile(): CompanionFile {
  return { desktopId: '', lastPort: null, devices: [] };
}

/** A port we would be willing to bind: a real, non-privileged TCP port. */
function validPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 1023 && value <= 65535
    ? value
    : null;
}

function migrate(raw: unknown): CompanionFile {
  const base = emptyFile();
  if (!raw || typeof raw !== 'object') return base;
  const file = raw as Partial<CompanionFile>;
  const devices = Array.isArray(file.devices)
    ? file.devices.filter(
        (d): d is DeviceRecord =>
          !!d &&
          typeof d.deviceId === 'string' &&
          typeof d.name === 'string' &&
          typeof d.tokenHash === 'string',
      )
    : [];
  return {
    desktopId: typeof file.desktopId === 'string' ? file.desktopId : '',
    lastPort: validPort(file.lastPort),
    devices: devices.map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      tokenHash: d.tokenHash,
      pairedAt: typeof d.pairedAt === 'string' ? d.pairedAt : new Date(0).toISOString(),
      lastSeenAt: typeof d.lastSeenAt === 'string' ? d.lastSeenAt : null,
    })),
  };
}

export class DeviceStore {
  private readonly store: JsonStore<CompanionFile>;

  constructor(
    appSupportDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new JsonStore<CompanionFile>(
      join(appSupportDir, 'companion.json'),
      emptyFile,
      migrate,
    );
  }

  /** This install's stable identity, minted the first time anything asks. */
  desktopId(): string {
    const file = this.store.read();
    if (file.desktopId) return file.desktopId;
    const minted = `desk_${randomBytes(8).toString('hex')}`;
    this.store.write({ ...file, desktopId: minted });
    return minted;
  }

  /** The port the host last bound, or null if it has never bound one. */
  lastPort(): number | null {
    return this.store.read().lastPort;
  }

  /** Records the port the host just bound, so the next start can reuse it. */
  rememberPort(port: number): void {
    const valid = validPort(port);
    if (valid === null || valid === this.lastPort()) return;
    this.store.update((file) => ({ ...file, lastPort: valid }));
  }

  /** Registers a phone and mints its token. The token is only returned here. */
  register(deviceName: string): { deviceId: string; token: string } {
    const token = randomBytes(32).toString('base64url');
    const deviceId = `dev_${randomBytes(8).toString('hex')}`;
    const record: DeviceRecord = {
      deviceId,
      name: deviceName.trim().slice(0, 80) || 'Companion',
      tokenHash: hashToken(token),
      pairedAt: new Date().toISOString(),
      lastSeenAt: null,
    };
    this.store.update((file) => ({ ...file, devices: [...file.devices, record] }));
    return { deviceId, token };
  }

  /**
   * The device a bearer token belongs to, or null — which every caller must
   * treat as a refusal. Constant-time hash comparison every request; the
   * last-seen stamp is debounced so a 2s poll does not rewrite the file on
   * every hit.
   */
  authenticate(token: string): CompanionDevice | null {
    if (!token) return null;
    const candidate = Buffer.from(hashToken(token), 'hex');
    const file = this.store.read();
    const match = file.devices.find((d) => {
      const stored = Buffer.from(d.tokenHash, 'hex');
      return stored.length === candidate.length && timingSafeEqual(stored, candidate);
    });
    if (!match) return null;
    const now = this.now();
    const previous = match.lastSeenAt ? Date.parse(match.lastSeenAt) : NaN;
    if (!Number.isFinite(previous) || now - previous >= LAST_SEEN_DEBOUNCE_MS) {
      match.lastSeenAt = new Date(now).toISOString();
      this.store.write(file);
    }
    return this.project(match);
  }

  /** Deletes the device row, which is what invalidates its token. */
  unpair(deviceId: string): boolean {
    let removed = false;
    this.store.update((file) => {
      const devices = file.devices.filter((d) => d.deviceId !== deviceId);
      removed = devices.length !== file.devices.length;
      return { ...file, devices };
    });
    return removed;
  }

  list(): CompanionDevice[] {
    return this.store.read().devices.map((d) => this.project(d));
  }

  private project(record: DeviceRecord): CompanionDevice {
    return {
      deviceId: record.deviceId,
      name: record.name,
      pairedAt: record.pairedAt,
      lastSeenAt: record.lastSeenAt,
    };
  }
}
