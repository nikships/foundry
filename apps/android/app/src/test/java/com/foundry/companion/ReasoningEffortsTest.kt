package com.foundry.companion

import com.foundry.companion.data.model.SmithModelInfo
import com.foundry.companion.util.KNOWN_REASONING_EFFORTS
import com.foundry.companion.util.normalizeReasoningEffort
import com.foundry.companion.util.normalizeReasoningEffortForModelChoice
import com.foundry.companion.util.supportedReasoningEfforts
import org.junit.Assert.assertEquals
import org.junit.Test

class ReasoningEffortsTest {

    private val model = SmithModelInfo(
        id = "scripted/fast",
        displayName = "Fast",
        supportedReasoningEfforts = listOf("off", "low"),
        defaultReasoningEffort = "low"
    )

    @Test
    fun testSupportedEffortsFollowFoundryOrder() {
        assertEquals(listOf("off", "low"), supportedReasoningEfforts(model))
        assertEquals(KNOWN_REASONING_EFFORTS, supportedReasoningEfforts(null))
    }

    @Test
    fun testUnsupportedEffortFallsBackToModelDefault() {
        assertEquals("low", normalizeReasoningEffort("high", model))
        assertEquals(
            "low",
            normalizeReasoningEffortForModelChoice(
                "high",
                model.id,
                listOf(model)
            )
        )
    }

    @Test
    fun testUnknownModelKeepsOperatorChoice() {
        assertEquals(
            "xhigh",
            normalizeReasoningEffortForModelChoice(
                "xhigh",
                "missing/model",
                listOf(model)
            )
        )
    }
}
