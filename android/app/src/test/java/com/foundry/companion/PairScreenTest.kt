package com.foundry.companion

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.foundry.companion.ui.screens.pair.PairScreen
import com.foundry.companion.ui.theme.FoundryTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PairScreenTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun cameraDeniedShowsOpenAppSettingsNotPasteField() {
        composeTestRule.setContent {
            FoundryTheme {
                PairScreen(
                    onPairSuccess = {},
                    onPairScanned = {},
                    errorMessage = null,
                    isPairing = false,
                    initialPasteMode = false
                )
            }
        }

        composeTestRule.onNodeWithText(
            "Foundry is waiting on your Mac. Allow camera access to scan its pairing code."
        ).assertIsDisplayed()
        composeTestRule.onNodeWithText("OPEN APP SETTINGS").assertIsDisplayed()
        composeTestRule.onNodeWithContentDescription("Open app settings").assertIsDisplayed()
        composeTestRule.onNodeWithText("PASTE PAIRING CODE INSTEAD").assertIsDisplayed()
        composeTestRule.onNodeWithContentDescription("Paste pairing code instead").assertIsDisplayed()
        composeTestRule.onNodeWithText("PAIRING CODE").assertDoesNotExist()
        composeTestRule.onNodeWithText("TRY CAMERA").assertDoesNotExist()
    }

    @Test
    fun pasteRemainsASecondaryEscapeFromCameraDenied() {
        composeTestRule.setContent {
            FoundryTheme {
                PairScreen(
                    onPairSuccess = {},
                    onPairScanned = {},
                    initialPasteMode = false
                )
            }
        }

        composeTestRule.onNodeWithText("PASTE PAIRING CODE INSTEAD").performClick()
        composeTestRule.onNodeWithText("PAIRING CODE").assertIsDisplayed()
        composeTestRule.onNodeWithText("PASTE CLIPBOARD").assertIsDisplayed()
        composeTestRule.onNodeWithText("OPEN APP SETTINGS").assertDoesNotExist()
    }
}
