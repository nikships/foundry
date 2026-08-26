package com.foundry.companion

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.foundry.companion.ui.screens.pair.CameraPermissionPrompt
import com.foundry.companion.ui.screens.pair.PairScreen
import com.foundry.companion.ui.screens.pair.cameraPermissionPrompt
import com.foundry.companion.ui.theme.FoundryTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PairScreenTest {

    @get:Rule
    val composeTestRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun firstVisitAsksForCameraInsteadOfSettings() {
        composeTestRule.setContent {
            FoundryTheme {
                PairScreen(
                    onPairSuccess = {},
                    onPairScanned = {},
                    cameraPromptOverride = CameraPermissionPrompt.Request
                )
            }
        }

        composeTestRule.onNodeWithText(
            "Foundry is waiting on your Mac. Allow camera access to scan its pairing code."
        ).assertIsDisplayed()
        composeTestRule.onNodeWithText("ALLOW CAMERA").assertIsDisplayed()
        composeTestRule.onNodeWithContentDescription("Allow camera").assertIsDisplayed()
        composeTestRule.onNodeWithText("OPEN APP SETTINGS").assertDoesNotExist()
        composeTestRule.onNodeWithText("PASTE PAIRING CODE INSTEAD").assertIsDisplayed()
        composeTestRule.onNodeWithText("PAIRING CODE").assertDoesNotExist()
    }

    @Test
    fun permanentDenyShowsOpenAppSettings() {
        composeTestRule.setContent {
            FoundryTheme {
                PairScreen(
                    onPairSuccess = {},
                    onPairScanned = {},
                    cameraPromptOverride = CameraPermissionPrompt.Settings
                )
            }
        }

        composeTestRule.onNodeWithText("OPEN APP SETTINGS").assertIsDisplayed()
        composeTestRule.onNodeWithContentDescription("Open app settings").assertIsDisplayed()
        composeTestRule.onNodeWithText("ALLOW CAMERA").assertDoesNotExist()
    }

    @Test
    fun pasteModeUpdatesCopyAndReturnsToScan() {
        composeTestRule.setContent {
            FoundryTheme {
                PairScreen(
                    onPairSuccess = {},
                    onPairScanned = {},
                    cameraPromptOverride = CameraPermissionPrompt.Request
                )
            }
        }

        composeTestRule.onNodeWithText("PASTE PAIRING CODE INSTEAD").performClick()
        composeTestRule.onNodeWithText(
            "Paste the pairing code from Foundry → Settings → Companion on your Mac"
        ).assertExists()
        composeTestRule.onNodeWithText("PAIRING CODE").assertIsDisplayed()
        composeTestRule.onNodeWithText("SCAN QR CODE INSTEAD").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("OPEN APP SETTINGS").assertDoesNotExist()

        composeTestRule.onNodeWithContentDescription("Scan QR code instead").performClick()
        composeTestRule.onNodeWithText(
            "Scan the QR code in Foundry → Settings → Companion on your Mac"
        ).assertIsDisplayed()
        composeTestRule.onNodeWithText("ALLOW CAMERA").assertIsDisplayed()
        composeTestRule.onNodeWithText("PAIRING CODE").assertDoesNotExist()
    }

    @Test
    fun systemBackLeavesPasteMode() {
        composeTestRule.setContent {
            FoundryTheme {
                PairScreen(
                    onPairSuccess = {},
                    onPairScanned = {},
                    initialPasteMode = true,
                    cameraPromptOverride = CameraPermissionPrompt.Request
                )
            }
        }

        composeTestRule.onNodeWithText("PAIRING CODE").assertIsDisplayed()
        composeTestRule.activity.onBackPressedDispatcher.onBackPressed()
        composeTestRule.waitForIdle()
        composeTestRule.onNodeWithText("PAIRING CODE").assertDoesNotExist()
        composeTestRule.onNodeWithText("ALLOW CAMERA").assertIsDisplayed()
    }

    @Test
    fun cameraPermissionPromptStates() {
        assertEquals(
            CameraPermissionPrompt.Granted,
            cameraPermissionPrompt(granted = true, asked = true, shouldShowRationale = false)
        )
        assertEquals(
            CameraPermissionPrompt.Request,
            cameraPermissionPrompt(granted = false, asked = false, shouldShowRationale = false)
        )
        assertEquals(
            CameraPermissionPrompt.Request,
            cameraPermissionPrompt(granted = false, asked = true, shouldShowRationale = true)
        )
        assertEquals(
            CameraPermissionPrompt.Settings,
            cameraPermissionPrompt(granted = false, asked = true, shouldShowRationale = false)
        )
    }
}
