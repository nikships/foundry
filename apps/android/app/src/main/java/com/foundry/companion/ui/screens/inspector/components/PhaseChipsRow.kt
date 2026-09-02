package com.foundry.companion.ui.screens.inspector.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.PhaseRunSummary
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.ui.theme.foundryPulseAlpha

@OptIn(ExperimentalFoundationApi::class)
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
    val pulseAlpha = foundryPulseAlpha(anyRunning)

    val requesters = remember(phases) {
        phases.associate { it.resolvedId to BringIntoViewRequester() }
    }

    LaunchedEffect(selectedPhaseId, phases) {
        val requester = selectedPhaseId?.let { requesters[it] } ?: return@LaunchedEffect
        requester.bringIntoView()
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(scrollState)
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .testTag("inspector-phase-chips"),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        phases.forEach { phase ->
            val isSelected = phase.resolvedId == selectedPhaseId
            val isRunning = phase.status.equals("running", ignoreCase = true)
            val statusColor = colors.statusColorFor(phase.status)
            val requester = requesters[phase.resolvedId] ?: BringIntoViewRequester()

            Row(
                modifier = Modifier
                    .bringIntoViewRequester(requester)
                    .defaultMinSize(minHeight = 48.dp)
                    .clip(shapes.chip)
                    .background(if (isSelected) colors.bgRaised else colors.bgPanel)
                    .border(
                        1.dp,
                        if (isSelected) colors.accent else colors.line,
                        shapes.chip
                    )
                    .clickable { onSelectPhase(phase.resolvedId) }
                    .semantics {
                        selected = isSelected
                        contentDescription = phase.accessibilityLabel
                    }
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

