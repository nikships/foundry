package com.foundry.companion.ui.screens.inspector

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.EventRow
import com.foundry.companion.data.model.PhaseRunSummary
import com.foundry.companion.data.model.RunDetail
import com.foundry.companion.data.model.TranscriptEvents
import com.foundry.companion.ui.components.FoundryTopBar
import com.foundry.companion.ui.components.ReconnectBanner
import com.foundry.companion.ui.components.StatusBadge
import com.foundry.companion.ui.screens.inspector.components.PhaseChipsRow
import com.foundry.companion.ui.screens.inspector.components.PhaseFilter
import com.foundry.companion.ui.screens.inspector.components.PhaseFilterRow
import com.foundry.companion.ui.screens.inspector.components.TranscriptLane
import com.foundry.companion.ui.theme.FoundryTheme

@Composable
fun InspectorScreen(
    runDetail: RunDetail?,
    events: List<EventRow>,
    initialPhaseId: String?,
    connectionStatus: ConnectionStatus,
    onBackClick: () -> Unit,
    onPhaseSelected: (phaseId: String) -> Unit,
    modifier: Modifier = Modifier,
    onRetryConnection: () -> Unit = {},
    hasProject: Boolean = true
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography

    if (!hasProject) {
        InspectorScaffold(
            title = "Inspector",
            connectionStatus = connectionStatus,
            onBackClick = onBackClick,
            onRetryConnection = onRetryConnection,
            status = null,
            modifier = modifier
        ) {
            InspectorEmptyState(
                title = "No project yet",
                body = "The Inspector follows that project's runs.",
                testTag = "inspector-empty-project"
            )
        }
        return
    }

    if (runDetail == null) {
        Box(
            modifier = modifier
                .fillMaxSize()
                .background(colors.bgBase)
                .testTag("inspector-loading"),
            contentAlignment = Alignment.Center
        ) {
            CircularProgressIndicator(color = colors.accent)
        }
        return
    }

    val phases = runDetail.phases
    var filter by remember { mutableStateOf(PhaseFilter.ALL) }
    val filteredPhases = remember(phases, filter) {
        phases.filter { phase ->
            when (filter) {
                PhaseFilter.ALL -> true
                PhaseFilter.RUNNING -> phase.status.equals("running", ignoreCase = true)
                PhaseFilter.FAILED -> phase.status.equals("fail", ignoreCase = true)
            }
        }
    }

    val defaultPhaseId = remember(initialPhaseId, phases) {
        initialPhaseId
            ?: phases.find { it.status.equals("running", ignoreCase = true) }?.resolvedId
            ?: phases.findLast { it.status.equals("fail", ignoreCase = true) }?.resolvedId
            ?: phases.lastOrNull()?.resolvedId
            ?: phases.firstOrNull()?.resolvedId
    }

    var selectedPhaseId by remember(defaultPhaseId) { mutableStateOf(defaultPhaseId) }

    LaunchedEffect(filteredPhases, selectedPhaseId) {
        if (filteredPhases.isNotEmpty() && filteredPhases.none { it.resolvedId == selectedPhaseId }) {
            selectedPhaseId = filteredPhases.first().resolvedId
            onPhaseSelected(filteredPhases.first().resolvedId)
        }
    }

    val currentPhase = phases.find { it.resolvedId == selectedPhaseId } ?: phases.firstOrNull()
    val isPhaseRunning = currentPhase?.status.equals("running", ignoreCase = true)
    val phaseEvents = remember(events, selectedPhaseId) {
        TranscriptEvents.visibleForPhase(events, selectedPhaseId)
    }

    InspectorScaffold(
        title = "Inspector · ${currentPhase?.name ?: "Phase"}",
        connectionStatus = connectionStatus,
        onBackClick = onBackClick,
        onRetryConnection = onRetryConnection,
        status = runDetail.run.status,
        modifier = modifier
    ) {
        PhaseFilterRow(
            currentFilter = filter,
            onFilterSelect = { filter = it },
            runningCount = phases.count { it.status.equals("running", ignoreCase = true) },
            failedCount = phases.count { it.status.equals("fail", ignoreCase = true) }
        )

        if (filteredPhases.isEmpty()) {
            InspectorEmptyState(
                title = "No phases match this filter.",
                body = null,
                testTag = "inspector-empty-filter",
                actionLabel = if (filter != PhaseFilter.ALL) "SHOW ALL PHASES" else null,
                onAction = { filter = PhaseFilter.ALL }
            )
            return@InspectorScaffold
        }

        PhaseChipsRow(
            phases = filteredPhases,
            selectedPhaseId = selectedPhaseId,
            onSelectPhase = {
                selectedPhaseId = it
                onPhaseSelected(it)
            }
        )

        when {
            currentPhase?.status.equals("queued", ignoreCase = true) -> {
                val previous = previousPhaseName(phases, currentPhase)
                InspectorEmptyState(
                    title = "This phase hasn't started yet.",
                    body = previous?.let { "runs after $it" },
                    testTag = "inspector-empty-queued"
                )
            }
            phaseEvents.isEmpty() -> {
                InspectorEmptyState(
                    title = "No events yet.",
                    body = null,
                    testTag = "inspector-empty-events"
                )
            }
            else -> {
                TranscriptLane(
                    events = phaseEvents,
                    isRunning = isPhaseRunning && connectionStatus is ConnectionStatus.Connected,
                    modifier = Modifier.weight(1f)
                )
            }
        }
    }
}

@Composable
private fun InspectorScaffold(
    title: String,
    connectionStatus: ConnectionStatus,
    onBackClick: () -> Unit,
    onRetryConnection: () -> Unit,
    status: String?,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit
) {
    val colors = FoundryTheme.colors
    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = colors.bgBase,
        topBar = {
            FoundryTopBar(
                title = title,
                onBackClick = onBackClick,
                actions = {
                    if (status != null) {
                        StatusBadge(status = status)
                    }
                }
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            ReconnectBanner(
                status = connectionStatus,
                onRetryClick = onRetryConnection
            )
            content()
        }
    }
}

@Composable
private fun InspectorEmptyState(
    title: String,
    body: String?,
    testTag: String,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp)
            .testTag(testTag),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(text = title, style = typography.bodyStrong, color = colors.textPrimary)
        if (!body.isNullOrBlank()) {
            Spacer(modifier = Modifier.height(8.dp))
            Text(text = body, style = typography.body, color = colors.textDim)
        }
        if (actionLabel != null && onAction != null) {
            TextButton(onClick = onAction) {
                Text(text = actionLabel, style = typography.labelMono, color = colors.accent)
            }
        }
    }
}

private fun previousPhaseName(phases: List<PhaseRunSummary>, current: PhaseRunSummary?): String? {
    if (current == null) return null
    val index = phases.indexOfFirst { it.resolvedId == current.resolvedId }
    if (index <= 0) return null
    return phases[index - 1].name
}
