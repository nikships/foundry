package com.foundry.companion.ui.screens.newrun

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.CompanionProjectSummary
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.GeneratedRunPlan
import com.foundry.companion.data.model.LinearConnectionState
import com.foundry.companion.data.model.LinearIssueSnapshot
import com.foundry.companion.data.model.LinearStatusMapping
import com.foundry.companion.data.model.LinearWorkflowState
import com.foundry.companion.data.model.OrchestratorOptions
import com.foundry.companion.data.model.OrchestratorState
import com.foundry.companion.data.model.SmithModelInfo
import com.foundry.companion.data.model.ValidationIssue
import com.foundry.companion.data.model.linearIssueBrief
import com.foundry.companion.ui.components.FoundryPrimaryButton
import com.foundry.companion.ui.components.FoundrySecondaryButton
import com.foundry.companion.ui.components.FoundryTopBar
import com.foundry.companion.ui.components.PhaseRibbon
import com.foundry.companion.ui.components.ReconnectBanner
import com.foundry.companion.ui.components.foundryBottomChromePadding
import com.foundry.companion.ui.components.foundryBottomChromePadding
import com.foundry.companion.ui.theme.FoundryTheme
import kotlinx.coroutines.delay

/** How the operator wants this run composed: pick a pipeline, generate one, or start from Linear. */
enum class NewRunMode { Manual, Orchestrator, Linear }

@Composable
fun NewRunScreen(
    projects: List<CompanionProjectSummary>,
    selectedProjectId: String,
    onProjectSelect: (String) -> Unit,
    onDismiss: () -> Unit,
    onStartRun: (projectId: String, pipelineId: String, request: String) -> Unit,
    connectionStatus: ConnectionStatus,
    modifier: Modifier = Modifier,
    lastUsedPipelineId: String? = null,
    onPipelineSelect: ((projectId: String, pipelineId: String) -> Unit)? = null,
    onRetryConnection: () -> Unit = {},
    isStarting: Boolean = false,
    validationIssues: List<ValidationIssue> = emptyList(),
    initialRequestText: String = "",
    onRequestChange: (String) -> Unit = {},
    // Orchestrator
    orchestratorOptions: OrchestratorOptions? = null,
    orchestratorState: OrchestratorState? = null,
    isPlanning: Boolean = false,
    onGeneratePlan: (projectId: String, prompt: String, model: String, effort: String) -> Unit = { _, _, _, _ -> },
    onCancelPlan: () -> Unit = {},
    onDiscardPlan: () -> Unit = {},
    onSetPlanPhaseModel: (phaseName: String, model: String) -> Unit = { _, _ -> },
    onStartOrchestratedRun: (projectId: String) -> Unit = {},
    // Linear
    linearConnection: LinearConnectionState? = null,
    linearIssues: List<LinearIssueSnapshot> = emptyList(),
    selectedLinearIssue: LinearIssueSnapshot? = null,
    linearWorkflowStates: List<LinearWorkflowState> = emptyList(),
    linearStatusMapping: LinearStatusMapping = LinearStatusMapping(),
    isSearchingLinear: Boolean = false,
    isLoadingLinearWorkflow: Boolean = false,
    onSearchLinearIssues: (String) -> Unit = {},
    onSelectLinearIssue: (LinearIssueSnapshot?) -> Unit = {},
    onSetLinearStatus: (stage: String, stateId: String) -> Unit = { _, _ -> },
    onStartLinearRun: (projectId: String, pipelineId: String, plan: GeneratedRunPlan?) -> Unit = { _, _, _ -> },
    /** Test/launcher seam: which composer mode starts out selected. */
    initialMode: NewRunMode = NewRunMode.Manual
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    val currentProject = projects.find { it.id == selectedProjectId } ?: projects.firstOrNull()
    val pipelines = currentProject?.pipelines ?: emptyList()

    val initialPipelineId = remember(currentProject, lastUsedPipelineId) {
        if (!lastUsedPipelineId.isNullOrBlank() && pipelines.any { it.id == lastUsedPipelineId }) {
            lastUsedPipelineId
        } else {
            pipelines.firstOrNull()?.id.orEmpty()
        }
    }

    var mode by rememberSaveable { mutableStateOf(initialMode) }
    var selectedPipelineId by remember(currentProject, lastUsedPipelineId) {
        mutableStateOf(initialPipelineId)
    }

    var requestText by rememberSaveable { mutableStateOf(initialRequestText) }
    var plannerModel by rememberSaveable { mutableStateOf("") }
    var plannerEffort by rememberSaveable { mutableStateOf("medium") }
    var linearQuery by rememberSaveable { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }

    // Seed the planner pickers from the desktop's saved defaults exactly once.
    LaunchedEffect(orchestratorOptions) {
        val options = orchestratorOptions ?: return@LaunchedEffect
        if (plannerModel.isBlank()) plannerModel = options.model.ifBlank { "inherit" }
        if (plannerEffort !in options.models.flatMap { it.supportedReasoningEfforts }) {
            plannerEffort = options.reasoningEffort
        }
    }

    // Debounced issue search, matching the desktop composer's pace. Blank is
    // skipped: the ViewModel seeds the list once when capabilities load, so
    // entering the screen must not double-fetch the same empty query.
    LaunchedEffect(linearQuery) {
        if (linearConnection?.keySet != true) return@LaunchedEffect
        if (linearQuery.isBlank()) return@LaunchedEffect
        delay(350)
        onSearchLinearIssues(linearQuery)
    }

    BackHandler { onDismiss() }

    LaunchedEffect(Unit) {
        try {
            focusRequester.requestFocus()
        } catch (_: Exception) {
            // Ignore focus failures in test environments
        }
    }

    val isConnected = connectionStatus is ConnectionStatus.Connected
    val hasBlockingErrors = validationIssues.any { it.level == "error" }
    val plan = orchestratorState?.plan
    val planReady = plan != null
    val planningLive = isPlanning || orchestratorState?.status == "running"
    val linearConnected = linearConnection?.keySet == true
    val linearReady = linearConnected && selectedLinearIssue != null && linearStatusMapping.isComplete

    val isFormValid = isConnected && requestText.isNotBlank() && selectedPipelineId.isNotBlank() && !hasBlockingErrors && !isStarting

    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = colors.bgBase,
        topBar = {
            Column {
                FoundryTopBar(
                    title = "New Run",
                    onBackClick = onDismiss,
                    isCloseAction = true
                )
                ReconnectBanner(
                    status = connectionStatus,
                    onRetryClick = onRetryConnection
                )
                NewRunModeTabs(
                    mode = mode,
                    onModeChange = { mode = it },
                    enabled = isConnected
                )
            }
        },
        bottomBar = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgBase)
                    .foundryBottomChromePadding()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                when (mode) {
                    NewRunMode.Manual -> ManualBottomBar(
                        isConnected = isConnected,
                        isStarting = isStarting,
                        isFormValid = isFormValid,
                        disabledReason = when {
                            !isConnected -> "Reconnect to start a run"
                            pipelines.isEmpty() -> "No pipeline available"
                            selectedPipelineId.isBlank() -> "Select a pipeline"
                            requestText.isBlank() -> "Describe what to build"
                            hasBlockingErrors -> "Fix pipeline errors first"
                            else -> null
                        },
                        onStart = {
                            onStartRun(currentProject?.id ?: selectedProjectId, selectedPipelineId, requestText.trim())
                        }
                    )

                    NewRunMode.Orchestrator -> OrchestratorBottomBar(
                        isConnected = isConnected,
                        isStarting = isStarting,
                        planReady = planReady,
                        planningLive = planningLive,
                        modelsAvailable = !orchestratorOptions?.models.isNullOrEmpty(),
                        canGenerate = isConnected && requestText.isNotBlank() && plannerModel.isNotBlank() &&
                            !orchestratorOptions?.models.isNullOrEmpty() && !hasBlockingErrors,
                        canStart = isConnected && planReady,
                        disabledReason = when {
                            !isConnected -> "Reconnect to start a run"
                            orchestratorOptions == null -> "Loading planning options…"
                            orchestratorOptions.models.isEmpty() -> "Connect a provider on the Mac to use the Orchestrator"
                            requestText.isBlank() -> "Describe what to build"
                            plannerModel.isBlank() -> "Choose a planning model"
                            !planReady -> "Generate a plan, then review it before starting"
                            else -> null
                        },
                        onGenerate = {
                            onGeneratePlan(
                                currentProject?.id ?: selectedProjectId,
                                requestText.trim(),
                                plannerModel,
                                plannerEffort
                            )
                        },
                        onCancel = onCancelPlan,
                        onDiscard = onDiscardPlan,
                        onStart = {
                            onStartOrchestratedRun(currentProject?.id ?: selectedProjectId)
                        }
                    )

                    NewRunMode.Linear -> LinearBottomBar(
                        isConnected = isConnected,
                        isStarting = isStarting,
                        linearConnected = linearConnected,
                        planReady = planReady,
                        canStart = isConnected && linearReady && !isLoadingLinearWorkflow &&
                            (planReady || selectedPipelineId.isNotBlank()),
                        disabledReason = when {
                            !isConnected -> "Reconnect to start a run"
                            !linearConnected -> "Connect Linear on the Mac first"
                            selectedLinearIssue == null -> "Choose a Linear issue"
                            isLoadingLinearWorkflow -> "Loading the team workflow…"
                            !linearStatusMapping.isComplete -> "Map all three lifecycle statuses"
                            selectedPipelineId.isBlank() && !planReady -> "Choose a pipeline or generate a plan"
                            else -> null
                        },
                        onDiscardPlan = { if (planReady) onDiscardPlan() },
                        onStart = {
                            onStartLinearRun(
                                currentProject?.id ?: selectedProjectId,
                                selectedPipelineId,
                                plan
                            )
                        }
                    )
                }
            }
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)
        ) {
            // Project selector if multi-project, otherwise static caption
            if (projects.size > 1) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = "PROJECT",
                        style = typography.eyebrowMono,
                        color = colors.textDim
                    )
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        projects.forEach { proj ->
                            val isSelected = proj.id == selectedProjectId
                            Box(
                                modifier = Modifier
                                    .background(
                                        if (isSelected) colors.bgRaised else colors.bgPanel,
                                        shapes.chip
                                    )
                                    .border(
                                        1.dp,
                                        if (isSelected) colors.accent else colors.line,
                                        shapes.chip
                                    )
                                    .clickable { onProjectSelect(proj.id) }
                                    .padding(horizontal = 12.dp, vertical = 8.dp)
                            ) {
                                Text(
                                    text = proj.name,
                                    style = typography.labelMono,
                                    color = if (isSelected) colors.textPrimary else colors.textDim
                                )
                            }
                        }
                    }
                }
            } else if (currentProject != null) {
                Text(
                    text = "PROJECT · ${currentProject.name.uppercase()}",
                    style = typography.eyebrowMono,
                    color = colors.textFaint
                )
            }

            when (mode) {
                NewRunMode.Manual -> {
                    RequestField(
                        requestText = requestText,
                        onRequestChange = {
                            requestText = it
                            onRequestChange(it)
                        },
                        focusRequester = focusRequester
                    )
                    PipelinePicker(
                        pipelines = pipelines,
                        selectedPipelineId = selectedPipelineId,
                        onSelect = { id ->
                            selectedPipelineId = id
                            onPipelineSelect?.invoke(currentProject?.id ?: selectedProjectId, id)
                        }
                    )
                }

                NewRunMode.Orchestrator -> {
                    RequestField(
                        requestText = requestText,
                        onRequestChange = {
                            requestText = it
                            onRequestChange(it)
                        },
                        focusRequester = focusRequester
                    )

                    if (planReady && plan != null) {
                        PlanCard(
                            plan = plan,
                            models = orchestratorOptions?.models.orEmpty(),
                            onSetPhaseModel = onSetPlanPhaseModel
                        )
                    } else if (planningLive && orchestratorState != null) {
                        PlanningCard(state = orchestratorState)
                    } else {
                        PlannerPicker(
                            options = orchestratorOptions,
                            model = plannerModel,
                            effort = plannerEffort,
                            onModelChange = { plannerModel = it },
                            onEffortChange = { plannerEffort = it }
                        )
                    }
                }

                NewRunMode.Linear -> {
                    LinearComposerSection(
                        connection = linearConnection,
                        issues = linearIssues,
                        selectedIssue = selectedLinearIssue,
                        states = linearWorkflowStates,
                        mapping = linearStatusMapping,
                        isSearching = isSearchingLinear,
                        isLoadingStates = isLoadingLinearWorkflow,
                        query = linearQuery,
                        onQueryChange = { linearQuery = it },
                        onSelectIssue = onSelectLinearIssue,
                        onSetStatus = onSetLinearStatus,
                        plan = plan,
                        models = orchestratorOptions?.models.orEmpty(),
                        onSetPhaseModel = onSetPlanPhaseModel,
                        pipelines = pipelines,
                        selectedPipelineId = selectedPipelineId,
                        onSelectPipeline = { id ->
                            selectedPipelineId = id
                            onPipelineSelect?.invoke(currentProject?.id ?: selectedProjectId, id)
                        },
                        onGeneratePlan = {
                            onGeneratePlan(
                                currentProject?.id ?: selectedProjectId,
                                it,
                                plannerModel,
                                plannerEffort
                            )
                        },
                        plannerModelSet = plannerModel.isNotBlank(),
                        onDiscardPlan = onDiscardPlan
                    )
                }
            }

            // Desktop preflight & validation issues
            if (validationIssues.isNotEmpty()) {
                Column(
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.statusFailed.copy(alpha = 0.14f), shapes.card)
                        .border(1.dp, colors.statusFailed.copy(alpha = 0.32f), shapes.card)
                        .padding(12.dp)
                ) {
                    Text(
                        text = "PREFLIGHT ISSUES",
                        style = typography.eyebrowMono,
                        color = colors.statusFailed
                    )
                    validationIssues.forEach { issue ->
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalAlignment = Alignment.Top
                        ) {
                            Text(
                                text = if (issue.level == "error") "✕" else "⚠",
                                style = typography.metaMono,
                                color = if (issue.level == "error") colors.statusFailed else colors.statusRejected
                            )
                            Text(
                                text = issue.message,
                                style = typography.body,
                                color = if (issue.level == "error") colors.statusFailed else colors.statusRejected
                            )
                        }
                    }
                }
            }
        }
    }
}

// ── Mode tabs ────────────────────────────────────────────────────────────────

@Composable
private fun NewRunModeTabs(
    mode: NewRunMode,
    onModeChange: (NewRunMode) -> Unit,
    enabled: Boolean
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        ModeTab(
            label = "MANUAL",
            selected = mode == NewRunMode.Manual,
            enabled = true,
            onClick = { onModeChange(NewRunMode.Manual) },
            colors = colors,
            typography = typography,
            shapes = shapes,
            modifier = Modifier.weight(1f)
        )
        ModeTab(
            label = "ORCHESTRATOR",
            selected = mode == NewRunMode.Orchestrator,
            enabled = enabled,
            onClick = { if (enabled) onModeChange(NewRunMode.Orchestrator) },
            colors = colors,
            typography = typography,
            shapes = shapes,
            modifier = Modifier.weight(1f)
        )
        ModeTab(
            label = "LINEAR",
            selected = mode == NewRunMode.Linear,
            enabled = enabled,
            onClick = { if (enabled) onModeChange(NewRunMode.Linear) },
            colors = colors,
            typography = typography,
            shapes = shapes,
            modifier = Modifier.weight(1f)
        )
    }
}

@Composable
private fun ModeTab(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    colors: com.foundry.companion.ui.theme.FoundryColors,
    typography: com.foundry.companion.ui.theme.FoundryTypography,
    shapes: com.foundry.companion.ui.theme.FoundryShapes,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier
            .background(if (selected) colors.bgRaised else colors.bgPanel, shapes.chip)
            .border(1.dp, if (selected) colors.accent else colors.line, shapes.chip)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = label,
            style = typography.labelMono,
            color = when {
                !enabled -> colors.textFaint
                selected -> colors.accent
                else -> colors.textDim
            }
        )
    }
}

// ── Bottom bars ──────────────────────────────────────────────────────────────

@Composable
private fun ManualBottomBar(
    isConnected: Boolean,
    isStarting: Boolean,
    isFormValid: Boolean,
    disabledReason: String?,
    onStart: () -> Unit
) {
    BottomBarShell(disabledReason = disabledReason) {
        RunStartBar(
            planReady = false,
            isStarting = isStarting,
            isConnected = isConnected,
            canStart = isFormValid,
            onDiscard = null,
            onStart = onStart
        )
    }
}

@Composable
private fun OrchestratorBottomBar(
    isConnected: Boolean,
    isStarting: Boolean,
    planReady: Boolean,
    planningLive: Boolean,
    modelsAvailable: Boolean,
    canGenerate: Boolean,
    canStart: Boolean,
    disabledReason: String?,
    onGenerate: () -> Unit,
    onCancel: () -> Unit,
    onDiscard: () -> Unit,
    onStart: () -> Unit
) {
    BottomBarShell(disabledReason = disabledReason) {
        if (planReady) {
            RunStartBar(
                planReady = true,
                isStarting = isStarting,
                isConnected = isConnected,
                canStart = canStart,
                onDiscard = onDiscard,
                onStart = onStart
            )
        } else if (planningLive) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                FoundrySecondaryButton(
                    text = "Cancel",
                    onClick = onCancel,
                    enabled = isConnected,
                    modifier = Modifier.weight(1f)
                )
                FoundryPrimaryButton(
                    text = "Planning…",
                    onClick = {},
                    enabled = false,
                    isLoading = true,
                    modifier = Modifier.weight(1f)
                )
            }
        } else {
            FoundryPrimaryButton(
                text = "Generate plan",
                onClick = onGenerate,
                enabled = canGenerate,
                contentDescription = "Generate plan"
            )
        }
        if (!modelsAvailable && !planningLive && !planReady) {
            val colors = FoundryTheme.colors
            val typography = FoundryTheme.typography
            Text(
                text = "Connect a provider on the Mac to use the Orchestrator.",
                style = typography.metaMono,
                color = colors.textFaint,
                modifier = Modifier.padding(horizontal = 4.dp)
            )
        }
    }
}

@Composable
private fun LinearBottomBar(
    isConnected: Boolean,
    isStarting: Boolean,
    linearConnected: Boolean,
    planReady: Boolean,
    canStart: Boolean,
    disabledReason: String?,
    onDiscardPlan: () -> Unit,
    onStart: () -> Unit
) {
    BottomBarShell(disabledReason = disabledReason) {
        RunStartBar(
            planReady = planReady,
            isStarting = isStarting,
            isConnected = isConnected,
            canStart = canStart,
            onDiscard = onDiscardPlan,
            onStart = onStart
        )
        if (!linearConnected) {
            val colors = FoundryTheme.colors
            val typography = FoundryTheme.typography
            Text(
                text = "Linear is not connected on the Mac. Add an API key in Foundry → Settings → Providers → Linear.",
                style = typography.metaMono,
                color = colors.textFaint,
                modifier = Modifier.padding(horizontal = 4.dp)
            )
        }
    }
}

/**
 * The shared start affordance: Discard + START RUN over a ready plan, or a
 * single START RUN over a picked pipeline. The bars above differ only in the
 * states that are NOT ready (planning, generate, setup).
 */
@Composable
private fun RunStartBar(
    planReady: Boolean,
    isStarting: Boolean,
    isConnected: Boolean,
    canStart: Boolean,
    onDiscard: (() -> Unit)?,
    onStart: () -> Unit
) {
    if (planReady && onDiscard != null) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            FoundrySecondaryButton(
                text = "Discard",
                onClick = onDiscard,
                enabled = isConnected && !isStarting,
                modifier = Modifier.weight(1f)
            )
            FoundryPrimaryButton(
                text = if (isStarting) "Starting…" else "START RUN",
                onClick = onStart,
                enabled = canStart,
                isLoading = isStarting,
                modifier = Modifier.weight(1f)
            )
        }
    } else {
        FoundryPrimaryButton(
            text = if (isStarting) "Starting…" else "START RUN",
            onClick = onStart,
            enabled = canStart,
            isLoading = isStarting
        )
    }
}

@Composable
private fun BottomBarShell(
    disabledReason: String?,
    content: @Composable () -> Unit
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
        content()
        if (disabledReason != null) {
            Text(
                text = disabledReason,
                style = typography.metaMono,
                color = colors.textFaint,
                modifier = Modifier.padding(horizontal = 4.dp)
            )
        }
    }
}

// ── Shared fields ────────────────────────────────────────────────────────────

@Composable
private fun RequestField(
    requestText: String,
    onRequestChange: (String) -> Unit,
    focusRequester: FocusRequester
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = "REQUEST",
            style = typography.eyebrowMono,
            color = colors.textDim
        )
        OutlinedTextField(
            value = requestText,
            onValueChange = onRequestChange,
            placeholder = {
                Text(
                    text = "What should the factory build? Be specific: the request is the whole brief.",
                    style = typography.body,
                    color = colors.textFaint
                )
            },
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 120.dp)
                .focusRequester(focusRequester),
            shape = shapes.card,
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = colors.bgInput,
                unfocusedContainerColor = colors.bgInput,
                focusedBorderColor = colors.lineStrong,
                unfocusedBorderColor = colors.line,
                focusedTextColor = colors.textPrimary,
                unfocusedTextColor = colors.textPrimary
            ),
            textStyle = typography.body
        )
    }
}

@Composable
private fun PipelinePicker(
    pipelines: List<com.foundry.companion.data.model.PipelineSummary>,
    selectedPipelineId: String,
    onSelect: (String) -> Unit
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = "PIPELINE",
            style = typography.eyebrowMono,
            color = colors.textDim
        )

        if (pipelines.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgPanel, shapes.card)
                    .border(1.dp, colors.line, shapes.card)
                    .padding(16.dp)
            ) {
                Text(
                    text = "This project has no pipelines yet. Add one in Foundry on your Mac.",
                    style = typography.body,
                    color = colors.textDim
                )
            }
        } else {
            pipelines.forEach { pipeline ->
                val isSelected = pipeline.id == selectedPipelineId
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(
                            if (isSelected) colors.bgRaised else colors.bgPanel,
                            shapes.card
                        )
                        .border(
                            1.dp,
                            if (isSelected) colors.accent else colors.line,
                            shapes.card
                        )
                        .clickable { onSelect(pipeline.id) }
                        .padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = pipeline.name,
                            style = typography.bodyStrong,
                            color = if (isSelected) colors.accent else colors.textPrimary
                        )
                        RadioButton(
                            selected = isSelected,
                            onClick = { onSelect(pipeline.id) },
                            colors = RadioButtonDefaults.colors(
                                selectedColor = colors.accent,
                                unselectedColor = colors.textFaint
                            )
                        )
                    }

                    if (pipeline.description.isNotBlank()) {
                        Text(
                            text = pipeline.description,
                            style = typography.body,
                            color = colors.textDim
                        )
                    }

                    if (pipeline.phases.isNotEmpty()) {
                        PhaseRibbon(phases = pipeline.phases)
                    }
                }
            }
        }
    }
}

// ── Orchestrator picker, planning, and plan card ─────────────────────────────

@Composable
private fun PlannerPicker(
    options: OrchestratorOptions?,
    model: String,
    effort: String,
    onModelChange: (String) -> Unit,
    onEffortChange: (String) -> Unit
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = "PLANNING MODEL",
            style = typography.eyebrowMono,
            color = colors.textDim
        )
        when {
            options == null -> {
                Text(
                    text = "Loading planning options from the desktop…",
                    style = typography.body,
                    color = colors.textDim
                )
            }
            options.models.isEmpty() -> {
                Text(
                    text = "No reachable models. Connect a provider on the Mac, then reopen this screen.",
                    style = typography.body,
                    color = colors.textDim
                )
            }
            else -> {
                val selectedModel = options.models.firstOrNull { it.id == model }
                NewRunChoiceRow(
                    modelLabel = selectedModel?.label
                        ?: if (model.isBlank() || model == "inherit") "Choose a model…" else model,
                    modelContentDescription = "Planning model",
                    modelOptions = options.models,
                    chosenModel = model,
                    effort = if (effort in options.models.flatMap { it.supportedReasoningEfforts }.orEmpty().toSet()) {
                        effort
                    } else {
                        options.reasoningEffort
                    },
                    effortOptions = selectedModel?.supportedReasoningEfforts
                        ?.ifEmpty { DEFAULT_EFFORTS }
                        ?: DEFAULT_EFFORTS,
                    onSelectModel = onModelChange,
                    onSelectEffort = onEffortChange
                )
                if (selectedModel == null && model.isNotBlank() && model != "inherit") {
                    Text(
                        text = "$model is not available to this install. Choose a model that is.",
                        style = typography.metaMono,
                        color = colors.statusWarning
                    )
                }
            }
        }
    }
}

/** The reasoning levels the desktop understands, used until the model's own list loads. */
private val DEFAULT_EFFORTS = listOf("off", "minimal", "low", "medium", "high", "xhigh", "max")

@Composable
private fun NewRunChoiceRow(
    modelLabel: String,
    modelContentDescription: String,
    modelOptions: List<SmithModelInfo>,
    chosenModel: String,
    effort: String,
    effortOptions: List<String>,
    onSelectModel: (String) -> Unit,
    onSelectEffort: (String) -> Unit
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        NewRunChoiceMenu(
            label = modelLabel,
            contentDescription = modelContentDescription,
            enabled = modelOptions.isNotEmpty(),
            modifier = Modifier.weight(1f)
        ) { dismiss ->
            modelOptions.forEach { option ->
                DropdownMenuItem(
                    text = {
                        Text(
                            text = option.label,
                            style = typography.body,
                            color = if (option.id == chosenModel) colors.accent else colors.textPrimary
                        )
                    },
                    onClick = {
                        onSelectModel(option.id)
                        dismiss()
                    }
                )
            }
        }
        NewRunChoiceMenu(
            label = effort.uppercase(),
            contentDescription = "Planning reasoning",
            enabled = effortOptions.isNotEmpty(),
            modifier = Modifier.weight(0.7f)
        ) { dismiss ->
            effortOptions.forEach { option ->
                DropdownMenuItem(
                    text = {
                        Text(
                            text = option.uppercase(),
                            style = typography.labelMono,
                            color = if (option == effort) colors.accent else colors.textPrimary
                        )
                    },
                    onClick = {
                        onSelectEffort(option)
                        dismiss()
                    }
                )
            }
        }
    }
}

@Composable
private fun NewRunChoiceMenu(
    label: String,
    contentDescription: String,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable (dismiss: () -> Unit) -> Unit
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    var expanded by rememberSaveable { mutableStateOf(false) }
    Box(modifier = modifier) {
        TextButton(
            onClick = { expanded = true },
            enabled = enabled,
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.bgRaised, shapes.chip)
                .border(1.dp, colors.line, shapes.chip)
                .semantics { this.contentDescription = contentDescription }
        ) {
            Text(
                text = label,
                style = typography.labelMono,
                color = if (enabled) colors.textPrimary else colors.textFaint,
                maxLines = 1
            )
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false }
        ) {
            content { expanded = false }
        }
    }
}

@Composable
private fun PlanningCard(state: OrchestratorState) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.bgPanel, shapes.card)
            .border(1.dp, colors.line, shapes.card)
            .padding(16.dp)
            .semantics { contentDescription = "Planning progress" },
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            CircularProgressIndicator(
                modifier = Modifier.size(20.dp),
                color = colors.accent,
                strokeWidth = 2.dp
            )
            Text(
                text = "ORCHESTRATOR IS PLANNING",
                style = typography.eyebrowMono,
                color = colors.accent
            )
        }
        if (state.detail.isNotBlank()) {
            Text(
                text = state.detail,
                style = typography.body,
                color = colors.textPrimary
            )
        }
        Text(
            text = "The Orchestrator picks phases, agents, and verification for your request. Review the plan before starting it.",
            style = typography.body,
            color = colors.textDim
        )
    }
}

@Composable
private fun PlanCard(
    plan: GeneratedRunPlan,
    models: List<SmithModelInfo>,
    onSetPhaseModel: (phaseName: String, model: String) -> Unit
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.bgPanel, shapes.card)
            .border(1.dp, colors.line, shapes.card)
            .padding(16.dp)
            .semantics { contentDescription = "Generated plan card" },
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            text = "ORCHESTRATOR PLAN",
            style = typography.eyebrowMono,
            color = colors.accent
        )
        Text(
            text = plan.pipelineName,
            style = typography.bodyStrong,
            color = colors.textPrimary
        )
        if (plan.pipelineDescription.isNotBlank()) {
            Text(
                text = plan.pipelineDescription,
                style = typography.body,
                color = colors.textDim
            )
        }
        Text(
            text = "${plan.phases.size} phases · ${plan.agents.size} synthesized agents",
            style = typography.metaMono,
            color = colors.textFaint
        )

        if (plan.rationale.isNotBlank()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = "WHY THIS SHAPE",
                    style = typography.eyebrowMono,
                    color = colors.textDim
                )
                Text(
                    text = plan.rationale,
                    style = typography.body,
                    color = colors.textPrimary
                )
            }
        }

        if (plan.refinedRequest.isNotBlank()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = "REFINED REQUEST",
                    style = typography.eyebrowMono,
                    color = colors.textDim
                )
                SelectionContainer {
                    Text(
                        text = plan.refinedRequest,
                        style = typography.body,
                        color = colors.textPrimary
                    )
                }
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                text = "PHASES",
                style = typography.eyebrowMono,
                color = colors.textDim
            )
            plan.phases.forEachIndexed { index, phase ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Text(
                        text = "${index + 1}",
                        style = typography.metaMono,
                        color = colors.textFaint,
                        modifier = Modifier.width(16.dp)
                    )
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = phase.name,
                            style = typography.bodyStrong,
                            color = colors.textPrimary
                        )
                        if (phase.description.isNotBlank()) {
                            Text(
                                text = phase.description,
                                style = typography.body,
                                color = colors.textDim,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                        if (phase.agent != null) {
                            Text(
                                text = "by ${phase.agent}",
                                style = typography.metaMono,
                                color = colors.textFaint
                            )
                        }
                    }
                    if (phase.kind == "agent" && models.isNotEmpty()) {
                        NewRunChoiceMenu(
                            label = phase.model?.let { modelLabel(it, models) } ?: "inherit",
                            contentDescription = "Phase model ${phase.name}",
                            enabled = true,
                            modifier = Modifier.width(150.dp)
                        ) { dismiss ->
                            models.forEach { option ->
                                DropdownMenuItem(
                                    text = {
                                        Text(
                                            text = option.label,
                                            style = typography.labelMono,
                                            color = if (option.id == phase.model) colors.accent else colors.textPrimary
                                        )
                                    },
                                    onClick = {
                                        onSetPhaseModel(phase.name, option.id)
                                        dismiss()
                                    }
                                )
                            }
                        }
                    }
                }
            }
        }

        if (plan.warnings.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = "WARNINGS",
                    style = typography.eyebrowMono,
                    color = colors.statusWarning
                )
                plan.warnings.forEach { warning ->
                    Text(
                        text = "⚠ ${warning.message}",
                        style = typography.metaMono,
                        color = colors.statusWarning
                    )
                }
            }
        }

        Text(
            text = "Planned by ${plan.model.substringAfterLast('/')} · ${plan.reasoningEffort.uppercase()}",
            style = typography.metaMono,
            color = colors.textFaint
        )
    }
}

private fun modelLabel(model: String, models: List<SmithModelInfo>): String {
    return models.firstOrNull { it.id == model }?.label ?: model.substringAfterLast('/')
}

// ── Linear composer ──────────────────────────────────────────────────────────

@Composable
private fun LinearComposerSection(
    connection: LinearConnectionState?,
    issues: List<LinearIssueSnapshot>,
    selectedIssue: LinearIssueSnapshot?,
    states: List<LinearWorkflowState>,
    mapping: LinearStatusMapping,
    isSearching: Boolean,
    isLoadingStates: Boolean,
    query: String,
    onQueryChange: (String) -> Unit,
    onSelectIssue: (LinearIssueSnapshot?) -> Unit,
    onSetStatus: (stage: String, stateId: String) -> Unit,
    plan: GeneratedRunPlan?,
    models: List<SmithModelInfo>,
    onSetPhaseModel: (phaseName: String, model: String) -> Unit,
    pipelines: List<com.foundry.companion.data.model.PipelineSummary>,
    selectedPipelineId: String,
    onSelectPipeline: (String) -> Unit,
    onGeneratePlan: (brief: String) -> Unit,
    plannerModelSet: Boolean,
    onDiscardPlan: () -> Unit
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    when {
        connection == null -> {
            Text(
                text = "Checking the Linear connection on your Mac…",
                style = typography.body,
                color = colors.textDim
            )
        }
        !connection.keySet -> {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgPanel, shapes.card)
                    .border(1.dp, colors.line, shapes.card)
                    .padding(16.dp)
                    .semantics { contentDescription = "Linear not connected" },
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text(
                    text = "LINEAR NOT CONNECTED",
                    style = typography.eyebrowMono,
                    color = colors.statusWarning
                )
                Text(
                    text = connection.detail.ifBlank {
                        "Add a Linear API key in Foundry → Settings → Providers → Linear on your Mac."
                    },
                    style = typography.body,
                    color = colors.textDim
                )
            }
        }
        selectedIssue != null -> {
            SelectedIssueCard(
                issue = selectedIssue,
                onChange = { onSelectIssue(null) }
            )

            // Lifecycle mapping: one state per run stage, saved with the start.
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "ISSUE LIFECYCLE",
                    style = typography.eyebrowMono,
                    color = colors.textDim
                )
                if (isLoadingStates) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            color = colors.accent,
                            strokeWidth = 2.dp
                        )
                        Text(
                            text = "Loading ${selectedIssue.team.name}'s workflow…",
                            style = typography.body,
                            color = colors.textDim
                        )
                    }
                } else {
                    MappingRow(
                        label = "ON START",
                        stage = "started",
                        selected = mapping.started,
                        states = states,
                        onSelect = { onSetStatus("started", it) }
                    )
                    MappingRow(
                        label = "WHEN ACCEPTED",
                        stage = "completed",
                        selected = mapping.completed,
                        states = states,
                        onSelect = { onSetStatus("completed", it) }
                    )
                    MappingRow(
                        label = "IF FAILED",
                        stage = "failed",
                        selected = mapping.failed,
                        states = states,
                        onSelect = { onSetStatus("failed", it) }
                    )
                    if (!mapping.isComplete) {
                        Text(
                            text = "Map all three lifecycle statuses before starting.",
                            style = typography.metaMono,
                            color = colors.statusWarning
                        )
                    }
                }
            }

            if (plan != null) {
                PlanCard(
                    plan = plan,
                    models = models,
                    onSetPhaseModel = onSetPhaseModel
                )
                Text(
                    text = "This run keeps the issue as its source and starts the generated plan.",
                    style = typography.metaMono,
                    color = colors.textFaint
                )
            } else {
                PipelinePicker(
                    pipelines = pipelines,
                    selectedPipelineId = selectedPipelineId,
                    onSelect = onSelectPipeline
                )
                Text(
                    text = "OR GENERATE A PLAN FROM THIS ISSUE",
                    style = typography.eyebrowMono,
                    color = colors.textDim,
                    modifier = Modifier.padding(top = 4.dp)
                )
                FoundrySecondaryButton(
                    text = "Generate plan from issue",
                    onClick = {
                        // The canonical brief: same shape and 32k truncation the
                        // repository uses, so phone and desktop agree verbatim.
                        onGeneratePlan(
                            linearIssueBrief(selectedIssue)
                        )
                    },
                    enabled = plannerModelSet && !isLoadingStates
                )
                if (!plannerModelSet) {
                    Text(
                        text = "A planning model is loading — reopen the screen if it stays empty.",
                        style = typography.metaMono,
                        color = colors.textFaint
                    )
                }
            }
        }
        else -> {
            // Issue search
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "LINEAR ISSUE",
                    style = typography.eyebrowMono,
                    color = colors.textDim
                )
                OutlinedTextField(
                    value = query,
                    onValueChange = onQueryChange,
                    placeholder = {
                        Text(
                            text = "Search by id or title, e.g. FOU-204…",
                            style = typography.body,
                            color = colors.textFaint
                        )
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { contentDescription = "Search Linear issues" },
                    singleLine = true,
                    shape = shapes.card,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = colors.bgInput,
                        unfocusedContainerColor = colors.bgInput,
                        focusedBorderColor = colors.lineStrong,
                        unfocusedBorderColor = colors.line,
                        focusedTextColor = colors.textPrimary,
                        unfocusedTextColor = colors.textPrimary
                    ),
                    textStyle = typography.body
                )

                if (isSearching) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            color = colors.accent,
                            strokeWidth = 2.dp
                        )
                        Text(
                            text = "Searching…",
                            style = typography.body,
                            color = colors.textDim
                        )
                    }
                } else if (issues.isEmpty()) {
                    Text(
                        text = if (query.isBlank()) {
                            "No issues shared by the desktop. Type an id or title to search Linear."
                        } else {
                            "No issues match “$query”."
                        },
                        style = typography.body,
                        color = colors.textDim
                    )
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        issues.forEach { issue ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(colors.bgPanel, shapes.card)
                                    .border(1.dp, colors.line, shapes.card)
                                    .clickable { onSelectIssue(issue) }
                                    .padding(12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp)
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(8.dp)
                                        .background(linearStateColor(issue.state.type, colors), shapes.chip)
                                )
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = "${issue.identifier} · ${issue.state.name}",
                                        style = typography.labelMono,
                                        color = if (issue.state.type == "started") colors.accent else colors.textDim
                                    )
                                    Text(
                                        text = issue.title,
                                        style = typography.bodyStrong,
                                        color = colors.textPrimary,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis
                                    )
                                }
                                Text(
                                    text = issue.team.name,
                                    style = typography.metaMono,
                                    color = colors.textFaint
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SelectedIssueCard(
    issue: LinearIssueSnapshot,
    onChange: () -> Unit
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.bgRaised, shapes.card)
            .border(1.dp, colors.accent.copy(alpha = 0.45f), shapes.card)
            .padding(12.dp)
            .semantics { contentDescription = "Selected Linear issue" },
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .background(linearStateColor(issue.state.type, colors), shapes.chip)
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "${issue.identifier} · ${issue.state.name}",
                    style = typography.labelMono,
                    color = if (issue.state.type == "started") colors.accent else colors.textDim
                )
                Text(
                    text = issue.title,
                    style = typography.bodyStrong,
                    color = colors.textPrimary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    text = issue.team.name,
                    style = typography.metaMono,
                    color = colors.textFaint
                )
            }
            Text(
                text = "CHANGE",
                style = typography.labelMono,
                color = colors.textDim,
                modifier = Modifier
                    .clickable(onClick = onChange)
                    .padding(8.dp)
            )
        }
    }
}

@Composable
private fun MappingRow(
    label: String,
    stage: String,
    selected: String?,
    states: List<LinearWorkflowState>,
    onSelect: (String) -> Unit
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    var expanded by rememberSaveable { mutableStateOf(false) }
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Text(
            text = label,
            style = typography.labelMono,
            color = colors.textDim,
            modifier = Modifier.width(118.dp)
        )
        Box(modifier = Modifier.weight(1f)) {
            TextButton(
                onClick = { expanded = true },
                enabled = states.isNotEmpty(),
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgRaised, shapes.chip)
                    .border(1.dp, colors.line, shapes.chip)
                    .semantics { this.contentDescription = "Linear status $stage" }
            ) {
                Text(
                    text = states.firstOrNull { it.id == selected }?.name ?: if (states.isEmpty()) "No states" else "Choose…",
                    style = typography.labelMono,
                    color = if (selected != null) colors.textPrimary else colors.textFaint,
                    maxLines = 1
                )
            }
            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false }
            ) {
                states.forEach { state ->
                    DropdownMenuItem(
                        text = {
                            Text(
                                text = state.name,
                                style = typography.body,
                                color = if (state.id == selected) colors.accent else colors.textPrimary
                            )
                        },
                        onClick = {
                            onSelect(state.id)
                            expanded = false
                        }
                    )
                }
            }
        }
    }
}

private fun linearStateColor(stateType: String, colors: com.foundry.companion.ui.theme.FoundryColors): androidx.compose.ui.graphics.Color {
    return when (stateType) {
        "started" -> colors.accent
        "completed" -> colors.statusAccepted
        "canceled", "cancelled" -> colors.textFaint
        else -> colors.textDim
    }
}
