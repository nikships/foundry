package com.foundry.companion

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.SmithChatState
import com.foundry.companion.data.model.SmithModelInfo
import com.foundry.companion.data.model.SmithProposal
import com.foundry.companion.data.model.SmithTranscriptEntry
import com.foundry.companion.ui.screens.smith.SmithScreen
import com.foundry.companion.ui.theme.FoundryTheme
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
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

    private val sampleModels = listOf(
        SmithModelInfo(
            id = "scripted/alpha",
            displayName = "Alpha",
            supportedReasoningEfforts = listOf("low", "medium", "high")
        )
    )

    @Test
    fun testEmptyStateAndSend() {
        var sent: String? = null
        composeTestRule.setContent {
            FoundryTheme {
                SmithScreen(
                    chat = SmithChatState(model = "scripted/alpha", activeModel = "scripted/alpha"),
                    proposal = null,
                    projectName = "Foundry",
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    isSending = false,
                    onBackClick = {},
                    onRetryConnection = {},
                    onSend = { sent = it },
                    onCancel = {},
                    onNewChat = {},
                    onAnswerProposal = { _, _ -> },
                    models = sampleModels
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
                        model = "scripted/alpha",
                        activeModel = "scripted/alpha",
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
                    onAnswerProposal = { ok, _ -> approved = ok },
                    models = sampleModels
                )
            }
        }

        composeTestRule.onNodeWithText("Change a setting").assertIsDisplayed()
        composeTestRule.onNodeWithText("Flip a toggle").assertIsDisplayed()
        composeTestRule.onNodeWithContentDescription("Approve proposal").performClick()
        assertTrue(approved == true)
    }

    @Test
    fun testUnsetModelBlocksSendAndOffersThePicker() {
        var sent: String? = null
        composeTestRule.setContent {
            FoundryTheme {
                SmithScreen(
                    chat = SmithChatState(model = "inherit"),
                    proposal = null,
                    projectName = "Foundry",
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    isSending = false,
                    onBackClick = {},
                    onRetryConnection = {},
                    onSend = { sent = it },
                    onCancel = {},
                    onNewChat = {},
                    onAnswerProposal = { _, _ -> },
                    models = sampleModels
                )
            }
        }
        composeTestRule.onNodeWithText("No model is selected. Choose one to start the conversation.").assertIsDisplayed()
        composeTestRule.onNodeWithText("Choose model").assertIsDisplayed()
        composeTestRule.onNodeWithText("Alpha").assertDoesNotExist()
        composeTestRule.onNodeWithContentDescription("Smith model").assertIsDisplayed()
        composeTestRule.onNodeWithContentDescription("Smith reasoning").assertIsDisplayed()
        composeTestRule.onNodeWithContentDescription("Message Smith").assertIsNotEnabled()
        composeTestRule.onNodeWithContentDescription("Send").assertIsNotEnabled()
        assertEquals(null, sent)
    }

    @Test
    fun testSmithMarkdownAndArtifactCardsRender() {
        composeTestRule.setContent {
            FoundryTheme {
                androidx.compose.foundation.layout.Column {
                    com.foundry.companion.ui.components.MarkdownText(text = "## Plan\nUse **bold** and `code`.")
                    com.foundry.companion.ui.screens.smith.SmithArtifactCard(
                        artifact = buildJsonObject {
                            put("id", "art_1")
                            put("kind", "checklist")
                            put("version", 1)
                            put("createdAt", 1)
                            putJsonObject("checklist") {
                                put("title", "Ready?")
                                put("summary", "One check.")
                            }
                        }
                    )
                }
            }
        }
        composeTestRule.onNodeWithText("Plan").assertIsDisplayed()
        composeTestRule.onNodeWithText("bold", substring = true).assertIsDisplayed()
        composeTestRule.onNodeWithText("CHECKLIST").assertIsDisplayed()
        composeTestRule.onNodeWithText("Ready?").assertIsDisplayed()
    }

    @Test
    fun testAgentDesignRendersPromptMarkdown() {
        composeTestRule.setContent {
            FoundryTheme {
                com.foundry.companion.ui.screens.smith.SmithArtifactCard(
                    artifact = buildJsonObject {
                        put("id", "art_agent")
                        put("kind", "agent_design")
                        put("version", 1)
                        put("createdAt", 1)
                        putJsonObject("agent") {
                            put("name", "Verifier")
                            put("model", "inherit")
                            put("envelope", "review")
                            put("systemPrompt", "**Role:** You are a reviewer.\n\n1. Read the diff.")
                            put("userPrompt", "Review **this** change.")
                        }
                    }
                )
            }
        }
        composeTestRule.onNodeWithText("SYSTEM PROMPT").assertIsDisplayed()
        composeTestRule.onNodeWithText("Role:", substring = true).assertIsDisplayed()
        composeTestRule.onNodeWithText("**Role:** You are a reviewer.").assertDoesNotExist()
        composeTestRule.onNodeWithText("Review this change.").assertIsDisplayed()
    }

    @Test
    fun testHidesVendorFunctionCallTextRows() {
        composeTestRule.setContent {
            FoundryTheme {
                SmithScreen(
                    chat = SmithChatState(
                        model = "scripted/alpha",
                        activeModel = "scripted/alpha",
                        transcript = listOf(
                            SmithTranscriptEntry(
                                id = "t1",
                                kind = "text",
                                text = "Got it.",
                                source = "smith",
                                at = 1
                            ),
                            SmithTranscriptEntry(
                                id = "t2",
                                kind = "text",
                                text = """{"functionCall":{"name":"smith_readiness"}}""",
                                source = "smith",
                                at = 2
                            ),
                            SmithTranscriptEntry(
                                id = "t3",
                                kind = "tool",
                                text = "smith_readiness",
                                toolKind = "other",
                                source = "smith",
                                at = 3
                            )
                        )
                    ),
                    proposal = null,
                    projectName = "foundry",
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    isSending = false,
                    onBackClick = {},
                    onRetryConnection = {},
                    onSend = {},
                    onCancel = {},
                    onNewChat = {},
                    onAnswerProposal = { _, _ -> },
                    models = sampleModels
                )
            }
        }
        composeTestRule.onNodeWithText("Got it.").assertIsDisplayed()
        composeTestRule.onNodeWithText("functionCall", substring = true).assertDoesNotExist()
        composeTestRule.onNodeWithText("smith_readiness").assertIsDisplayed()
    }
}
