package com.foundry.companion

import com.foundry.companion.data.model.EventRow
import com.foundry.companion.data.model.TranscriptEvents
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

    private fun row(id: String, phaseId: String, type: String): EventRow {
        return EventRow(
            eventId = id,
            phaseId = phaseId,
            type = type,
            name = type,
            payload = buildJsonObject { put("text", id) },
            startedAt = "23:30:00Z"
        )
    }
}
