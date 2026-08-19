package com.foundry.companion.ui.screens.inspector.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.PhaseRunSummary
import com.foundry.companion.ui.theme.FoundryTheme

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

    Row(
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        phases.forEach { phase ->
            val isSelected = phase.id == selectedPhaseId
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
                    .clickable { onSelectPhase(phase.id) }
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(6.dp)
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
