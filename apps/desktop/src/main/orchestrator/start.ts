/**
 * Shared "open a planning session" step for the two surfaces that start
 * plans: the desktop composer's IPC router and the companion host. Both used
 * to re-implement the same guards and the same `plans.start()` call;
 * a change to what starting a plan means would drift them apart again.
 */

import type {
  AgentDef,
  EnvelopeDef,
  ModelInfo,
  PlanImageAttachment,
  ProjectCommand,
  ReasoningEffort,
} from '@shared/types.js';
import type { OrchestratorState } from '@shared/ipc-contract.js';
import type { PanelRegistry } from '../session/index.js';
import { validatePlanImages } from './plan-images.js';
import type { PlanStart } from './plan-session.js';

export interface PlanStartInput {
  prompt: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  images?: PlanImageAttachment[];
}

export interface PlanStartProject {
  id: string;
  path: string;
  contextSummary?: string | null;
  commands: ProjectCommand[];
  scaffold?: boolean;
}

export interface PlanStartServices {
  /** The agents this project runs planning with. */
  rosterFor(projectId: string): AgentDef[];
  envelopeDefs: EnvelopeDef[];
  /** Settings → Agent Defaults model, captured for this planning session. */
  defaultModel: string;
  /** The models this install can reach, minus the operator's hidden ones. */
  enabledModels: () => Promise<ModelInfo[]>;
  /** Resolved in the background so opening the planning panel stays immediate. */
  ghAvailable(projectPath: string): Promise<boolean>;
}

export function startPlan(
  plans: PanelRegistry<PlanStart, OrchestratorState>,
  project: PlanStartProject | null | undefined,
  input: PlanStartInput,
  services: PlanStartServices,
): { planId: string } | { error: string } {
  if (!project) return { error: 'project not found' };
  const checked = validatePlanImages(input.images);
  if (!checked.ok) return { error: checked.error };
  if (!input.prompt.trim() && checked.images.length === 0) {
    return { error: 'a plan needs a request' };
  }
  const projectPath = project.path;
  const planId = plans.start({
    projectId: project.id,
    projectPath,
    prompt: input.prompt,
    model: input.model || 'inherit',
    defaultModel: services.defaultModel || 'inherit',
    reasoningEffort: input.reasoningEffort,
    contextSummary: project.contextSummary ?? '',
    commands: project.commands,
    roster: services.rosterFor(project.id),
    envelopeDefs: services.envelopeDefs,
    scaffold: project.scaffold === true,
    enabledModels: services.enabledModels,
    ghAvailable: async () => services.ghAvailable(projectPath),
    ...(checked.images.length > 0 ? { images: checked.images } : {}),
  });
  return { planId };
}
