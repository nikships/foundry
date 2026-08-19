package com.foundry.companion.ui.screens.runs.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.RunRow
import com.foundry.companion.ui.components.StatusBadge
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.ui.theme.foundryLiveClockEnabled
import com.foundry.companion.util.RunFormatters
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

@Composable
fun LiveRunCard(
    run: RunRow,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    // Live ticking timer for elapsed duration
    var currentNow by remember(run.runId) { mutableLongStateOf(System.currentTimeMillis()) }
    val liveClock = foundryLiveClockEnabled()
    LaunchedEffect(run.runId, run.status, liveClock) {
        if (!liveClock) return@LaunchedEffect
        while (isActive) {
            delay(1000L)
            currentNow = System.currentTimeMillis()
        }
    }

    val elapsedMs = RunFormatters.computeDurationMs(run, currentNow) ?: 0L
    val timerString = RunFormatters.formatElapsedTimer(elapsedMs)

    // Phase statuses from phases list or phaseSummary
    val phaseStatuses = remember(run.phases, run.phaseSummary) {
        if (run.phases.isNotEmpty()) {
            run.phases.map { it.status }
        } else if (run.phaseSummary.isNotEmpty()) {
            run.phaseSummary.map { it.status }
        } else {
            emptyList()
        }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 64.dp)
            .background(colors.bgRaised, shapes.card)
            .border(1.dp, colors.lineStrong, shapes.card)
            .clickable(onClick = onClick)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        // Top row: Status badge + Pipeline name + (Waiting badge) + Elapsed timer
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.weight(1f, fill = false)
            ) {
                StatusBadge(status = "running")
                Text(
                    text = run.pipelineName,
                    style = typography.labelMono,
                    color = colors.textDim,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                if (run.waitingInterrupt) {
                    StatusBadge(
                        status = "rejected",
                        customLabel = "WAITING"
                    )
                }
            }

            Text(
                text = timerString,
                style = typography.metaMono,
                color = colors.accent
            )
        }

        // Request excerpt (2 lines)
        Text(
            text = run.request,
            style = typography.bodyStrong,
            color = colors.textPrimary,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )

        // Slim mini horizontal phase strip
        if (phaseStatuses.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(4.dp),
                horizontalArrangement = Arrangement.spacedBy(3.dp)
            ) {
                phaseStatuses.forEach { phaseStatus ->
                    val segColor = colors.statusColorFor(phaseStatus)
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .background(segColor, RoundedCornerShape(1.dp))
                    )
                }
            }
        }

        // Bottom meta: branch tail · tokens
        val branchTail = RunFormatters.branchTail(run.branch)
        val tokensText = RunFormatters.formatTokens(run.totalTokens)
        val metaString = if (tokensText != null) {
            "$branchTail · $tokensText"
        } else {
            branchTail
        }

        Text(
            text = metaString,
            style = typography.metaMono,
            color = colors.textFaint
        )
    }
}
