package com.foundry.companion.ui.screens.run.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.RunRow
import com.foundry.companion.ui.components.FoundryPrimaryButton
import com.foundry.companion.ui.components.FoundrySecondaryButton
import com.foundry.companion.ui.components.StatusBadge
import com.foundry.companion.ui.theme.FoundryTheme

@Composable
fun OutcomeCard(
    run: RunRow,
    onOpenPr: (String) -> Unit,
    onCreatePr: () -> Unit,
    onOpenIssue: (String) -> Unit,
    isCreatingPr: Boolean = false,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    val statusColor = colors.statusColorFor(run.status)
    val headline = when (run.status.lowercase()) {
        "accepted" -> "Run Accepted"
        "rejected" -> "Run Not Accepted"
        "failed" -> "Run Failed"
        "killed" -> "Run Killed"
        else -> "Run Settled"
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(statusColor.copy(alpha = 0.12f), shapes.card)
            .border(1.dp, statusColor.copy(alpha = 0.35f), shapes.card)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = headline.uppercase(),
                style = typography.labelMono,
                color = statusColor
            )
            StatusBadge(status = run.status)
        }

        if (!run.outcomeDetail.isNullOrBlank()) {
            Text(
                text = run.outcomeDetail,
                style = typography.body,
                color = colors.textPrimary
            )
        }

        // PR / Issue actions
        when {
            !run.prUrl.isNullOrBlank() -> {
                val prNumber = run.prUrl.substringAfterLast("/").takeIf { it.all(Char::isDigit) }
                val buttonText = if (prNumber != null) "Open PR #$prNumber ↗" else "Open PR ↗"
                FoundryPrimaryButton(
                    text = buttonText,
                    onClick = { onOpenPr(run.prUrl) }
                )
            }
            run.status.equals("accepted", ignoreCase = true) || run.status.equals("rejected", ignoreCase = true) -> {
                FoundryPrimaryButton(
                    text = "Create PR…",
                    onClick = onCreatePr,
                    isLoading = isCreatingPr
                )
            }
            !run.issueUrl.isNullOrBlank() -> {
                val issueNum = run.issueUrl.substringAfterLast("/").takeIf { it.all(Char::isDigit) }
                val buttonText = if (issueNum != null) "Issue #$issueNum ↗" else "View Issue ↗"
                FoundrySecondaryButton(
                    text = buttonText,
                    onClick = { onOpenIssue(run.issueUrl) },
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }
    }
}
