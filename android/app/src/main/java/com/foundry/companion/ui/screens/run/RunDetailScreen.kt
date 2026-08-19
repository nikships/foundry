package com.foundry.companion.ui.screens.run

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
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
import com.foundry.companion.data.model.PendingInterrupt
import com.foundry.companion.data.model.RunDetail
import com.foundry.companion.ui.components.*
import com.foundry.companion.ui.screens.run.components.OutcomeCard
import com.foundry.companion.ui.screens.run.components.PhaseWaterfall
import com.foundry.companion.ui.screens.run.components.SelectedPhaseSummaryCard
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.ui.theme.foundryLiveClockEnabled
import com.foundry.companion.util.RunFormatters
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

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
    modifier: Modifier = Modifier,
    pendingInterrupt: PendingInterrupt? = null,
    actionError: String? = null,
    onDismissActionError: (() -> Unit)? = null,
    onAnswerInterrupt: ((interruptId: String, approved: Boolean, notes: String?) -> Unit)? = null,
    onRetryConnection: (() -> Unit)? = null,
    isCreatingPr: Boolean = false
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    var showKillDialog by remember { mutableStateOf(false) }
    var showInterruptSheet by remember { mutableStateOf(false) }
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

    // Live ticking timer for elapsed duration while running
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val liveClock = foundryLiveClockEnabled()
    LaunchedEffect(isRunning, isConnected, liveClock) {
        if (liveClock && isRunning && isConnected) {
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
                while (isActive) {
                    delay(250L)
                    nowMs = System.currentTimeMillis()
                }
            }
        }
    }

    // Default selection: running phase, else last failed, else first
    val defaultPhaseId = remember(phases) {
        phases.find { it.status.equals("running", ignoreCase = true) }?.id
            ?: phases.find { it.status.equals("fail", ignoreCase = true) }?.id
            ?: phases.firstOrNull()?.id
    }
    var selectedPhaseId by remember(defaultPhaseId) { mutableStateOf(defaultPhaseId) }
    val selectedPhase = phases.find { it.id == selectedPhaseId } ?: phases.firstOrNull()

    val shortRunId = if (run.runId.length >= 7) run.runId.substring(0, 7) else run.runId
    val whenTime = RunFormatters.formatRelativeTime(run.effectiveStartedAt, nowMs)

    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = colors.bgBase,
        topBar = {
            Column {
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

                // Reconnect banner when disconnected
                ReconnectBanner(
                    status = connectionStatus,
                    onRetryClick = { onRetryConnection?.invoke() }
                )
            }
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
            // Action error banner
            if (!actionError.isNullOrBlank()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.statusFailed.copy(alpha = 0.18f), shapes.card)
                        .border(1.dp, colors.statusFailed.copy(alpha = 0.5f), shapes.card)
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        text = actionError,
                        style = typography.body,
                        color = colors.statusFailed,
                        modifier = Modifier.weight(1f)
                    )
                    if (onDismissActionError != null) {
                        Text(
                            text = "✕",
                            style = typography.labelMono,
                            color = colors.statusFailed,
                            modifier = Modifier
                                .clickable(onClick = onDismissActionError)
                                .padding(start = 8.dp)
                        )
                    }
                }
            }

            // Engineer interrupt banner (if active for this run)
            if (pendingInterrupt != null) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.statusRejected.copy(alpha = 0.18f), shapes.card)
                        .border(1.dp, colors.statusRejected.copy(alpha = 0.5f), shapes.card)
                        .padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(2.dp)
                    ) {
                        Text(
                            text = "ENGINEER INTERRUPT",
                            style = typography.eyebrowMono,
                            color = colors.statusRejected
                        )
                        Text(
                            text = "An engineer phase is waiting for your answer.",
                            style = typography.body,
                            color = colors.textPrimary
                        )
                    }

                    if (isConnected) {
                        Button(
                            onClick = { showInterruptSheet = true },
                            shape = shapes.button,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = colors.statusRejected.copy(alpha = 0.25f),
                                contentColor = colors.statusRejected
                            )
                        ) {
                            Text(text = "Answer…", style = typography.labelMono)
                        }
                    } else {
                        Text(
                            text = "Reconnect to answer",
                            style = typography.metaMono,
                            color = colors.textFaint,
                            modifier = Modifier.padding(start = 8.dp)
                        )
                    }
                }
            }

            // Header block: Status + Pipeline Name + When + Selectable Request + Meta
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgPanel, shapes.card)
                    .border(1.dp, colors.line, shapes.card)
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
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
                    Text(
                        text = whenTime,
                        style = typography.metaMono,
                        color = colors.textFaint
                    )
                }

                SelectionContainer {
                    Text(
                        text = run.request,
                        style = typography.requestText,
                        color = colors.textPrimary,
                        maxLines = if (isRequestExpanded) Int.MAX_VALUE else 4,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.clickable { isRequestExpanded = !isRequestExpanded }
                    )
                }

                // Meta row: duration · tokens · branch
                val durationMs = if (isRunning && isConnected) {
                    RunFormatters.computeDurationMs(run, nowMs)
                } else {
                    run.durationMs ?: RunFormatters.computeDurationMs(run, nowMs)
                }
                val durationText = RunFormatters.formatDuration(durationMs)
                val tokensText = RunFormatters.formatTokens(run.totalTokens) ?: "—"
                val branchName = run.branch ?: "—"

                Text(
                    text = "$durationText · $tokensText · $branchName",
                    style = typography.metaMono,
                    color = colors.textFaint
                )
            }

            // Outcome card for settled runs (directly below header block)
            if (!isRunning) {
                OutcomeCard(
                    run = run,
                    onOpenPr = onOpenPr,
                    onCreatePr = { onCreatePr(run.runId) },
                    onOpenIssue = onOpenIssue,
                    isCreatingPr = isCreatingPr
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

            // Selected phase summary (bottom card)
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

    // Engineer interrupt bottom sheet
    if (showInterruptSheet && pendingInterrupt != null) {
        InterruptBottomSheet(
            interrupt = pendingInterrupt,
            onApprove = { notes ->
                showInterruptSheet = false
                onAnswerInterrupt?.invoke(pendingInterrupt.interruptId, true, notes)
            },
            onReject = { notes ->
                showInterruptSheet = false
                onAnswerInterrupt?.invoke(pendingInterrupt.interruptId, false, notes)
            },
            onDismiss = { showInterruptSheet = false }
        )
    }
}
