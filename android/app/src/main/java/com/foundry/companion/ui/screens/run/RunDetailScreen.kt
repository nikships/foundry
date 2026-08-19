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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.GhStatus
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
    /**
     * Set only by a notification / deep-link tap naming a specific interrupt:
     * the sheet opens once on arrival. Nothing else raises it — the strip's
     * `Answer…` is the in-app entry point.
     */
    initialInterruptId: String? = null,
    actionError: String? = null,
    onDismissActionError: (() -> Unit)? = null,
    onAnswerInterrupt: ((interruptId: String, approved: Boolean, notes: String?) -> Unit)? = null,
    onRetryConnection: (() -> Unit)? = null,
    isCreatingPr: Boolean = false,
    ghStatus: GhStatus? = null,
    onCopyPrUrl: ((String) -> Unit)? = null,
    /** The desktop answered that it has no such run, so there is nothing to wait for. */
    isRunMissing: Boolean = false
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    var showKillDialog by remember { mutableStateOf(false) }
    var showInterruptSheet by remember { mutableStateOf(false) }
    var isRequestExpanded by remember { mutableStateOf(false) }

    // The deep link consumes once: re-opening the sheet after the operator
    // dismissed it would be the global modal again, only slower.
    var consumedInterruptId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(initialInterruptId, pendingInterrupt?.interruptId) {
        val target = initialInterruptId
        if (!target.isNullOrBlank() &&
            target != consumedInterruptId &&
            pendingInterrupt?.interruptId == target
        ) {
            consumedInterruptId = target
            showInterruptSheet = true
        }
    }

    if (runDetail == null) {
        Scaffold(
            modifier = modifier.fillMaxSize(),
            containerColor = colors.bgBase,
            topBar = { FoundryTopBar(title = "Run", onBackClick = onBackClick) }
        ) { innerPadding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .testTag(if (isRunMissing) "run-detail-missing" else "run-detail-loading"),
                contentAlignment = Alignment.Center
            ) {
                if (isRunMissing) {
                    Column(
                        modifier = Modifier.padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Text(
                            text = "This run is gone.",
                            style = typography.bodyStrong,
                            color = colors.textPrimary
                        )
                        Text(
                            text = "The desktop no longer has it — it was discarded or its trace was pruned.",
                            style = typography.body,
                            color = colors.textDim
                        )
                    }
                } else {
                    CircularProgressIndicator(color = colors.accent)
                }
            }
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
        phases.find { it.status.equals("running", ignoreCase = true) }?.resolvedId
            ?: phases.find { it.status.equals("fail", ignoreCase = true) }?.resolvedId
            ?: phases.firstOrNull()?.resolvedId
    }
    var selectedPhaseId by remember(defaultPhaseId) { mutableStateOf(defaultPhaseId) }
    val selectedPhase = phases.find { it.resolvedId == selectedPhaseId } ?: phases.firstOrNull()

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

                // Engineer interrupt strip, pinned above the header (spec §3.7)
                if (pendingInterrupt != null) {
                    InterruptStrip(
                        onAnswerClick = { showInterruptSheet = true },
                        isConnected = isConnected,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
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
                    ghStatus = ghStatus,
                    isCreatingPr = isCreatingPr,
                    isConnected = isConnected,
                    onCopyPrUrl = onCopyPrUrl
                )
            }

            // Phase waterfall
            if (phases.isNotEmpty()) {
                PhaseWaterfall(
                    phases = phases,
                    selectedPhaseId = selectedPhaseId,
                    onSelectPhase = { selectedPhaseId = it },
                    nowMs = nowMs
                )
            }

            // Selected phase summary (bottom card)
            if (selectedPhase != null) {
                SelectedPhaseSummaryCard(
                    phase = selectedPhase,
                    onViewTranscript = { onOpenInspector(it) },
                    nowMs = nowMs
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
            // Swiping the sheet away closes it and nothing more. On the desktop
            // Escape rejects; a phone swipe is too cheap a gesture to mean that,
            // so the strip persists and the run stays blocked.
            onDismiss = { showInterruptSheet = false }
        )
    }
}
