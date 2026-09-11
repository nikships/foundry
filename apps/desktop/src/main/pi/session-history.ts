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
  const persisted = tracer.agentSessions(runId).find((row) => row.agent === phase.owner);
  const sessionId = persisted?.agentSessionId ?? null;
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
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
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
    if (entry.type === 'session') continue;
    const json = JSON.stringify(entry);
    if (offset >= json.length) continue;
    const take = Math.min(json.length - offset, budget - used);
    chunks.push(chunkFor(entry, lineNumber, json, offset, take));
    used += take;
    if (offset + take < json.length) {
      nextCursor = { line: lineNumber, offset: offset + take };
      break;
    }
    if (used >= budget) {
      nextCursor = { line: lineNumber + 1, offset: 0 };
      break;
    }
  }
  lines.close();
  return { runId, phaseId, agentSessionId: sessionId, chunks, nextCursor };
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
