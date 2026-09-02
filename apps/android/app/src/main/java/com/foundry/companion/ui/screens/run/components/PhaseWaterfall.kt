package com.foundry.companion.ui.screens.run.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.EventRow
import com.foundry.companion.data.model.PhaseRunSummary
import com.foundry.companion.data.model.TranscriptEvents
import com.foundry.companion.data.model.WaterfallTickKind
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.ui.theme.foundryPulseAlpha
import com.foundry.companion.util.RunFormatters
import java.util.Locale

@Composable
fun PhaseWaterfall(
    phases: List<PhaseRunSummary>,
    selectedPhaseId: String?,
    onSelectPhase: (String) -> Unit,
    modifier: Modifier = Modifier,
    events: List<EventRow> = emptyList(),
    nowMs: Long = System.currentTimeMillis()
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    val durations = phases.associate { it.resolvedId to RunFormatters.computePhaseDurationMs(it, nowMs) }
    val maxDuration = durations.values.filterNotNull().maxOrNull()?.coerceAtLeast(1000L) ?: 10000L
    val allQueued = phases.isNotEmpty() && phases.all { it.status.equals("queued", ignoreCase = true) }

    val anyRunning = phases.any { it.status.equals("running", ignoreCase = true) }
    val pulseAlpha = foundryPulseAlpha(anyRunning)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.bgPanel, shapes.card)
            .border(1.dp, colors.line, shapes.card)
            .padding(12.dp)
            .testTag("phase-waterfall"),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "PHASE WATERFALL",
                style = typography.eyebrowMono,
                color = colors.textDim
            )
        }

        if (allQueued) {
            Text(
                text = "Waiting for the first phase…",
                style = typography.body,
                color = colors.textFaint,
                modifier = Modifier.padding(vertical = 4.dp)
            )
        }

        phases.forEach { phase ->
            val isSelected = phase.resolvedId == selectedPhaseId
            val isRunning = phase.status.equals("running", ignoreCase = true)
            val statusColor = colors.statusColorFor(phase.status)
            val durationMs = durations[phase.resolvedId]
            val durationSec = (durationMs ?: 0L) / 1000.0
            val fraction = if (durationMs != null) {
                (durationMs.toFloat() / maxDuration.toFloat()).coerceIn(0.15f, 1.0f)
            } else 0.08f

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 48.dp)
                    .clip(shapes.card)
                    .background(if (isSelected) colors.bgRaised else colors.bgPanel)
                    .border(
                        1.dp,
                        if (isSelected) colors.lineStrong else colors.line.copy(alpha = 0.5f),
                        shapes.card
                    )
                    .clickable { onSelectPhase(phase.resolvedId) }
                    .semantics {
                        selected = isSelected
                        contentDescription = phase.accessibilityLabel
                    }
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                // Phase Kind & Name
                Row(
                    modifier = Modifier.weight(0.35f),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .alpha(if (isRunning) pulseAlpha else 1f)
                            .background(statusColor, shapes.circle)
                    )
                    Text(
                        text = if (phase.attempt > 1) "${phase.name} ×${phase.attempt}" else phase.name,
                        style = if (isSelected) typography.bodyStrong else typography.body,
                        color = if (isSelected) colors.textPrimary else colors.textDim,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }

                // Proportional bar + tool/gate/interrupt ticks from already-fetched events
                val ticks = TranscriptEvents.waterfallTicks(phase, events, nowMs)
                BoxWithConstraints(
                    modifier = Modifier
                        .weight(1f)
                        .height(8.dp)
                        .background(colors.bgInput, RoundedCornerShape(2.dp))
                        .testTag("waterfall-bar-${phase.resolvedId}")
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(fraction)
                            .fillMaxHeight()
                            .background(statusColor, RoundedCornerShape(2.dp))
                    )
                    ticks.forEach { tick ->
                        val tickColor = when (tick.kind) {
                            WaterfallTickKind.TOOL -> colors.accent
                            WaterfallTickKind.GATE -> colors.statusAccepted
                            WaterfallTickKind.GATE_FAIL -> colors.statusFailed
                            WaterfallTickKind.INTERRUPT -> colors.statusRejected
                        }
                        Box(
                            modifier = Modifier
                                .offset(x = maxWidth * tick.fraction.coerceIn(0f, 0.98f))
                                .width(2.dp)
                                .height(8.dp)
                                .background(tickColor, RoundedCornerShape(1.dp))
                                .testTag("waterfall-tick-${tick.kind.tag}")
                        )
                    }
                }

                // Duration text
                Text(
                    text = if (durationMs != null) String.format(Locale.US, "%.1fs", durationSec) else "queued",
                    style = typography.metaMono,
                    color = if (isSelected) colors.textPrimary else colors.textFaint
                )
            }
        }
    }
}

