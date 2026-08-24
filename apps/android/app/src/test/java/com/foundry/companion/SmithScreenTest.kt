package com.foundry.companion

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.SmithChatState
import com.foundry.companion.data.model.SmithProposal
import com.foundry.companion.data.model.SmithTranscriptEntry
import com.foundry.companion.ui.screens.smith.SmithScreen
import com.foundry.companion.ui.theme.FoundryTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SmithScreenTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun testEmptyStateAndSend() {
        var sent: String? = null
        composeTestRule.setContent {
            FoundryTheme {
                SmithScreen(
                    chat = SmithChatState(),
                    proposal = null,
                    projectName = "Foundry",
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    isSending = false,
                    onBackClick = {},
                    onRetryConnection = {},
                    onSend = { sent = it },
                    onCancel = {},
                    onNewChat = {},
                    onAnswerProposal = { _, _ -> }
                )
            }
        }

        composeTestRule.onNodeWithText("Smith").assertIsDisplayed()
        composeTestRule.onNodeWithText("Ask Smith to inspect or operate Foundry — entities, readiness, runs, and pull requests.")
            .assertIsDisplayed()
        composeTestRule.onNodeWithContentDescription("Message Smith").performTextInput("list pipelines")
        composeTestRule.onNodeWithContentDescription("Send").performClick()
        assertEquals("list pipelines", sent)
    }

    @Test
    fun testTranscriptAndProposalApprove() {
        var approved: Boolean? = null
        composeTestRule.setContent {
            FoundryTheme {
                SmithScreen(
                    chat = SmithChatState(
                        transcript = listOf(
                            SmithTranscriptEntry(
                                id = "op_0",
                                kind = "text",
                                text = "list pipelines",
                                source = "operator",
                                at = 1
                            ),
                            SmithTranscriptEntry(
                                id = "sm_1",
                                kind = "text",
                                text = "Feature Pipeline is the default.",
                                source = "smith",
                                at = 2
                            )
                        )
                    ),
                    proposal = SmithProposal(
                        id = "prop_1",
                        type = "action",
                        title = "Change a setting",
                        summary = "Flip a toggle",
                        risk = "write"
                    ),
                    projectName = "Foundry",
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    isSending = false,
                    onBackClick = {},
                    onRetryConnection = {},
                    onSend = {},
                    onCancel = {},
                    onNewChat = {},
                    onAnswerProposal = { ok, _ -> approved = ok }
                )
            }
        }

        composeTestRule.onNodeWithText("Change a setting").assertIsDisplayed()
        composeTestRule.onNodeWithText("Flip a toggle").assertIsDisplayed()
        composeTestRule.onNodeWithContentDescription("Approve proposal").performClick()
        assertTrue(approved == true)
    }
}
