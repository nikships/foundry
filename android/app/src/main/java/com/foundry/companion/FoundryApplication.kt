package com.foundry.companion

import android.app.Application
import com.foundry.companion.data.repository.CompanionRepository
import com.foundry.companion.data.repository.FakeCompanionRepository
import com.foundry.companion.data.repository.HttpCompanionRepository
import com.foundry.companion.data.session.SessionManager

class FoundryApplication : Application() {

    lateinit var sessionManager: SessionManager
        private set

    lateinit var repository: CompanionRepository
        private set

    override fun onCreate() {
        super.onCreate()
        sessionManager = SessionManager(this)

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
    }

    companion object {
        var USE_FAKE_REPOSITORY = false
    }
}
