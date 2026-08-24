package com.foundry.companion.ui.screens.runs

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.RunRow
import com.foundry.companion.ui.components.*
import com.foundry.companion.ui.screens.runs.components.LiveRunCard
import com.foundry.companion.ui.screens.runs.components.RunHistoryRow
import com.foundry.companion.ui.theme.FoundryTheme

@Composable
fun RunsScreen(
    runs: List<RunRow>,
    connectionStatus: ConnectionStatus,
    projectName: String,
    onRunClick: (runId: String) -> Unit,
    onStartRunClick: () -> Unit,
    onConnectionPillClick: () -> Unit,
    onRetryConnection: () -> Unit,
    modifier: Modifier = Modifier,
    onInspectorClick: (runId: String) -> Unit = {},
    onOpenPr: ((String) -> Unit)? = null,
    onSmithClick: (() -> Unit)? = null
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    // Filter out archived runs (archived runs stay hidden)
    val visibleRuns = remember(runs) { runs.filterNot { it.archived } }
    val liveRuns = remember(visibleRuns) {
        visibleRuns.filter { it.status.equals("running", ignoreCase = true) }
    }
    val historyRuns = remember(visibleRuns) {
        visibleRuns.filterNot { it.status.equals("running", ignoreCase = true) }
    }
    val isConnected = connectionStatus is ConnectionStatus.Connected

    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = colors.bgBase,
        topBar = {
            Column {
                FoundryTopBar(
                    title = "RUNS",
                    subtitle = projectName,
                    eyebrowStyle = true,
                    actions = {
                        if (onSmithClick != null) {
                            TextButton(
                                onClick = onSmithClick,
                                modifier = Modifier.semantics { contentDescription = "Open Smith" }
                            ) {
                                Text(
                                    text = "SMITH",
                                    style = typography.labelMono,
                                    color = colors.textPrimary
                                )
                            }
                        }
                        ConnectionPill(
                            status = connectionStatus,
                            onClick = onConnectionPillClick
                        )
                    }
                )
                ReconnectBanner(
                    status = connectionStatus,
                    onRetryClick = onRetryConnection
                )
            }
        },
        floatingActionButton = {
            Column(horizontalAlignment = Alignment.End) {
                if (!isConnected) {
                    Text(
                        text = "Reconnect to start a run",
                        style = typography.metaMono,
                        color = colors.textFaint,
                        modifier = Modifier.padding(end = 4.dp, bottom = 8.dp)
                    )
                }
                ExtendedFloatingActionButton(
                    onClick = {
                        if (isConnected) {
                            onStartRunClick()
                        }
                    },
                    modifier = Modifier
                        .defaultMinSize(minHeight = 48.dp)
                        .semantics { contentDescription = "Start run" },
                    containerColor = if (isConnected) colors.accent else colors.bgRaised,
                    contentColor = if (isConnected) androidx.compose.ui.graphics.Color.Black else colors.textFaint,
                    shape = shapes.button,
                    icon = {
                        Icon(
                            imageVector = Icons.Default.Add,
                            contentDescription = null
                        )
                    },
                    text = {
                        Text(
                            text = "START RUN",
                            style = typography.labelMono
                        )
                    }
                )
            }
        }
    ) { innerPadding ->
        if (visibleRuns.isEmpty()) {
            // Empty state
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .padding(24.dp),
                contentAlignment = Alignment.Center
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = "Nothing has run yet",
                        style = typography.screenTitle,
                        color = colors.textPrimary
                    )
                    Text(
                        text = "Describe a change and pick a pipeline — every run is isolated in its own worktree on your Mac.",
                        style = typography.body,
                        color = colors.textDim,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center
                    )
                    FoundryPrimaryButton(
                        text = "Start a run",
                        onClick = onStartRunClick,
                        enabled = isConnected,
                        contentDescription = "Start a run",
                        modifier = Modifier.widthIn(max = 240.dp)
                    )
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                if (liveRuns.isNotEmpty()) {
                    item(key = "live_run_header") {
                        Text(
                            text = "IN FLIGHT",
                            style = typography.eyebrowMono,
                            color = colors.accent
                        )
                    }
                    items(
                        items = liveRuns,
                        key = { it.runId }
                    ) { run ->
                        LiveRunCard(
                            run = run,
                            onClick = { onRunClick(run.runId) }
                        )
                    }
                }

                // History section
                if (historyRuns.isNotEmpty()) {
                    item(key = "history_header") {
                        Text(
                            text = "HISTORY",
                            style = typography.eyebrowMono,
                            color = colors.textDim,
                            modifier = Modifier.padding(top = 4.dp, bottom = 2.dp)
                        )
                    }

                    items(
                        items = historyRuns,
                        key = { it.runId }
                    ) { run ->
                        RunHistoryRow(
                            run = run,
                            onClick = { onRunClick(run.runId) },
                            onInspectorClick = { onInspectorClick(run.runId) },
                            onOpenPr = onOpenPr
                        )
                    }
                }
            }
        }
    }
}
