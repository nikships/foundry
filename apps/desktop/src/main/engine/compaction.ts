/**
 * Foundry-owned compaction summary and constitution pins.
 *
 * Pi's default compact template is a chat Goal / Progress / Next Steps note.
 * A pipeline turn needs the request, the current phase, artifact paths, open
 * failures, files already edited, and the envelope the next submit must hit.
 * The system harness is re-injected every turn, so it is never summarised.
 *
 * `session.compact()` stays opaque: this module only builds the text a Foundry
 * wrapper hands back through `session_before_compact`.
 */

import type { CustomEnvelopeField, EnvelopeDef } from '@shared/types.js';
import { jsonSchemaFor } from './envelopes.js';

export interface CompactionFacts {
  request: string;
  phase: string;
  artifactPaths: readonly string[];
  unresolvedFailures: readonly string[];
  filesModified: readonly string[];
  envelopeKind: string;
  requiredFields: readonly string[];
  /** Current phase user prompt with the Report block removed. */
  phaseUserPrompt: string;
  /** Repository / project card, already standing in the system role. */
  projectCard: string;
}

/** Drops the trailing `## Report` example so a pin does not re-teach the envelope. */
export function stripReportBlock(userPrompt: string): string {
  const match = /(?:^|\n)## Report(?:\n|$)/.exec(userPrompt);
  if (!match || match.index === undefined) return userPrompt.trimEnd();
  return userPrompt.slice(0, match.index).trimEnd();
}

/** Field names the next `submit_envelope` must still name, from the same schema. */
export function requiredFieldsFor(
  kind: string,
  custom?: CustomEnvelopeField[],
  defs?: EnvelopeDef[],
): string[] {
  const schema = jsonSchemaFor(kind, custom, defs) as { required?: unknown };
  if (!Array.isArray(schema.required)) return [];
  return schema.required.filter((name): name is string => typeof name === 'string');
}

function bullets(items: readonly string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '(none)';
}

export function artifactPathsOf(envelopes: Iterable<{ artifacts?: unknown }>): string[] {
  const paths: string[] = [];
  for (const envelope of envelopes) {
    if (!Array.isArray(envelope.artifacts)) continue;
    for (const artifact of envelope.artifacts) {
      if (typeof artifact === 'string' && artifact.trim()) paths.push(artifact);
    }
  }
  return paths;
}

interface CommandFailure {
  passed: boolean;
  command: string;
  exitCode: number | null;
  outputTail: string;
}

export function unresolvedFailuresOf(input: {
  commands: Iterable<[string, CommandFailure]>;
  feedback: Iterable<[string, string]>;
}): string[] {
  const failures: string[] = [];
  for (const [name, result] of input.commands) {
    if (result.passed) continue;
    const tail = result.outputTail.trim();
    const line = `${name}: ${result.command} exited ${String(result.exitCode)}`;
    failures.push(tail ? `${line}\n${tail}` : line);
  }
  for (const [name, text] of input.feedback) {
    const trimmed = text.trim();
    if (trimmed) failures.push(`${name}: ${trimmed}`);
  }
  return failures;
}

/**
 * Deterministic compact summary. Pins the constitution verbatim and records
 * the pipeline evidence a follow-up turn still needs; never the system harness.
 */
export function foundryCompactionSummary(facts: CompactionFacts): string {
  const sections: string[] = [];
  if (facts.phaseUserPrompt.trim()) {
    sections.push(['## Phase prompt', '', facts.phaseUserPrompt.trim()].join('\n'));
  }
  if (facts.projectCard.trim()) {
    sections.push(['## Project card', '', facts.projectCard.trim()].join('\n'));
  }
  sections.push(
    ['## Request', '', facts.request.trim() || '(none)'].join('\n'),
    ['## Current phase', '', facts.phase.trim() || '(none)'].join('\n'),
    ['## Artifact paths', '', bullets(facts.artifactPaths)].join('\n'),
    ['## Unresolved failures', '', bullets(facts.unresolvedFailures)].join('\n'),
    ['## Files modified', '', bullets(facts.filesModified)].join('\n'),
    [
      '## Envelope',
      '',
      `kind: ${facts.envelopeKind.trim() || '(none)'}`,
      `required fields: ${facts.requiredFields.length ? facts.requiredFields.join(', ') : '(none)'}`,
    ].join('\n'),
  );
  return sections.join('\n\n');
}
