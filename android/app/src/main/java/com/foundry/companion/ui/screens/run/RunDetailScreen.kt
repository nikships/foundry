package com.foundry.companion.ui.screens.run

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.RunDetail
import com.foundry.companion.ui.components.*
import com.foundry.companion.ui.screens.run.components.OutcomeCard
import com.foundry.companion.ui.screens.run.components.PhaseWaterfall
import com.foundry.companion.ui.screens.run.components.SelectedPhaseSummaryCard
import com.foundry.companion.ui.theme.FoundryTheme

@Composable
fun RunDetailScreen(
    runDetail: RunDetail?,
    connectionStatus: ConnectionStatus,
    onBackClick: () -> Unit,
    onOpenInspector: (phaseId: String?) -> Unit,
    onKillRun: (runId: String) -> Unit,
    onOpenPr: (prUrl: String) -> Unit,
    onCreatePr: (runId: String) -> Unit,
    onOpenIssue: (issueUrl: String) -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    var showKillDialog by remember { mutableStateOf(false) }
    var isRequestExpanded by remember { mutableStateOf(false) }

    if (runDetail == null) {
        Box(
            modifier = modifier
                .fillMaxSize()
                .background(colors.bgBase),
            contentAlignment = Alignment.Center
        ) {
            CircularProgressIndicator(color = colors.accent)
        }
        return
    }

    val run = runDetail.run
    val phases = runDetail.phases
    val isRunning = run.status.equals("running", ignoreCase = true)
    val isConnected = connectionStatus is ConnectionStatus.Connected

    // Default selection: running phase, else last failed, else first
    val defaultPhaseId = remember(phases) {
        phases.find { it.status.equals("running", ignoreCase = true) }?.id
            ?: phases.find { it.status.equals("fail", ignoreCase = true) }?.id
            ?: phases.firstOrNull()?.id
    }
    var selectedPhaseId by remember(defaultPhaseId) { mutableStateOf(defaultPhaseId) }
    val selectedPhase = phases.find { it.id == selectedPhaseId } ?: phases.firstOrNull()

    val shortRunId = run.runId.takeLast(6)

    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = colors.bgBase,
        topBar = {
            FoundryTopBar(
                title = "Run · ${run.pipelineName} · $shortRunId",
                onBackClick = onBackClick,
                actions = {
                    if (isRunning) {
                        TextButton(
                            onClick = { showKillDialog = true },
                            enabled = isConnected
                        ) {
                            Text(
                                text = "KILL",
                                style = typography.labelMono,
                                color = if (isConnected) colors.statusFailed else colors.textFaint
                            )
                        }
                    }

                    IconButton(
                        onClick = { onOpenInspector(selectedPhaseId) }
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.List,
                            contentDescription = "Inspector",
                            tint = colors.textPrimary
                        )
                    }
                }
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Header block: Status + Pipeline Name + Request
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgPanel, shapes.card)
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    StatusBadge(status = run.status)
                    Text(
                        text = run.pipelineName,
                        style = typography.labelMono,
                        color = colors.textDim
                    )
                }

                Text(
                    text = run.request,
                    style = typography.requestText,
                    color = colors.textPrimary,
                    maxLines = if (isRequestExpanded) Int.MAX_VALUE else 4,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.clickable { isRequestExpanded = !isRequestExpanded }
                )

                // Meta row: duration · tokens · branch
                val durationText = (run.durationMs?.let { ms ->
                    val totalSec = ms / 1000
                    val min = totalSec / 60
                    val sec = totalSec % 60
                    if (min > 0) "${min}m ${sec}s" else "${sec}s"
                } ?: "—")

                val tokensText = run.totalTokens?.let { "${it / 1000}k tokens" } ?: "—"
                val branchName = run.branch ?: "—"

                Text(
                    text = "$durationText · $tokensText · $branchName",
                    style = typography.metaMono,
                    color = colors.textFaint
                )
            }

            // Outcome card for settled runs
            if (!isRunning) {
                OutcomeCard(
                    run = run,
                    onOpenPr = onOpenPr,
                    onCreatePr = { onCreatePr(run.runId) },
                    onOpenIssue = onOpenIssue
                )
            }

            // Phase waterfall
            if (phases.isNotEmpty()) {
                PhaseWaterfall(
                    phases = phases,
                    selectedPhaseId = selectedPhaseId,
                    onSelectPhase = { selectedPhaseId = it }
                )
            }

            // Selected phase summary
            if (selectedPhase != null) {
                SelectedPhaseSummaryCard(
                    phase = selectedPhase,
                    onViewTranscript = { onOpenInspector(it) }
                )
            }
        }
    }

    // Kill confirmation dialog
    if (showKillDialog) {
        AlertDialog(
            onDismissRequest = { showKillDialog = false },
            containerColor = colors.bgRaised,
            shape = shapes.card,
            title = {
                Text(
                    text = "KILL RUN",
                    style = typography.eyebrowMono,
                    color = colors.statusFailed
                )
            },
            text = {
                Text(
                    text = "Kill this run? In-flight agent turns stop; the worktree branch is kept.",
                    style = typography.body,
                    color = colors.textPrimary
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        showKillDialog = false
                        onKillRun(run.runId)
                    },
                    shape = shapes.button,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.statusFailed.copy(alpha = 0.18f),
                        contentColor = colors.statusFailed
                    )
                ) {
                    Text(text = "KILL", style = typography.labelMono)
                }
            },
            dismissButton = {
                TextButton(onClick = { showKillDialog = false }) {
                    Text(text = "CANCEL", style = typography.labelMono, color = colors.textDim)
                }
            }
        )
    }
}
