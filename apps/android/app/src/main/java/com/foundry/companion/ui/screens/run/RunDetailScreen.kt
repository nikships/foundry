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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.EventRow
import com.foundry.companion.data.model.GhStatus
import com.foundry.companion.data.model.RestorableCheckpoint
import com.foundry.companion.data.model.RestorableCheckpointList
import com.foundry.companion.data.model.RunDetail
import com.foundry.companion.ui.components.*
import com.foundry.companion.ui.screens.run.components.CreatePrConfirmSheet
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
    onContinueRun: (runId: String) -> Unit = {},
    onOpenPr: (prUrl: String) -> Unit,
    onCreatePr: (runId: String) -> Unit,
    onOpenIssue: (issueUrl: String) -> Unit,
    modifier: Modifier = Modifier,
    actionError: String? = null,
    onDismissActionError: (() -> Unit)? = null,
    onRetryConnection: (() -> Unit)? = null,
    isCreatingPr: Boolean = false,
    isContinuingRun: Boolean = false,
    ghStatus: GhStatus? = null,
    prDraftTitle: String? = null,
    onCopyPrUrl: ((String) -> Unit)? = null,
    /** The desktop answered that it has no such run, so there is nothing to wait for. */
    isRunMissing: Boolean = false,
    /** Already-fetched transcript events; the waterfall ticks from these. */
    events: List<EventRow> = emptyList(),
    // Checkpoint restore (settled restorable runs only)
    restorableCheckpoints: RestorableCheckpointList? = null,
    isLoadingCheckpoints: Boolean = false,
    isRestoringCheckpoint: Boolean = false,
    restoreMessage: String? = null,
    onDismissRestoreMessage: (() -> Unit)? = null,
    onRestoreCheckpoint: (runId: String, checkpointId: String, acceptPartial: Boolean) -> Unit = { _, _, _ -> }
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    var showKillDialog by remember { mutableStateOf(false) }
    var showCreatePrSheet by rememberSaveable { mutableStateOf(false) }
    var isRequestExpanded by remember { mutableStateOf(false) }
    var restoreTarget by remember { mutableStateOf<RestorableCheckpoint?>(null) }
    var acceptPartialRestore by remember { mutableStateOf(false) }

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

    val whenTime = RunFormatters.formatRelativeTime(run.effectiveStartedAt, nowMs)

    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = colors.bgBase,
        topBar = {
            Column {
                FoundryTopBar(
                    title = "Run · ${run.pipelineName}",
                    subtitle = run.runId,
                    onBackClick = onBackClick,
                    actions = {
                        if (isRunning) {
                            TextButton(
                                onClick = { showKillDialog = true },
                                enabled = isConnected,
                                modifier = Modifier
                                    .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                                    .semantics { contentDescription = "Kill this run" }
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

                // Source and orchestration metadata the desktop records on newer runs.
                val source = run.source
                if (run.orchestrated || run.amendments > 0 || source != null) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        if (run.orchestrated) {
                            Text(
                                text = "ORCHESTRATED",
                                style = typography.metaMono,
                                color = colors.accent,
                                modifier = Modifier
                                    .background(colors.accent.copy(alpha = 0.12f), shapes.chip)
                                    .padding(horizontal = 6.dp, vertical = 2.dp)
                            )
                        }
                        if (run.amendments > 0) {
                            Text(
                                text = "AMENDED ×${run.amendments}",
                                style = typography.metaMono,
                                color = colors.statusWarning,
                                modifier = Modifier
                                    .background(colors.statusWarning.copy(alpha = 0.12f), shapes.chip)
                                    .padding(horizontal = 6.dp, vertical = 2.dp)
                            )
                        }
                        source?.snapshot?.let { snapshot ->
                            Text(
                                text = "LINEAR · ${snapshot.identifier}",
                                style = typography.metaMono,
                                color = if (source.url.isNotBlank()) colors.textPrimary else colors.textDim,
                                modifier = Modifier
                                    .background(colors.bgRaised, shapes.chip)
                                    .border(1.dp, colors.line, shapes.chip)
                                    .then(
                                        if (source.url.isNotBlank()) {
                                            Modifier.clickable { onOpenIssue(source.url) }
                                        } else {
                                            Modifier
                                        }
                                    )
                                    .padding(horizontal = 6.dp, vertical = 2.dp)
                                    .semantics {
                                        contentDescription = "Open Linear issue ${snapshot.identifier}"
                                    }
                            )
                        }
                    }
                    if (!run.sourceSyncError.isNullOrBlank()) {
                        Text(
                            text = "LINEAR SYNC · ${run.sourceSyncError}",
                            style = typography.metaMono,
                            color = colors.statusFailed,
                            modifier = Modifier.padding(top = 2.dp)
                        )
                    }
                }
            }

            // Outcome card for settled runs (directly below header block)
            if (!isRunning) {
                OutcomeCard(
                    run = run,
                    onContinue = { onContinueRun(run.runId) },
                    onOpenPr = onOpenPr,
                    onCreatePr = { showCreatePrSheet = true },
                    onOpenIssue = onOpenIssue,
                    ghStatus = ghStatus,
                    isCreatingPr = isCreatingPr,
                    isContinuing = isContinuingRun,
                    isConnected = isConnected,
                    onCopyPrUrl = onCopyPrUrl
                )

                // Durable phase checkpoints: rewind a terminal run, nothing here
                // starts it again — Continue stays a separate deliberate act.
                RestoreCheckpointSection(
                    runId = run.runId,
                    checkpoints = restorableCheckpoints,
                    isLoading = isLoadingCheckpoints,
                    isRestoring = isRestoringCheckpoint,
                    message = restoreMessage,
                    onDismissMessage = onDismissRestoreMessage,
                    onRestore = { checkpoint ->
                        restoreTarget = checkpoint
                        acceptPartialRestore = false
                    }
                )
            }

            // Phase waterfall
            if (phases.isNotEmpty()) {
                PhaseWaterfall(
                    phases = phases,
                    selectedPhaseId = selectedPhaseId,
                    onSelectPhase = { selectedPhaseId = it },
                    events = events,
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
                Column {
                    ApplyFoundryDialogScrim()
                    Text(
                        text = "KILL RUN",
                        style = typography.eyebrowMono,
                        color = colors.statusFailed
                    )
                }
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
                    Text(text = "CANCEL", style = typography.labelMono, color = colors.textPrimary)
                }
            }
        )
    }

    if (showCreatePrSheet) {
        CreatePrConfirmSheet(
            title = prDraftTitle.orEmpty(),
            confirmEnabled = !prDraftTitle.isNullOrBlank() && isConnected && !isCreatingPr,
            onConfirm = {
                showCreatePrSheet = false
                onCreatePr(run.runId)
            },
            onDismiss = { showCreatePrSheet = false }
        )
    }

    val target = restoreTarget
    if (target != null) {
        AlertDialog(
            onDismissRequest = { restoreTarget = null },
            containerColor = colors.bgRaised,
            shape = shapes.card,
            title = {
                Column {
                    ApplyFoundryDialogScrim()
                    Text(
                        text = "RESTORE CHECKPOINT · ${target.phaseName.uppercase()}",
                        style = typography.eyebrowMono,
                        color = colors.accent
                    )
                }
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        text = "Rewind this run's worktree to the ${target.phaseName} phase start (generation ${target.generation}, " +
                            RunFormatters.formatRelativeTime(target.createdAt) + ")?",
                        style = typography.body,
                        color = colors.textPrimary
                    )
                    if (target.commitsSince > 0) {
                        val dropped = target.commitsSinceShas.take(5)
                        Text(
                            text = buildString {
                                append("This moves ${target.commitsSince} commit")
                                if (target.commitsSince != 1) append("s")
                                append(" off the branch")
                                if (dropped.isNotEmpty()) {
                                    append(" (")
                                    append(dropped.joinToString(", "))
                                    if (target.commitsSinceShas.size > dropped.size) append(", …")
                                    append(")")
                                }
                                append(". They stay reachable through the branch reflog.")
                            },
                            style = typography.metaMono,
                            color = colors.statusWarning
                        )
                    }
                    if (!target.exactRestorePossible) {
                        Text(
                            text = "An exact restore is impossible: ${target.omittedPaths.size} path(s) cannot be put back. Accept a partial restore to continue.",
                            style = typography.body,
                            color = colors.statusWarning
                        )
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Checkbox(
                                checked = acceptPartialRestore,
                                onCheckedChange = { acceptPartialRestore = it },
                                colors = CheckboxDefaults.colors(
                                    checkedColor = colors.accent,
                                    uncheckedColor = colors.textFaint
                                )
                            )
                            Text(
                                text = "Accept partial restore",
                                style = typography.body,
                                color = colors.textPrimary
                            )
                        }
                    }
                    Text(
                        text = "The run stays stopped after restoring. Continue is a separate step.",
                        style = typography.metaMono,
                        color = colors.textFaint
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        restoreTarget = null
                        onRestoreCheckpoint(run.runId, target.checkpointId, acceptPartialRestore)
                    },
                    enabled = isConnected && !isRestoringCheckpoint && (target.exactRestorePossible || acceptPartialRestore),
                    shape = shapes.button,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.accent,
                        contentColor = androidx.compose.ui.graphics.Color.Black
                    )
                ) {
                    Text(text = if (isRestoringCheckpoint) "RESTORING…" else "RESTORE", style = typography.labelMono)
                }
            },
            dismissButton = {
                TextButton(onClick = { restoreTarget = null }) {
                    Text(text = "CANCEL", style = typography.labelMono, color = colors.textPrimary)
                }
            }
        )
    }
}

@Composable
private fun RestoreCheckpointSection(
    runId: String,
    checkpoints: RestorableCheckpointList?,
    isLoading: Boolean,
    isRestoring: Boolean,
    message: String?,
    onDismissMessage: (() -> Unit)?,
    onRestore: (RestorableCheckpoint) -> Unit
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    if (isLoading) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(vertical = 4.dp)
        ) {
            CircularProgressIndicator(
                modifier = Modifier.size(14.dp),
                color = colors.accent,
                strokeWidth = 2.dp
            )
            Text(
                text = "Loading phase checkpoints…",
                style = typography.body,
                color = colors.textDim
            )
        }
        return
    }

    val list = checkpoints ?: return
    val rows = list.checkpoints

    if (list.refusal != null && rows.isEmpty()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.bgPanel, shapes.card)
                .border(1.dp, colors.line, shapes.card)
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            Text(
                text = "RESTORE PHASE CHECKPOINT",
                style = typography.eyebrowMono,
                color = colors.textDim
            )
            Text(
                text = list.detail.ifBlank { "This run cannot be restored." },
                style = typography.body,
                color = colors.textDim
            )
        }
        return
    }

    if (rows.isEmpty()) return

    if (!message.isNullOrBlank()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.statusAccepted.copy(alpha = 0.14f), shapes.card)
                .border(1.dp, colors.statusAccepted.copy(alpha = 0.4f), shapes.card)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = message,
                style = typography.body,
                color = colors.statusAccepted,
                modifier = Modifier.weight(1f)
            )
            if (onDismissMessage != null) {
                Text(
                    text = "✕",
                    style = typography.labelMono,
                    color = colors.statusAccepted,
                    modifier = Modifier
                        .clickable(onClick = onDismissMessage)
                        .padding(start = 8.dp)
                )
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.bgPanel, shapes.card)
            .border(1.dp, colors.line, shapes.card)
            .padding(12.dp)
            .semantics { contentDescription = "Restore checkpoint" },
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(
            text = "RESTORE PHASE CHECKPOINT",
            style = typography.eyebrowMono,
            color = colors.accent
        )
        Text(
            text = "Rewind the worktree to a recorded phase start. The run stays stopped until you continue it.",
            style = typography.body,
            color = colors.textDim
        )
        rows.forEach { checkpoint ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = buildString {
                            append(checkpoint.phaseName)
                            if (checkpoint.generation > 1) append(" ×${checkpoint.generation}")
                        },
                        style = typography.bodyStrong,
                        color = colors.textPrimary
                    )
                    Text(
                        text = buildString {
                            append(RunFormatters.formatRelativeTime(checkpoint.createdAt))
                            append(" · ${checkpoint.fileCount} files")
                            if (checkpoint.commitsSince > 0) {
                                append(" · moves ${checkpoint.commitsSince} commit")
                                if (checkpoint.commitsSince != 1) append("s")
                                append(" off the branch")
                            }
                        },
                        style = typography.metaMono,
                        color = colors.textFaint
                    )
                    if (!checkpoint.exactRestorePossible && checkpoint.restorable) {
                        Text(
                            text = "Exact restore impossible — ${checkpoint.omittedPaths.size} path(s) cannot be put back",
                            style = typography.metaMono,
                            color = colors.statusWarning
                        )
                    }
                }
                if (checkpoint.restorable) {
                    Text(
                        text = if (isRestoring) "RESTORING…" else "RESTORE",
                        style = typography.labelMono,
                        color = colors.accent,
                        modifier = Modifier
                            .clickable(enabled = !isRestoring) { onRestore(checkpoint) }
                            .padding(horizontal = 8.dp, vertical = 6.dp)
                            .semantics { contentDescription = "Restore ${checkpoint.phaseName}" }
                    )
                } else {
                    Text(
                        text = "NOT RESTORABLE",
                        style = typography.metaMono,
                        color = colors.textFaint,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp)
                    )
                }
            }
            if (checkpoint !== rows.last()) {
                HorizontalDivider(color = colors.line)
            }
        }
    }
}
