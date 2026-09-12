package com.foundry.companion

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.foundry.companion.ui.screens.smith.SmithVoiceContent
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.voice.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SmithVoicePanelTest {
    @get:Rule val compose = createComposeRule()

    @Test fun `opening does not start mic and controls reflect connecting muted speaking and error`() {
        val state = mutableStateOf(SmithVoiceState())
        var starts = 0
        var mutes = 0
        var ends = 0
        compose.setContent {
            FoundryTheme {
                SmithVoiceContent(state.value, onStart = { starts++ }, onMute = { mutes++ },
                    onEnd = { ends++ }, onDismiss = {})
            }
        }
        assertEquals(0, starts)
        compose.onNodeWithText("START VOICE").performScrollTo().performClick()
        assertEquals(1, starts)
        compose.runOnIdle { state.value = SmithVoiceState(phase = VoicePhase.Connecting) }
        compose.onNodeWithText("MUTE").assertIsNotEnabled()
        compose.onNodeWithText("END VOICE").performScrollTo().performClick()
        assertEquals(1, ends)
        compose.runOnIdle { state.value = SmithVoiceState(phase = VoicePhase.Live, muted = true) }
        compose.onNodeWithText("MICROPHONE MUTED").assertExists()
        compose.onNodeWithText("UNMUTE").performScrollTo().performClick()
        assertEquals(1, mutes)
        compose.runOnIdle { state.value = state.value.copy(amplitude = 0.65f) }
        compose.onNodeWithText("SMITH IS SPEAKING").assertExists()
        compose.runOnIdle { state.value = SmithVoiceState(phase = VoicePhase.Error, detail = "Connection lost") }
        compose.onNodeWithText("Connection lost").assertExists()
        compose.onNodeWithText("START VOICE").assertIsEnabled()
    }

    @Test fun `pcm meter uses signed little endian samples including negative full scale`() {
        assertEquals(0f, SmithVoiceAudio.pcmLevel(byteArrayOf(0, 0)), 0f)
        assertEquals(0.5f, SmithVoiceAudio.pcmLevel(byteArrayOf(0, 64, 0, 0)), 0f)
        assertEquals(1f, SmithVoiceAudio.pcmLevel(byteArrayOf(0, -128)), 0f)
    }
}
