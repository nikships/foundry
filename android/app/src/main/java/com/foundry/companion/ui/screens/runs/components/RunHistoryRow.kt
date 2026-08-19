package com.foundry.companion.ui.screens.runs.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
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
fun RunHistoryRow(
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
            .defaultMinSize(minHeight = 64.dp)
            .background(colors.bgPanel, shapes.card)
            .border(1.dp, colors.line, shapes.card)
            .clickable(onClick = onClick)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
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
                StatusBadge(status = run.status)
                Text(
                    text = run.pipelineName,
                    style = typography.labelMono,
                    color = colors.textDim
                )
            }

            if (run.waitingInterrupt) {
                StatusBadge(
                    status = "rejected",
                    customLabel = "WAITING"
                )
            }
        }

        Text(
            text = run.request,
            style = typography.body,
            color = colors.textPrimary,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )

        // Meta line: duration · tokens · branch tail
        val durationText = (run.durationMs?.let { ms ->
            val totalSec = ms / 1000
            val min = totalSec / 60
            val sec = totalSec % 60
            if (min > 0) "${min}m ${sec}s" else "${sec}s"
        } ?: "—")

        val tokensText = run.totalTokens?.let { "${it / 1000}k tokens" } ?: "—"
        val branchTail = run.branch?.substringAfterLast('/') ?: "—"

        Text(
            text = "$durationText · $tokensText · $branchTail",
            style = typography.metaMono,
            color = colors.textFaint
        )
    }
}
