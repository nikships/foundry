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
  devices: DeviceRecord[];
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function migrate(raw: unknown): CompanionFile {
  const base: CompanionFile = { desktopId: '', devices: [] };
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

  constructor(appSupportDir: string) {
    this.store = new JsonStore<CompanionFile>(
      join(appSupportDir, 'companion.json'),
      () => ({ desktopId: '', devices: [] }),
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
   * treat as a refusal. Constant-time hash comparison, then a last-seen stamp.
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
    match.lastSeenAt = new Date().toISOString();
    this.store.write(file);
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
