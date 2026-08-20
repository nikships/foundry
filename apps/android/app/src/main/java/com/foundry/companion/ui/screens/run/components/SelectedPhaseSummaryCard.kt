package com.foundry.companion.ui.screens.run.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.PhaseRunSummary
import com.foundry.companion.ui.components.FoundrySecondaryButton
import com.foundry.companion.ui.components.StatusBadge
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.util.RunFormatters

@Composable
fun SelectedPhaseSummaryCard(
    phase: PhaseRunSummary,
    onViewTranscript: (phaseId: String) -> Unit,
    modifier: Modifier = Modifier,
    nowMs: Long = System.currentTimeMillis()
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.bgRaised, shapes.card)
            .border(1.dp, colors.lineStrong, shapes.card)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = "PHASE · ${phase.name.uppercase()}",
                    style = typography.eyebrowMono,
                    color = colors.textDim
                )
                if (phase.model != null) {
                    Text(
                        text = RunFormatters.modelLabel(phase.model),
                        style = typography.metaMono,
                        color = colors.textFaint
                    )
                }
            }
            StatusBadge(status = phase.status)
        }

        // Duration and Tokens Meta
        val durationText = RunFormatters.computePhaseDurationMs(phase, nowMs)
            ?.let { "${it / 1000}s" } ?: "—"
        val tokensText = RunFormatters.formatTokens(phase.tokens) ?: "—"
        Text(
            text = "Duration: $durationText · Tokens: $tokensText",
            style = typography.metaMono,
            color = colors.textDim
        )

        if (phase.changedFiles.isNotEmpty()) {
            val shown = phase.changedFiles.take(CHANGED_FILES_VISIBLE)
            val extra = phase.changedFiles.size - shown.size
            Column(
                verticalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("phase-changed-files")
            ) {
                Text(
                    text = "CHANGED FILES",
                    style = typography.eyebrowMono,
                    color = colors.textDim
                )
                shown.forEach { path ->
                    Text(
                        text = path,
                        style = typography.metaMono,
                        color = colors.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.testTag("phase-changed-file")
                    )
                }
                if (extra > 0) {
                    Text(
                        text = "+$extra more",
                        style = typography.metaMono,
                        color = colors.textFaint
                    )
                }
            }
        }

        // Envelope verdict if present
        if (!phase.envelopeVerdict.isNullOrBlank()) {
            Column(
                verticalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgPanel, shapes.card)
                    .border(1.dp, colors.line, shapes.card)
                    .padding(10.dp)
            ) {
                Text(
                    text = "ENVELOPE VERDICT",
                    style = typography.eyebrowMono,
                    color = colors.statusAccepted
                )
                Text(
                    text = phase.envelopeVerdict,
                    style = typography.body,
                    color = colors.textPrimary
                )
            }
        }

        // Gate results
        if (phase.gateResults.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = "GATES",
                    style = typography.eyebrowMono,
                    color = colors.textDim
                )
                phase.gateResults.forEach { gate ->
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = if (gate.passed) "⛨ ✓" else "⛨ ✕",
                            style = typography.metaMono,
                            color = if (gate.passed) colors.statusAccepted else colors.statusFailed
                        )
                        Text(
                            text = gate.name,
                            style = typography.body,
                            color = colors.textPrimary
                        )
                    }
                }
            }
        }

        // Error message if any
        if (!phase.errorMessage.isNullOrBlank()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.statusFailed.copy(alpha = 0.14f), shapes.card)
                    .padding(10.dp)
            ) {
                Text(
                    text = "ERROR",
                    style = typography.eyebrowMono,
                    color = colors.statusFailed
                )
                Text(
                    text = phase.errorMessage,
                    style = typography.body,
                    color = colors.statusFailed
                )
            }
        }

        FoundrySecondaryButton(
            text = "View Transcript",
            onClick = { onViewTranscript(phase.resolvedId) },
            modifier = Modifier.fillMaxWidth()
        )
    }
}

private const val CHANGED_FILES_VISIBLE = 8
