package com.foundry.companion

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.foundry.companion.ui.components.StatusBadge
import com.foundry.companion.ui.theme.FoundryTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class StatusBadgeTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun runningKeepsTheStatusLabel() {
        composeTestRule.setContent {
            FoundryTheme {
                StatusBadge(status = "running")
            }
        }
        composeTestRule.onNodeWithText("RUNNING").assertIsDisplayed()
    }

    @Test
    fun settledStatusesKeepFilledDotLabels() {
        composeTestRule.setContent {
            FoundryTheme {
                StatusBadge(status = "accepted")
            }
        }
        composeTestRule.onNodeWithText("ACCEPTED").assertIsDisplayed()
    }
}
