package com.foundry.companion

import android.content.Context
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import com.foundry.companion.data.model.COMPANION_PROTOCOL_VERSION
import com.foundry.companion.data.model.CompanionPairingPayload
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.PairedSession
import com.foundry.companion.data.repository.FakeCompanionRepository
import com.foundry.companion.data.session.SessionManager
import com.foundry.companion.viewmodel.CompanionViewModel
import com.foundry.companion.viewmodel.defaultCompanionDeviceName
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class CompanionViewModelTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var repository: FakeCompanionRepository
    private lateinit var sessionManager: SessionManager
    private lateinit var viewModel: CompanionViewModel

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        val context = ApplicationProvider.getApplicationContext<Context>()
        sessionManager = SessionManager(context)
        sessionManager.clearSession()
        sessionManager.clearNewRunDraft()
        sessionManager.setSelectedProjectId(null)

        repository = FakeCompanionRepository(initialPaired = true)
        viewModel = CompanionViewModel(repository, sessionManager, enablePolling = false)
        testDispatcher.scheduler.advanceUntilIdle()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun testInitialLoadedState() {
        val state = viewModel.uiState.value
        assertTrue(state.connectionStatus is ConnectionStatus.Connected)
        assertTrue(state.projects.isNotEmpty())
        assertTrue(state.runs.isNotEmpty())
        assertEquals("proj_foundry_core", state.selectedProjectId)
    }

    @Test
    fun testStartRunFlow() {
        var createdRunId: String? = null
        viewModel.startRun(
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default",
            request = "Test starting run from view model"
        ) { newRunId ->
            createdRunId = newRunId
        }

        testDispatcher.scheduler.advanceUntilIdle()
        assertNotNull(createdRunId)
        val runs = viewModel.uiState.value.runs
        assertTrue(runs.any { it.runId == createdRunId })
        assertEquals("pipe_default", viewModel.getLastUsedPipeline("proj_foundry_core"))
    }

    @Test
    fun testStartRunRejectedWithValidationIssues() {
        var callbackInvoked = false
        viewModel.startRun(
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default",
            request = ""
        ) {
            callbackInvoked = true
        }

        testDispatcher.scheduler.advanceUntilIdle()
        assertFalse(callbackInvoked)
        val issues = viewModel.uiState.value.validationIssues
        assertTrue(issues.isNotEmpty())
        assertEquals("error", issues.first().level)
        assertTrue(issues.first().message.contains("request cannot be empty"))

        viewModel.clearValidationIssues()
        assertTrue(viewModel.uiState.value.validationIssues.isEmpty())
    }

    @Test
    fun testLastUsedPipelineManagement() {
        assertNull(viewModel.getLastUsedPipeline("proj_foundry_docs"))
        viewModel.setLastUsedPipeline("proj_foundry_docs", "pipe_bugfix")
        assertEquals("pipe_bugfix", viewModel.getLastUsedPipeline("proj_foundry_docs"))
        assertEquals("pipe_bugfix", sessionManager.getLastUsedPipeline("proj_foundry_docs"))
    }

    @Test
    fun testPairFlowWithPayload() {
        val unpairedRepo = FakeCompanionRepository(initialPaired = false)
        val vm = CompanionViewModel(unpairedRepo, sessionManager, enablePolling = false)
        testDispatcher.scheduler.advanceUntilIdle()

        assertTrue(vm.uiState.value.connectionStatus is ConnectionStatus.Unpaired)
        assertNull(vm.uiState.value.activeSession)

        val payload = CompanionPairingPayload(
            protocolVersion = COMPANION_PROTOCOL_VERSION,
            origin = "http://192.168.1.100:52810",
            desktopId = "desk_01",
            desktopName = "Nik’s Mac",
            secret = "sec_test_abc",
            expiresAt = "2026-08-19T12:00:00Z"
        )
        vm.pair(payload)
        testDispatcher.scheduler.advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.isPairing)
        assertNull(state.errorMessage)
        assertTrue(state.connectionStatus is ConnectionStatus.Connected)
        assertNotNull(state.activeSession)
        assertEquals("Nik’s Mac", state.activeSession?.desktopName)

        // Verifies session was persisted into sessionManager
        val stored = sessionManager.getSession()
        assertNotNull(stored)
        assertEquals("Nik’s Mac", stored?.desktopName)
        assertEquals(defaultCompanionDeviceName(), unpairedRepo.lastPairedDeviceName)
        assertEquals(Build.MODEL.trim().ifBlank { "Android Device" }, unpairedRepo.lastPairedDeviceName)
        assertFalse(unpairedRepo.lastPairedDeviceName.isNullOrBlank())
    }

    @Test
    fun testPairSendsExplicitDeviceName() {
        val unpairedRepo = FakeCompanionRepository(initialPaired = false)
        val vm = CompanionViewModel(
            unpairedRepo,
            sessionManager,
            enablePolling = false,
            deviceName = "Pixel 8 Pro"
        )
        testDispatcher.scheduler.advanceUntilIdle()

        vm.pair(
            CompanionPairingPayload(
                protocolVersion = COMPANION_PROTOCOL_VERSION,
                origin = "http://192.168.1.100:52810",
                desktopId = "desk_01",
                desktopName = "Nik’s Mac",
                secret = "sec_test_abc",
                expiresAt = "2026-08-19T12:00:00Z"
            )
        )
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals("Pixel 8 Pro", unpairedRepo.lastPairedDeviceName)
        assertNotEquals("Android Device", unpairedRepo.lastPairedDeviceName)
    }

    @Test
    fun testUnpairFlow() {
        viewModel.unpair()
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value
        assertTrue(state.connectionStatus is ConnectionStatus.Unpaired)
        assertNull(state.activeSession)
        assertTrue(state.runs.isEmpty())
        assertNull(sessionManager.getSession())
    }

    @Test
    fun testToggleNotificationPreference() {
        viewModel.toggleNotifyOnSettle(false)
        assertFalse(viewModel.uiState.value.isNotifyOnSettleEnabled)
        assertFalse(sessionManager.isNotifyOnSettleEnabled())

        viewModel.toggleNotifyOnSettle(true)
        assertTrue(viewModel.uiState.value.isNotifyOnSettleEnabled)
        assertTrue(sessionManager.isNotifyOnSettleEnabled())
    }

    @Test
    fun testSelectProject() {
        viewModel.selectProject("proj_foundry_docs")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("proj_foundry_docs", viewModel.uiState.value.selectedProjectId)
        assertEquals("proj_foundry_docs", sessionManager.getSelectedProjectId())
    }

    @Test
    fun testSelectedProjectSurvivesRestart() {
        viewModel.selectProject("proj_foundry_docs")
        testDispatcher.scheduler.advanceUntilIdle()

        val restarted = CompanionViewModel(repository, sessionManager, enablePolling = false)
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("proj_foundry_docs", restarted.uiState.value.selectedProjectId)
        assertEquals("proj_foundry_docs", sessionManager.getSelectedProjectId())
    }

    @Test
    fun testDeepLinkProjectOverridesPersistedFocus() {
        viewModel.selectProject("proj_foundry_core")
        testDispatcher.scheduler.advanceUntilIdle()

        val restarted = CompanionViewModel(repository, sessionManager, enablePolling = false)
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("proj_foundry_core", restarted.uiState.value.selectedProjectId)

        // foundry://run/{id}?project=proj_foundry_docs (or the notification extra)
        restarted.selectProject("proj_foundry_docs")
        restarted.loadRunDetail("run_260818_live99")
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals("proj_foundry_docs", restarted.uiState.value.selectedProjectId)
        assertEquals("proj_foundry_docs", sessionManager.getSelectedProjectId())
        assertEquals("run_260818_live99", restarted.uiState.value.currentRunDetail?.run?.runId)
    }

    @Test
    fun testNewRunDraftSurvivesRestartAndClearsOnSuccessfulStart() {
        assertEquals("", viewModel.getNewRunDraft())
        viewModel.setNewRunDraft("Add companion draft persistence")
        assertEquals("Add companion draft persistence", viewModel.getNewRunDraft())

        val restarted = CompanionViewModel(repository, sessionManager, enablePolling = false)
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("Add companion draft persistence", restarted.getNewRunDraft())

        restarted.startRun(
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default",
            request = "Add companion draft persistence"
        ) { }
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("", restarted.getNewRunDraft())
    }

    @Test
    fun testNewRunDraftIsKeptOnFailedStartAndClearedOnDismiss() {
        viewModel.setNewRunDraft("keep this draft")
        viewModel.startRun(
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default",
            request = ""
        ) { }
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("keep this draft", viewModel.getNewRunDraft())
        assertTrue(viewModel.uiState.value.validationIssues.isNotEmpty())

        viewModel.clearNewRunDraft()
        assertEquals("", viewModel.getNewRunDraft())
    }

    @Test
    fun testLivePollingUpdates() = runTest(testDispatcher) {
        val vmWithPolling = CompanionViewModel(repository, sessionManager, enablePolling = true)
        testDispatcher.scheduler.advanceTimeBy(100)
        assertTrue(vmWithPolling.uiState.value.runs.isNotEmpty())

        // Start a run and ensure polling picks it up after interval
        repository.startRun(
            com.foundry.companion.data.model.StartRunInput(
                projectId = "proj_foundry_core",
                pipelineId = "pipe_default",
                request = "A new live run started externally"
            )
        )
        testDispatcher.scheduler.advanceTimeBy(2500)
        assertTrue(vmWithPolling.uiState.value.runs.any { it.request == "A new live run started externally" })
        vmWithPolling.stopPolling()
    }

    @Test
    fun testInspectorEventsLoadAndLiveMerge() {
        viewModel.loadRunDetail("run_260818_live99")
        viewModel.loadTranscriptEvents("run_260818_live99", "p_3")
        testDispatcher.scheduler.advanceUntilIdle()

        val initial = viewModel.uiState.value.eventRows
        assertTrue(initial.isNotEmpty())
        assertTrue(initial.any { it.type == "tool_call" })
        assertTrue(initial.any { it.type == "future_widget" })

        val extra = com.foundry.companion.data.model.EventRow(
            rowid = 99,
            changeId = 99,
            eventId = "ev_live_append",
            runId = "run_260818_live99",
            phaseId = "p_3",
            type = "tool_call",
            name = "read: next.md",
            payload = buildJsonObject { put("kind", "read") },
            startedAt = "23:31:00Z"
        )
        repository.appendEvent(extra)

        val polling = CompanionViewModel(repository, sessionManager, enablePolling = true)
        polling.loadRunDetail("run_260818_live99")
        polling.loadTranscriptEvents("run_260818_live99")
        testDispatcher.scheduler.advanceTimeBy(100)
        testDispatcher.scheduler.advanceTimeBy(2500)
        assertTrue(polling.uiState.value.eventRows.any { it.eventId == "ev_live_append" })
        polling.stopPolling()
    }

    @Test
    fun testKillRunFlow() {
        viewModel.loadRunDetail("run_260818_live99")
        testDispatcher.scheduler.advanceUntilIdle()

        var detail = viewModel.uiState.value.currentRunDetail
        assertNotNull(detail)
        assertEquals("running", detail?.run?.status)

        viewModel.killRun("run_260818_live99")
        testDispatcher.scheduler.advanceUntilIdle()

        detail = viewModel.uiState.value.currentRunDetail
        assertNotNull(detail)
        assertEquals("killed", detail?.run?.status)
    }

    @Test
    fun testMissingRunIsReportedRatherThanLeftLoading() {
        viewModel.loadRunDetail("run_260818_live99")
        testDispatcher.scheduler.advanceUntilIdle()
        assertNotNull(viewModel.uiState.value.currentRunDetail)

        viewModel.loadRunDetail("run_that_the_desktop_discarded")
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals("run_that_the_desktop_discarded", state.missingRunId)
        assertNull(state.currentRunDetail)
        assertNull(state.errorMessage)

        viewModel.loadRunDetail("run_260818_live99")
        testDispatcher.scheduler.advanceUntilIdle()
        val recovered = viewModel.uiState.value
        assertNull(recovered.missingRunId)
        assertEquals("run_260818_live99", recovered.currentRunDetail?.run?.runId)
        assertNull(recovered.errorMessage)
    }

    @Test
    fun testAnswerInterruptFlow() {
        val interrupt = com.foundry.companion.data.model.PendingInterrupt(
            interruptId = "int_99",
            runId = "run_260818_live99",
            question = "Approve schema change?"
        )
        repository.setPendingInterrupts(listOf(interrupt))
        viewModel.loadPendingInterrupts()
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals(1, viewModel.uiState.value.pendingInterrupts.size)
        assertEquals("int_99", viewModel.uiState.value.pendingInterrupts.first().interruptId)

        viewModel.answerInterrupt("int_99", approved = true, notes = "Approved from phone")
        testDispatcher.scheduler.advanceUntilIdle()

        assertTrue(viewModel.uiState.value.pendingInterrupts.isEmpty())
    }

    @Test
    fun testWaitingChipIsDerivedFromPendingInterruptRunId() {
        // The host never stamps waitingInterrupt on a run row; only the runId
        // join with GET /v1/interrupts can light the chip against a real Mac.
        assertTrue(viewModel.uiState.value.runs.none { it.waitingInterrupt })

        repository.setPendingInterrupts(
            listOf(
                com.foundry.companion.data.model.PendingInterrupt(
                    interruptId = "int_waiting",
                    runId = "run_260818_live99",
                    question = "Approve schema change?"
                )
            )
        )
        viewModel.loadPendingInterrupts()
        testDispatcher.scheduler.advanceUntilIdle()

        val runs = viewModel.uiState.value.runs
        assertTrue(runs.isNotEmpty())
        assertTrue(runs.first { it.runId == "run_260818_live99" }.waitingInterrupt)
        assertTrue(runs.filter { it.runId != "run_260818_live99" }.none { it.waitingInterrupt })

        // A reload of the run list must not drop the derived flag.
        viewModel.loadRuns("proj_foundry_core")
        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(viewModel.uiState.value.runs.first { it.runId == "run_260818_live99" }.waitingInterrupt)

        // Answering clears it.
        viewModel.answerInterrupt("int_waiting", approved = true, notes = null)
        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(viewModel.uiState.value.runs.none { it.waitingInterrupt })
    }

    @Test
    fun testInterruptForRunOnlyMatchesItsOwnRun() {
        // The Run screen used to fall back to any interrupt with a blank runId,
        // which pinned another run's strip onto whatever run was open.
        repository.setPendingInterrupts(
            listOf(
                com.foundry.companion.data.model.PendingInterrupt(
                    interruptId = "int_lookup",
                    runId = "run_260818_live99",
                    question = "Approve?"
                )
            )
        )
        viewModel.loadPendingInterrupts()
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals("int_lookup", state.interruptForRun("run_260818_live99")?.interruptId)
        assertNull(state.interruptForRun("run_some_other"))
    }

    @Test
    fun testLoadPrStatus() {
        viewModel.loadPrStatus("proj_foundry_core")
        testDispatcher.scheduler.advanceUntilIdle()

        val status = viewModel.uiState.value.ghStatus
        assertNotNull(status)
        assertTrue(status?.available == true)
        assertEquals("foundry-app/foundry", status?.repo)
    }

    @Test
    fun testCreatePrPostsHostDraftAndDoesNotCreateUntilCalled() {
        val draft = com.foundry.companion.data.model.CompanionPrDraft(
            title = "Bugfix & Verify: Refactor main electron bootstrap process initialization order.",
            body = "Refactor main electron bootstrap process initialization order.\n\n---\nOpened by Foundry from run run_260818_rej02 (branch `foundry/run_260818_rej02`).",
            source = "run"
        )
        repository.setPrDraft("run_260818_rej02", draft)

        viewModel.loadRunDetail("run_260818_rej02")
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals(0, repository.createPrCallCount)
        assertEquals(draft.title, viewModel.uiState.value.prDraft?.title)
        assertEquals("run_260818_rej02", viewModel.uiState.value.prDraftRunId)
        val draftCallsAfterLoad = repository.getPrDraftCallCount
        assertTrue(draftCallsAfterLoad >= 1)

        viewModel.createPr("run_260818_rej02")
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals(1, repository.createPrCallCount)
        assertEquals(draftCallsAfterLoad, repository.getPrDraftCallCount)
        assertEquals(draft.title, repository.lastCreatePrRequest?.title)
        assertEquals(draft.body, repository.lastCreatePrRequest?.body)
    }

    @Test
    fun testCreatePrFlowSuccess() {
        var callbackSuccess: Boolean? = null
        var callbackUrl: String? = null

        viewModel.createPr("run_260818_acc01") { ok, url ->
            callbackSuccess = ok
            callbackUrl = url
        }
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals(true, callbackSuccess)
        assertEquals("https://github.com/foundry-app/foundry/pull/133", callbackUrl)
        assertFalse(viewModel.uiState.value.isCreatingPr)
        assertNull(viewModel.uiState.value.errorMessage)

        val run = viewModel.uiState.value.runs.find { it.runId == "run_260818_acc01" }
        assertEquals("https://github.com/foundry-app/foundry/pull/133", run?.prUrl)
    }

    @Test
    fun testCreatePrFailureSetsErrorMessage() {
        repository.setFakeGhStatus(
            com.foundry.companion.data.model.GhStatus(
                available = false,
                detail = "GitHub CLI (gh) is not installed or not on PATH"
            )
        )

        var callbackSuccess: Boolean? = null
        viewModel.createPr("run_260818_acc01") { ok, _ ->
            callbackSuccess = ok
        }
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals(false, callbackSuccess)
        assertFalse(viewModel.uiState.value.isCreatingPr)
        assertEquals("GitHub CLI (gh) is not installed or not on PATH", viewModel.uiState.value.errorMessage)

        viewModel.clearActionError()
        assertNull(viewModel.uiState.value.errorMessage)
    }
}
