package com.foundry.companion.ui.screens.inspector.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.PhaseRunSummary
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.ui.theme.foundryPulseEnabled

enum class PhaseFilter(val label: String) {
    ALL("ALL"),
    RUNNING("RUNNING"),
    FAILED("FAILED")
}

@Composable
fun PhaseFilterRow(
    currentFilter: PhaseFilter,
    onFilterSelect: (PhaseFilter) -> Unit,
    modifier: Modifier = Modifier,
    runningCount: Int = 0,
    failedCount: Int = 0
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        PhaseFilter.entries.forEach { filter ->
            val isSelected = filter == currentFilter
            val label = when (filter) {
                PhaseFilter.ALL -> "ALL"
                PhaseFilter.RUNNING -> if (runningCount > 0) "RUNNING ($runningCount)" else "RUNNING"
                PhaseFilter.FAILED -> if (failedCount > 0) "FAILED ($failedCount)" else "FAILED"
            }
            val tag = when (filter) {
                PhaseFilter.ALL -> "inspector-filter-all"
                PhaseFilter.RUNNING -> "inspector-filter-running"
                PhaseFilter.FAILED -> "inspector-filter-failed"
            }

            Box(
                modifier = Modifier
                    .clip(shapes.button)
                    .background(if (isSelected) colors.bgRaised else colors.bgInput)
                    .border(
                        1.dp,
                        if (isSelected) colors.lineStrong else colors.line,
                        shapes.button
                    )
                    .clickable { onFilterSelect(filter) }
                    .testTag(tag)
                    .padding(horizontal = 10.dp, vertical = 4.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = label,
                    style = typography.labelMono,
                    color = if (isSelected) colors.textPrimary else colors.textFaint
                )
            }
        }
    }
}

@Composable
fun PhaseChipsRow(
    phases: List<PhaseRunSummary>,
    selectedPhaseId: String?,
    onSelectPhase: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    val scrollState = rememberScrollState()
    val anyRunning = phases.any { it.status.equals("running", ignoreCase = true) }

    val pulseAlpha = if (foundryPulseEnabled(anyRunning)) {
        val infiniteTransition = rememberInfiniteTransition(label = "phaseDotPulse")
        val alpha by infiniteTransition.animateFloat(
            initialValue = 0.35f,
            targetValue = 1.0f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 750, easing = LinearEasing),
                repeatMode = RepeatMode.Reverse
            ),
            label = "pulseAlpha"
        )
        alpha
    } else {
        1f
    }

    val selectedIndex = remember(phases, selectedPhaseId) {
        phases.indexOfFirst { it.resolvedId == selectedPhaseId }.coerceAtLeast(0)
    }

    LaunchedEffect(selectedIndex) {
        if (phases.isNotEmpty()) {
            val approxChipWidthPx = 320
            val targetScroll = (selectedIndex * approxChipWidthPx) - 100
            scrollState.animateScrollTo(targetScroll.coerceAtLeast(0))
        }
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(scrollState)
            .padding(horizontal = 16.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        phases.forEach { phase ->
            val isSelected = phase.resolvedId == selectedPhaseId
            val isRunning = phase.status.equals("running", ignoreCase = true)
            val statusColor = colors.statusColorFor(phase.status)

            Row(
                modifier = Modifier
                    .clip(shapes.chip)
                    .background(if (isSelected) colors.bgRaised else colors.bgPanel)
                    .border(
                        1.dp,
                        if (isSelected) colors.accent else colors.line,
                        shapes.chip
                    )
                    .clickable { onSelectPhase(phase.resolvedId) }
                    .testTag("inspector-phase-${phase.resolvedId}")
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(6.dp)
                        .alpha(if (isRunning) pulseAlpha else 1f)
                        .background(statusColor, shapes.circle)
                )
                Text(
                    text = if (phase.attempt > 1) "${phase.name} ×${phase.attempt}" else phase.name,
                    style = typography.labelMono,
                    color = if (isSelected) colors.textPrimary else colors.textDim
                )
            }
        }
    }
}
