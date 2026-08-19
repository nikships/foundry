package com.foundry.companion

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.foundry.companion.data.model.*
import com.foundry.companion.ui.screens.runs.RunsScreen
import com.foundry.companion.ui.theme.FoundryTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RunsScreenTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    private val sampleLiveRun = RunRow(
        runId = "run_live_1",
        pipelineName = "Feature Pipeline",
        request = "Implement live runs monitoring with timer and mini phase strip",
        status = "running",
        startedAt = "2026-08-18T23:30:00Z",
        durationMs = 75000,
        totalTokens = 12000,
        branch = "foundry/run_live_1",
        phases = listOf(
            PhaseRunSummary("p1", "Plan", "agent", "success"),
            PhaseRunSummary("p2", "Spec", "agent", "success"),
            PhaseRunSummary("p3", "Code", "code", "running")
        )
    )

    private val sampleHistoryRuns = listOf(
        RunRow(
            runId = "run_hist_1",
            pipelineName = "Feature Pipeline",
            request = "LAN pairing host and authenticated protocol",
            status = "accepted",
            startedAt = "2026-08-18T22:00:00Z",
            endedAt = "2026-08-18T22:05:30Z",
            durationMs = 330000,
            totalTokens = 45000,
            branch = "foundry/run_hist_1",
            prNumber = 132,
            prUrl = "https://github.com/foundry-app/foundry/pull/132"
        ),
        RunRow(
            runId = "run_hist_2",
            pipelineName = "Bugfix & Verify",
            request = "Protected path boundary violation repair",
            status = "rejected",
            startedAt = "2026-08-18T21:00:00Z",
            endedAt = "2026-08-18T21:03:00Z",
            durationMs = 180000,
            totalTokens = 21000,
            branch = "foundry/run_hist_2"
        ),
        RunRow(
            runId = "run_hist_3",
            pipelineName = "Feature Pipeline",
            request = "Compilation gate failure repair",
            status = "failed",
            startedAt = "2026-08-18T20:00:00Z",
            endedAt = "2026-08-18T20:04:00Z",
            durationMs = 240000,
            totalTokens = 35000,
            branch = "foundry/run_hist_3",
            issueNumber = 140,
            issueUrl = "https://github.com/foundry-app/foundry/issues/140"
        ),
        RunRow(
            runId = "run_hist_4",
            pipelineName = "Feature Pipeline",
            request = "Experimental renderer prototype",
            status = "killed",
            startedAt = "2026-08-18T19:00:00Z",
            endedAt = "2026-08-18T19:02:00Z",
            durationMs = 120000,
            totalTokens = 15000,
            branch = "foundry/run_hist_4"
        ),
        RunRow(
            runId = "run_archived_5",
            pipelineName = "Feature Pipeline",
            request = "This is an archived run and must not be displayed",
            status = "accepted",
            archived = true
        )
    )

    @Test
    fun testLiveRunAndHistoryDisplay() {
        var clickedRunId: String? = null
        var clickedInspectorRunId: String? = null

        composeTestRule.setContent {
            FoundryTheme {
                RunsScreen(
                    runs = listOf(sampleLiveRun) + sampleHistoryRuns,
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    projectName = "Foundry",
                    onRunClick = { clickedRunId = it },
                    onStartRunClick = {},
                    onConnectionPillClick = {},
                    onRetryConnection = {},
                    onInspectorClick = { clickedInspectorRunId = it }
                )
            }
        }

        // Live run section
        composeTestRule.onNodeWithText("IN FLIGHT").assertIsDisplayed()
        composeTestRule.onNodeWithText("Implement live runs monitoring with timer and mini phase strip").assertIsDisplayed()

        // History section
        composeTestRule.onNodeWithText("HISTORY").assertIsDisplayed()
        composeTestRule.onNodeWithText("LAN pairing host and authenticated protocol").assertIsDisplayed()
        composeTestRule.onNodeWithText("PR #132 ↗").assertIsDisplayed()

        // Archived run is hidden
        composeTestRule.onNodeWithText("This is an archived run and must not be displayed").assertDoesNotExist()

        // Clicking live card
        composeTestRule.onNodeWithText("Implement live runs monitoring with timer and mini phase strip").performClick()
        assertEquals("run_live_1", clickedRunId)
    }

    @Test
    fun testPrMarkTappingDirectlyOpensPrWithoutOpeningRun() {
        var clickedRunId: String? = null
        var openedPrUrl: String? = null

        composeTestRule.setContent {
            FoundryTheme {
                RunsScreen(
                    runs = sampleHistoryRuns,
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    projectName = "Foundry",
                    onRunClick = { clickedRunId = it },
                    onStartRunClick = {},
                    onConnectionPillClick = {},
                    onRetryConnection = {},
                    onOpenPr = { openedPrUrl = it }
                )
            }
        }

        // Tap the PR mark on the history row
        composeTestRule.onNodeWithText("PR #132 ↗").performClick()

        // Verifies onOpenPr was called with PR URL and row onRunClick was NOT called
        assertEquals("https://github.com/foundry-app/foundry/pull/132", openedPrUrl)
        assertEquals(null, clickedRunId)
    }

    @Test
    fun testEmptyStateDisplay() {
        var startRunClicked = false

        composeTestRule.setContent {
            FoundryTheme {
                RunsScreen(
                    runs = emptyList(),
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    projectName = "Foundry",
                    onRunClick = {},
                    onStartRunClick = { startRunClicked = true },
                    onConnectionPillClick = {},
                    onRetryConnection = {}
                )
            }
        }

        composeTestRule.onNodeWithText("Nothing has run yet").assertIsDisplayed()
        composeTestRule.onNodeWithText("Describe a change and pick a pipeline — every run is isolated in its own worktree on your Mac.").assertIsDisplayed()
        composeTestRule.onNodeWithText("START A RUN").performClick()
        assertTrue(startRunClicked)
    }

    @Test
    fun testSingleProjectNoSwitcher() {
        composeTestRule.setContent {
            FoundryTheme {
                RunsScreen(
                    runs = emptyList(),
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    projectName = "Foundry Core",
                    projects = listOf(CompanionProjectSummary("p1", "Foundry Core")),
                    selectedProjectId = "p1",
                    onRunClick = {},
                    onStartRunClick = {},
                    onConnectionPillClick = {},
                    onRetryConnection = {}
                )
            }
        }

        composeTestRule.onNodeWithContentDescription("Switch project").assertDoesNotExist()
        composeTestRule.onNodeWithText("Foundry Core").assertIsDisplayed()
    }

    @Test
    fun testMultiProjectSwitcher() {
        var selectedProj: String? = null
        composeTestRule.setContent {
            FoundryTheme {
                RunsScreen(
                    runs = emptyList(),
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    projectName = "Foundry Core",
                    projects = listOf(
                        CompanionProjectSummary("p1", "Foundry Core"),
                        CompanionProjectSummary("p2", "Foundry Docs")
                    ),
                    selectedProjectId = "p1",
                    onSelectProject = { selectedProj = it },
                    onRunClick = {},
                    onStartRunClick = {},
                    onConnectionPillClick = {},
                    onRetryConnection = {}
                )
            }
        }

        composeTestRule.onNodeWithContentDescription("Switch project").assertIsDisplayed()
        composeTestRule.onNodeWithContentDescription("Switch project").performClick()
        composeTestRule.waitForIdle()
        composeTestRule.onNodeWithText("Foundry Docs", useUnmergedTree = true).assertIsDisplayed()
        composeTestRule.onNodeWithText("Foundry Docs", useUnmergedTree = true).performClick()
        assertEquals("p2", selectedProj)
    }
}
