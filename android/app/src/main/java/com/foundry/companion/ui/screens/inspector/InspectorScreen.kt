package com.foundry.companion.ui.screens.inspector

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
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
import com.foundry.companion.ui.screens.inspector.components.TranscriptLane
import com.foundry.companion.ui.theme.FoundryTheme
import kotlinx.coroutines.flow.distinctUntilChanged

@OptIn(ExperimentalFoundationApi::class)
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
    hasProject: Boolean = true,
    /** The desktop answered that it has no such run, so there is nothing to wait for. */
    isRunMissing: Boolean = false
) {
    val colors = FoundryTheme.colors

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
        if (isRunMissing) {
            InspectorScaffold(
                title = "Inspector",
                connectionStatus = connectionStatus,
                onBackClick = onBackClick,
                onRetryConnection = onRetryConnection,
                status = null,
                modifier = modifier
            ) {
                InspectorEmptyState(
                    title = "This run is gone.",
                    body = "The desktop no longer has it — it was discarded or its trace was pruned.",
                    testTag = "inspector-missing"
                )
            }
            return
        }
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

    val defaultPhaseId = remember(initialPhaseId, phases) {
        initialPhaseId
            ?: phases.find { it.status.equals("running", ignoreCase = true) }?.resolvedId
            ?: phases.findLast { it.status.equals("fail", ignoreCase = true) }?.resolvedId
            ?: phases.lastOrNull()?.resolvedId
            ?: phases.firstOrNull()?.resolvedId
    }

    var selectedPhaseId by remember(defaultPhaseId) { mutableStateOf(defaultPhaseId) }

    val selectedIndex = remember(phases, selectedPhaseId) {
        phases.indexOfFirst { it.resolvedId == selectedPhaseId }.let { index ->
            if (index >= 0) index else 0
        }
    }

    val pagerState = rememberPagerState(
        initialPage = selectedIndex,
        pageCount = { phases.size.coerceAtLeast(1) }
    )
    var pagerDriven by remember { mutableStateOf(false) }

    LaunchedEffect(selectedIndex, phases.size) {
        if (phases.isEmpty()) return@LaunchedEffect
        if (pagerState.currentPage != selectedIndex && !pagerDriven) {
            pagerState.animateScrollToPage(selectedIndex)
        }
        pagerDriven = false
    }

    LaunchedEffect(pagerState, phases) {
        snapshotFlow { pagerState.settledPage }
            .distinctUntilChanged()
            .collect { page ->
                val id = phases.getOrNull(page)?.resolvedId ?: return@collect
                if (id != selectedPhaseId) {
                    pagerDriven = true
                    selectedPhaseId = id
                    onPhaseSelected(id)
                }
            }
    }

    val currentPhase = phases.find { it.resolvedId == selectedPhaseId } ?: phases.firstOrNull()

    InspectorScaffold(
        title = "Inspector · ${currentPhase?.name ?: "Phase"}",
        connectionStatus = connectionStatus,
        onBackClick = onBackClick,
        onRetryConnection = onRetryConnection,
        status = runDetail.run.status,
        modifier = modifier
    ) {
        if (phases.isEmpty()) {
            InspectorEmptyState(
                title = "No phases yet.",
                body = null,
                testTag = "inspector-empty-phases"
            )
            return@InspectorScaffold
        }

        PhaseChipsRow(
            phases = phases,
            selectedPhaseId = selectedPhaseId,
            onSelectPhase = {
                selectedPhaseId = it
                onPhaseSelected(it)
            }
        )

        HorizontalPager(
            state = pagerState,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .testTag("inspector-pager"),
            key = { page -> phases[page].resolvedId },
            userScrollEnabled = true
        ) { page ->
            val phase = phases[page]
            InspectorPhasePage(
                phase = phase,
                phases = phases,
                events = events,
                isSelected = phase.resolvedId == selectedPhaseId,
                isConnected = connectionStatus is ConnectionStatus.Connected
            )
        }
    }
}

@Composable
private fun InspectorPhasePage(
    phase: PhaseRunSummary,
    phases: List<PhaseRunSummary>,
    events: List<EventRow>,
    isSelected: Boolean,
    isConnected: Boolean
) {
    val isPhaseRunning = phase.status.equals("running", ignoreCase = true)
    val followLive = isSelected && isPhaseRunning && isConnected
    val phaseEvents = remember(events, phase.resolvedId) {
        TranscriptEvents.visibleForPhase(events, phase.resolvedId)
    }

    when {
        phase.status.equals("queued", ignoreCase = true) -> {
            val previous = previousPhaseName(phases, phase)
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
                isRunning = followLive,
                modifier = Modifier
                    .fillMaxSize()
                    .testTag("inspector-page-${phase.resolvedId}")
            )
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
