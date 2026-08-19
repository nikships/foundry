package com.foundry.companion.ui.screens.runs.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.RunRow
import com.foundry.companion.ui.components.StatusBadge
import com.foundry.companion.ui.theme.FoundryTheme

@Composable
fun LiveRunCard(
    run: RunRow,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.bgRaised, shapes.card)
            .border(1.dp, colors.lineStrong, shapes.card)
            .clickable(onClick = onClick)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                StatusBadge(status = "running")
                Text(
                    text = run.pipelineName,
                    style = typography.labelMono,
                    color = colors.textDim
                )
            }

            val elapsedSec = (run.durationMs ?: 0L) / 1000
            val min = elapsedSec / 60
            val sec = elapsedSec % 60
            Text(
                text = String.format("%02d:%02d", min, sec),
                style = typography.metaMono,
                color = colors.accent
            )
        }

        Text(
            text = run.request,
            style = typography.bodyStrong,
            color = colors.textPrimary,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )

        // Slim mini phase strip
        if (run.phases.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(4.dp),
                horizontalArrangement = Arrangement.spacedBy(3.dp)
            ) {
                run.phases.forEach { phase ->
                    val segColor = colors.statusColorFor(phase.status)
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .background(segColor, RoundedCornerShape(1.dp))
                    )
                }
            }
        }
    }
}
