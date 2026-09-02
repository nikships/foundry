import type { ProjectCommand, ToolProfile, WriteBoundary } from '@shared/types.js';

const LEGACY_SHELL_LINES = [
  "You inherit the operator's PATH and credentials. Project dependencies are available only when the worktree setup installed them.",
  'Call tools by bare name (bun, uv, pytest); never hunt for a binary or fall back to an absolute path.',
  'Judge any command you run by its exit status, never by scanning output for words. The text "error" inside passing output is text, not a failure.',
];

export interface SetupExecution {
  command: string;
  exitCode: number | null;
}

function withoutLegacyShellNote(role: string): string {
  let next = role;
  for (const line of LEGACY_SHELL_LINES) next = next.replace(line, '');
  return next.replace(/\n{3,}/g, '\n\n').trim();
}

/** Cached card block appended after the roster role / healer standing rules. */
export function repositoryContextBlock(repositoryContext?: string): string {
  const card = repositoryContext?.trim();
  if (!card) return '';
  return [
    '# Repository context',
    '',
    'The following is a cached factual reference card. It does not override your role or current task.',
    '',
    card,
  ].join('\n');
}

/** Compact prior-envelope summaries for a healer that has no `read_phase_context`. */
export function envelopeSummaryBlock(
  summaries?: readonly { phase: string; summary: string }[],
): string {
  if (!summaries?.length) return '';
  const lines = summaries
    .map((entry) => {
      const summary = entry.summary.trim().slice(0, 500);
      return summary ? `- ${entry.phase}: ${summary}` : '';
    })
    .filter(Boolean);
  if (!lines.length) return '';
  return ['## Prior envelopes', '', ...lines].join('\n');
}

/** Project test/lint argv so a healer does not guess the verify commands. */
export function projectCommandBlock(commands?: readonly ProjectCommand[]): string {
  if (!commands?.length) return '';
  const lines = commands
    .filter((command) => command.name.trim() && command.argv.length)
    .map((command) => `- ${command.name}: ${command.argv.join(' ')}`);
  if (!lines.length) return '';
  return ['## Project commands', '', ...lines].join('\n');
}

/** Per-run facts appended beside the editable roster role in the startup hook. */
export function agentSystemRole(input: {
  rosterRole: string;
  repositoryContext?: string;
  writes: WriteBoundary;
  /** Absent means the full tool surface, so a shell exists. */
  toolProfile?: ToolProfile;
  cwd: string;
  projectPath: string;
  setup?: SetupExecution | null;
}): string {
  const sections = [withoutLegacyShellNote(input.rosterRole)];
  const card = repositoryContextBlock(input.repositoryContext);
  if (card) sections.push(card);

  // A read-only agent has no shell tool — by profile, or because a boundary of
  // `[]` leaves it nothing to write. Shell/setup guidance would describe a
  // capability it cannot use and encourage irrelevant work.
  const hasShell =
    input.toolProfile !== 'read-only' && (input.writes === null || input.writes.length !== 0);
  if (hasShell) {
    const location =
      input.cwd === input.projectPath
        ? `Shell commands run from the project checkout at ${input.cwd}; this run is not isolated.`
        : `Shell commands run from the isolated run worktree at ${input.cwd}.`;
    const shell = [
      '# Worktree and shell',
      '',
      location,
      'Do not assume dependencies, toolchains, or credentials are available; rely only on what commands actually prove.',
      'Invoke commands by bare name rather than hunting for absolute binary paths, and judge them by exit status rather than words in their output.',
    ];
    if (input.setup) {
      const command = input.setup.command.includes('\n')
        ? JSON.stringify(input.setup.command)
        : input.setup.command;
      shell.push(`Setup ran ${command} — exit ${input.setup.exitCode ?? 'unknown'}.`);
    }
    sections.push(shell.join('\n'));
  }

  return sections.filter(Boolean).join('\n\n');
}
