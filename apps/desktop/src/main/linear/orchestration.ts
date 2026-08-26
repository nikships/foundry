import type {
  LinearRunSource,
  LinearStatusMapping,
  LinearWorkflowState,
  StartRunInput,
} from '@shared/types.js';
import type { LinearStartRunInput } from '@shared/ipc-contract.js';
import { linearIssueBrief } from '@shared/linear.js';
import { startRun, type StartRunDeps, type StartRunOutcome } from '../engine/operations.js';
import type { LinearService } from './service.js';

export async function startLinearIssueRun(
  deps: StartRunDeps,
  linear: Pick<LinearService, 'issue' | 'workflowStates'>,
  mapping: LinearStatusMapping,
  input: LinearStartRunInput,
): Promise<StartRunOutcome> {
  const issue = await linear.issue(input.issueId);
  const states = await linear.workflowStates(issue.team.id);
  const mappingIssues = statusMappingIssues(mapping, states, issue.team.name);
  if (mappingIssues.length) return { ok: false, issues: mappingIssues };

  const source: LinearRunSource = {
    kind: 'linear',
    trigger: 'manual',
    issueId: issue.id,
    url: issue.url,
    revision: issue.updatedAt,
    statusMapping: { ...mapping },
    snapshot: issue,
  };
  const startInput: StartRunInput = {
    projectId: input.projectId,
    pipelineId: input.pipelineId,
    request: linearIssueBrief(issue),
    ...(input.plan ? { plan: input.plan } : {}),
  };
  return startRun(deps, startInput, source);
}

function statusMappingIssues(
  mapping: LinearStatusMapping,
  states: LinearWorkflowState[],
  teamName: string,
): StartRunOutcome['issues'] {
  const known = new Set(states.map((state) => state.id));
  const labels: Record<keyof LinearStatusMapping, string> = {
    started: 'run started',
    completed: 'run accepted',
    failed: 'run failed',
  };
  const issues: StartRunOutcome['issues'] = [];
  for (const stage of Object.keys(labels) as (keyof LinearStatusMapping)[]) {
    const stateId = mapping[stage];
    if (!stateId) {
      issues.push({
        level: 'error',
        where: `linear.status.${stage}`,
        message: `Choose a ${labels[stage]} status for ${teamName}.`,
      });
    } else if (!known.has(stateId)) {
      issues.push({
        level: 'error',
        where: `linear.status.${stage}`,
        message: `The saved ${labels[stage]} status is not in ${teamName}'s workflow.`,
      });
    }
  }
  return issues;
}
