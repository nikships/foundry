package com.foundry.companion

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.foundry.companion.voice.SmithVoiceController
import com.foundry.companion.voice.VoicePhase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SmithVoiceControllerTest {
    @Test fun `end fences a connecting session and unpaired start fails closed`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val host = OfflineCompanionRepository()
            val controller = SmithVoiceController(ApplicationProvider.getApplicationContext<Context>(), host, "p")
            assertEquals(VoicePhase.Idle, controller.state.value.phase)
            controller.start()
            runCurrent()
            assertEquals(VoicePhase.Connecting, controller.state.value.phase)
            controller.end()
            runCurrent()
            assertEquals(VoicePhase.Idle, controller.state.value.phase)

            host.unpair()
            val unpaired = SmithVoiceController(ApplicationProvider.getApplicationContext<Context>(), host, null)
            unpaired.start()
            runCurrent()
            assertEquals(VoicePhase.Error, unpaired.state.value.phase)
            assertTrue(unpaired.state.value.detail.orEmpty().contains("Connect the Mac"))
            unpaired.end()
        } finally { Dispatchers.resetMain() }
    }
}
