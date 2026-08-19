package com.foundry.companion

import android.app.Application
import com.foundry.companion.background.CompanionWatchService
import com.foundry.companion.data.repository.CompanionRepository
import com.foundry.companion.data.repository.FakeCompanionRepository
import com.foundry.companion.data.repository.HttpCompanionRepository
import com.foundry.companion.data.session.SessionManager
import com.foundry.companion.notification.CompanionNotificationManager
import com.foundry.companion.notification.CompanionNotifier
import com.foundry.companion.notification.FoundryNotificationManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class FoundryApplication : Application() {

    lateinit var sessionManager: SessionManager
        private set

    lateinit var repository: CompanionRepository
        private set

    lateinit var notificationManager: CompanionNotificationManager
        private set

    /**
     * Shared by the background watcher and the UI ViewModel so a transition is
     * announced once, whichever poll saw it first.
     */
    lateinit var notifier: CompanionNotifier
        private set

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        sessionManager = SessionManager(this)
        notificationManager = FoundryNotificationManager(this)
        notifier = CompanionNotifier(notificationManager, sessionManager)

        // By default use FakeCompanionRepository for instant demo & unit test reliability,
        // or HttpCompanionRepository when configured.
        val existingSession = sessionManager.getSession()
        repository = if (USE_FAKE_REPOSITORY) {
            FakeCompanionRepository(initialPaired = existingSession != null)
        } else {
            HttpCompanionRepository().apply {
                if (existingSession != null) {
                    injectFakeSession(existingSession)
                }
            }
        }

        // Pairing owns the watcher's lifetime: a stored session on process start
        // and a fresh pair both start it, and losing the session — unpair here or
        // a revoke from the desktop — stops it.
        appScope.launch {
            repository.activeSession.collect { session ->
                if (session == null) {
                    notifier.reset()
                    CompanionWatchService.stop(this@FoundryApplication)
                } else {
                    startWatchIfAllowed()
                }
            }
        }
    }

    /**
     * A watcher that cannot post anything is only a battery cost, so the service
     * waits until the OS has actually granted notifications. `MainActivity`
     * re-checks after the permission prompt settles.
     */
    fun startWatchIfAllowed() {
        if (repository.activeSession.value == null) return
        if (!notificationManager.hasNotificationPermission()) return
        CompanionWatchService.start(this)
    }

    companion object {
        var USE_FAKE_REPOSITORY = false
    }
}
