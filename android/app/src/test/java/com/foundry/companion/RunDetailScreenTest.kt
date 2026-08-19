package com.foundry.companion

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.foundry.companion.data.model.*
import com.foundry.companion.ui.screens.run.RunDetailScreen
import com.foundry.companion.ui.theme.FoundryTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RunDetailScreenTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    private val livePhases = listOf(
        PhaseRunSummary(
            id = "p_1",
            name = "Plan",
            kind = "agent",
            status = "success",
            attempt = 1,
            durationMs = 12400,
            tokens = 4120,
            model = "anthropic/claude-3-7-sonnet",
            gateResults = listOf(GateResult("plan_approved", true)),
            envelopeVerdict = "Architecture plan validated against invariants."
        ),
        PhaseRunSummary(
            id = "p_2",
            name = "Spec",
            kind = "agent",
            status = "success",
            attempt = 1,
            durationMs = 24100,
            tokens = 8200,
            model = "anthropic/claude-3-7-sonnet",
            gateResults = listOf(GateResult("spec_complete", true)),
            envelopeVerdict = "Spec and contract definitions generated cleanly."
        ),
        PhaseRunSummary(
            id = "p_3",
            name = "Code",
            kind = "code",
            status = "running",
            attempt = 2,
            durationMs = 45200,
            tokens = 18450,
            model = "anthropic/claude-3-7-sonnet"
        ),
        PhaseRunSummary(
            id = "p_4",
            name = "Review",
            kind = "review",
            status = "queued",
            attempt = 1
        ),
        PhaseRunSummary(
            id = "p_5",
            name = "PR",
            kind = "agent",
            status = "queued",
            attempt = 1
        )
    )

    private val liveRun = RunRow(
        runId = "run_260818_live99",
        projectId = "proj_foundry_core",
        pipelineId = "pipe_default",
        pipelineName = "Feature Pipeline",
        request = "Stand up the Android companion scaffold with Compose navigation and Foundry dark visual system.",
        status = "running",
        startedAt = "2026-08-18T23:30:00Z",
        createdAt = "2026-08-18T23:30:00Z",
        durationMs = 81700,
        totalTokens = 30770,
        branch = "foundry/run_260818_live99",
        phases = livePhases
    )

    private val settledPhases = listOf(
        PhaseRunSummary(
            id = "acc_p1",
            name = "Plan",
            kind = "agent",
            status = "success",
            attempt = 1,
            durationMs = 14200,
            tokens = 3100,
            model = "anthropic/claude-3-7-sonnet",
            gateResults = listOf(GateResult("plan_valid", true)),
            envelopeVerdict = "Plan verified."
        ),
        PhaseRunSummary(
            id = "acc_p2",
            name = "Spec",
            kind = "agent",
            status = "success",
            attempt = 1,
            durationMs = 28100,
            tokens = 7800,
            model = "anthropic/claude-3-7-sonnet"
        ),
        PhaseRunSummary(
            id = "acc_p3",
            name = "Code",
            kind = "code",
            status = "fail",
            attempt = 1,
            durationMs = 189000,
            tokens = 28400,
            model = "anthropic/claude-3-7-sonnet",
            gateResults = listOf(GateResult("compile_gate", false)),
            errorMessage = "Compilation failed with 1 error in bridge.ts"
        )
    )

    private val settledRun = RunRow(
        runId = "run_260818_acc01",
        projectId = "proj_foundry_core",
        pipelineId = "pipe_default",
        pipelineName = "Feature Pipeline",
        request = "LAN pairing host and authenticated companion protocol (FOU-83).",
        status = "accepted",
        startedAt = "2026-08-18T22:10:00Z",
        endedAt = "2026-08-18T22:15:34Z",
        createdAt = "2026-08-18T22:10:00Z",
        finishedAt = "2026-08-18T22:15:34Z",
        durationMs = 334000,
        totalTokens = 52140,
        branch = "foundry/run_260818_acc01",
        prNumber = 132,
        prUrl = "https://github.com/foundry-app/foundry/pull/132",
        outcomeDetail = "All phases passed. Authenticated companion routes verified with token auth.",
        phases = settledPhases
    )

    @Test
    fun testLiveRunHeaderAndWaterfallDisplay() {
        var killedRunId: String? = null
        var inspectorPhaseId: String? = null

        composeTestRule.setContent {
            FoundryTheme {
                RunDetailScreen(
                    runDetail = RunDetail(run = liveRun, phases = livePhases, live = true),
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    onBackClick = {},
                    onOpenInspector = { inspectorPhaseId = it },
                    onKillRun = { killedRunId = it },
                    onOpenPr = {},
                    onCreatePr = {},
                    onOpenIssue = {}
                )
            }
        }

        // Top bar title with pipeline name and short id
        composeTestRule.onNodeWithText("Run · Feature Pipeline · run_260", substring = true).assertIsDisplayed()

        // Status badge and pipeline name in header
        composeTestRule.onAllNodesWithText("RUNNING")[0].assertIsDisplayed()
        composeTestRule.onNodeWithText("Feature Pipeline").assertIsDisplayed()

        // Full request text
        composeTestRule.onNodeWithText("Stand up the Android companion scaffold with Compose navigation and Foundry dark visual system.").assertIsDisplayed()

        // Meta info (duration, tokens, branch name as read-only text)
        composeTestRule.onNodeWithText("30.8k tokens · foundry/run_260818_live99", substring = true).assertIsDisplayed()

        // KILL action is visible on live runs
        composeTestRule.onNodeWithText("KILL").assertIsDisplayed()

        // Waterfall section
        composeTestRule.onNodeWithText("PHASE WATERFALL").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("Plan").assertIsDisplayed()
        composeTestRule.onNodeWithText("Spec").assertIsDisplayed()
        composeTestRule.onNodeWithText("Code ×2").assertIsDisplayed()

        // Default selected phase summary is running phase ("Code")
        composeTestRule.onNodeWithText("PHASE · CODE").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("anthropic/claude-3-7-sonnet").assertExists()

        // Clicking Inspector button in top bar opens inspector on selected phase
        composeTestRule.onNodeWithContentDescription("Inspector").performClick()
        assertEquals("p_3", inspectorPhaseId)
    }

    @Test
    fun testKillRunConfirmationFlow() {
        var killedRunId: String? = null

        composeTestRule.setContent {
            FoundryTheme {
                RunDetailScreen(
                    runDetail = RunDetail(run = liveRun, phases = livePhases, live = true),
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    onBackClick = {},
                    onOpenInspector = {},
                    onKillRun = { killedRunId = it },
                    onOpenPr = {},
                    onCreatePr = {},
                    onOpenIssue = {}
                )
            }
        }

        // Tap KILL action in top bar
        composeTestRule.onNodeWithText("KILL").performClick()

        // Confirmation dialog appears with verbatim desktop copy
        composeTestRule.onNodeWithText("KILL RUN").assertIsDisplayed()
        composeTestRule.onNodeWithText("Kill this run? In-flight agent turns stop; the worktree branch is kept.").assertIsDisplayed()

        // Confirm kill
        composeTestRule.onAllNodesWithText("KILL")[1].performClick()
        assertEquals("run_260818_live99", killedRunId)
    }

    @Test
    fun testKillButtonDisabledWhenOffline() {
        composeTestRule.setContent {
            FoundryTheme {
                RunDetailScreen(
                    runDetail = RunDetail(run = liveRun, phases = livePhases, live = true),
                    connectionStatus = ConnectionStatus.Offline("Nik's Mac", "http://192.168.1.100"),
                    onBackClick = {},
                    onOpenInspector = {},
                    onKillRun = {},
                    onOpenPr = {},
                    onCreatePr = {},
                    onOpenIssue = {}
                )
            }
        }

        // Offline banner shown
        composeTestRule.onNodeWithText("Can't reach Nik's Mac. Is Foundry running on the same Wi-Fi?", substring = true).assertIsDisplayed()

        // KILL action is disabled
        composeTestRule.onNodeWithText("KILL").assertIsNotEnabled()
    }

    @Test
    fun testSettledRunDisplaysOutcomeCardAndNoKillButton() {
        var openedPrUrl: String? = null
        var copiedUrl: String? = null

        composeTestRule.setContent {
            FoundryTheme {
                RunDetailScreen(
                    runDetail = RunDetail(run = settledRun, phases = settledPhases, live = false),
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    onBackClick = {},
                    onOpenInspector = {},
                    onKillRun = {},
                    onOpenPr = { openedPrUrl = it },
                    onCreatePr = {},
                    onOpenIssue = {},
                    onCopyPrUrl = { copiedUrl = it }
                )
            }
        }

        // KILL button must not exist on settled run
        composeTestRule.onNodeWithText("KILL").assertDoesNotExist()

        // Outcome card is mounted directly below header
        composeTestRule.onNodeWithText("RUN ACCEPTED").assertExists()
        composeTestRule.onNodeWithText("All phases passed. Authenticated companion routes verified with token auth.").assertExists()
        composeTestRule.onNodeWithText("OPEN PR #132 ↗").performScrollTo().assertIsDisplayed()

        // Tap PR button
        composeTestRule.onNodeWithText("OPEN PR #132 ↗").performClick()
        assertEquals("https://github.com/foundry-app/foundry/pull/132", openedPrUrl)

        // Tap Copy PR URL button
        composeTestRule.onNodeWithText("COPY PR URL").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("COPY PR URL").performClick()
        assertEquals("https://github.com/foundry-app/foundry/pull/132", copiedUrl)
        composeTestRule.onNodeWithText("COPIED URL").assertIsDisplayed()

        // Verify NO merge or discard controls exist on the phone
        composeTestRule.onNodeWithText("Merge branch", substring = true).assertDoesNotExist()
        composeTestRule.onNodeWithText("Discard", substring = true).assertDoesNotExist()
        composeTestRule.onNodeWithText("Fix & merge", substring = true).assertDoesNotExist()
    }

    @Test
    fun testOutcomeCardAcceptedWithoutPrCanCreatePr() {
        var createPrRunId: String? = null
        val runWithoutPr = settledRun.copy(
            prNumber = null,
            prUrl = null,
            branch = "foundry/run_260818_acc01"
        )

        composeTestRule.setContent {
            FoundryTheme {
                RunDetailScreen(
                    runDetail = RunDetail(run = runWithoutPr, phases = settledPhases, live = false),
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    onBackClick = {},
                    onOpenInspector = {},
                    onKillRun = {},
                    onOpenPr = {},
                    onCreatePr = { createPrRunId = it },
                    onOpenIssue = {}
                )
            }
        }

        // Outcome card shows Create PR… button
        composeTestRule.onNodeWithText("RUN ACCEPTED").assertExists()
        composeTestRule.onNodeWithText("CREATE PR…").performScrollTo().assertIsDisplayed()

        composeTestRule.onNodeWithText("CREATE PR…").performClick()
        assertEquals("run_260818_acc01", createPrRunId)
    }

    @Test
    fun testOutcomeCardCreatePrDisabledWhenGhUnavailable() {
        val runWithoutPr = settledRun.copy(
            prNumber = null,
            prUrl = null,
            branch = "foundry/run_260818_acc01"
        )
        val ghOffline = GhStatus(
            available = false,
            detail = "gh is not signed in — run `gh auth login` in a terminal"
        )

        composeTestRule.setContent {
            FoundryTheme {
                RunDetailScreen(
                    runDetail = RunDetail(run = runWithoutPr, phases = settledPhases, live = false),
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    ghStatus = ghOffline,
                    onBackClick = {},
                    onOpenInspector = {},
                    onKillRun = {},
                    onOpenPr = {},
                    onCreatePr = {},
                    onOpenIssue = {}
                )
            }
        }

        // Button is disabled with one-line helper text
        composeTestRule.onNodeWithText("CREATE PR…").performScrollTo().assertIsNotEnabled()
        composeTestRule.onNodeWithText("gh is not signed in — run `gh auth login` in a terminal").assertIsDisplayed()
    }

    @Test
    fun testOutcomeCardKilledAndFailedRuns() {
        var openedIssueUrl: String? = null

        val failedRunWithIssue = RunRow(
            runId = "run_fail_1",
            pipelineName = "Feature Pipeline",
            request = "Fix type checking in parser",
            status = "failed",
            durationMs = 120000,
            issueNumber = 140,
            issueUrl = "https://github.com/foundry-app/foundry/issues/140",
            outcomeDetail = "Compilation failed after 3 retries."
        )

        composeTestRule.setContent {
            FoundryTheme {
                RunDetailScreen(
                    runDetail = RunDetail(run = failedRunWithIssue, phases = emptyList(), live = false),
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    onBackClick = {},
                    onOpenInspector = {},
                    onKillRun = {},
                    onOpenPr = {},
                    onCreatePr = {},
                    onOpenIssue = { openedIssueUrl = it }
                )
            }
        }

        composeTestRule.onNodeWithText("RUN FAILED").assertExists()
        composeTestRule.onNodeWithText("Compilation failed after 3 retries.").assertExists()
        composeTestRule.onNodeWithText("ISSUE #140 ↗").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("CREATE PR…").assertDoesNotExist()

        composeTestRule.onNodeWithText("ISSUE #140 ↗").performClick()
        assertEquals("https://github.com/foundry-app/foundry/issues/140", openedIssueUrl)
    }

    @Test
    fun testOutcomeCardMergedRunDisplaysMergedBadge() {
        val mergedRun = settledRun.copy(
            merged = true
        )

        composeTestRule.setContent {
            FoundryTheme {
                RunDetailScreen(
                    runDetail = RunDetail(run = mergedRun, phases = settledPhases, live = false),
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    onBackClick = {},
                    onOpenInspector = {},
                    onKillRun = {},
                    onOpenPr = {},
                    onCreatePr = {},
                    onOpenIssue = {}
                )
            }
        }

        // Merged badge inside outcome card
        composeTestRule.onNodeWithText("MERGED").assertIsDisplayed()
        // No create PR verb on merged run
        composeTestRule.onNodeWithText("CREATE PR…").assertDoesNotExist()
    }

    @Test
    fun testPhaseSelectionAndSummaryDetails() {
        var openedPhaseTranscript: String? = null

        composeTestRule.setContent {
            FoundryTheme {
                RunDetailScreen(
                    runDetail = RunDetail(run = settledRun, phases = settledPhases, live = false),
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    onBackClick = {},
                    onOpenInspector = { openedPhaseTranscript = it },
                    onKillRun = {},
                    onOpenPr = {},
                    onCreatePr = {},
                    onOpenIssue = {}
                )
            }
        }

        // Initially default selected phase is the failed phase ("Code")
        composeTestRule.onNodeWithText("PHASE · CODE").assertExists()
        composeTestRule.onNodeWithText("ERROR").assertExists()
        composeTestRule.onNodeWithText("Compilation failed with 1 error in bridge.ts").assertExists()
        composeTestRule.onNodeWithText("compile_gate").assertExists()

        // Tap "Plan" phase lane in waterfall
        composeTestRule.onNodeWithText("Plan").performScrollTo().performClick()

        // Summary switches to Plan phase
        composeTestRule.onNodeWithText("PHASE · PLAN").assertExists()
        composeTestRule.onNodeWithText("ENVELOPE VERDICT").assertExists()
        composeTestRule.onNodeWithText("Plan verified.").assertExists()
        composeTestRule.onNodeWithText("plan_valid").assertExists()

        // Tap "VIEW TRANSCRIPT" button in summary
        composeTestRule.onNodeWithText("VIEW TRANSCRIPT").performScrollTo().performClick()
        assertEquals("acc_p1", openedPhaseTranscript)
    }

    @Test
    fun testEngineerInterruptBannerDisplay() {
        val sampleInterrupt = PendingInterrupt(
            interruptId = "int_42",
            runId = "run_260818_live99",
            pipelineName = "Feature Pipeline",
            phaseName = "Engineer Checkpoint",
            question = "Do you want to enable automatic database backup migration?",
            kind = "engineer"
        )

        composeTestRule.setContent {
            FoundryTheme {
                RunDetailScreen(
                    runDetail = RunDetail(run = liveRun, phases = livePhases, live = true),
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    pendingInterrupt = sampleInterrupt,
                    onBackClick = {},
                    onOpenInspector = {},
                    onKillRun = {},
                    onOpenPr = {},
                    onCreatePr = {},
                    onOpenIssue = {},
                    onAnswerInterrupt = { _, _, _ -> }
                )
            }
        }

        // Pinned amber engineer interrupt strip above header
        composeTestRule.onNodeWithText("ENGINEER INTERRUPT").assertIsDisplayed()
        composeTestRule.onNodeWithText("An engineer phase is waiting for your answer.").assertIsDisplayed()
        composeTestRule.onNodeWithText("Answer…").assertIsDisplayed()
    }

    @Test
    fun testInterruptContentApproveAndReject() {
        var answeredApproved: Boolean? = null
        var answeredNotes: String? = null

        val sampleInterrupt = PendingInterrupt(
            interruptId = "int_42",
            runId = "run_260818_live99",
            pipelineName = "Feature Pipeline",
            phaseName = "Engineer Checkpoint",
            question = "Do you want to enable automatic database backup migration?",
            kind = "engineer"
        )

        composeTestRule.setContent {
            FoundryTheme {
                com.foundry.companion.ui.components.InterruptContent(
                    interrupt = sampleInterrupt,
                    onApprove = { notes ->
                        answeredApproved = true
                        answeredNotes = notes
                    },
                    onReject = { notes ->
                        answeredApproved = false
                        answeredNotes = notes
                    }
                )
            }
        }

        composeTestRule.onNodeWithText("Do you want to enable automatic database backup migration?").assertIsDisplayed()
        composeTestRule.onNodeWithText("Optional operator notes or guidance…").performTextInput("Looks solid, approve.")
        composeTestRule.onNodeWithText("APPROVE").performClick()

        assertEquals(true, answeredApproved)
        assertEquals("Looks solid, approve.", answeredNotes)
    }

    @Test
    fun testEmptyWaterfallState() {
        val queuedPhases = listOf(
            PhaseRunSummary("q1", "Plan", "agent", "queued"),
            PhaseRunSummary("q2", "Code", "code", "queued")
        )
        val queuedRun = liveRun.copy(status = "running", phases = queuedPhases)

        composeTestRule.setContent {
            FoundryTheme {
                RunDetailScreen(
                    runDetail = RunDetail(run = queuedRun, phases = queuedPhases, live = true),
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    onBackClick = {},
                    onOpenInspector = {},
                    onKillRun = {},
                    onOpenPr = {},
                    onCreatePr = {},
                    onOpenIssue = {}
                )
            }
        }

        // Empty state message when no phase has started
        composeTestRule.onNodeWithText("Waiting for the first phase…").assertIsDisplayed()
    }
}
