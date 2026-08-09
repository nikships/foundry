/**
 * The vendor seam interface for agent CLIs.
 */

import type {
  AutonomyLevel,
  CliVendor,
  ModelInfo,
  ReasoningEffort,
  ToolInfo,
} from '@shared/types.js';
import type { DroidNotification, TokenUsage } from '../droid/protocol.js';

// Re-exported so everything under cli/ has one import for the vendor seam, but
// defined in the shared contract: the renderer names vendors too, and two
// definitions of the same union drift.
export type { CliVendor };

/** What a vendor needs to know to build one turn's argv. */
export interface TurnRequest {
  prompt: string;
  cwd: string;
  autonomy: AutonomyLevel;
  model: string;
  reasoningEffort: ReasoningEffort;
  /** Null on the first turn of a session; the vendor's own id afterwards. */
  sessionId: string | null;
  restrictTools?: string[];
  disabledTools?: string[];
  /** Operator escape hatch: flags this app does not model, appended verbatim. */
  extraArgs?: string[];
}

export interface Invocation {
  argv: string[];
}

/** A turn's outcome, normalised out of whatever the vendor printed. */
export interface ParsedTurn {
  text: string;
  usage: TokenUsage | null;
  /** Echoed back so the next turn can resume; null means the vendor was silent. */
  sessionId: string | null;
  /** The vendor's own word for how the turn ended, kept for the trace. */
  reason: string;
  isError: boolean;
}

export interface ProcessOutput {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface CliAdapter {
  id: CliVendor;
  /** Shown in the roster and settings. */
  label: string;
  /** Bare binary name, used for the PATH lookup. */
  binary: string;
  /** Absolute paths probed when the binary is not on PATH, best first. */
  installPaths: () => string[];
  /** Where the doctor sends someone whose binary is missing. */
  docsUrl: string;
  /** Any one of these in the environment counts as authenticated. */
  authEnvVars: string[];
  /** A config file that means the CLI has already been logged in. */
  authPaths: () => string[];
  /** Where the doctor sends someone whose CLI has no credentials. */
  authUrl: string;
  /** True only for droid, which has a hand-written JSON-RPC client. */
  supportsRpc: boolean;
  versionArgs: string[];
  /**
   * Explains what this vendor cannot do that droid can, in the words the
   * Settings pane shows. Empty for droid.
   */
  caveats: string[];
  /**
   * Lines this CLI writes to stderr on runs that succeed. Matching output is
   * kept out of the trace, because a warning filed as an error on every green
   * phase trains the reader to ignore the trace.
   */
  noisyStderr?: RegExp;
  turn: (req: TurnRequest) => Invocation;
  parse: (out: ProcessOutput) => ParsedTurn | null;
  /**
   * Returns the normaliser for one turn: folds one parsed stdout line into
   * droid-shaped notifications, so the shared EventFolder traces streams
   * accurately. A factory rather than a bare function because folding can be
   * stateful, and two runs may share the adapter object concurrently.
   * Shapes are pinned in tests against real CLI output, never invented.
   */
  stream?: () => (line: unknown) => DroidNotification[];
  /**
   * The model list, however this CLI allows it to be discovered. A vendor that
   * publishes no list returns its documented aliases and nothing more: an
   * invented model id reads as a broken agent rather than a bad setting, so
   * guessing here is worse than a short list.
   */
  models: (binPath: string) => Promise<ModelInfo[]>;
  /** Only droid enumerates tools; the rest return an empty list. */
  tools?: (binPath: string, model?: string) => Promise<ToolInfo[]>;
}

/** Last JSON object printed on stdout, for vendors that end with one summary. */
export function lastJsonObject<T>(stdout: string, accept: (value: T) => boolean): T | null {
  const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{'));
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line) as T;
      if (accept(parsed)) return parsed;
    } catch {
      // A truncated or interleaved line is not fatal; try the one before it.
    }
  }
  return null;
}

/** Every JSON object on stdout, in order, for vendors that stream JSONL. */
export function jsonLines<T>(stdout: string): T[] {
  const out: T[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Partial line from a killed process; the events before it still count.
    }
  }
  return out;
}

/**
 * A model entry standing for "whatever this CLI would have picked". Vendors that
 * cannot enumerate models still need one selectable value, and the engine
 * already treats `inherit` as "pass no model flag".
 */
export function inheritModel(vendor: CliVendor, note: string): ModelInfo {
  return {
    id: 'inherit',
    displayName: note,
    // The vendor is its own provider here. The picker's icon is optional and a
    // vendor without one simply shows no icon, which beats claiming it is OpenAI.
    provider: vendor,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'none',
    isCustom: false,
    deprecated: false,
  };
}
