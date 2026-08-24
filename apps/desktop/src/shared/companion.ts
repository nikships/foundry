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
  ModelInfo,
  PendingInterrupt,
  ReasoningEffort,
  RunRow,
  SmithProposal,
  SmithProposalAnswer,
  SmithProposalAnswerResult,
  StartRunInput,
  ValidationIssue,
} from './types.js';
import type {
  EventPage,
  PrAction,
  RunDetail,
  SmithChatState,
  SmithScreenContext,
} from './ipc-contract.js';

/**
 * Bumped whenever a route, payload, or auth rule changes shape. The QR carries
 * it so a phone knows before pairing, and the pair exchange enforces it so a
 * stale client gets a readable refusal instead of a half-working session.
 */
export const COMPANION_PROTOCOL_VERSION = 4;

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

/** Phase summary for pipeline ribbons on the companion app. */
export interface CompanionPhaseSummary {
  id: string;
  name: string;
  kind?: string;
  isFeedbackTarget?: boolean;
  feedbackTo?: string;
}

/** Pipeline summary including phase ribbons. */
export interface CompanionPipelineSummary {
  id: string;
  name: string;
  description: string;
  phases?: CompanionPhaseSummary[];
}

/** A project as the phone sees it: enough to list runs and compose a new one. */
export interface CompanionProjectSummary {
  id: string;
  name: string;
  pipelines: CompanionPipelineSummary[];
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

export interface CompanionContinueResult {
  ok: boolean;
  detail: string;
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
 * Body of `POST /v1/smith/send`. `projectId` omitted (or empty) is the global
 * “All projects” conversation — the same optional scope the desktop IPC uses.
 */
export interface CompanionSmithSendRequest {
  projectId?: string;
  text: string;
  screen?: SmithScreenContext;
}

/** Body of cancel / new-chat / state-scoped writes that only name a chat. */
export interface CompanionSmithScopeRequest {
  projectId?: string;
}

/** Body of `POST /v1/smith/proposals/answer`. */
export interface CompanionSmithProposalAnswerRequest {
  id: string;
  answer: SmithProposalAnswer;
}

/** Body of `POST /v1/smith/model`. `inherit` means “not chosen”. */
export interface CompanionSmithModelRequest {
  projectId?: string;
  model: string;
}

/** Body of `POST /v1/smith/effort`. */
export interface CompanionSmithEffortRequest {
  projectId?: string;
  effort: ReasoningEffort;
}

/**
 * What `createRunPr` would send to GitHub if title/body were left empty.
 * Same formula as the desktop "Open PR…" form (`manualPrDraft`).
 */
export interface CompanionPrDraft {
  title: string;
  body: string;
  source: 'pr-envelope' | 'run';
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
  'POST /v1/projects/:projectId/runs/:runId/continue': { response: CompanionContinueResult };
  'GET /v1/interrupts': { response: PendingInterrupt[] };
  'POST /v1/interrupts/answer': { request: InterruptAnswer; response: CompanionAnswerResult };
  'GET /v1/projects/:projectId/pr-status': { response: GhStatus };
  'GET /v1/projects/:projectId/runs/:runId/pr-draft': { response: CompanionPrDraft };
  'POST /v1/projects/:projectId/runs/:runId/pr': {
    request: CompanionPrCreateRequest;
    response: PrAction;
  };
  /**
   * Smith's persistent chat. Same snapshot the desktop window polls over IPC.
   * `projectId` query omitted (or empty) is the global conversation.
   */
  'GET /v1/smith': { response: SmithChatState };
  'POST /v1/smith/send': { request: CompanionSmithSendRequest; response: SmithChatState };
  'POST /v1/smith/cancel': { request: CompanionSmithScopeRequest; response: SmithChatState };
  'POST /v1/smith/new': { request: CompanionSmithScopeRequest; response: SmithChatState };
  'GET /v1/smith/proposals': { response: SmithProposal[] };
  'POST /v1/smith/proposals/answer': {
    request: CompanionSmithProposalAnswerRequest;
    response: SmithProposalAnswerResult;
  };
  /** Same catalog the desktop Smith picker reads, minus hidden models. */
  'GET /v1/smith/models': { response: ModelInfo[] };
  'POST /v1/smith/model': { request: CompanionSmithModelRequest; response: SmithChatState };
  'POST /v1/smith/effort': { request: CompanionSmithEffortRequest; response: SmithChatState };
  'POST /v1/unpair': { response: { ok: boolean } };
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
  /**
   * Why the host is not running (or refused to start) — and, while it is
   * running, anything surprising about the bind: a virtual-looking interface,
   * or a port that moved and invalidated an already-paired phone's origin.
   */
  detail?: string;
}
