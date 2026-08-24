package com.foundry.companion.ui.screens.smith

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.SmithChatState
import com.foundry.companion.data.model.SmithModelInfo
import com.foundry.companion.data.model.SmithProposal
import com.foundry.companion.data.model.SmithTranscriptEntry
import com.foundry.companion.ui.components.FoundryDangerButton
import com.foundry.companion.ui.components.FoundryPrimaryButton
import com.foundry.companion.ui.components.FoundrySecondaryButton
import com.foundry.companion.ui.components.FoundryTopBar
import com.foundry.companion.ui.components.MarkdownText
import com.foundry.companion.ui.components.ReconnectBanner
import com.foundry.companion.ui.theme.FoundryTheme

@Composable
fun SmithScreen(
    chat: SmithChatState?,
    proposal: SmithProposal?,
    projectName: String,
    connectionStatus: ConnectionStatus,
    isSending: Boolean,
    onBackClick: () -> Unit,
    onRetryConnection: () -> Unit,
    onSend: (String) -> Unit,
    onCancel: () -> Unit,
    onNewChat: () -> Unit,
    onAnswerProposal: (approved: Boolean, secret: String?) -> Unit,
    modifier: Modifier = Modifier,
    actionError: String? = null,
    models: List<SmithModelInfo> = emptyList(),
    onSelectModel: (String) -> Unit = {},
    onSelectEffort: (String) -> Unit = {}
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    val isConnected = connectionStatus is ConnectionStatus.Connected
    val running = chat?.running == true || isSending
    val chosenModel = chat?.model.orEmpty().ifBlank { "inherit" }
    val selectedModel = models.firstOrNull { it.id == chosenModel }
        ?: models.firstOrNull { it.id == chat?.activeModel }
    val effortOptions = selectedModel?.supportedReasoningEfforts
        ?.ifEmpty { listOf("off", "minimal", "low", "medium", "high", "xhigh", "max") }
        ?: listOf("off", "minimal", "low", "medium", "high", "xhigh", "max")
    val modelBlocked = when {
        models.isEmpty() -> "Connect a provider on the Mac to choose a model."
        chosenModel.isBlank() || chosenModel == "inherit" -> "No model is selected. Choose one to start the conversation."
        selectedModel == null && models.none { it.id == chosenModel } ->
            "$chosenModel is not available to this install. Choose a model that is."
        else -> null
    }
    var draft by rememberSaveable { mutableStateOf("") }
    var secret by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()
    val transcript = chat?.transcript.orEmpty()

    LaunchedEffect(transcript.size) {
        if (transcript.isNotEmpty()) {
            listState.animateScrollToItem(transcript.lastIndex)
        }
    }

    Scaffold(
        modifier = modifier
            .fillMaxSize()
            .imePadding(),
        containerColor = colors.bgBase,
        topBar = {
            Column {
                FoundryTopBar(
                    title = "SMITH",
                    subtitle = projectName,
                    eyebrowStyle = true,
                    onBackClick = onBackClick,
                    actions = {
                        TextButton(
                            onClick = onNewChat,
                            enabled = isConnected && !running,
                            modifier = Modifier.semantics { contentDescription = "New chat" }
                        ) {
                            Text(
                                text = "NEW",
                                style = typography.labelMono,
                                color = if (isConnected && !running) colors.textPrimary else colors.textFaint
                            )
                        }
                    }
                )
                ReconnectBanner(
                    status = connectionStatus,
                    onRetryClick = onRetryConnection
                )
                SmithPickerRow(
                    models = models,
                    chosenModel = chosenModel,
                    selectedModel = selectedModel,
                    effort = chat?.reasoningEffort.orEmpty().ifBlank { "medium" },
                    effortOptions = effortOptions,
                    enabled = isConnected && !running,
                    onSelectModel = onSelectModel,
                    onSelectEffort = onSelectEffort
                )
                if (modelBlocked != null) {
                    Text(
                        text = modelBlocked,
                        style = typography.metaMono,
                        color = colors.statusWarning,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                    )
                }
            }
        },
        bottomBar = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgBase)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                if (proposal != null) {
                    SmithProposalCard(
                        proposal = proposal,
                        secret = secret,
                        onSecretChange = { secret = it },
                        onApprove = {
                            onAnswerProposal(true, secret.takeIf { proposal.needsSecret })
                            secret = ""
                        },
                        onReject = {
                            onAnswerProposal(false, null)
                            secret = ""
                        },
                        enabled = isConnected
                    )
                }
                if (!actionError.isNullOrBlank()) {
                    Text(
                        text = actionError,
                        style = typography.metaMono,
                        color = colors.statusFailed
                    )
                }
                chat?.error?.takeIf { it.isNotBlank() }?.let { error ->
                    Text(
                        text = error,
                        style = typography.metaMono,
                        color = colors.statusFailed
                    )
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.Bottom
                ) {
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        modifier = Modifier
                            .weight(1f)
                            .semantics { contentDescription = "Message Smith" },
                        placeholder = {
                            Text(
                                text = if (projectName.isBlank()) {
                                    "Ask Smith to manage Foundry…"
                                } else {
                                    "Ask Smith about $projectName…"
                                },
                                style = typography.body,
                                color = colors.textFaint
                            )
                        },
                        enabled = isConnected && !running && modelBlocked == null,
                        minLines = 1,
                        maxLines = 5,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(
                            onSend = {
                                if (draft.isNotBlank() && isConnected && !running && modelBlocked == null) {
                                    onSend(draft)
                                    draft = ""
                                }
                            }
                        ),
                        shape = shapes.card,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedContainerColor = colors.bgInput,
                            unfocusedContainerColor = colors.bgInput,
                            disabledContainerColor = colors.bgInput,
                            focusedBorderColor = colors.lineStrong,
                            unfocusedBorderColor = colors.line,
                            focusedTextColor = colors.textPrimary,
                            unfocusedTextColor = colors.textPrimary,
                            disabledTextColor = colors.textDim
                        )
                    )
                    if (running) {
                        FoundrySecondaryButton(
                            text = "Stop",
                            onClick = onCancel,
                            enabled = isConnected
                        )
                    } else {
                        IconButton(
                            onClick = {
                                if (draft.isNotBlank() && isConnected && modelBlocked == null) {
                                    onSend(draft)
                                    draft = ""
                                }
                            },
                            enabled = isConnected && draft.isNotBlank() && modelBlocked == null,
                            modifier = Modifier.semantics { contentDescription = "Send" }
                        ) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.Send,
                                contentDescription = null,
                                tint = if (isConnected && draft.isNotBlank()) colors.accent else colors.textFaint
                            )
                        }
                    }
                }
            }
        }
    ) { innerPadding ->
        if (transcript.isEmpty() && proposal == null) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .padding(24.dp),
                contentAlignment = Alignment.Center
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text(
                        text = "Smith",
                        style = typography.screenTitle,
                        color = colors.textPrimary
                    )
                    Text(
                        text = if (projectName.isBlank()) {
                            "Ask Smith to inspect or manage Foundry across all projects."
                        } else {
                            "Ask Smith to inspect or operate $projectName — entities, readiness, runs, and pull requests."
                        },
                        style = typography.body,
                        color = colors.textDim
                    )
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding),
                state = listState,
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                items(
                    items = transcript,
                    key = { it.id.ifBlank { "${it.source}_${it.at}_${it.text.hashCode()}" } }
                ) { entry ->
                    SmithTranscriptRow(entry = entry)
                }
                if (running) {
                    item(key = "smith_running") {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            CircularProgressIndicator(
                                modifier = Modifier.heightIn(max = 16.dp),
                                color = colors.accent,
                                strokeWidth = 2.dp
                            )
                            Text(
                                text = "SMITH IS WORKING",
                                style = typography.eyebrowMono,
                                color = colors.accent
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SmithPickerRow(
    models: List<SmithModelInfo>,
    chosenModel: String,
    selectedModel: SmithModelInfo?,
    effort: String,
    effortOptions: List<String>,
    enabled: Boolean,
    onSelectModel: (String) -> Unit,
    onSelectEffort: (String) -> Unit
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        SmithChoiceMenu(
            label = selectedModel?.label ?: if (chosenModel == "inherit" || chosenModel.isBlank()) "Select a model…" else chosenModel,
            contentDescription = "Smith model",
            enabled = enabled && models.isNotEmpty(),
            modifier = Modifier.weight(1f)
        ) { dismiss ->
            models.forEach { model ->
                DropdownMenuItem(
                    text = {
                        Text(
                            text = model.label,
                            style = typography.body,
                            color = if (model.id == chosenModel) colors.accent else colors.textPrimary
                        )
                    },
                    onClick = {
                        onSelectModel(model.id)
                        dismiss()
                    }
                )
            }
        }
        SmithChoiceMenu(
            label = effort.uppercase(),
            contentDescription = "Smith reasoning",
            enabled = enabled && effortOptions.isNotEmpty(),
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
private fun SmithChoiceMenu(
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
private fun SmithTranscriptRow(entry: SmithTranscriptEntry) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    val isOperator = entry.isOperator
    val label = when {
        entry.isArtifact -> entry.artifactKind.replace('_', ' ').uppercase().ifBlank { "CARD" }
        entry.kind == "tool" -> (entry.toolKind ?: "tool").uppercase()
        entry.kind == "error" -> "ERROR"
        isOperator -> "YOU"
        entry.source == "readiness" -> "READY"
        else -> "SMITH"
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (isOperator) colors.bgRaised else colors.bgPanel, shapes.card)
            .border(1.dp, colors.line, shapes.card)
            .padding(12.dp)
            .semantics { contentDescription = if (isOperator) "You said" else "Smith said" },
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Text(
            text = label,
            style = typography.eyebrowMono,
            color = if (entry.kind == "error" || entry.failed == true) colors.statusFailed else colors.textDim
        )
        if (entry.isArtifact) {
            val artifact = entry.artifact
            if (artifact != null) {
                SmithArtifactCard(artifact = artifact)
            } else {
                Text(
                    text = entry.artifactTitle.ifBlank { "Card" },
                    style = typography.bodyStrong,
                    color = colors.textPrimary
                )
            }
        } else if (entry.text.isNotBlank()) {
            if (entry.kind == "text" && !isOperator) {
                MarkdownText(text = entry.text)
            } else {
                Text(
                    text = entry.text,
                    style = if (entry.kind == "tool") typography.transcriptMono else typography.body,
                    color = if (entry.kind == "error") colors.statusFailed else colors.textPrimary
                )
            }
        }
    }
}

@Composable
private fun SmithProposalCard(
    proposal: SmithProposal,
    secret: String,
    onSecretChange: (String) -> Unit,
    onApprove: () -> Unit,
    onReject: () -> Unit,
    enabled: Boolean
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
            .semantics { contentDescription = "Smith proposal" },
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Text(
            text = if (proposal.type == "entity") "ENTITY" else "ACTION",
            style = typography.eyebrowMono,
            color = colors.accent
        )
        Text(
            text = proposal.headline.ifBlank { "Pending approval" },
            style = typography.bodyStrong,
            color = colors.textPrimary
        )
        if (proposal.body.isNotBlank()) {
            Text(
                text = proposal.body,
                style = typography.body,
                color = colors.textDim
            )
        }
        if (!proposal.risk.isNullOrBlank()) {
            Text(
                text = "RISK · ${proposal.risk.uppercase()}",
                style = typography.metaMono,
                color = colors.statusWarning
            )
        }
        if (proposal.needsSecret) {
            OutlinedTextField(
                value = secret,
                onValueChange = onSecretChange,
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = proposal.secretRequest?.label ?: "Secret" },
                label = {
                    Text(
                        text = proposal.secretRequest?.label ?: "API key",
                        style = typography.metaMono
                    )
                },
                placeholder = {
                    Text(
                        text = proposal.secretRequest?.placeholder ?: "",
                        style = typography.body,
                        color = colors.textFaint
                    )
                },
                enabled = enabled,
                singleLine = true,
                shape = shapes.card,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = colors.bgInput,
                    unfocusedContainerColor = colors.bgInput,
                    focusedBorderColor = colors.lineStrong,
                    unfocusedBorderColor = colors.line,
                    focusedTextColor = colors.textPrimary,
                    unfocusedTextColor = colors.textPrimary
                )
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            FoundryPrimaryButton(
                text = "Approve",
                onClick = onApprove,
                enabled = enabled && (!proposal.needsSecret || secret.isNotBlank()),
                contentDescription = "Approve proposal",
                modifier = Modifier.weight(1f)
            )
            FoundryDangerButton(
                text = "Reject",
                onClick = onReject,
                enabled = enabled,
                modifier = Modifier.weight(1f)
            )
        }
    }
}
