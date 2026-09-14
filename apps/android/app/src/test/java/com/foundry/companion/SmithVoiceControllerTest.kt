package com.foundry.companion

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.foundry.companion.data.model.SmithVoiceToken
import com.foundry.companion.data.repository.CompanionRepository
import com.foundry.companion.voice.SmithVoiceController
import com.foundry.companion.voice.VoicePhase
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SmithVoiceControllerTest {
    @Test fun `end fences a noncancellable token response and connection times out before live`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val token = CompletableDeferred<SmithVoiceToken>()
            val host = object : CompanionRepository by OfflineCompanionRepository() {
                override suspend fun getSmithVoiceToken(projectId: String?): Result<SmithVoiceToken> =
                    withContext(NonCancellable) { Result.success(token.await()) }
            }
            val controller = SmithVoiceController(ApplicationProvider.getApplicationContext<Context>(), host, "p")
            assertEquals(VoicePhase.Idle, controller.state.value.phase)
            controller.start()
            runCurrent()
            assertEquals(VoicePhase.Connecting, controller.state.value.phase)
            controller.end()
            token.complete(SmithVoiceToken("unused", "model", "instruction"))
            runCurrent()
            assertEquals(VoicePhase.Idle, controller.state.value.phase)

            val stalled = object : CompanionRepository by OfflineCompanionRepository() {
                override suspend fun getSmithVoiceToken(projectId: String?): Result<SmithVoiceToken> = awaitCancellation()
            }
            val timeout = SmithVoiceController(ApplicationProvider.getApplicationContext<Context>(), stalled, null)
            timeout.start()
            advanceTimeBy(20001)
            runCurrent()
            assertEquals(VoicePhase.Error, timeout.state.value.phase)
            assertTrue(timeout.state.value.detail.orEmpty().contains("timed out"))
            timeout.end()
        } finally { Dispatchers.resetMain() }
    }
}
