/**
 * What Foundry knows about an agent CLI it does not run.
 *
 * This used to be a vendor seam: argv construction plus one-shot stdout
 * parsing, so a `droid exec` child could be spawned for a turn. Nothing spawns
 * one any more — agent phases run on the in-process transport in `src/main/pi/`
 * and every one-shot call site opens a short-lived session there — so the argv,
 * the parse, and the stream normaliser are gone with the code that called them.
 *
 * What is left is a **descriptor**: where the binary lives, how it says it is
 * authenticated, and where to send someone whose install is broken. Settings,
 * the doctor, and the model picker still read it. Those paths move to Pi's own
 * provider and credential model in the settings/doctor migration, and this file
 * goes with them; it survives here so that migration is one change rather than
 * a prerequisite for this one.
 */

import type { CliVendor, ModelInfo, ToolInfo } from '@shared/types.js';

// Re-exported so everything under cli/ has one import for the vendor seam, but
// defined in the shared contract: the renderer names vendors too, and two
// definitions of the same union drift.
export type { CliVendor };

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
   * The model list, however this CLI allows it to be discovered. A vendor that
   * publishes no list returns its documented aliases and nothing more: an
   * invented model id reads as a broken agent rather than a bad setting, so
   * guessing here is worse than a short list.
   */
  models: (binPath: string) => Promise<ModelInfo[]>;
  /** Only droid enumerates tools; the rest return an empty list. */
  tools?: (binPath: string, model?: string) => Promise<ToolInfo[]>;
}
