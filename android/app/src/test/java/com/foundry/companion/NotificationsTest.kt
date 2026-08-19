package com.foundry.companion

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.foundry.companion.data.model.PendingInterrupt
import com.foundry.companion.data.model.PhaseRunSummary
import com.foundry.companion.data.model.RunRow
import com.foundry.companion.data.repository.FakeCompanionRepository
import com.foundry.companion.data.session.SessionManager
import com.foundry.companion.notification.CompanionNotificationManager
import com.foundry.companion.notification.CompanionNotifier
import com.foundry.companion.notification.FoundryNotificationManager
import com.foundry.companion.viewmodel.CompanionViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

class TestNotificationManager : CompanionNotificationManager {
    val postedSettledRuns = mutableListOf<RunRow>()
    val postedInterrupts = mutableListOf<PendingInterrupt>()
    val interruptProjectIds = mutableListOf<String>()
    var permissionGranted = true

    override fun hasNotificationPermission(): Boolean = permissionGranted

    override fun postRunSettledNotification(run: RunRow) {
        postedSettledRuns.add(run)
    }

    override fun postInterruptNotification(interrupt: PendingInterrupt, projectId: String) {
        postedInterrupts.add(interrupt)
        interruptProjectIds.add(projectId)
    }

    fun clear() {
        postedSettledRuns.clear()
        postedInterrupts.clear()
        interruptProjectIds.clear()
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NotificationsTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var context: Context
    private lateinit var sessionManager: SessionManager
    private lateinit var testNotificationManager: TestNotificationManager
    private lateinit var notifier: CompanionNotifier
    private lateinit var repository: FakeCompanionRepository

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        context = ApplicationProvider.getApplicationContext()
        sessionManager = SessionManager(context)
        sessionManager.clearSession()
        sessionManager.clearNewRunDraft()
        sessionManager.setSelectedProjectId(null)

        testNotificationManager = TestNotificationManager()
        notifier = CompanionNotifier(testNotificationManager, sessionManager)
        repository = FakeCompanionRepository(initialPaired = true)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun testRealNotificationManagerInitializationAndPosting() {
        val realManager = FoundryNotificationManager(context)
        // Check permission helper returns without crashing
        val perm = realManager.hasNotificationPermission()
        assertNotNull(perm)

        val run = RunRow(
            runId = "run_settle_01",
            pipelineName = "Feature Pipeline",
            request = "Test notification for settled run",
            status = "accepted",
            outcomeDetail = "All 5 phases passed."
        )
        realManager.postRunSettledNotification(run)

        val interrupt = PendingInterrupt(
            interruptId = "int_01",
            runId = "run_settle_01",
            pipelineName = "Feature Pipeline",
            question = "Approve deployment?"
        )
        realManager.postInterruptNotification(interrupt)
    }

    @Test
    fun testInitialLoadDoesNotSpamNotifications() {
        val vm = CompanionViewModel(
            repository = repository,
            sessionManager = sessionManager,
            notifier = notifier,
            enablePolling = false
        )
        testDispatcher.scheduler.advanceUntilIdle()

        // Existing historical runs should not post notifications on first launch
        assertTrue(testNotificationManager.postedSettledRuns.isEmpty())
        assertTrue(testNotificationManager.postedInterrupts.isEmpty())
    }

    @Test
    fun testRunSettlingPostsNotificationWhenEnabled() {
        val vm = CompanionViewModel(
            repository = repository,
            sessionManager = sessionManager,
            notifier = notifier,
            enablePolling = false
        )
        testDispatcher.scheduler.advanceUntilIdle()

        // Transition the running run to accepted
        val updatedRun = RunRow(
            runId = "run_260818_live99",
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default",
            pipelineName = "Feature Pipeline",
            request = "Stand up the Android companion scaffold with Compose navigation.",
            status = "accepted",
            outcomeDetail = "All phases passed successfully."
        )
        repository.updateRun(updatedRun)

        vm.loadRuns("proj_foundry_core")
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals(1, testNotificationManager.postedSettledRuns.size)
        assertEquals("run_260818_live99", testNotificationManager.postedSettledRuns.first().runId)
        assertEquals("accepted", testNotificationManager.postedSettledRuns.first().status)
    }

    @Test
    fun testRunSettlingDoesNotNotifyWhenPreferenceDisabled() {
        val vm = CompanionViewModel(
            repository = repository,
            sessionManager = sessionManager,
            notifier = notifier,
            enablePolling = false
        )
        testDispatcher.scheduler.advanceUntilIdle()

        vm.toggleNotifyOnSettle(false)
        testDispatcher.scheduler.advanceUntilIdle()

        val updatedRun = RunRow(
            runId = "run_260818_live99",
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default",
            pipelineName = "Feature Pipeline",
            request = "Stand up the Android companion scaffold with Compose navigation.",
            status = "failed",
            outcomeDetail = "Compilation failed."
        )
        repository.updateRun(updatedRun)

        vm.loadRuns("proj_foundry_core")
        testDispatcher.scheduler.advanceUntilIdle()

        assertTrue(testNotificationManager.postedSettledRuns.isEmpty())
    }

    @Test
    fun testEngineerInterruptNotifiesEvenWhenSettleToggleDisabled() {
        val vm = CompanionViewModel(
            repository = repository,
            sessionManager = sessionManager,
            notifier = notifier,
            enablePolling = false
        )
        testDispatcher.scheduler.advanceUntilIdle()

        vm.toggleNotifyOnSettle(false)
        testDispatcher.scheduler.advanceUntilIdle()

        val interrupt = PendingInterrupt(
            interruptId = "int_new_urgent",
            runId = "run_260818_live99",
            pipelineName = "Security Pipeline",
            question = "Authorize privileged key rotation?"
        )
        repository.setPendingInterrupts(listOf(interrupt))

        vm.loadPendingInterrupts()
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals(1, testNotificationManager.postedInterrupts.size)
        assertEquals("int_new_urgent", testNotificationManager.postedInterrupts.first().interruptId)
        assertEquals("Security Pipeline", testNotificationManager.postedInterrupts.first().pipelineName)
    }

    @Test
    fun testNotificationDedupingPreventsDuplicateAlerts() {
        val vm = CompanionViewModel(
            repository = repository,
            sessionManager = sessionManager,
            notifier = notifier,
            enablePolling = false
        )
        testDispatcher.scheduler.advanceUntilIdle()

        val updatedRun = RunRow(
            runId = "run_260818_live99",
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default",
            pipelineName = "Feature Pipeline",
            request = "Stand up Android companion scaffold.",
            status = "rejected",
            outcomeDetail = "Boundary check failed."
        )
        repository.updateRun(updatedRun)

        // First load triggers notification
        vm.loadRuns("proj_foundry_core")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(1, testNotificationManager.postedSettledRuns.size)

        // Second load of same settled status should not notify again
        vm.loadRuns("proj_foundry_core")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(1, testNotificationManager.postedSettledRuns.size)
    }
}
