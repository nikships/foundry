package com.foundry.companion.ui.screens.inspector.components

import androidx.compose.animation.AnimatedVisibility
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
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.TranscriptEvent
import com.foundry.companion.ui.theme.FoundryTheme

@Composable
fun TranscriptLane(
    events: List<TranscriptEvent>,
    isRunning: Boolean,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    val listState = rememberLazyListState()
    val expandedTools = remember { mutableStateMapOf<String, Boolean>() }

    Column(modifier = modifier.fillMaxSize()) {
        // Actions row
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "EVENTS (${events.size})",
                style = typography.eyebrowMono,
                color = colors.textDim
            )

            TextButton(
                onClick = { expandedTools.clear() },
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp)
            ) {
                Text(
                    text = "COLLAPSE ALL",
                    style = typography.labelMono,
                    color = colors.textFaint
                )
            }
        }

        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(bottom = 32.dp)
        ) {
            items(
                items = events,
                key = { it.id }
            ) { event ->
                when (event.type) {
                    "tool_call" -> {
                        val isExpanded = expandedTools[event.id] == true
                        val isSuccess = event.isSuccess ?: true
                        val duration = event.durationMs?.let { "${it}ms" } ?: "—"

                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(colors.bgRaised, shapes.card)
                                .border(1.dp, colors.line, shapes.card)
                                .padding(10.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { expandedTools[event.id] = !isExpanded },
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = "⚙",
                                        style = typography.transcriptMono,
                                        color = colors.accent
                                    )
                                    Text(
                                        text = "${event.toolName ?: "tool"} · $duration",
                                        style = typography.metaMono,
                                        color = colors.textPrimary
                                    )
                                }

                                Text(
                                    text = if (isSuccess) "✓" else "✕",
                                    style = typography.metaMono,
                                    color = if (isSuccess) colors.statusAccepted else colors.statusFailed
                                )
                            }

                            AnimatedVisibility(visible = isExpanded) {
                                Column(
                                    verticalArrangement = Arrangement.spacedBy(4.dp),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .background(colors.bgInput, shapes.card)
                                        .padding(8.dp)
                                ) {
                                    if (!event.toolArgs.isNullOrBlank()) {
                                        Text(
                                            text = "ARGS: ${event.toolArgs}",
                                            style = typography.transcriptMono,
                                            color = colors.textDim
                                        )
                                    }
                                    if (!event.toolOutput.isNullOrBlank()) {
                                        Text(
                                            text = "OUTPUT: ${event.toolOutput}",
                                            style = typography.transcriptMono,
                                            color = colors.textPrimary
                                        )
                                    }
                                }
                            }
                        }
                    }
                    "gate" -> {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(colors.bgPanel, shapes.card)
                                .padding(8.dp),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "⛨",
                                style = typography.transcriptMono,
                                color = colors.statusAccepted
                            )
                            Text(
                                text = event.content,
                                style = typography.transcriptMono,
                                color = colors.statusAccepted
                            )
                        }
                    }
                    "error" -> {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(colors.statusFailed.copy(alpha = 0.14f), shapes.card)
                                .padding(8.dp),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "✕",
                                style = typography.transcriptMono,
                                color = colors.statusFailed
                            )
                            Text(
                                text = event.content,
                                style = typography.transcriptMono,
                                color = colors.statusFailed
                            )
                        }
                    }
                    else -> {
                        // Prose text block
                        Text(
                            text = event.content,
                            style = typography.transcriptMono,
                            color = colors.textPrimary,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp)
                        )
                    }
                }
            }

            if (isRunning) {
                item(key = "live_caret") {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(vertical = 4.dp)
                    ) {
                        Text(
                            text = "▍",
                            style = typography.transcriptMono,
                            color = colors.accent
                        )
                        Text(
                            text = "Live tailing…",
                            style = typography.metaMono,
                            color = colors.accent
                        )
                    }
                }
            }
        }
    }
}
