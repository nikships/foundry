package com.foundry.companion

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.EventRow
import com.foundry.companion.data.model.PhaseRunSummary
import com.foundry.companion.data.model.RunDetail
import com.foundry.companion.data.model.RunRow
import com.foundry.companion.ui.screens.inspector.InspectorScreen
import com.foundry.companion.ui.theme.FoundryTheme
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class InspectorScreenTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    private val livePhases = listOf(
        PhaseRunSummary(id = "p_1", name = "Plan", status = "success"),
        PhaseRunSummary(id = "p_3", name = "Code", status = "running"),
        PhaseRunSummary(id = "p_4", name = "Review", status = "queued"),
        PhaseRunSummary(id = "p_fail", name = "Patch", status = "fail")
    )

    private val liveRun = RunRow(
        runId = "run_live",
        pipelineName = "Feature Pipeline",
        request = "Mobile inspector transcript",
        status = "running",
        phases = livePhases
    )

    private val sampleEvents = listOf(
        event("ev_text", "p_3", "assistant_text", "New tool call landed in the focused phase."),
        event("ev_tool", "p_3", "tool_call", "read spec", name = "read: spec.md"),
        event("ev_unknown", "p_3", "future_widget", "should vanish"),
        event("ev_phase", "p_3", "phase_start", "should vanish"),
        event("ev_plan", "p_1", "assistant_text", "Plan prose from history.")
    )

    @Test
    fun liveRunShowsFocusedPhaseEventsAndSkipsUnknown() {
        composeTestRule.setContent {
            FoundryTheme {
                InspectorScreen(
                    runDetail = RunDetail(run = liveRun, phases = livePhases, live = true),
                    events = sampleEvents,
                    initialPhaseId = "p_3",
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.1"),
                    onBackClick = {},
                    onPhaseSelected = {}
                )
            }
        }

        composeTestRule.onNodeWithText("Inspector · Code").assertIsDisplayed()
        composeTestRule.onNodeWithText("New tool call landed in the focused phase.").assertIsDisplayed()
        composeTestRule.onNodeWithTag("inspector-tool-ev_tool").assertIsDisplayed()
        composeTestRule.onNodeWithTag("inspector-tool-body-ev_tool").assertDoesNotExist()
        composeTestRule.onNodeWithText("should vanish").assertDoesNotExist()
        composeTestRule.onNodeWithTag("inspector-live-caret").assertIsDisplayed()
    }

    @Test
    fun expandingToolCallRevealsPayloadAndCollapseAllHidesIt() {
        composeTestRule.setContent {
            FoundryTheme {
                InspectorScreen(
                    runDetail = RunDetail(run = liveRun, phases = livePhases, live = true),
                    events = sampleEvents,
                    initialPhaseId = "p_3",
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.1"),
                    onBackClick = {},
                    onPhaseSelected = {}
                )
            }
        }

        composeTestRule.onNodeWithTag("inspector-tool-toggle-ev_tool").performClick()
        composeTestRule.onNodeWithTag("inspector-tool-body-ev_tool").assertExists()
        composeTestRule.onNodeWithTag("inspector-collapse-all").performClick()
        composeTestRule.onNodeWithTag("inspector-tool-body-ev_tool").assertDoesNotExist()
    }

    @Test
    fun switchingPhaseKeepsSameRunAndShowsThatTranscript() {
        var selected: String? = "p_3"
        composeTestRule.setContent {
            FoundryTheme {
                InspectorScreen(
                    runDetail = RunDetail(run = liveRun, phases = livePhases, live = true),
                    events = sampleEvents,
                    initialPhaseId = "p_3",
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.1"),
                    onBackClick = {},
                    onPhaseSelected = { selected = it }
                )
            }
        }

        composeTestRule.onNodeWithTag("inspector-phase-p_1").performClick()
        assertEquals("p_1", selected)
        composeTestRule.onNodeWithText("Inspector · Plan").assertIsDisplayed()
        composeTestRule.onNodeWithText("Plan prose from history.").assertIsDisplayed()
        composeTestRule.onNodeWithText("New tool call landed in the focused phase.").assertDoesNotExist()
    }

    @Test
    fun liveAppendAppearsWithoutLeavingScreen() {
        var events by mutableStateOf(sampleEvents)
        composeTestRule.setContent {
            FoundryTheme {
                InspectorScreen(
                    runDetail = RunDetail(run = liveRun, phases = livePhases, live = true),
                    events = events,
                    initialPhaseId = "p_3",
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.1"),
                    onBackClick = {},
                    onPhaseSelected = {}
                )
            }
        }

        composeTestRule.onNodeWithText("EVENTS (2)").assertExists()
        events = sampleEvents + event("ev_new", "p_3", "tool_call", "second tool", name = "read: next.md")
        composeTestRule.waitForIdle()
        composeTestRule.onNodeWithText("EVENTS (3)").assertExists()
        composeTestRule.onNodeWithText("Inspector · Code").assertExists()
    }

    @Test
    fun historyRunShowsFinishedTranscriptAndQueuedEmptyState() {
        val settledPhases = listOf(
            PhaseRunSummary(id = "acc_p1", name = "Plan", status = "success"),
            PhaseRunSummary(id = "acc_p2", name = "Review", status = "queued")
        )
        val settled = liveRun.copy(runId = "run_hist", status = "accepted", phases = settledPhases)
        val historyEvents = listOf(
            event("hist_1", "acc_p1", "assistant_text", "Finished plan transcript.")
        )

        composeTestRule.setContent {
            FoundryTheme {
                InspectorScreen(
                    runDetail = RunDetail(run = settled, phases = settledPhases, live = false),
                    events = historyEvents,
                    initialPhaseId = "acc_p1",
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.1"),
                    onBackClick = {},
                    onPhaseSelected = {}
                )
            }
        }

        composeTestRule.onNodeWithText("Finished plan transcript.").assertIsDisplayed()
        composeTestRule.onNodeWithTag("inspector-live-caret").assertDoesNotExist()

        composeTestRule.onNodeWithTag("inspector-phase-acc_p2").performClick()
        composeTestRule.onNodeWithText("This phase hasn't started yet.").assertIsDisplayed()
        composeTestRule.onNodeWithText("runs after Plan").assertIsDisplayed()
    }

    @Test
    fun filterHidesNonMatchingPhases() {
        composeTestRule.setContent {
            FoundryTheme {
                InspectorScreen(
                    runDetail = RunDetail(run = liveRun, phases = livePhases, live = true),
                    events = sampleEvents,
                    initialPhaseId = "p_3",
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.1"),
                    onBackClick = {},
                    onPhaseSelected = {}
                )
            }
        }

        composeTestRule.onNodeWithTag("inspector-filter-failed").performClick()
        composeTestRule.onNodeWithText("Inspector · Patch").assertIsDisplayed()
        composeTestRule.onNodeWithTag("inspector-phase-p_3").assertDoesNotExist()
    }

    @Test
    fun emptyProjectAndOfflineBanner() {
        composeTestRule.setContent {
            FoundryTheme {
                InspectorScreen(
                    runDetail = null,
                    events = emptyList(),
                    initialPhaseId = null,
                    connectionStatus = ConnectionStatus.Offline("Nik's Mac", "http://192.168.1.1"),
                    hasProject = false,
                    onBackClick = {},
                    onPhaseSelected = {}
                )
            }
        }

        composeTestRule.onNodeWithTag("inspector-empty-project").assertIsDisplayed()
        composeTestRule.onNodeWithText("No project yet").assertIsDisplayed()
        composeTestRule.onNodeWithText("Can't reach Nik's Mac. Is Foundry running on the same Wi-Fi?", substring = true).assertIsDisplayed()
    }

    private fun event(
        id: String,
        phaseId: String,
        type: String,
        text: String,
        name: String = type
    ): EventRow {
        return EventRow(
            eventId = id,
            phaseId = phaseId,
            type = type,
            name = name,
            payload = buildJsonObject { put("text", text) },
            startedAt = "23:30:00Z",
            endedAt = if (type == "tool_call" && id == "ev_tool") "23:30:01Z" else "23:30:01Z"
        )
    }
}
