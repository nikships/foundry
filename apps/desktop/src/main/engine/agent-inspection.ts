import type { RunAgentPhaseState, RunAgentStateResult } from '@shared/run-agent-state.js';
import type { AgentSessionRow, EventRow, PhaseCheckpointRow } from '@shared/types.js';
import type { Tracer } from '../trace/tracer.js';

function allEvents(tracer: Tracer, runId: string): EventRow[] {
  // Inspection is a snapshot, not a change-feed walk. One unbounded read avoids
  // advancing past older rows when an early row has a newer in-place revision.
  return tracer.eventsAfter(runId, 0, Number.MAX_SAFE_INTEGER);
}

/** Read-only, trace-backed inspection of every phase, including queued phases. */
export function readRunAgentState(tracer: Tracer, runId: string): RunAgentStateResult | null {
  const run = tracer.run(runId);
  if (!run) return null;
  const events = allEvents(tracer, runId);
  const sessions = tracer.agentSessions(runId);
  const checkpoints = tracer.phaseCheckpoints(runId);

  const phases: RunAgentPhaseState[] = tracer.phases(runId).map((phase) => {
    const phaseEvents = events.filter((event) => event.phaseId === phase.phaseId);
    const session =
      phase.kind === 'agent' && phase.status !== 'queued'
        ? sessions.find((candidate) => candidate.agent === phase.owner)
        : undefined;
    const phaseCheckpoints = checkpoints.filter((item) => item.phaseId === phase.phaseId);
    const errorEvent = [...phaseEvents].reverse().find((event) => event.type === 'error');
    const eventMessage = errorEvent?.payload.message;
    return {
      phaseId: phase.phaseId,
      phase: phase.name,
      kind: phase.kind,
      phaseStatus: phase.status,
      runStatus: run.status,
      agent: phase.kind === 'agent' ? phase.owner || null : null,
      ...phaseIdentity(phaseEvents, session, phaseCheckpoints),
      activeToolCalls: phaseEvents
        .filter(
          (event) =>
            run.status === 'running' &&
            phase.status === 'running' &&
            event.type === 'tool_call' &&
            event.endedAt === null,
        )
        .map((event) => ({
          eventId: event.eventId,
          name: event.name,
          tool: typeof event.payload.tool === 'string' ? event.payload.tool : null,
          startedAt: event.startedAt,
          args: isRecord(event.payload.args) ? event.payload.args : {},
        })),
      lastError:
        phase.error ??
        (typeof eventMessage === 'string' ? eventMessage : (errorEvent?.name ?? null)),
      fileChanges: {
        availability: 'unavailable',
        files: [],
        checkpointIds: phaseCheckpoints.map((item) => item.checkpointId),
        detail: phaseCheckpoints.length
          ? 'Phase-start checkpoints exist, but the trace does not persist a phase-end file diff.'
          : 'No persisted phase file-change evidence is available.',
      },
      pendingApprovals: [],
    };
  });
  return { runId, runStatus: run.status, phases };
}

function phaseIdentity(
  events: EventRow[],
  session: AgentSessionRow | undefined,
  checkpoints: PhaseCheckpointRow[],
): Pick<RunAgentPhaseState, 'model' | 'agentSessionId'> {
  const identity = events.findLast((event) => event.name === 'phase session')?.payload;
  return {
    model:
      typeof identity?.model === 'string'
        ? identity.model
        : (session?.model ?? checkpoints.findLast((item) => item.model)?.model ?? null),
    agentSessionId:
      typeof identity?.agentSessionId === 'string'
        ? identity.agentSessionId
        : (session?.agentSessionId ??
          checkpoints.findLast((item) => item.agentSessionId)?.agentSessionId ??
          null),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
