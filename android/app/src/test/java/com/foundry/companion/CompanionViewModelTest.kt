package com.foundry.companion

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.foundry.companion.data.model.COMPANION_PROTOCOL_VERSION
import com.foundry.companion.data.model.CompanionPairingPayload
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.PairedSession
import com.foundry.companion.data.repository.FakeCompanionRepository
import com.foundry.companion.data.session.SessionManager
import com.foundry.companion.viewmodel.CompanionViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
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
}
