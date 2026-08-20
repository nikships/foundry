package com.foundry.companion.ui.screens.runs.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ReceiptLong
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.RunRow
import com.foundry.companion.ui.components.StatusBadge
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.util.RunFormatters

@Composable
fun RunHistoryRow(
    run: RunRow,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onInspectorClick: (() -> Unit)? = null,
    onOpenPr: ((String) -> Unit)? = null,
    onOpenIssue: ((String) -> Unit)? = null
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    val durationMs = RunFormatters.computeDurationMs(run)
    val durationText = RunFormatters.formatDuration(durationMs)
    val tokensText = RunFormatters.formatTokens(run.totalTokens) ?: "—"
    val branchTail = RunFormatters.branchTail(run.branch)
    val relativeTime = RunFormatters.formatRelativeTime(run.effectiveEndedAt ?: run.effectiveStartedAt)

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
        // Top row: StatusBadge + PipelineName + (Waiting / Merged) + RelativeTime + (Inspector Button)
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
                StatusBadge(status = run.status)
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
                if (run.merged) {
                    StatusBadge(
                        status = "accepted",
                        customLabel = "MERGED"
                    )
                }
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Text(
                    text = relativeTime,
                    style = typography.metaMono,
                    color = colors.textFaint
                )

                if (onInspectorClick != null) {
                    IconButton(
                        onClick = onInspectorClick,
                        modifier = Modifier.size(48.dp)
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ReceiptLong,
                            contentDescription = "Open Inspector",
                            tint = colors.textDim,
                            modifier = Modifier.size(16.dp)
                        )
                    }
                }
            }
        }

        // Request excerpt (2 lines)
        Text(
            text = run.request,
            style = typography.body,
            color = colors.textPrimary,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )

        // Bottom meta row: duration · tokens · branch tail · PR / Issue glyph
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = "$durationText · $tokensText · $branchTail",
                style = typography.metaMono,
                color = colors.textFaint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false)
            )

            // PR or Issue glyph
            if (!run.prUrl.isNullOrBlank()) {
                val prLabel = if (run.prNumber != null) "PR #${run.prNumber} ↗" else "PR ↗"
                val prModifier = if (onOpenPr != null) {
                    Modifier
                        .padding(start = 6.dp)
                        .background(colors.statusAccepted.copy(alpha = 0.12f), RoundedCornerShape(3.dp))
                        .clickable { onOpenPr(run.prUrl) }
                        .padding(horizontal = 5.dp, vertical = 1.dp)
                } else {
                    Modifier
                        .padding(start = 6.dp)
                        .background(colors.statusAccepted.copy(alpha = 0.12f), RoundedCornerShape(3.dp))
                        .padding(horizontal = 5.dp, vertical = 1.dp)
                }
                Row(
                    modifier = prModifier,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = prLabel,
                        style = typography.metaMono,
                        color = colors.statusAccepted
                    )
                }
            } else if (!run.issueUrl.isNullOrBlank()) {
                val issueLabel = if (run.issueNumber != null) "Issue #${run.issueNumber} ↗" else "Issue ↗"
                val issueModifier = if (onOpenIssue != null) {
                    Modifier
                        .padding(start = 6.dp)
                        .background(colors.bgRaised, RoundedCornerShape(3.dp))
                        .clickable { onOpenIssue(run.issueUrl) }
                        .padding(horizontal = 5.dp, vertical = 1.dp)
                } else {
                    Modifier
                        .padding(start = 6.dp)
                        .background(colors.bgRaised, RoundedCornerShape(3.dp))
                        .padding(horizontal = 5.dp, vertical = 1.dp)
                }
                Row(
                    modifier = issueModifier,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = issueLabel,
                        style = typography.metaMono,
                        color = colors.textDim
                    )
                }
            }
        }
    }
}
