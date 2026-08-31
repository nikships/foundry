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
import com.foundry.companion.viewmodel.CompanionHapticEvent
import com.foundry.companion.viewmodel.CompanionViewModel
import com.foundry.companion.viewmodel.defaultCompanionDeviceName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
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
    fun testSmithSendAndNewChat() {
        viewModel.sendSmith("list the pipelines")
        testDispatcher.scheduler.advanceUntilIdle()

        val afterSend = viewModel.uiState.value
        assertEquals("proj_foundry_core" to "list the pipelines", repository.lastSmithSend)
        assertEquals(2, afterSend.smithChat?.transcript?.size)
        assertEquals("list the pipelines", afterSend.smithChat?.transcript?.first()?.text)
        assertFalse(afterSend.smithSending)

        viewModel.newSmithChat()
        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(viewModel.uiState.value.smithChat?.transcript.isNullOrEmpty())
    }

    @Test
    fun testSmithModelAndEffortSwitch() {
        viewModel.loadSmith()
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("scripted/alpha", viewModel.uiState.value.smithModels.first().id)

        viewModel.setSmithModel("scripted/beta")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("proj_foundry_core" to "scripted/beta", repository.lastSmithModel)
        assertEquals("scripted/beta", viewModel.uiState.value.smithChat?.model)

        viewModel.setSmithEffort("high")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("proj_foundry_core" to "high", repository.lastSmithEffort)
        assertEquals("high", viewModel.uiState.value.smithChat?.reasoningEffort)
    }

    @Test
    fun testSmithProposalApproveClearsTheCard() {
        repository.enqueueSmithProposal(
            com.foundry.companion.data.model.SmithProposal(
                id = "prop_1",
                type = "action",
                title = "Change a setting",
                summary = "Flip a toggle",
                risk = "write"
            )
        )
        viewModel.loadSmith()
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("prop_1", viewModel.uiState.value.smithProposal?.id)

        viewModel.answerSmithProposal(approved = true)
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("prop_1" to true, repository.smithAnswered)
        assertNull(viewModel.uiState.value.smithProposal)
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

    @Test
    fun testPairSuccessEmitsOneHaptic() {
        val unpairedRepo = FakeCompanionRepository(initialPaired = false)
        val vm = CompanionViewModel(unpairedRepo, sessionManager, enablePolling = false)
        testDispatcher.scheduler.advanceUntilIdle()

        val events = collectHaptics(vm)

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

        assertEquals(listOf(CompanionHapticEvent.PairSuccess), events)
    }

    @Test
    fun testRunSettleEmitsOneHaptic() {
        val events = collectHaptics(viewModel)
        assertTrue(events.isEmpty())

        viewModel.killRun("run_260818_live99")
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals(listOf(CompanionHapticEvent.RunSettle), events)

        viewModel.loadRuns("proj_foundry_core")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(1, events.size)
    }

    @Test
    fun testStartRunDoesNotHaptic() {
        val events = collectHaptics(viewModel)
        viewModel.startRun(
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default",
            request = "Start should not buzz"
        ) { }
        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(events.isEmpty())
    }

    @Test
    fun testNewRunCapabilitiesLoadOrchestratorAndLinear() {
        viewModel.loadNewRunCapabilities()
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value
        assertNotNull(state.orchestratorOptions)
        assertTrue(state.orchestratorOptions!!.models.isNotEmpty())
        assertTrue(state.linearConnection?.keySet == true)
        assertTrue(state.linearIssues.isNotEmpty())
        assertTrue(state.linearIssues.any { it.identifier == "FOU-204" })
    }

    @Test
    fun testOrchestratorPlanGenerationAndStartCreatesAdaptiveRun() {
        viewModel.loadNewRunCapabilities()
        testDispatcher.scheduler.advanceUntilIdle()
        val options = viewModel.uiState.value.orchestratorOptions!!

        viewModel.generateOrchestratorPlan(
            projectId = "proj_foundry_core",
            prompt = "Bring Android run creation to desktop parity",
            model = options.model,
            reasoningEffort = "high"
        )
        testDispatcher.scheduler.advanceUntilIdle()

        val planning = viewModel.uiState.value
        assertFalse(planning.isPlanning)
        assertNull(planning.errorMessage)
        val state = planning.orchestratorState!!
        assertEquals("done", state.status)
        val plan = state.plan!!
        assertTrue(plan.phases.isNotEmpty())
        assertEquals("Investigate", plan.phases.first().name)
        assertEquals("high", plan.phases.first().reasoningEffort)
        assertEquals(plan, planning.orchestratorOriginalPlan)

        // Phase appointments remain editable and can be restored together.
        viewModel.setPlanPhaseReasoningEffort("Investigate", "low")
        viewModel.setPlanPhaseModel("Investigate", "openai/gpt-5.4")
        testDispatcher.scheduler.advanceUntilIdle()
        val editedPhase = viewModel.uiState.value.orchestratorState?.plan?.phases?.first()
        assertEquals("openai/gpt-5.4", editedPhase?.model)
        assertEquals("low", editedPhase?.reasoningEffort)

        viewModel.restorePlanPhaseSettings()
        val restoredPhase = viewModel.uiState.value.orchestratorState?.plan?.phases?.first()
        assertEquals(options.model, restoredPhase?.model)
        assertEquals("high", restoredPhase?.reasoningEffort)

        var startedRunId: String? = null
        viewModel.startOrchestratedRun("proj_foundry_core") { startedRunId = it }
        testDispatcher.scheduler.advanceUntilIdle()
        assertNotNull(startedRunId)
        val started = viewModel.uiState.value.runs.first { it.runId == startedRunId }
        assertEquals(plan.pipelineId, started.pipelineId)
        assertEquals("adaptive", started.mode)
        assertTrue(started.orchestrated)
    }

    @Test
    fun testGeneratedPlanAndModeSurviveComposerNavigation() {
        viewModel.loadNewRunCapabilities()
        testDispatcher.scheduler.advanceUntilIdle()
        val options = viewModel.uiState.value.orchestratorOptions!!

        viewModel.setNewRunMode("orchestrator")
        viewModel.setNewRunDraft("Keep this composer")
        viewModel.generateOrchestratorPlan(
            projectId = "proj_foundry_core",
            prompt = "Keep this composer",
            model = options.model,
            reasoningEffort = "high"
        )
        testDispatcher.scheduler.advanceUntilIdle()

        // Re-entering the route reloads capabilities but must not reset the draft.
        viewModel.loadNewRunCapabilities()
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals("orchestrator", viewModel.uiState.value.newRunMode)
        assertEquals("Keep this composer", viewModel.getNewRunDraft())
        assertNotNull(viewModel.uiState.value.orchestratorState?.plan)
    }

    @Test
    fun testCancelAndDiscardOrchestratorPlan() {
        viewModel.loadNewRunCapabilities()
        testDispatcher.scheduler.advanceUntilIdle()
        val options = viewModel.uiState.value.orchestratorOptions!!

        viewModel.generateOrchestratorPlan(
            projectId = "proj_foundry_core",
            prompt = "Plan then cancel",
            model = options.model,
            reasoningEffort = "high"
        )
        testDispatcher.scheduler.advanceUntilIdle()
        assertNotNull(viewModel.uiState.value.orchestratorState?.plan)

        // Cancel clears the plan immediately and asks the desktop to stop planning.
        viewModel.cancelOrchestratorPlan()
        testDispatcher.scheduler.advanceUntilIdle()
        assertNull(viewModel.uiState.value.orchestratorState)
        assertFalse(viewModel.uiState.value.isPlanning)

        viewModel.generateOrchestratorPlan(
            projectId = "proj_foundry_core",
            prompt = "Plan then discard",
            model = options.model,
            reasoningEffort = "high"
        )
        testDispatcher.scheduler.advanceUntilIdle()
        assertNotNull(viewModel.uiState.value.orchestratorState?.plan)

        viewModel.discardOrchestratorPlan()
        testDispatcher.scheduler.advanceUntilIdle()
        assertNull(viewModel.uiState.value.orchestratorState)
    }

    @Test
    fun testLinearSearchSelectMappingAndSourcedStart() {
        viewModel.loadNewRunCapabilities()
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.searchLinearIssues("FOU-204")
        testDispatcher.scheduler.advanceUntilIdle()
        val issues = viewModel.uiState.value.linearIssues
        assertTrue(issues.any { it.identifier == "FOU-204" })

        viewModel.selectLinearIssue(issues.first { it.identifier == "FOU-204" })
        testDispatcher.scheduler.advanceUntilIdle()

        val selected = viewModel.uiState.value
        assertEquals("FOU-204", selected.selectedLinearIssue?.identifier)
        assertTrue(selected.linearWorkflowStates.isNotEmpty())

        // The saved mapping is complete, so a run can start right away.
        assertTrue(selected.linearStatusMapping.isComplete)

        var sourcedRunId: String? = null
        viewModel.startLinearRun(
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default"
        ) { sourcedRunId = it }
        testDispatcher.scheduler.advanceUntilIdle()

        assertNotNull(sourcedRunId)
        val run = viewModel.uiState.value.runs.first { it.runId == sourcedRunId }
        assertEquals("linear-fou-204", run.source?.issueId)
        assertEquals("pi", run.mode)
        assertNotNull(run.source)
    }

    @Test
    fun testLinearStartWithoutIssueIsNoOp() {
        viewModel.loadNewRunCapabilities()
        testDispatcher.scheduler.advanceUntilIdle()

        var startAttempted = false
        val runsBefore = viewModel.uiState.value.runs.size
        viewModel.startLinearRun(
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default"
        ) { startAttempted = true }
        testDispatcher.scheduler.advanceUntilIdle()

        assertFalse(startAttempted)
        assertEquals(runsBefore, viewModel.uiState.value.runs.size)
    }

    @Test
    fun testCheckpointListAndRestoreForTerminalRun() {
        viewModel.loadRunDetail("run_260818_kill04")
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.loadRestorableCheckpoints("run_260818_kill04")
        testDispatcher.scheduler.advanceUntilIdle()

        val curated = viewModel.uiState.value
        assertFalse(curated.isLoadingCheckpoints)
        assertNull(curated.restorableCheckpoints?.refusal)
        val checkpoint = curated.restorableCheckpoints?.checkpoints?.firstOrNull()
        assertNotNull(checkpoint)

        var restoredOk: Boolean? = null
        viewModel.restoreCheckpoint(
            runId = "run_260818_kill04",
            checkpointId = checkpoint!!.checkpointId,
            acceptPartial = true
        ) { restoredOk = it }
        testDispatcher.scheduler.advanceUntilIdle()

        assertTrue(restoredOk == true)
        assertTrue(viewModel.uiState.value.restoreMessage.isNullOrBlank().not())
        assertEquals(checkpoint.checkpointId, repository.lastRestoreRequest?.checkpointId)

        // The banner belongs to the restored run only: opening another terminal
        // run must not leak it into that run's restore section.
        viewModel.loadRunDetail("run_260818_fail03")
        testDispatcher.scheduler.advanceUntilIdle()
        assertNull(viewModel.uiState.value.restoreMessage)

        viewModel.clearRestoreMessage()
        assertNull(viewModel.uiState.value.restoreMessage)

        // A live run refuses checkpoint listing.
        viewModel.loadRestorableCheckpoints("run_260818_live99")
        testDispatcher.scheduler.advanceUntilIdle()
        assertNotNull(viewModel.uiState.value.restorableCheckpoints?.refusal)
    }

    @Test
    fun testOrchestratorPollFailureClearsPlanAndStopsPlanning() {
        viewModel.loadNewRunCapabilities()
        testDispatcher.scheduler.advanceUntilIdle()
        val options = viewModel.uiState.value.orchestratorOptions!!

        repository.failGetOrchestratorPlan = true
        viewModel.generateOrchestratorPlan(
            projectId = "proj_foundry_core",
            prompt = "Plan that dies",
            model = options.model,
            reasoningEffort = "high"
        )
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value
        assertFalse(state.isPlanning)
        // A dead poll must not leave a "running" snapshot behind (spinner forever).
        assertNull(state.orchestratorState)
        assertTrue(state.validationIssues.any { it.where == "orchestrator" })

        viewModel.clearValidationIssues()
        assertTrue(viewModel.uiState.value.validationIssues.isEmpty())
    }

    @Test
    fun testProtocolMismatchSurfacesErrorAndStopsLoad() {
        val mismatchedRepo = FakeCompanionRepository(initialPaired = true)
        mismatchedRepo.overrideProtocolVersion = COMPANION_PROTOCOL_VERSION - 1
        val vm = CompanionViewModel(mismatchedRepo, sessionManager, enablePolling = false)
        testDispatcher.scheduler.advanceUntilIdle()

        val state = vm.uiState.value
        assertNotNull(state.errorMessage)
        assertTrue(state.errorMessage!!.contains("Protocol mismatch"))
        assertTrue(state.projects.isEmpty())
    }

    private fun collectHaptics(vm: CompanionViewModel): MutableList<CompanionHapticEvent> {
        val events = mutableListOf<CompanionHapticEvent>()
        CoroutineScope(testDispatcher + Job()).launch {
            vm.hapticEvents.collect { events.add(it) }
        }
        testDispatcher.scheduler.advanceUntilIdle()
        return events
    }
}
