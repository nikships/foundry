package com.foundry.companion.data.model

/**
 * Desktop Inspector (`inspector/entries.tsx`) is the contract for which
 * event types render and which vanish. Unknown types are skipped, never
 * crashed on.
 */
object TranscriptEvents {
    val skippedTypes: Set<String> = setOf(
        "agent_start",
        "phase_start",
        "phase_end"
    )

    val knownTypes: Set<String> = setOf(
        "thinking",
        "assistant_text",
        "tool_call",
        "interrupt",
        "gate_pass",
        "gate_fail",
        "correction",
        "error",
        "handoff",
        "compaction",
        "agent_end",
        "log"
    )

    fun isRenderable(type: String): Boolean = type in knownTypes

    fun visibleForPhase(events: List<EventRow>, phaseId: String?): List<EventRow> {
        return events.filter { event ->
            (phaseId == null || event.phaseId == phaseId) && isRenderable(event.type)
        }
    }
}
