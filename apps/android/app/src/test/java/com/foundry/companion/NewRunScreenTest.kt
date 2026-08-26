package com.foundry.companion

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.foundry.companion.data.model.*
import com.foundry.companion.ui.screens.newrun.NewRunScreen
import com.foundry.companion.ui.theme.FoundryTheme
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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
    fun testRestoredDraftPopulatesRequestAndReportsEdits() {
        var latestDraft: String? = null

        composeTestRule.setContent {
            FoundryTheme {
                NewRunScreen(
                    projects = sampleProjects,
                    selectedProjectId = "proj_foundry_core",
                    onProjectSelect = {},
                    onDismiss = {},
                    onStartRun = { _, _, _ -> },
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    initialRequestText = "Persisted draft request",
                    onRequestChange = { latestDraft = it }
                )
            }
        }

        composeTestRule.onNodeWithText("Persisted draft request").assertIsDisplayed()
        composeTestRule.onNodeWithText("Describe what to build").assertDoesNotExist()
        composeTestRule.onNodeWithText("START RUN").assertIsEnabled()

        composeTestRule.onNodeWithText("Persisted draft request").performTextReplacement("Edited persisted draft")
        assertEquals("Edited persisted draft", latestDraft)
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

    // ── Orchestrator mode ─────────────────────────────────────────────────────

    private val sampleOrchestratorOptions = OrchestratorOptions(
        models = listOf(
            SmithModelInfo(
                id = "scripted/alpha",
                displayName = "Alpha",
                provider = "scripted",
                supportedReasoningEfforts = listOf("low", "medium", "high"),
                defaultReasoningEffort = "medium"
            )
        ),
        model = "scripted/alpha",
        reasoningEffort = "high"
    )

    private val sampleGeneratedPlan = GeneratedRunPlan(
        planId = "plan_1",
        projectId = "proj_foundry_core",
        prompt = "Bring Android run creation to desktop parity",
        refinedRequest = "Bring Android run creation to desktop parity, with focused tests.",
        rationale = "Keep implementation and verification together so the PR lands clean.",
        pipeline = buildJsonObject {
            put("id", "gen-pipe-1")
            put("name", "Generated pipeline")
            put("description", "A pipeline synthesized for this request.")
            put(
                "acceptance",
                buildJsonObject { put("kind", "all_phases_pass") }
            )
            put(
                "phases",
                buildJsonArray {
                    add(
                        buildJsonObject {
                            put("name", "Investigate")
                            put("kind", "agent")
                            put("agent", "planner")
                            put("model", "scripted/alpha")
                            put("description", "Inspect the gap and scope the change.")
                        }
                    )
                    add(
                        buildJsonObject {
                            put("name", "Implement")
                            put("kind", "agent")
                            put("agent", "builder")
                            put("model", "scripted/alpha")
                            put("description", "Implement the parity change.")
                        }
                    )
                }
            )
        },
        agents = emptyList(),
        warnings = emptyList(),
        model = "scripted/alpha",
        reasoningEffort = "high"
    )

    @Test
    fun testOrchestratorTabGeneratesPlanFromRequest() {
        var capturedProject: String? = null
        var capturedPrompt: String? = null
        var capturedModel: String? = null
        var capturedEffort: String? = null

        composeTestRule.setContent {
            FoundryTheme {
                NewRunScreen(
                    projects = sampleProjects,
                    selectedProjectId = "proj_foundry_core",
                    onProjectSelect = {},
                    onDismiss = {},
                    onStartRun = { _, _, _ -> },
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    orchestratorOptions = sampleOrchestratorOptions,
                    onGeneratePlan = { projectId, prompt, model, effort ->
                        capturedProject = projectId
                        capturedPrompt = prompt
                        capturedModel = model
                        capturedEffort = effort
                    }
                )
            }
        }

        composeTestRule.onNodeWithText("ORCHESTRATOR").performClick()

        // Generate stays disabled without a request (the picking bar has no START RUN yet).
        composeTestRule.onNodeWithContentDescription("Generate plan").assertIsNotEnabled()

        composeTestRule.onNodeWithText("What should the factory build? Be specific: the request is the whole brief.")
            .performScrollTo()
            .performTextInput("Build the parity change")
        composeTestRule.onNodeWithContentDescription("Generate plan").assertIsEnabled()
        composeTestRule.onNodeWithContentDescription("Generate plan").performClick()

        assertEquals("proj_foundry_core", capturedProject)
        assertEquals("Build the parity change", capturedPrompt)
        assertEquals("scripted/alpha", capturedModel)
        // The UI keeps the built-in default until the operator changes it.
        assertEquals("medium", capturedEffort)
    }

    @Test
    fun testOrchestratorPlanCardShowsPhasesAndStartsRun() {
        val state = OrchestratorState(
            planId = "plan_1",
            projectId = "proj_foundry_core",
            status = "done",
            model = "scripted/alpha",
            reasoningEffort = "high",
            prompt = "Bring Android run creation to desktop parity",
            plan = sampleGeneratedPlan,
            detail = "Plan ready."
        )
        var startedProject: String? = null

        composeTestRule.setContent {
            FoundryTheme {
                NewRunScreen(
                    projects = sampleProjects,
                    selectedProjectId = "proj_foundry_core",
                    onProjectSelect = {},
                    onDismiss = {},
                    onStartRun = { _, _, _ -> },
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    orchestratorOptions = sampleOrchestratorOptions,
                    orchestratorState = state,
                    onStartOrchestratedRun = { startedProject = it }
                )
            }
        }

        composeTestRule.onNodeWithText("ORCHESTRATOR").performClick()

        composeTestRule.onNodeWithContentDescription("Generated plan card")
            .performScrollTo()
            .assertIsDisplayed()
        composeTestRule.onNodeWithText("ORCHESTRATOR PLAN").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("2 phases · 0 synthesized agents").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("Investigate").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("WHY THIS SHAPE").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("REFINED REQUEST").performScrollTo().assertIsDisplayed()

        composeTestRule.onNodeWithText("START RUN").performClick()
        assertEquals("proj_foundry_core", startedProject)
    }

    // ── Linear mode ───────────────────────────────────────────────────────────

    private val sampleLinearIssue = LinearIssueSnapshot(
        id = "linear-fou-204",
        identifier = "FOU-204",
        title = "Bring Android run creation and recovery to desktop parity",
        description = "Add Orchestrator plans, Linear-backed starts, and checkpoint restore.",
        url = "https://linear.app/foundry-nik/issue/FOU-204",
        updatedAt = "2026-08-25T20:00:00Z",
        team = LinearTeam("team-foundry", "Foundry"),
        state = LinearWorkflowState("linear-started", "In Progress", "started")
    )

    private val sampleLinearStates = listOf(
        LinearWorkflowState("linear-started", "In Progress", "started"),
        LinearWorkflowState("linear-done", "Done", "completed"),
        LinearWorkflowState("linear-failed", "Cancelled", "canceled")
    )

    private val sampleLinearConnection = LinearConnectionState(
        keySet = true,
        detail = "Connected to Linear as mntechsurvey.",
        statusMapping = LinearStatusMapping(
            started = "linear-started",
            completed = "linear-done",
            failed = "linear-failed"
        )
    )

    @Test
    fun testLinearTabUnconnectedShowsSetupCopyAndDisablesStart() {
        composeTestRule.setContent {
            FoundryTheme {
                NewRunScreen(
                    projects = sampleProjects,
                    selectedProjectId = "proj_foundry_core",
                    onProjectSelect = {},
                    onDismiss = {},
                    onStartRun = { _, _, _ -> },
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    linearConnection = LinearConnectionState(
                        keySet = false,
                        detail = "Add a Linear API key in Foundry → Settings → Providers → Linear on your Mac."
                    )
                )
            }
        }

        composeTestRule.onNodeWithText("LINEAR").performClick()
        composeTestRule.onNodeWithContentDescription("Linear not connected").assertIsDisplayed()
        composeTestRule.onNodeWithText("LINEAR NOT CONNECTED").assertIsDisplayed()
        composeTestRule.onNodeWithText("START RUN").assertIsNotEnabled()
    }

    @Test
    fun testLinearTabIssueLifecycleMappingAndStart() {
        var startedProject: String? = null
        var startedPipeline: String? = null
        var startedPlan: GeneratedRunPlan? = null

        composeTestRule.setContent {
            FoundryTheme {
                NewRunScreen(
                    projects = sampleProjects,
                    selectedProjectId = "proj_foundry_core",
                    onProjectSelect = {},
                    onDismiss = {},
                    onStartRun = { _, _, _ -> },
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    linearConnection = sampleLinearConnection,
                    linearIssues = listOf(sampleLinearIssue),
                    selectedLinearIssue = sampleLinearIssue,
                    linearWorkflowStates = sampleLinearStates,
                    linearStatusMapping = sampleLinearConnection.statusMapping,
                    onStartLinearRun = { projectId, pipelineId, plan ->
                        startedProject = projectId
                        startedPipeline = pipelineId
                        startedPlan = plan
                    }
                )
            }
        }

        composeTestRule.onNodeWithText("LINEAR").performClick()

        composeTestRule.onNodeWithContentDescription("Selected Linear issue")
            .performScrollTo()
            .assertIsDisplayed()
        composeTestRule.onNodeWithText("ISSUE LIFECYCLE").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("ON START").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("WHEN ACCEPTED").performScrollTo().assertIsDisplayed()
        composeTestRule.onNodeWithText("IF FAILED").performScrollTo().assertIsDisplayed()

        composeTestRule.onNodeWithText("START RUN").performClick()
        assertEquals("proj_foundry_core", startedProject)
        assertEquals("pipe_default", startedPipeline)
        assertNull(startedPlan)
    }

    @Test
    fun testLinearTabGeneratesPlanFromIssue() {
        var generatedProject: String? = null
        var generatedPrompt: String? = null
        var generatedModel: String? = null
        var generatedEffort: String? = null

        composeTestRule.setContent {
            FoundryTheme {
                NewRunScreen(
                    projects = sampleProjects,
                    selectedProjectId = "proj_foundry_core",
                    onProjectSelect = {},
                    onDismiss = {},
                    onStartRun = { _, _, _ -> },
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    orchestratorOptions = sampleOrchestratorOptions,
                    linearConnection = sampleLinearConnection,
                    linearIssues = listOf(sampleLinearIssue),
                    selectedLinearIssue = sampleLinearIssue,
                    linearWorkflowStates = sampleLinearStates,
                    linearStatusMapping = sampleLinearConnection.statusMapping,
                    onGeneratePlan = { projectId, prompt, model, effort ->
                        generatedProject = projectId
                        generatedPrompt = prompt
                        generatedModel = model
                        generatedEffort = effort
                    }
                )
            }
        }

        composeTestRule.onNodeWithText("LINEAR").performClick()

        composeTestRule.onNodeWithText("GENERATE PLAN FROM ISSUE").performScrollTo().performClick()
        assertEquals("proj_foundry_core", generatedProject)
        assertTrue(generatedPrompt!!.contains("FOU-204"))
        assertTrue(generatedPrompt!!.contains("desktop parity"))
        assertEquals("scripted/alpha", generatedModel)
        // The UI keeps the built-in default until the operator changes it.
        assertEquals("medium", generatedEffort)
    }
}
