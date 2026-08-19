/**
 * The companion protocol: what a paired phone may ask this desktop and what it
 * hears back. The Android app is a client of exactly this contract, so this
 * file is types and constants only — no Node, no Electron, no main-process
 * imports — and every route reuses the same rows the renderer reads
 * (`RunRow`, `RunDetail`, `EventPage`), so a phone and the desktop window can
 * never disagree about what a run looks like.
 */

import type {
  GhStatus,
  InterruptAnswer,
  PendingInterrupt,
  RunRow,
  StartRunInput,
  ValidationIssue,
} from './types.js';
import type { EventPage, PrAction, RunDetail } from './ipc-contract.js';

/**
 * Bumped whenever a route, payload, or auth rule changes shape. The QR carries
 * it so a phone knows before pairing, and the pair exchange enforces it so a
 * stale client gets a readable refusal instead of a half-working session.
 */
export const COMPANION_PROTOCOL_VERSION = 1;

/**
 * What the desktop encodes in the pairing QR (FOU-85 renders it). Everything a
 * phone needs to find the host and prove it saw this screen: the LAN origin,
 * who the desktop is, and a short-lived single-use secret.
 */
export interface CompanionPairingPayload {
  protocolVersion: number;
  /** The LAN origin the phone should call, e.g. `http://192.168.1.20:52810`. */
  origin: string;
  /** Stable id of this desktop install, so a re-pair recognises the same Mac. */
  desktopId: string;
  /** The human name the phone shows: "Paired with ⟨desktopName⟩". */
  desktopName: string;
  /** Short-lived, single-use secret exchanged for a device token via `POST /pair`. */
  secret: string;
  /** ISO timestamp after which the secret is refused. */
  expiresAt: string;
}

/** The body of `POST /pair`: the scanned secret traded for a device token. */
export interface CompanionPairRequest {
  protocolVersion: number;
  secret: string;
  /** The phone's own name, shown in the desktop's paired-devices list. */
  deviceName: string;
}

/** The answer to a successful pair. The token appears here and never again. */
export interface CompanionPairResult {
  /** Long-lived bearer token for every authenticated route. Stored hashed on the desktop. */
  token: string;
  deviceId: string;
  desktopId: string;
  desktopName: string;
  protocolVersion: number;
}

/** One paired phone as the desktop lists it. Never carries the token. */
export interface CompanionDevice {
  deviceId: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
}

export type CompanionErrorCode =
  | 'unauthorized'
  | 'protocol_mismatch'
  | 'pairing_invalid'
  | 'bad_request'
  | 'not_found'
  | 'internal';

/** Every non-2xx answer carries this shape, with a message a human can read. */
export interface CompanionError {
  error: { code: CompanionErrorCode; message: string };
}

/** A project as the phone sees it: enough to list runs and compose a new one. */
export interface CompanionProjectSummary {
  id: string;
  name: string;
  pipelines: { id: string; name: string; description: string }[];
}

/** Who answered: rendered in the phone's Connection sheet fine print. */
export interface CompanionSessionInfo {
  desktopId: string;
  desktopName: string;
  protocolVersion: number;
  appVersion: string;
}

export interface CompanionStartResult {
  ok: boolean;
  runId?: string;
  issues: ValidationIssue[];
}

export interface CompanionKillResult {
  ok: boolean;
}

export interface CompanionAnswerResult {
  ok: boolean;
}

/** The body of the PR-create route; the desktop drafts when either is empty. */
export interface CompanionPrCreateRequest {
  title: string;
  body: string;
}

/**
 * The authenticated HTTP surface, route → shapes. Every route below `POST
 * /pair` requires `Authorization: Bearer <token>` and answers `CompanionError`
 * (401) for a missing, unknown, or revoked token — fail closed, every route.
 *
 * Live updates are the same authenticated cursor poll the renderer runs:
 * `events?after=<changeId>` walks `EventRow.changeId` exactly like
 * `runs:events` over IPC, so updated rows re-serve rather than only new ones.
 */
export interface CompanionRoutes {
  'POST /pair': { request: CompanionPairRequest; response: CompanionPairResult };
  'GET /v1/session': { response: CompanionSessionInfo };
  'GET /v1/projects': { response: CompanionProjectSummary[] };
  'GET /v1/projects/:projectId/runs': { response: RunRow[] };
  'GET /v1/projects/:projectId/runs/:runId': { response: RunDetail };
  'GET /v1/projects/:projectId/runs/:runId/events': { response: EventPage };
  'POST /v1/runs': { request: StartRunInput; response: CompanionStartResult };
  'POST /v1/projects/:projectId/runs/:runId/kill': { response: CompanionKillResult };
  'GET /v1/interrupts': { response: PendingInterrupt[] };
  'POST /v1/interrupts/answer': { request: InterruptAnswer; response: CompanionAnswerResult };
  'GET /v1/projects/:projectId/pr-status': { response: GhStatus };
  'POST /v1/projects/:projectId/runs/:runId/pr': {
    request: CompanionPrCreateRequest;
    response: PrAction;
  };
}

/**
 * Desktop-side host state: what Settings renders next to the toggle. The
 * pairing secret is deliberately absent — it exists only inside a
 * `CompanionPairingPayload` handed to the QR flow.
 */
export interface CompanionHostState {
  running: boolean;
  /** The origin the host is serving on, null while stopped. */
  origin: string | null;
  protocolVersion: number;
  devices: CompanionDevice[];
  /** Why the host is not running (or refused to start), when it is not. */
  detail?: string;
}
