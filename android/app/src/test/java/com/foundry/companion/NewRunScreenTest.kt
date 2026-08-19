package com.foundry.companion

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.foundry.companion.data.model.*
import com.foundry.companion.ui.screens.newrun.NewRunScreen
import com.foundry.companion.ui.theme.FoundryTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NewRunScreenTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    private val samplePipelines = listOf(
        PipelineSummary(
            id = "pipe_default",
            name = "Feature Pipeline",
            description = "Standard 5-phase feature development workflow with review gate.",
            phases = listOf(
                PhaseTemplateSummary("p1", "Plan", "agent"),
                PhaseTemplateSummary("p2", "Spec", "agent"),
                PhaseTemplateSummary("p3", "Code", "code"),
                PhaseTemplateSummary("p4", "Review", "review", isFeedbackTarget = true),
                PhaseTemplateSummary("p5", "PR", "agent")
            )
        ),
        PipelineSummary(
            id = "pipe_bugfix",
            name = "Bugfix & Verify",
            description = "Fast turnaround pipeline for isolated regression repairs.",
            phases = listOf(
                PhaseTemplateSummary("b1", "Triage", "agent"),
                PhaseTemplateSummary("b2", "Patch", "code"),
                PhaseTemplateSummary("b3", "Verify", "agent")
            )
        )
    )

    private val sampleProjects = listOf(
        CompanionProjectSummary(
            id = "proj_foundry_core",
            name = "Foundry Core",
            pipelines = samplePipelines
        ),
        CompanionProjectSummary(
            id = "proj_foundry_docs",
            name = "Foundry Documentation",
            pipelines = samplePipelines
        )
    )

    @Test
    fun testFormValidationAndStartDisabledReasons() {
        var startedProjectId: String? = null
        var startedPipelineId: String? = null
        var startedRequest: String? = null

        composeTestRule.setContent {
            FoundryTheme {
                NewRunScreen(
                    projects = sampleProjects,
                    selectedProjectId = "proj_foundry_core",
                    onProjectSelect = {},
                    onDismiss = {},
                    onStartRun = { pId, pipeId, req ->
                        startedProjectId = pId
                        startedPipelineId = pipeId
                        startedRequest = req
                    },
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100")
                )
            }
        }

        // Empty request initially: helper text shown, start disabled
        composeTestRule.onNodeWithText("Describe what to build").assertIsDisplayed()
        composeTestRule.onNodeWithText("START RUN").assertIsNotEnabled()

        // Type a request into the multiline text field
        composeTestRule.onNodeWithText("What should the factory build? Be specific: the request is the whole brief.")
            .performTextInput("Add companion start run support with Compose")

        composeTestRule.onNodeWithText("Describe what to build").assertDoesNotExist()
        composeTestRule.onNodeWithText("START RUN").assertIsEnabled()

        // Tap Start run
        composeTestRule.onNodeWithText("START RUN").performClick()
        assertEquals("proj_foundry_core", startedProjectId)
        assertEquals("pipe_default", startedPipelineId)
        assertEquals("Add companion start run support with Compose", startedRequest)
    }

    @Test
    fun testStartDisabledWhenOffline() {
        composeTestRule.setContent {
            FoundryTheme {
                NewRunScreen(
                    projects = sampleProjects,
                    selectedProjectId = "proj_foundry_core",
                    onProjectSelect = {},
                    onDismiss = {},
                    onStartRun = { _, _, _ -> },
                    connectionStatus = ConnectionStatus.Offline("Nik's Mac", "http://192.168.1.100")
                )
            }
        }

        composeTestRule.onNodeWithText("Reconnect to start a run").assertIsDisplayed()
        composeTestRule.onNodeWithText("START RUN").assertIsNotEnabled()
    }

    @Test
    fun testEmptyPipelinesState() {
        val emptyPipelinesProject = CompanionProjectSummary(
            id = "proj_empty",
            name = "Empty Project",
            pipelines = emptyList()
        )

        composeTestRule.setContent {
            FoundryTheme {
                NewRunScreen(
                    projects = listOf(emptyPipelinesProject),
                    selectedProjectId = "proj_empty",
                    onProjectSelect = {},
                    onDismiss = {},
                    onStartRun = { _, _, _ -> },
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100")
                )
            }
        }

        composeTestRule.onNodeWithText("This project has no pipelines yet. Add one in Foundry on your Mac.")
            .performScrollTo()
            .assertIsDisplayed()
        composeTestRule.onNodeWithText("START RUN").assertIsNotEnabled()
    }

    @Test
    fun testSingleProjectStaticCaption() {
        composeTestRule.setContent {
            FoundryTheme {
                NewRunScreen(
                    projects = listOf(sampleProjects.first()),
                    selectedProjectId = "proj_foundry_core",
                    onProjectSelect = {},
                    onDismiss = {},
                    onStartRun = { _, _, _ -> },
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100")
                )
            }
        }

        composeTestRule.onNodeWithText("PROJECT · FOUNDRY CORE").assertIsDisplayed()
    }

    @Test
    fun testMultiProjectChipSelection() {
        var selectedProjectId: String? = null

        composeTestRule.setContent {
            FoundryTheme {
                NewRunScreen(
                    projects = sampleProjects,
                    selectedProjectId = "proj_foundry_core",
                    onProjectSelect = { selectedProjectId = it },
                    onDismiss = {},
                    onStartRun = { _, _, _ -> },
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100")
                )
            }
        }

        composeTestRule.onNodeWithText("Foundry Documentation").assertIsDisplayed()
        composeTestRule.onNodeWithText("Foundry Documentation").performClick()
        assertEquals("proj_foundry_docs", selectedProjectId)
    }

    @Test
    fun testPipelinePreselectionAndSwitching() {
        var persistedPipelineId: String? = null

        composeTestRule.setContent {
            FoundryTheme {
                NewRunScreen(
                    projects = sampleProjects,
                    selectedProjectId = "proj_foundry_core",
                    lastUsedPipelineId = "pipe_bugfix",
                    onPipelineSelect = { _, pipeId -> persistedPipelineId = pipeId },
                    onProjectSelect = {},
                    onDismiss = {},
                    onStartRun = { _, _, _ -> },
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100")
                )
            }
        }

        // Phase ribbons rendered
        composeTestRule.onNodeWithText("Triage").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("Patch").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("Verify").performScrollTo().assertIsDisplayed()

        // Switch to Feature Pipeline
        composeTestRule.onNodeWithText("Feature Pipeline").performScrollTo().performClick()
        assertEquals("pipe_default", persistedPipelineId)
    }

    @Test
    fun testValidationIssuesSurfacedInline() {
        val issues = listOf(
            ValidationIssue(level = "error", message = "Project command 'test' is not configured on your Mac."),
            ValidationIssue(level = "warning", message = "Agent 'reviewer' is using fallback reasoning effort.")
        )

        composeTestRule.setContent {
            FoundryTheme {
                NewRunScreen(
                    projects = sampleProjects,
                    selectedProjectId = "proj_foundry_core",
                    onProjectSelect = {},
                    onDismiss = {},
                    onStartRun = { _, _, _ -> },
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    validationIssues = issues
                )
            }
        }

        composeTestRule.onNodeWithText("PREFLIGHT ISSUES").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("Project command 'test' is not configured on your Mac.").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("Agent 'reviewer' is using fallback reasoning effort.").performScrollTo().assertIsDisplayed()

        // Type request
        composeTestRule.onNodeWithText("What should the factory build? Be specific: the request is the whole brief.")
            .performScrollTo()
            .performTextInput("Fix test command")

        // Error level disables start with specific helper text
        composeTestRule.onNodeWithText("Fix pipeline errors first").assertIsDisplayed()
        composeTestRule.onNodeWithText("START RUN").assertIsNotEnabled()
    }

    @Test
    fun testDismissCallback() {
        var dismissed = false

        composeTestRule.setContent {
            FoundryTheme {
                NewRunScreen(
                    projects = sampleProjects,
                    selectedProjectId = "proj_foundry_core",
                    onProjectSelect = {},
                    onDismiss = { dismissed = true },
                    onStartRun = { _, _, _ -> },
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100")
                )
            }
        }

        composeTestRule.onNodeWithContentDescription("Close").performClick()
        assertTrue(dismissed)
    }
}
