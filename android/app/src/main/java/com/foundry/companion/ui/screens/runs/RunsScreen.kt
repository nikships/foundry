package com.foundry.companion.ui.screens.runs

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    val liveRun = runs.find { it.status.equals("running", ignoreCase = true) }
    val historyRuns = runs.filterNot { it.status.equals("running", ignoreCase = true) }
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
            ExtendedFloatingActionButton(
                onClick = onStartRunClick,
                containerColor = if (isConnected) colors.accent else colors.bgRaised,
                contentColor = if (isConnected) androidx.compose.ui.graphics.Color.Black else colors.textFaint,
                shape = shapes.button,
                icon = {
                    Icon(
                        imageVector = Icons.Default.Add,
                        contentDescription = "Start run"
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
    ) { innerPadding ->
        if (runs.isEmpty()) {
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
                // Live run card pinned at top
                if (liveRun != null) {
                    item(key = "live_run_card") {
                        Column(
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                            modifier = Modifier.padding(bottom = 6.dp)
                        ) {
                            Text(
                                text = "IN FLIGHT",
                                style = typography.eyebrowMono,
                                color = colors.accent
                            )
                            LiveRunCard(
                                run = liveRun,
                                onClick = { onRunClick(liveRun.runId) }
                            )
                        }
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
                            onClick = { onRunClick(run.runId) }
                        )
                    }
                }
            }
        }
    }
}
