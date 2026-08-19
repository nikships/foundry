package com.foundry.companion

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.foundry.companion.data.session.SessionManager
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class StateRestorationTest {

    private lateinit var sessionManager: SessionManager

    @Before
    fun setup() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        sessionManager = SessionManager(context)
        sessionManager.clearSession()
    }

    @Test
    fun testLastActiveRoutePersistence() {
        assertNull(sessionManager.getLastActiveRoute())

        sessionManager.setLastActiveRoute("run/run_260818_live99")
        assertEquals("run/run_260818_live99", sessionManager.getLastActiveRoute())

        sessionManager.setLastActiveRoute("run/run_260818_live99/inspector?phase=p_3")
        assertEquals("run/run_260818_live99/inspector?phase=p_3", sessionManager.getLastActiveRoute())

        sessionManager.setLastActiveRoute(null)
        assertNull(sessionManager.getLastActiveRoute())
    }

    @Test
    fun testNotificationPermissionPromptedFlag() {
        assertFalse(sessionManager.hasPromptedNotificationPermission())

        sessionManager.setPromptedNotificationPermission(true)
        assertTrue(sessionManager.hasPromptedNotificationPermission())
    }

    @Test
    fun testNotifiedIdsPersistence() {
        assertTrue(sessionManager.getNotifiedSettledRunIds().isEmpty())
        sessionManager.addNotifiedSettledRunId("run_01")
        assertTrue(sessionManager.getNotifiedSettledRunIds().contains("run_01"))

        assertTrue(sessionManager.getNotifiedInterruptIds().isEmpty())
        sessionManager.addNotifiedInterruptId("int_01")
        assertTrue(sessionManager.getNotifiedInterruptIds().contains("int_01"))
    }
}
