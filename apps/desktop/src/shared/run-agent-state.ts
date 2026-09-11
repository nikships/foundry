import type { PhaseKind, PhaseStatus, RunStatus } from './types.js';

export interface PhaseMessage {
  messageId: string;
  runId: string;
  phaseId: string;
  phase: string;
  text: string;
  status: 'delivered' | 'read' | 'acted_on' | 'dismissed';
  noteOnly: boolean;
  deliveredAt: string;
  readAt?: string;
  readPhaseId?: string;
  resolvedAt?: string;
  reason?: string;
}

/** Clone-safe evidence exposed to Smith without implying a computed Git diff. */
export interface PhaseFileChangeEvidence {
  availability: 'unavailable';
  files: string[];
  checkpointIds: string[];
  detail: string;
}

export interface ActiveAgentToolCall {
  eventId: string;
  name: string;
  tool: string | null;
  startedAt: string;
  args: Record<string, unknown>;
}

export interface RunAgentPhaseState {
  phaseId: string;
  phase: string;
  kind: PhaseKind;
  phaseStatus: PhaseStatus;
  runStatus: RunStatus;
  agent: string | null;
  model: string | null;
  agentSessionId: string | null;
  activeToolCalls: ActiveAgentToolCall[];
  lastError: string | null;
  fileChanges: PhaseFileChangeEvidence;
  /** Run-agent policy decides synchronously; there is no approval queue to report. */
  pendingApprovals: [];
}

export interface RunAgentStateResult {
  runId: string;
  runStatus: RunStatus;
  phases: RunAgentPhaseState[];
}

/** Position in the persisted JSONL file and in one entry's lossless JSON text. */
export interface SessionHistoryCursor {
  line: number;
  offset: number;
}

export interface SessionHistoryChunk {
  line: number;
  entryId: string | null;
  entryType: string;
  role: string | null;
  timestamp: string | number | null;
  /** A slice of `JSON.stringify(entry)`, suitable for lossless reassembly. */
  json: string;
  offset: number;
  totalChars: number;
}

export interface SessionHistoryPage {
  runId: string;
  phaseId: string;
  agentSessionId: string | null;
  chunks: SessionHistoryChunk[];
  nextCursor: SessionHistoryCursor | null;
}
