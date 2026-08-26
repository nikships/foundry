package com.foundry.companion

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.foundry.companion.background.CompanionWatcher
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.RunRow
import com.foundry.companion.data.repository.FakeCompanionRepository
import com.foundry.companion.data.session.SessionManager
import com.foundry.companion.notification.CompanionNotifier
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The background path is the whole point of FOU-98: these assert it keeps
 * notifying without a screen, and that it stops rather than spins when the
 * pairing or the LAN goes away.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BackgroundWatcherTest {

    private lateinit var sessionManager: SessionManager
    private lateinit var notificationManager: TestNotificationManager
    private lateinit var notifier: CompanionNotifier

    private val pollMs = CompanionWatcher.DEFAULT_POLL_INTERVAL_MS

    @Before
    fun setup() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        sessionManager = SessionManager(context)
        sessionManager.clearSession()
        notificationManager = TestNotificationManager()
        notifier = CompanionNotifier(notificationManager, sessionManager)
    }

    private fun runningRun(runId: String = "run_bg_01") = RunRow(
        runId = runId,
        projectId = "proj_foundry_core",
        pipelineId = "pipe_default",
        pipelineName = "Feature Pipeline",
        request = "Background settle notifications.",
        status = "running"
    )

    @Test
    fun testWatcherPostsSettleNotificationWithNoViewModelInvolved() = runTest {
        val repository = FakeCompanionRepository(initialPaired = true)
        repository.updateRun(runningRun())
        val watcher = CompanionWatcher(repository, notifier, TestScope(testScheduler))

        assertTrue(watcher.start())
        advanceTimeBy(pollMs / 2)
        runCurrent()

        // First sweep only seeds; nothing settled while anyone was watching.
        assertTrue(notificationManager.postedSettledRuns.isEmpty())

        repository.updateRun(runningRun().copy(status = "accepted", outcomeDetail = "All phases passed."))
        advanceTimeBy(pollMs * 2)
        runCurrent()

        assertEquals(1, notificationManager.postedSettledRuns.size)
        assertEquals("run_bg_01", notificationManager.postedSettledRuns.first().runId)
        watcher.stop()
    }

    @Test
    fun testUnpairStopsTheWatcher() = runTest {
        val repository = FakeCompanionRepository(initialPaired = true)
        val watcher = CompanionWatcher(repository, notifier, TestScope(testScheduler))
        watcher.start()
        advanceTimeBy(pollMs / 2)
        runCurrent()
        assertTrue(watcher.isRunning)

        repository.unpair()
        advanceTimeBy(pollMs * 2)
        runCurrent()

        assertEquals(CompanionWatcher.StopReason.UNPAIRED, watcher.stopReason.value)
        assertFalse(watcher.isRunning)
    }

    @Test
    fun testRevokedPairingStopsTheWatcher() = runTest {
        val repository = FakeCompanionRepository(initialPaired = true)
        val watcher = CompanionWatcher(repository, notifier, TestScope(testScheduler))
        watcher.start()
        advanceTimeBy(pollMs / 2)
        runCurrent()

        repository.simulateRevokeToken()
        advanceTimeBy(pollMs * 2)
        runCurrent()

        assertEquals(CompanionWatcher.StopReason.UNPAIRED, watcher.stopReason.value)
    }

    @Test
    fun testWatcherStartsRefusedWithNoStoredSession() = runTest {
        val repository = FakeCompanionRepository(initialPaired = false)
        val watcher = CompanionWatcher(repository, notifier, TestScope(testScheduler))

        assertFalse(watcher.start())
        assertFalse(watcher.isRunning)
        assertEquals(CompanionWatcher.StopReason.UNPAIRED, watcher.stopReason.value)
    }

    @Test
    fun testOfflineHostBacksOffThenGivesUpInsteadOfSpinning() = runTest {
        val repository = OfflineCompanionRepository()
        val watcher = CompanionWatcher(
            repository = repository,
            notifier = notifier,
            scope = TestScope(testScheduler),
            failureLimit = 3
        )
        watcher.start()

        // Backoff must widen rather than hammer the radio at the poll interval:
        // three poll intervals of elapsed time buy fewer than three tries.
        advanceTimeBy(pollMs * 3)
        runCurrent()
        val earlyAttempts = repository.attempts
        assertTrue("expected backoff to slow polling, got $earlyAttempts attempts", earlyAttempts in 1..2)

        advanceUntilIdle()

        assertEquals(CompanionWatcher.StopReason.UNREACHABLE, watcher.stopReason.value)
        assertFalse(watcher.isRunning)

        val attemptsAtGiveUp = repository.attempts
        assertTrue("expected the watcher to have actually tried", attemptsAtGiveUp >= 3)
        advanceTimeBy(CompanionWatcher.MAX_BACKOFF_MS * 4)
        runCurrent()
        assertEquals(
            "a given-up watcher must not keep polling",
            attemptsAtGiveUp,
            repository.attempts
        )
    }

    @Test
    fun testWatcherRecoversAfterATransientFailure() = runTest {
        val repository = OfflineCompanionRepository()
        val watcher = CompanionWatcher(
            repository = repository,
            notifier = notifier,
            scope = TestScope(testScheduler),
            failureLimit = 4
        )
        watcher.start()
        advanceTimeBy(pollMs * 2)
        runCurrent()

        repository.reachable = true
        repository.setRun(runningRun())
        advanceTimeBy(pollMs * 6)
        runCurrent()

        repository.setRun(runningRun().copy(status = "accepted"))
        advanceTimeBy(pollMs * 3)
        runCurrent()

        assertNull(watcher.stopReason.value)
        assertEquals(1, notificationManager.postedSettledRuns.size)
        watcher.stop()
    }

    @Test
    fun testSharedNotifierDoesNotAnnounceTheSameRunTwiceAcrossPaths() = runTest {
        val repository = FakeCompanionRepository(initialPaired = true)
        repository.updateRun(runningRun())
        val watcher = CompanionWatcher(repository, notifier, TestScope(testScheduler))
        watcher.start()
        advanceTimeBy(pollMs / 2)
        runCurrent()

        val settled = runningRun().copy(status = "accepted")
        repository.updateRun(settled)
        advanceTimeBy(pollMs * 2)
        runCurrent()
        assertEquals(1, notificationManager.postedSettledRuns.size)

        // The UI poll observing the same transition through the same notifier
        // must not post a second time.
        notifier.onRuns(listOf(settled))
        assertEquals(1, notificationManager.postedSettledRuns.size)
        watcher.stop()
    }

    @Test
    fun testDeniedNotificationPermissionSuppressesPostsAndDoesNotBurnTheRetry() = runTest {
        notificationManager.permissionGranted = false
        val repository = FakeCompanionRepository(initialPaired = true)
        repository.updateRun(runningRun())
        val watcher = CompanionWatcher(repository, notifier, TestScope(testScheduler))
        watcher.start()
        advanceTimeBy(pollMs / 2)
        runCurrent()

        repository.updateRun(runningRun().copy(status = "accepted"))
        advanceTimeBy(pollMs * 2)
        runCurrent()

        assertTrue(notificationManager.postedSettledRuns.isEmpty())
        // Nothing was delivered, so nothing may be recorded as delivered.
        assertFalse(sessionManager.getNotifiedSettledRunIds().contains("run_bg_01"))

        notificationManager.permissionGranted = true
        advanceTimeBy(pollMs * 2)
        runCurrent()
        assertEquals(1, notificationManager.postedSettledRuns.size)
        watcher.stop()
    }

    @Test
    fun testConnectionStatusUnpairedAloneStopsTheWatcher() = runTest {
        val repository = FakeCompanionRepository(initialPaired = true)
        val watcher = CompanionWatcher(repository, notifier, TestScope(testScheduler))
        watcher.start()
        advanceTimeBy(pollMs / 2)
        runCurrent()

        repository.setConnectionStatus(ConnectionStatus.Unpaired)
        advanceTimeBy(pollMs * 2)
        runCurrent()

        assertEquals(CompanionWatcher.StopReason.UNPAIRED, watcher.stopReason.value)
    }
}
