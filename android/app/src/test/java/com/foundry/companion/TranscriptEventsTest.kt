package com.foundry.companion

import com.foundry.companion.data.model.EventRow
import com.foundry.companion.data.model.PhaseRunSummary
import com.foundry.companion.data.model.TranscriptEvents
import com.foundry.companion.data.model.WaterfallTickKind
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptEventsTest {

    @Test
    fun skipsUnknownAndLifecycleTypes() {
        assertFalse(TranscriptEvents.isRenderable("future_widget"))
        assertFalse(TranscriptEvents.isRenderable("phase_start"))
        assertFalse(TranscriptEvents.isRenderable("phase_end"))
        assertFalse(TranscriptEvents.isRenderable("agent_start"))
        assertTrue(TranscriptEvents.isRenderable("tool_call"))
        assertTrue(TranscriptEvents.isRenderable("assistant_text"))
        assertTrue(TranscriptEvents.isRenderable("error"))
        assertTrue(TranscriptEvents.isRenderable("gate_pass"))
    }

    @Test
    fun filtersByPhaseAndSkipsUnknown() {
        val events = listOf(
            row("a", "p_1", "assistant_text"),
            row("b", "p_1", "future_widget"),
            row("c", "p_3", "tool_call"),
            row("d", "p_1", "phase_start")
        )
        val visible = TranscriptEvents.visibleForPhase(events, "p_1")
        assertEquals(listOf("a"), visible.map { it.eventId })
    }

    @Test
    fun waterfallTicksComeFromToolGateAndInterruptOnly() {
        val phase = PhaseRunSummary(
            id = "p_3",
            name = "Code",
            status = "running",
            startedAt = "2026-08-18T23:30:00Z"
        )
        val events = listOf(
            row("tool", "p_3", "tool_call", "2026-08-18T23:30:10Z"),
            row("gate", "p_3", "gate_fail", "2026-08-18T23:30:20Z"),
            row("int", "p_3", "interrupt", "2026-08-18T23:30:30Z"),
            row("text", "p_3", "assistant_text", "2026-08-18T23:30:15Z"),
            row("other", "p_1", "tool_call", "2026-08-18T23:30:12Z")
        )

        val ticks = TranscriptEvents.waterfallTicks(
            phase,
            events,
            nowMs = java.time.Instant.parse("2026-08-18T23:31:00Z").toEpochMilli()
        )
        assertEquals(
            listOf(WaterfallTickKind.TOOL, WaterfallTickKind.GATE_FAIL, WaterfallTickKind.INTERRUPT),
            ticks.map { it.kind }
        )
        assertEquals(listOf("tool", "gate", "int"), ticks.map { it.eventId })
        assertTrue(ticks[0].fraction < ticks[1].fraction)
        assertTrue(ticks[1].fraction < ticks[2].fraction)
    }

    private fun row(
        id: String,
        phaseId: String,
        type: String,
        startedAt: String = "23:30:00Z"
    ): EventRow {
        return EventRow(
            eventId = id,
            phaseId = phaseId,
            type = type,
            name = type,
            payload = buildJsonObject { put("text", id) },
            startedAt = startedAt
        )
    }
}
