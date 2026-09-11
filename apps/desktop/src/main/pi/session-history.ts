import { createReadStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  SessionHistoryChunk,
  SessionHistoryCursor,
  SessionHistoryPage,
} from '@shared/run-agent-state.js';
import type { Tracer } from '../trace/tracer.js';

const DEFAULT_CHARS = 32_000;
const MAX_CHARS = 128_000;

interface JsonRecord {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  message?: unknown;
}

/**
 * Reads one persisted Pi conversation without trusting a caller or model with a path.
 * The cursor can stop inside any JSON entry, so even very large tool output is pageable.
 */
export async function readSessionHistory(
  tracer: Tracer,
  runId: string,
  phaseId: string,
  cursor: SessionHistoryCursor = { line: 1, offset: 0 },
  maxChars = DEFAULT_CHARS,
): Promise<SessionHistoryPage | null> {
  const phase = tracer.phase(phaseId);
  if (!phase || phase.runId !== runId) return null;
  const sessionId = resolveSessionId(tracer, phase, cursor);
  if (!sessionId) return { runId, phaseId, agentSessionId: null, chunks: [], nextCursor: null };

  const path = await findSessionFile(join(tracer.runDir(runId), 'sessions'), sessionId);
  if (!path) return { runId, phaseId, agentSessionId: sessionId, chunks: [], nextCursor: null };
  const budget = Math.max(1, Math.min(MAX_CHARS, Math.floor(maxChars)));
  const startLine = Math.max(1, Math.floor(cursor.line));
  let offset = Math.max(0, Math.floor(cursor.offset));
  let used = 0;
  let lineNumber = 0;
  const chunks: SessionHistoryChunk[] = [];
  let nextCursor: SessionHistoryCursor | null = null;
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (lineNumber < startLine || !line.trim()) continue;
      if (lineNumber > startLine) offset = 0;
      let entry: JsonRecord;
      try {
        entry = JSON.parse(line) as JsonRecord;
      } catch {
        continue;
      }
      if (!isRecord(entry) || entry.type === 'session') continue;
      const json = JSON.stringify(entry);
      if (offset >= json.length) continue;
      const take = Math.min(json.length - offset, budget - used);
      chunks.push(chunkFor(entry, lineNumber, json, offset, take));
      used += take;
      if (offset + take < json.length) {
        nextCursor = pinCursor(lineNumber, offset + take, sessionId);
        break;
      }
      if (used >= budget) {
        nextCursor = pinCursor(lineNumber + 1, 0, sessionId);
        break;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return { runId, phaseId, agentSessionId: sessionId, chunks, nextCursor };
}

/**
 * Prefer the caller's pin, then the phase's recorded conversation, then the
 * live roster row. A reused agent overwrites that roster row; the pin and the
 * phase-session event are what keep paging on the conversation already open.
 */
function resolveSessionId(
  tracer: Tracer,
  phase: { runId: string; phaseId: string; owner: string },
  cursor: SessionHistoryCursor,
): string | null {
  const pinned = cursor.agentSessionId?.trim();
  if (pinned) return pinned;
  const recorded = tracer
    .phaseSessionEvents(phase.runId, phase.phaseId)
    .findLast((event) => typeof event.payload.agentSessionId === 'string')?.payload.agentSessionId;
  if (typeof recorded === 'string' && recorded.length > 0) return recorded;
  return (
    tracer.agentSessions(phase.runId).find((row) => row.agent === phase.owner)?.agentSessionId ??
    null
  );
}

function pinCursor(line: number, offset: number, sessionId: string): SessionHistoryCursor {
  return { line, offset, agentSessionId: sessionId };
}

function chunkFor(
  entry: JsonRecord,
  line: number,
  json: string,
  offset: number,
  length: number,
): SessionHistoryChunk {
  const message = isRecord(entry.message) ? entry.message : null;
  return {
    line,
    entryId: typeof entry.id === 'string' ? entry.id : null,
    entryType: typeof entry.type === 'string' ? entry.type : 'unknown',
    role: message && typeof message.role === 'string' ? message.role : null,
    timestamp:
      typeof entry.timestamp === 'string' || typeof entry.timestamp === 'number'
        ? entry.timestamp
        : null,
    json: json.slice(offset, offset + length),
    offset,
    totalChars: json.length,
  };
}

async function findSessionFile(sessionDir: string, sessionId: string): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.readdir(sessionDir);
  } catch {
    return null;
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(sessionDir, name);
    try {
      const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const first = await firstLine(path);
      const header = JSON.parse(first) as { type?: unknown; id?: unknown };
      if (header.type === 'session' && header.id === sessionId) return path;
    } catch {
      // Ignore unrelated or incomplete session artifacts.
    }
  }
  return null;
}

async function firstLine(path: string): Promise<string> {
  const file = await fs.open(path, 'r');
  try {
    const buffer = Buffer.alloc(16_384);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0] ?? '';
  } finally {
    await file.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
