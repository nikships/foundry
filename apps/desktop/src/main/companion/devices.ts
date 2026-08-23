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
  /** Whether the operator left the LAN host on for the next app launch. */
  enabled: boolean;
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

/** Constant-time comparison of a stored hex hash against a candidate digest. */
function tokenMatches(storedHex: string, candidate: Buffer): boolean {
  const stored = Buffer.from(storedHex, 'hex');
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

/** True while the stamp is fresh enough that a poll need not rewrite the file. */
function isSeenRecently(lastSeenAt: string | null, now: number): boolean {
  const previous = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  return Number.isFinite(previous) && now - previous < LAST_SEEN_DEBOUNCE_MS;
}

function emptyFile(): CompanionFile {
  return { desktopId: '', enabled: false, lastPort: null, devices: [] };
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
    enabled: file.enabled === true,
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

  /** Whether the host should be restored after the desktop app relaunches. */
  enabled(): boolean {
    return this.store.read().enabled;
  }

  /** Records the operator's on/off choice independently of the current bind. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled()) return;
    this.store.update((file) => ({ ...file, enabled }));
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
    const match = file.devices.find((d) => tokenMatches(d.tokenHash, candidate));
    if (!match) return null;
    const now = this.now();
    if (isSeenRecently(match.lastSeenAt, now)) return this.project(match);

    const stamped: DeviceRecord = { ...match, lastSeenAt: new Date(now).toISOString() };
    this.store.write({
      ...file,
      devices: file.devices.map((d) => (d === match ? stamped : d)),
    });
    return this.project(stamped);
  }

  /** Deletes the device row, which is what invalidates its token. */
  unpair(deviceId: string): boolean {
    const file = this.store.read();
    const devices = file.devices.filter((d) => d.deviceId !== deviceId);
    if (devices.length === file.devices.length) return false;
    this.store.write({ ...file, devices });
    return true;
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
