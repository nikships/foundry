/**
 * Materialising a prepared Smith session on disk.
 *
 * A prepared launch hands the terminal one command, and that command has to
 * survive two layers of quoting (`open --args`, then the shell it starts). Rather
 * than escape a multi-line script through both, the script is written to the
 * support dir and the terminal is told to run `sh <path>` — one argument, no
 * nesting, and the same file is there to read when a launch misbehaves.
 *
 * The directory is rewritten on every launch, not appended to: it is derived
 * state, and a stale shim pointing at a moved app is worse than no shim.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { smithSessionScript, smithShimScript } from './launch.js';

export interface PreparedSession {
  /** The script the terminal runs, as `sh <scriptPath>`. */
  scriptPath: string;
  /** The directory prepended to PATH, holding the `foundry-cli` shim. */
  binDir: string;
}

export interface PrepareSessionInput {
  /** Where the session's files live: `<supportDir>/smith`. */
  sessionDir: string;
  /** The helper binary the shim execs through `node`. */
  cliPath: string;
  /** The agent CLI to start, resolved to an absolute path. */
  agentPath: string;
  /** The opening instruction handed to the agent. */
  prompt: string;
  projectPath: string;
  socketPath: string;
  /** The interactive shell the window falls back to once the agent exits. */
  shell: string;
  projectId?: string;
}

export function prepareSession(input: PrepareSessionInput): PreparedSession {
  const binDir = join(input.sessionDir, 'bin');
  mkdirSync(binDir, { recursive: true });

  const shimPath = join(binDir, 'foundry-cli');
  writeFileSync(shimPath, smithShimScript(input.cliPath), 'utf8');
  // The shim is found through PATH, so it is executed rather than sourced: it
  // needs the exec bit that `writeFileSync` does not grant.
  chmodSync(shimPath, 0o755);

  const scriptPath = join(input.sessionDir, 'session.sh');
  writeFileSync(
    scriptPath,
    smithSessionScript({
      binDir,
      projectPath: input.projectPath,
      socketPath: input.socketPath,
      agentPath: input.agentPath,
      prompt: input.prompt,
      shell: input.shell,
      projectId: input.projectId,
    }),
    'utf8',
  );
  return { scriptPath, binDir };
}
