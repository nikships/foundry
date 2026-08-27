import type { PipelineDef, ProjectCommand, ProjectDef, ValidationIssue } from '@shared/types.js';

/** Add the command rows a surface is asking for without guessing any stack's argv. */
export function seedMissingProjectCommands(
  project: ProjectDef,
  commandNames: string[],
): ProjectDef {
  const known = new Set(project.commands.map((command) => command.name));
  const additions: ProjectCommand[] = [];
  for (const name of commandNames) {
    const trimmed = name.trim();
    if (!trimmed || known.has(trimmed)) continue;
    known.add(trimmed);
    additions.push({ name: trimmed, argv: [] });
  }
  return { ...project, commands: [...project.commands, ...additions] };
}

/** The store requires every visible command row to have a name and executable argv. */
export function projectCommandsReady(commands: ProjectCommand[]): boolean {
  return commands.every((command) => Boolean(command.name.trim()) && command.argv.length > 0);
}

/** Project command refs this pipeline needs but the current project does not provide. */
export function missingProjectCommandRefs(
  pipeline: PipelineDef,
  commands: ProjectCommand[],
): string[] {
  const configured = new Set(commands.map((command) => command.name));
  const missing = new Set<string>();
  for (const phase of pipeline.phases) {
    if (phase.kind !== 'code' || !phase.command || !('ref' in phase.command)) continue;
    if (!configured.has(phase.command.ref)) missing.add(phase.command.ref);
  }
  return [...missing];
}

/**
 * Generated plans freeze their validation warnings. The Plan card replaces
 * these two established missing-command forms with one live, actionable row.
 */
export function isMissingProjectCommandWarning(issue: ValidationIssue): boolean {
  return (
    /project command "[^"]+" is not configured/.test(issue.message) ||
    /no "[^"]+" command in this new project yet/.test(issue.message)
  );
}
