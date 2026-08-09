/**
 * Start-time checks that catch deterministic failures before a run burns tokens.
 *
 * Edit-time validation keeps missing project commands as warnings so a designer
 * can draft a pipeline before the project is wired. Start-time upgrades those
 * to errors, and optionally fills them from manifests / an agent first.
 */

import {
  BUILTIN_ENVELOPE_KINDS,
  type AgentDef,
  type PipelineDef,
  type ProjectDef,
  type ValidationIssue,
} from '@shared/types.js';
import { validate as validatePipeline } from '../store/pipelines.js';
import { type CommandCandidate, mergeCommandsFillMissing, sniffCommands } from './detect.js';

/** Unique `{ref}` names a code phase will look up on the project. */
export function requiredCommandRefs(pipeline: PipelineDef): string[] {
  const refs = new Set<string>();
  for (const phase of pipeline.phases) {
    if (phase.kind !== 'code' || !phase.command) continue;
    if ('ref' in phase.command && phase.command.ref) refs.add(phase.command.ref);
  }
  return [...refs];
}

export function missingCommandRefs(pipeline: PipelineDef, project: ProjectDef): string[] {
  const have = new Set(project.commands.map((c) => c.name));
  return requiredCommandRefs(pipeline).filter((ref) => !have.has(ref));
}

/**
 * Structural errors from the designer rail, plus missing command refs promoted
 * to errors. Unknown envelope names are warnings so a deleted library entry
 * does not block a start (runtime falls back to generic). Callers that refuse
 * to start must filter on `level === 'error'`.
 */
export function preflightForRun(
  pipeline: PipelineDef,
  agents: AgentDef[],
  commandNames: string[],
  knownEnvelopes: string[] = [],
): ValidationIssue[] {
  const known = new Set([...BUILTIN_ENVELOPE_KINDS, ...knownEnvelopes]);
  const issues = validatePipeline(pipeline, agents, commandNames, knownEnvelopes).filter(
    (i) => i.level === 'error' || i.message.includes('not in the library'),
  );

  // Cover agent-only envelope refs (phase has no override) that pipeline
  // validate does not see on the phase itself.
  const agentsByName = new Map(agents.map((a) => [a.name, a]));
  for (const phase of pipeline.phases) {
    if (phase.kind !== 'agent' || phase.envelope) continue;
    const agent = phase.agent ? agentsByName.get(phase.agent) : undefined;
    const envelope = agent?.envelope;
    if (!envelope || known.has(envelope)) continue;
    issues.push({
      level: 'warning',
      where: phase.name,
      message: `envelope "${envelope}" is not in the library — this run will fall back to generic`,
    });
  }

  const have = new Set(commandNames);
  for (const phase of pipeline.phases) {
    if (phase.kind !== 'code' || !phase.command || !('ref' in phase.command)) continue;
    const ref = phase.command.ref;
    if (!ref || have.has(ref)) continue;
    issues.push({
      level: 'error',
      where: phase.name,
      message: `project command "${ref}" is not configured — detect it from the repo or set it in Settings → Project`,
    });
  }
  return issues;
}

export interface EnsureCommandsResult {
  project: ProjectDef;
  filled: string[];
  stillMissing: string[];
  via: 'manifest' | 'agent' | 'none' | 'unchanged';
  detail: string;
}

/**
 * Fill missing refs from free manifest sniffing, then an optional agent pass.
 * Never overwrites a name the project already has. Does not execute candidates
 * (start must stay fast; the human can Try it in Settings).
 */
export async function ensureMissingCommands(
  project: ProjectDef,
  missing: string[],
  opts: {
    useAgent?: boolean;
    detectWithAgent?: () => Promise<CommandCandidate[]>;
    save: (project: ProjectDef) => ProjectDef;
  },
): Promise<EnsureCommandsResult> {
  if (!missing.length) {
    return {
      project,
      filled: [],
      stillMissing: [],
      via: 'unchanged',
      detail: 'nothing missing',
    };
  }

  let candidates = await sniffCommands(project.path);
  let via: EnsureCommandsResult['via'] = candidates.length ? 'manifest' : 'none';

  const covers = (list: CommandCandidate[]): string[] =>
    missing.filter((name) => list.some((c) => c.name === name));

  if (!covers(candidates).length && opts.useAgent && opts.detectWithAgent) {
    try {
      const agentHits = await opts.detectWithAgent();
      if (agentHits.length) {
        candidates = agentHits;
        via = 'agent';
      }
    } catch (e) {
      return {
        project,
        filled: [],
        stillMissing: missing,
        via: 'none',
        detail: `could not ask an agent: ${(e as Error).message}`,
      };
    }
  }

  // If test is still missing but build or lint was found, alias test to the
  // best available gate. Repos with no automated suite still need a phase that
  // fails the run when the project does not build or lint.
  const stillAfterSniff = missing.filter((name) => !candidates.some((c) => c.name === name));
  if (stillAfterSniff.includes('test')) {
    const fallback =
      candidates.find((c) => c.name === 'build') ?? candidates.find((c) => c.name === 'lint');
    if (fallback) {
      candidates = [
        ...candidates,
        {
          name: 'test',
          argv: fallback.argv,
          source: `${fallback.source} (aliased to ${fallback.name}; no dedicated test command)`,
        },
      ];
    }
  }

  const nextCommands = mergeCommandsFillMissing(project.commands, candidates, missing);
  const filled = nextCommands
    .map((c) => c.name)
    .filter((name) => missing.includes(name) && !project.commands.some((c) => c.name === name));

  if (!filled.length) {
    return {
      project,
      filled: [],
      stillMissing: missing,
      via,
      detail:
        via === 'none'
          ? 'no command found in the manifests'
          : `found commands, but none named ${missing.join(', ')}`,
    };
  }

  const saved = opts.save({ ...project, commands: nextCommands });
  const have = new Set(saved.commands.map((c) => c.name));
  const stillMissing = missing.filter((name) => !have.has(name));
  return {
    project: saved,
    filled,
    stillMissing,
    via,
    detail: `filled ${filled.join(', ')} via ${via}`,
  };
}
