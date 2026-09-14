import type { ProjectCommand } from '@shared/types.js';

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
