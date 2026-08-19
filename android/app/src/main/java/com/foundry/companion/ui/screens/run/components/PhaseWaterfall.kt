package com.foundry.companion.ui.screens.run.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.PhaseRunSummary
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.ui.theme.foundryPulseEnabled
import java.util.Locale

@Composable
fun PhaseWaterfall(
    phases: List<PhaseRunSummary>,
    selectedPhaseId: String?,
    onSelectPhase: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    val maxDuration = phases.mapNotNull { it.durationMs }.maxOrNull()?.coerceAtLeast(1000L) ?: 10000L
    val allQueued = phases.isNotEmpty() && phases.all { it.status.equals("queued", ignoreCase = true) }

    val anyRunning = phases.any { it.status.equals("running", ignoreCase = true) }
    val pulseAlpha = if (foundryPulseEnabled(anyRunning)) {
        val infiniteTransition = rememberInfiniteTransition(label = "waterfallPulse")
        val alpha by infiniteTransition.animateFloat(
            initialValue = 0.35f,
            targetValue = 1.0f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 750, easing = LinearEasing),
                repeatMode = RepeatMode.Reverse
            ),
            label = "alpha"
        )
        alpha
    } else {
        1f
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.bgPanel, shapes.card)
            .border(1.dp, colors.line, shapes.card)
            .padding(12.dp),
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
            val isSelected = phase.id == selectedPhaseId
            val isRunning = phase.status.equals("running", ignoreCase = true)
            val statusColor = colors.statusColorFor(phase.status)
            val durationSec = (phase.durationMs ?: 0L) / 1000.0
            val fraction = if (phase.durationMs != null) {
                (phase.durationMs.toFloat() / maxDuration.toFloat()).coerceIn(0.15f, 1.0f)
            } else 0.08f

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp)
                    .clip(shapes.card)
                    .background(if (isSelected) colors.bgRaised else colors.bgPanel)
                    .border(
                        1.dp,
                        if (isSelected) colors.lineStrong else colors.line.copy(alpha = 0.5f),
                        shapes.card
                    )
                    .clickable { onSelectPhase(phase.id) }
                    .padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                // Phase Kind & Name
                Row(
                    modifier = Modifier.width(108.dp),
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
                        maxLines = 1
                    )
                }

                // Proportional bar
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(8.dp)
                        .background(colors.bgInput, RoundedCornerShape(2.dp))
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(fraction)
                            .fillMaxHeight()
                            .background(statusColor, RoundedCornerShape(2.dp))
                    )
                }

                // Duration text
                Text(
                    text = if (phase.durationMs != null) String.format(Locale.US, "%.1fs", durationSec) else "queued",
                    style = typography.metaMono,
                    color = if (isSelected) colors.textPrimary else colors.textFaint
                )
            }
        }
    }
}
