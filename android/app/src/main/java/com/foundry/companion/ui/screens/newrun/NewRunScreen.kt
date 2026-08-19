package com.foundry.companion.ui.screens.newrun

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.CompanionProjectSummary
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.ValidationIssue
import com.foundry.companion.ui.components.FoundryPrimaryButton
import com.foundry.companion.ui.components.FoundryTopBar
import com.foundry.companion.ui.components.PhaseRibbon
import com.foundry.companion.ui.components.ReconnectBanner
import com.foundry.companion.ui.theme.FoundryTheme

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
    onRequestChange: (String) -> Unit = {}
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

    var selectedPipelineId by remember(currentProject, lastUsedPipelineId) {
        mutableStateOf(initialPipelineId)
    }

    var requestText by rememberSaveable { mutableStateOf(initialRequestText) }
    val focusRequester = remember { FocusRequester() }

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
    val isFormValid = isConnected && requestText.isNotBlank() && selectedPipelineId.isNotBlank() && !hasBlockingErrors && !isStarting

    val disabledReason = when {
        !isConnected -> "Reconnect to start a run"
        pipelines.isEmpty() -> "No pipeline available"
        selectedPipelineId.isBlank() -> "Select a pipeline"
        requestText.isBlank() -> "Describe what to build"
        hasBlockingErrors -> "Fix pipeline errors first"
        else -> null
    }

    Scaffold(
        modifier = modifier
            .fillMaxSize()
            .imePadding(),
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
            }
        },
        bottomBar = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgBase)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                FoundryPrimaryButton(
                    text = if (isStarting) "Starting…" else "Start run",
                    onClick = {
                        if (isFormValid) {
                            onStartRun(currentProject?.id ?: selectedProjectId, selectedPipelineId, requestText.trim())
                        }
                    },
                    enabled = isFormValid,
                    isLoading = isStarting
                )

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

            // 1. Request multiline text area
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "REQUEST",
                    style = typography.eyebrowMono,
                    color = colors.textDim
                )
                OutlinedTextField(
                    value = requestText,
                    onValueChange = {
                        requestText = it
                        onRequestChange(it)
                    },
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

            // 2. Pipeline selector
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
                                .clickable {
                                    selectedPipelineId = pipeline.id
                                    onPipelineSelect?.invoke(currentProject?.id ?: selectedProjectId, pipeline.id)
                                }
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
                                    onClick = {
                                        selectedPipelineId = pipeline.id
                                        onPipelineSelect?.invoke(currentProject?.id ?: selectedProjectId, pipeline.id)
                                    },
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
