package com.foundry.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.PhaseTemplateSummary
import com.foundry.companion.ui.theme.FoundryTheme

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PhaseRibbon(
    phases: List<PhaseTemplateSummary>,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    FlowRow(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        phases.forEachIndexed { index, phase ->
            val kindColor = when (phase.kind.lowercase()) {
                "code" -> colors.accent
                "review" -> colors.statusAccepted
                else -> colors.textDim
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Box(
                    modifier = Modifier
                        .background(colors.bgRaised, shapes.chip)
                        .border(1.dp, colors.line, shapes.chip)
                        .padding(horizontal = 6.dp, vertical = 3.dp)
                ) {
                    Text(
                        text = phase.name,
                        style = typography.labelMono,
                        color = kindColor
                    )
                }

                val hasFeedback = phase.isFeedbackTarget || !phase.feedbackTo.isNullOrEmpty()
                if (hasFeedback) {
                    Text(
                        text = "↩",
                        style = typography.metaMono,
                        color = colors.statusRejected
                    )
                } else if (index < phases.size - 1) {
                    Text(
                        text = "→",
                        style = typography.metaMono,
                        color = colors.textFaint
                    )
                }
            }
        }
    }
}
