package com.foundry.companion.data.model

import com.foundry.companion.util.RunFormatters

/**
 * Desktop Inspector (`inspector/entries.tsx`) is the contract for which
 * event types render and which vanish. Unknown types are skipped, never
 * crashed on.
 *
 * Waterfall ticks reuse the same already-fetched [EventRow] list — there is
 * no separate ticks endpoint. Only tool / gate / interrupt leave a mark.
 */
object TranscriptEvents {
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

    fun waterfallTicks(
        phase: PhaseRunSummary,
        events: List<EventRow>,
        nowMs: Long = System.currentTimeMillis()
    ): List<WaterfallTick> {
        val marked = events.filter { event ->
            event.phaseId == phase.resolvedId && WaterfallTickKind.fromEventType(event.type) != null
        }
        if (marked.isEmpty()) return emptyList()

        val startMs = RunFormatters.parseIsoToEpochMs(phase.startedAt)
        val endMs = RunFormatters.parseIsoToEpochMs(phase.endedAt)
            ?: if (phase.isRunning) nowMs else null
        val span = if (startMs != null && endMs != null) {
            (endMs - startMs).coerceAtLeast(1L)
        } else {
            null
        }

        return marked.mapIndexed { index, event ->
            val kind = checkNotNull(WaterfallTickKind.fromEventType(event.type))
            val eventMs = RunFormatters.parseIsoToEpochMs(event.startedAt)
            val fraction = if (span != null && startMs != null && eventMs != null) {
                ((eventMs - startMs).toFloat() / span.toFloat()).coerceIn(0f, 1f)
            } else {
                (index + 1f) / (marked.size + 1f)
            }
            WaterfallTick(
                kind = kind,
                fraction = fraction,
                label = event.name.ifBlank { kind.tag },
                eventId = event.eventId.ifBlank { "row_${event.rowid}" }
            )
        }
    }
}

enum class WaterfallTickKind(val tag: String) {
    TOOL("tool"),
    GATE("gate"),
    GATE_FAIL("gate-fail"),
    INTERRUPT("interrupt");

    companion object {
        fun fromEventType(type: String): WaterfallTickKind? = when (type) {
            "tool_call" -> TOOL
            "gate_pass" -> GATE
            "gate_fail" -> GATE_FAIL
            "interrupt" -> INTERRUPT
            else -> null
        }
    }
}

data class WaterfallTick(
    val kind: WaterfallTickKind,
    val fraction: Float,
    val label: String,
    val eventId: String
)
