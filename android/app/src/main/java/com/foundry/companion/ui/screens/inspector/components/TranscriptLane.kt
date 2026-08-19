package com.foundry.companion.ui.screens.inspector.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.EventRow
import com.foundry.companion.data.model.TranscriptEvents
import com.foundry.companion.ui.theme.FoundryTheme

@Composable
fun TranscriptLane(
    events: List<EventRow>,
    isRunning: Boolean,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    val listState = rememberLazyListState()
    val expandedTools = remember { mutableStateMapOf<String, Boolean>() }
    var collapseGeneration by remember { mutableIntStateOf(0) }
    var followTail by remember { mutableStateOf(true) }

    val visible = remember(events) { events.filter { TranscriptEvents.isRenderable(it.type) } }

    LaunchedEffect(visible.size, isRunning, followTail) {
        if (isRunning && followTail && visible.isNotEmpty()) {
            listState.scrollToItem(visible.lastIndex)
        }
    }

    val atBottom = !listState.canScrollForward
    LaunchedEffect(atBottom) {
        if (atBottom) followTail = true
    }

    Column(modifier = modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "EVENTS (${visible.size})",
                style = typography.eyebrowMono,
                color = colors.textDim
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (isRunning && !followTail) {
                    TextButton(
                        onClick = { followTail = true },
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                        modifier = Modifier.testTag("inspector-jump-live")
                    ) {
                        Text(
                            text = "↓ LIVE",
                            style = typography.labelMono,
                            color = colors.accent
                        )
                    }
                }
                TextButton(
                    onClick = {
                        expandedTools.clear()
                        collapseGeneration += 1
                    },
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                    modifier = Modifier.testTag("inspector-collapse-all")
                ) {
                    Text(
                        text = "COLLAPSE ALL",
                        style = typography.labelMono,
                        color = colors.textFaint
                    )
                }
            }
        }

        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp)
                .testTag("inspector-transcript"),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(bottom = 32.dp)
        ) {
            items(
                items = visible,
                key = { it.eventId.ifBlank { "row_${it.rowid}" } }
            ) { event ->
                key(collapseGeneration) {
                    TranscriptEntry(
                        event = event,
                        expandedTools = expandedTools,
                        onUserScrollAway = { followTail = false }
                    )
                }
            }

            if (isRunning) {
                item(key = "live_caret") {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .padding(vertical = 4.dp)
                            .testTag("inspector-live-caret")
                    ) {
                        Text(text = "▍", style = typography.transcriptMono, color = colors.accent)
                        Text(text = "Live tailing…", style = typography.metaMono, color = colors.accent)
                    }
                }
            }
        }
    }
}

@Composable
private fun TranscriptEntry(
    event: EventRow,
    expandedTools: MutableMap<String, Boolean>,
    onUserScrollAway: () -> Unit
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    val eventId = event.eventId.ifBlank { "row_${event.rowid}" }

    when (event.type) {
        "tool_call" -> {
            val isExpanded = expandedTools[eventId] == true
            val isSuccess = !event.isError
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgRaised, shapes.card)
                    .border(1.dp, colors.line, shapes.card)
                    .padding(10.dp)
                    .testTag("inspector-tool-$eventId"),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable {
                            onUserScrollAway()
                            expandedTools[eventId] = !isExpanded
                        }
                        .testTag("inspector-tool-toggle-$eventId"),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.weight(1f)
                    ) {
                        Text(text = "⚙", style = typography.transcriptMono, color = colors.accent)
                        Text(
                            text = "${event.toolName.ifBlank { "tool" }} · ${event.durationLabel}",
                            style = typography.metaMono,
                            color = colors.textPrimary
                        )
                    }
                    Text(
                        text = if (event.isOpen) "…" else if (isSuccess) "✓" else "✕",
                        style = typography.metaMono,
                        color = when {
                            event.isOpen -> colors.accent
                            isSuccess -> colors.statusAccepted
                            else -> colors.statusFailed
                        }
                    )
                }
                Text(
                    text = event.toolSummary,
                    style = typography.transcriptMono,
                    color = colors.textDim,
                    maxLines = if (isExpanded) Int.MAX_VALUE else 1
                )
                if (isExpanded) {
                    Column(
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(colors.bgInput, shapes.card)
                            .padding(8.dp)
                            .testTag("inspector-tool-body-$eventId")
                    ) {
                        if (event.argsText.isNotBlank()) {
                            Text(
                                text = "ARGS: ${event.argsText}",
                                style = typography.transcriptMono,
                                color = colors.textDim
                            )
                        }
                        if (event.resultText.isNotBlank()) {
                            Text(
                                text = "OUTPUT: ${event.resultText}",
                                style = typography.transcriptMono,
                                color = colors.textPrimary
                            )
                        }
                    }
                }
            }
        }
        "assistant_text" -> {
            val envelope = event.parsedEnvelope
            if (envelope != null) {
                BannerRow(
                    glyph = "→",
                    label = "ENVELOPE",
                    detail = envelope.summary ?: envelope.status.orEmpty(),
                    color = if (envelope.status.equals("fail", ignoreCase = true)) {
                        colors.statusFailed
                    } else {
                        colors.statusAccepted
                    },
                    testTag = "inspector-envelope-$eventId"
                )
            } else {
                Text(
                    text = event.textContent.ifBlank { event.name },
                    style = typography.transcriptMono,
                    color = colors.textPrimary,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp)
                        .testTag("inspector-text-$eventId")
                )
            }
        }
        "thinking" -> {
            Text(
                text = event.textContent.ifBlank { "thought" },
                style = typography.transcriptMono,
                color = colors.textFaint,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp)
                    .testTag("inspector-thinking-$eventId")
            )
        }
        "gate_pass" -> BannerRow("⛨", "GATE", event.textContent.ifBlank { event.name }, colors.statusAccepted, "inspector-gate-$eventId")
        "gate_fail" -> BannerRow("⛨", "GATE", event.textContent.ifBlank { event.name }, colors.statusFailed, "inspector-gate-$eventId")
        "correction" -> BannerRow("↻", "CORRECTION", event.textContent.ifBlank { event.name }, colors.statusRejected, "inspector-correction-$eventId")
        "interrupt" -> BannerRow("☝", "INTERRUPT", event.textContent.ifBlank { event.name }, colors.statusRejected, "inspector-interrupt-$eventId")
        "error" -> BannerRow("✕", "ERROR", event.textContent.ifBlank { event.name }, colors.statusFailed, "inspector-error-$eventId")
        "handoff" -> BannerRow("→", "HANDOFF", event.textContent.ifBlank { event.name }, colors.accent, "inspector-handoff-$eventId")
        "compaction" -> BannerRow("↻", "COMPACTION", event.textContent.ifBlank { event.name }, colors.textDim, "inspector-compaction-$eventId")
        "log" -> BannerRow("·", event.name.ifBlank { "LOG" }, event.textContent, colors.textFaint, "inspector-log-$eventId")
        "agent_end" -> BannerRow("·", "TURN", event.textContent.ifBlank { "${event.tokens} tokens" }, colors.textFaint, "inspector-usage-$eventId")
        else -> Unit
    }
}

@Composable
private fun BannerRow(
    glyph: String,
    label: String,
    detail: String,
    color: Color,
    testTag: String
) {
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(color.copy(alpha = 0.14f), shapes.card)
            .padding(8.dp)
            .testTag(testTag),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text = glyph, style = typography.transcriptMono, color = color)
        Text(text = label, style = typography.labelMono, color = color)
        if (detail.isNotBlank()) {
            Text(text = detail, style = typography.transcriptMono, color = color)
        }
    }
}
