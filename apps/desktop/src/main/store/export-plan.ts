/**
 * Cross-store export for an ephemeral orchestrated plan. Everything is
 * validated before the first write, so a collision or invalid pipeline never
 * leaves only part of the requested selection behind.
 */

import type { GeneratedRunPlan, ValidationIssue } from '@shared/types.js';
import type { RunPlanExportResult, RunPlanExportSelection } from '@shared/ipc-contract.js';
import { exportedPipelineId } from '@shared/plan-export.js';
import { validate as validateAgent, type RosterStore } from './roster.js';
import { validate as validatePipeline, type PipelineStore } from './pipelines.js';

interface ExportPlanStores {
  roster: RosterStore;
  pipelines: PipelineStore;
  rosterScope: { projectId?: string; ownRoster?: boolean };
  pipelineScope: { projectId?: string; ownPipelines?: boolean };
  rosterAgents: ReturnType<RosterStore['list']>;
  commandNames: string[];
  knownEnvelopes: string[];
}

function scopedIssues(prefix: string, issues: ValidationIssue[]): ValidationIssue[] {
  return issues.map((issue) => ({
    ...issue,
    where: issue.where ? `${prefix}.${issue.where}` : prefix,
  }));
}

function error(where: string, message: string): ValidationIssue {
  return { level: 'error', where, message };
}

export function exportRunPlan(
  plan: GeneratedRunPlan,
  selection: RunPlanExportSelection,
  stores: ExportPlanStores,
): RunPlanExportResult {
  const selectedNames = [...new Set(selection.agents)];
  if (!selection.pipeline && selectedNames.length === 0) {
    return { ok: false, issues: [error('selection', 'Choose a pipeline or agent to save.')] };
  }

  const generatedByName = new Map(plan.agents.map((agent) => [agent.name, agent]));
  const selectedAgents = selectedNames.flatMap((name) => {
    const agent = generatedByName.get(name);
    return agent ? [{ ...agent, builtin: false }] : [];
  });
  const pipeline = {
    ...plan.pipeline,
    id: exportedPipelineId(plan.pipeline.name),
    builtin: false,
  };

  const issues: ValidationIssue[] = [];
  for (const name of selectedNames) {
    if (!generatedByName.has(name)) {
      issues.push(error(`agent:${name}`, `The generated plan has no agent named "${name}".`));
    }
  }
  for (const agent of selectedAgents) {
    if (stores.roster.get(agent.name, stores.rosterScope)) {
      issues.push(error(`agent:${agent.name}`, `An agent named "${agent.name}" already exists.`));
    }
    issues.push(
      ...scopedIssues(`agent:${agent.name}`, validateAgent(agent, stores.knownEnvelopes)),
    );
  }
  if (selection.pipeline) {
    if (stores.pipelines.get(pipeline.id, stores.pipelineScope)) {
      issues.push(error('pipeline', `A pipeline with id "${pipeline.id}" already exists.`));
    }
    issues.push(
      ...scopedIssues(
        'pipeline',
        validatePipeline(
          pipeline,
          [...stores.rosterAgents, ...selectedAgents],
          stores.commandNames,
          stores.knownEnvelopes,
        ),
      ),
    );
  }

  if (issues.some((issue) => issue.level === 'error')) return { ok: false, issues };

  for (const agent of selectedAgents) {
    const saved = stores.roster.save(agent, stores.rosterScope, stores.knownEnvelopes);
    if (!saved.ok) {
      return {
        ok: false,
        issues: [...issues, ...scopedIssues(`agent:${agent.name}`, saved.issues)],
      };
    }
  }
  if (selection.pipeline) {
    const saved = stores.pipelines.save(
      pipeline,
      [...stores.rosterAgents, ...selectedAgents],
      stores.commandNames,
      stores.pipelineScope,
      stores.knownEnvelopes,
    );
    if (!saved.ok) {
      return { ok: false, issues: [...issues, ...scopedIssues('pipeline', saved.issues)] };
    }
  }

  return { ok: true, issues };
}
