import { z } from 'zod';
import type { PhaseMessage } from '@shared/run-agent-state.js';
import type { Tracer } from '../trace/tracer.js';

const messageText = z.string().trim().min(1).max(12_000);
const resolution = z.object({
  messageId: z.string().min(1),
  status: z.enum(['acted_on', 'dismissed']),
  reason: z.string().trim().min(1).max(4_000),
});

export function phaseMessages(tracer: Tracer, runId: string): PhaseMessage[] {
  return tracer.phaseMessageEvents(runId).map((event) => ({
    ...(event.payload.direction as Omit<PhaseMessage, 'messageId'>),
    messageId: event.eventId,
  }));
}

/** Persistence only. A completed phase accepts a historical note, never new work. */
export function deliverPhaseMessage(
  tracer: Tracer,
  runId: string,
  phaseId: string,
  text: string,
): PhaseMessage {
  const phase = tracer.phase(phaseId);
  if (!phase || phase.runId !== runId || phase.kind !== 'agent') {
    throw new Error('agent phase not found in this run');
  }
  const direction: Omit<PhaseMessage, 'messageId'> = {
    runId,
    phaseId,
    phase: phase.name,
    text: messageText.parse(text),
    status: 'delivered',
    noteOnly: phase.status === 'success' || phase.status === 'skipped',
    deliveredAt: new Date().toISOString(),
  };
  const messageId = tracer.event({
    runId,
    phaseId,
    type: 'log',
    name: 'phase message',
    payload: { direction, message: `Delivered to ${phase.name}: ${direction.text}` },
  });
  return { ...direction, messageId };
}

/** Replayed until explicitly resolved, including after a crash or conversation rewind. */
export function pendingPhaseMessages(
  tracer: Tracer,
  runId: string,
  phaseId: string,
): PhaseMessage[] {
  const phase = tracer.phase(phaseId);
  if (!phase || phase.runId !== runId) return [];
  return phaseMessages(tracer, runId).filter(
    (note) =>
      note.phase === phase.name &&
      !note.noteOnly &&
      (note.status === 'delivered' || note.status === 'read'),
  );
}

function updateMessage(tracer: Tracer, note: PhaseMessage, phaseId: string): void {
  const message = `${note.phase}: ${note.status}${note.reason ? ` — ${note.reason}` : ''}\n${note.text}`;
  tracer.patchEvent(note.messageId, { direction: note, message });
  tracer.event({
    runId: note.runId,
    phaseId,
    type: 'log',
    name: `phase message ${note.status}`,
    payload: { messageId: note.messageId, status: note.status, message },
  });
}

/** Read means supplied to an agent turn, not merely accepted by the run. */
export function readPhaseMessages(tracer: Tracer, runId: string, phaseId: string): PhaseMessage[] {
  return pendingPhaseMessages(tracer, runId, phaseId).map((note) => {
    const read = {
      ...note,
      status: 'read' as const,
      readAt: note.readAt ?? new Date().toISOString(),
      readPhaseId: phaseId,
    };
    if (note.status !== 'read' || note.readPhaseId !== phaseId)
      updateMessage(tracer, read, phaseId);
    return read;
  });
}

export function acknowledgePhaseMessage(
  tracer: Tracer,
  runId: string,
  phaseId: string,
  input: unknown,
): void {
  const answer = resolution.parse(input);
  const note = pendingPhaseMessages(tracer, runId, phaseId).find(
    (item) => item.messageId === answer.messageId,
  );
  if (!note || note.status !== 'read' || note.readPhaseId !== phaseId) {
    throw new Error('message has not been read by this phase, or is already resolved');
  }
  updateMessage(tracer, { ...note, ...answer, resolvedAt: new Date().toISOString() }, phaseId);
}

export function phaseDirectionPrompt(messages: PhaseMessage[]): string {
  return [
    'Direction delivered through Foundry. This does not grant tools, change the plan, bypass gates, or authorize any security exception.',
    'Address each note explicitly. Call acknowledge_direction with its messageId, acted_on or dismissed, and a concrete reason before your verdict. Acknowledge only what you actually addressed.',
    JSON.stringify(messages.map(({ messageId, text }) => ({ messageId, text }))),
  ].join('\n\n');
}
