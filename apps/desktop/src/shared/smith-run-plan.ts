import { SMITH_ARTIFACT_VERSION } from './types.js';
import type { CommandSpec, ProposalSnapshot, SmithRunPlanArtifact } from './types.js';

function commandText(command: CommandSpec | undefined): string | undefined {
  if (!command) return undefined;
  if ('ref' in command) return command.ref;
  if ('builtin' in command) return command.builtin;
  return command.argv.join(' ');
}

/** An allowlisted, bounded snapshot; never copy the durable row or plan JSON. */
export function smithRunPlanArtifact(row: ProposalSnapshot): SmithRunPlanArtifact {
  const plan = row.acceptedPlan ?? row.plan;
  const brief = plan?.refinedRequest ?? row.prompt;
  return {
    id: `run-plan:${row.planId}:${row.revision}:${row.status}`,
    version: SMITH_ARTIFACT_VERSION,
    createdAt: row.updatedAt,
    kind: 'run_plan',
    planId: row.planId,
    projectId: row.projectId,
    status: row.status,
    revision: row.revision,
    title: (brief.split(/(?<=[.!?])\s/)[0] || 'Run plan').slice(0, 120),
    refinedRequest: brief.slice(0, 2000),
    rationale: (plan?.rationale ?? row.detail).slice(0, 1000),
    phases: (plan?.pipeline.phases ?? []).slice(0, 50).map((phase, index) => ({
      index,
      name: phase.name.slice(0, 200),
      kind: phase.kind,
      ...(phase.kind === 'agent'
        ? {
            agent: phase.agent?.slice(0, 200),
            model: phase.model?.slice(0, 200),
            reasoningEffort: phase.reasoningEffort,
            synthesized: plan?.agents.some((agent) => agent.name === phase.agent),
          }
        : { command: commandText(phase.command)?.slice(0, 1000) }),
    })),
    warnings: (plan?.warnings ?? []).slice(0, 20).map((warning) => ({
      level: 'warning',
      where: warning.where.slice(0, 200),
      message: warning.message.slice(0, 1000),
    })),
    ...(row.acceptedRunId ? { acceptedRunId: row.acceptedRunId } : {}),
  };
}
