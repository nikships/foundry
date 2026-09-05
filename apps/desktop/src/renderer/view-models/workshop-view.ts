import type { AgentSessionRow, EventRow, PhaseRow, PipelineDef } from '@shared/types.js';

export interface WorkshopStation {
  phase: PhaseRow;
  model: string | null;
  color: string;
}

const COLORS = ['#eab08d', '#aaa0ed', '#8bc9b1', '#e2be72', '#91bbdf', '#dc9dbe'];

/** Prefer the latest start, including fallback models, over a shared session's current model. */
export function workshopModel(
  phase: PhaseRow,
  events: EventRow[],
  sessions: AgentSessionRow[],
  pipeline?: PipelineDef,
): string | null {
  if (phase.kind !== 'agent') return null;
  const recorded = events.findLast(
    (event) =>
      event.phaseId === phase.phaseId &&
      event.type === 'agent_start' &&
      typeof event.payload.model === 'string',
  );
  if (recorded) return recorded.payload.model as string;
  const planned = pipeline?.phases.find((item) => item.name === phase.name);
  const appointed = planned?.kind === 'agent' ? planned.model : undefined;
  if (phase.status === 'queued') return appointed && appointed !== 'inherit' ? appointed : null;
  return (
    sessions.find((session) => session.agent === phase.owner)?.model ??
    (appointed && appointed !== 'inherit' ? appointed : null)
  );
}

/** Model-family logos take precedence over routing providers such as OpenRouter. */
export function workshopBrand(model: string | null): string | null {
  if (!model) return null;
  const id = model.toLowerCase();
  const families: [RegExp, string][] = [
    [/claude/, 'claude'],
    [/codex/, 'openai'],
    [/\bgpt|\/o[134](?:-|$)/, 'openai'],
    [/gemini/, 'gemini'],
    [/grok/, 'grok'],
    [/deepseek/, 'deepseek'],
    [/qwen/, 'qwen'],
    [/kimi|moonshot/, 'kimi'],
    [/glm/, 'zai'],
    [/minimax/, 'minimax'],
    [/mistral|mixtral|devstral/, 'mistral'],
    [/llama/, 'meta'],
  ];
  return (
    families.find(([pattern]) => pattern.test(id))?.[1] ?? id.split('/')[0]!.replace(/^bridge-/, '')
  );
}

/** Follow execution time, not sequence: retries and amendments can move backwards. */
export function workshopFocus(phases: PhaseRow[]): PhaseRow | null {
  const running = phases.filter((phase) => phase.status === 'running');
  if (running.length) {
    return running.reduce((latest, phase) =>
      (phase.startedAt ?? '') >= (latest.startedAt ?? '') ? phase : latest,
    );
  }
  const started = phases.filter((phase) => phase.startedAt);
  if (started.length) {
    return started.reduce((latest, phase) =>
      (phase.endedAt ?? phase.startedAt ?? '') >= (latest.endedAt ?? latest.startedAt ?? '')
        ? phase
        : latest,
    );
  }
  return null;
}

export function workshopStations(
  phases: PhaseRow[],
  events: EventRow[],
  sessions: AgentSessionRow[],
  pipeline?: PipelineDef,
): WorkshopStation[] {
  return [...phases]
    .sort((a, b) => a.seq - b.seq)
    .map((phase, index) => ({
      phase,
      model: workshopModel(phase, events, sessions, pipeline),
      color: COLORS[index % COLORS.length]!,
    }));
}

export function workshopActivity(
  phase: PhaseRow | null,
  events: EventRow[],
  live: boolean,
): string {
  if (!phase) return live ? 'Preparing the workshop' : 'No phase work recorded';
  if (!live || phase.status !== 'running') {
    const labels = {
      success: 'Work delivered',
      fail: 'Needs attention',
      skipped: 'Skipped',
      queued: 'Waiting for a turn',
      running: 'Work stopped',
    };
    return labels[phase.status];
  }
  const latest = events.findLast((event) =>
    ['tool_call', 'thinking', 'assistant_text', 'correction', 'gate_fail', 'error'].includes(
      event.type,
    ),
  );
  if (!latest) return phase.kind === 'code' ? 'Starting the machinery' : 'Getting situated';
  if (latest.type === 'tool_call') return latest.endedAt ? `Finished ${latest.name}` : latest.name;
  if (latest.type === 'thinking')
    return latest.endedAt ? 'Planning the next move' : 'Thinking it through';
  if (latest.type === 'assistant_text') return 'Writing an update';
  return latest.type === 'correction' ? 'Making a correction' : 'Checking a problem';
}
