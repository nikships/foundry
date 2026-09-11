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

    /**
     * Auto-allow policy verdicts, mirroring desktop `isAutoAllowPolicy` in
     * `renderer/utils/derive.ts`. Older runs recorded one `interrupt` per tool
     * call (`allow (policy)`); new runs no longer write them and views drop
     * leftovers so a reopened trace stays readable.
     */
    fun isAutoAllowPolicy(event: EventRow): Boolean {
        return event.type == "interrupt" &&
            event.payload.booleanOrNull("auto") == true &&
            event.name == "allow (policy)"
    }

    /**
     * A genuine engineer-waiting interrupt: an `interrupt` row that is not an
     * auto-allow policy leftover. There is no companion answer route on the
     * desktop (`shared/companion.ts` carries no interrupt write), so callers
     * must treat this as read-only waiting state, never as an answerable
     * action — the phone never invents endpoints.
     */
    fun isWaitingInterrupt(event: EventRow): Boolean {
        return event.type == "interrupt" && !isAutoAllowPolicy(event)
    }

    /**
     * The question to show for a waiting interrupt, mirroring the desktop
     * Inspector `Banner` detail order: `detail` → `question` → `reason` →
     * the row's text content.
     */
    fun interruptDetail(event: EventRow): String {
        return event.payload.stringOrNull("detail")
            ?.takeIf { it.isNotBlank() }
            ?: event.payload.stringOrNull("question")
                ?.takeIf { it.isNotBlank() }
            ?: event.payload.stringOrNull("reason")
                ?.takeIf { it.isNotBlank() }
            ?: event.textContent.ifBlank { event.name }
    }

    /**
     * The latest waiting interrupt across the given rows, or null when none
     * is waiting. Feeds the amber `waiting` chip / pinned strip state and the
     * high-priority "waiting on you" notification (spec §3.7).
     */
    fun pendingInterrupt(events: List<EventRow>): PendingInterrupt? {
        val waiting = events.filter(::isWaitingInterrupt)
        if (waiting.isEmpty()) return null
        val latest = waiting.maxWith(compareBy<EventRow> { it.rowid }.thenBy { it.changeId })
        return PendingInterrupt(
            eventId = latest.eventId.ifBlank { "row_${latest.rowid}" },
            runId = latest.runId,
            phaseId = latest.phaseId,
            question = interruptDetail(latest)
        )
    }

    fun hasPendingInterrupt(events: List<EventRow>): Boolean = pendingInterrupt(events) != null

    fun visibleForPhase(events: List<EventRow>, phaseId: String?): List<EventRow> {
        return events.filter { event ->
            (phaseId == null || event.phaseId == phaseId) &&
                isRenderable(event.type) &&
                !isAutoAllowPolicy(event)
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

/**
 * Read-only waiting state derived from `interrupt` trace rows (spec §3.7).
 * There is deliberately no answer payload here: the desktop exposes no
 * companion interrupt-answer route, so dismissal can never answer.
 */
data class PendingInterrupt(
    val eventId: String,
    val runId: String = "",
    val phaseId: String? = null,
    val question: String = ""
)

data class WaterfallTick(
    val kind: WaterfallTickKind,
    val fraction: Float,
    val label: String,
    val eventId: String
)
