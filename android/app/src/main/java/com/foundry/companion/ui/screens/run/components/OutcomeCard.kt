package com.foundry.companion.ui.screens.run.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.GhStatus
import com.foundry.companion.data.model.RunRow
import com.foundry.companion.ui.components.FoundryPrimaryButton
import com.foundry.companion.ui.components.FoundrySecondaryButton
import com.foundry.companion.ui.components.StatusBadge
import com.foundry.companion.ui.theme.FoundryTheme
import kotlinx.coroutines.delay

@Composable
fun OutcomeCard(
    run: RunRow,
    onOpenPr: (String) -> Unit,
    onCreatePr: () -> Unit,
    onOpenIssue: (String) -> Unit,
    modifier: Modifier = Modifier,
    ghStatus: GhStatus? = null,
    isCreatingPr: Boolean = false,
    isConnected: Boolean = true,
    onCopyPrUrl: ((String) -> Unit)? = null
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    val clipboardManager = LocalClipboardManager.current

    var isCopied by remember { mutableStateOf(false) }
    LaunchedEffect(isCopied) {
        if (isCopied) {
            delay(2000L)
            isCopied = false
        }
    }

    val statusColor = colors.statusColorFor(run.status)
    val headline = when (run.status.lowercase()) {
        "accepted" -> "Run Accepted"
        "rejected" -> "Run Not Accepted"
        "failed" -> "Run Failed"
        "killed" -> "Run Killed"
        else -> "Run Settled"
    }

    val explanation = if (!run.outcomeDetail.isNullOrBlank()) {
        run.outcomeDetail
    } else {
        when (run.status.lowercase()) {
            "accepted" -> "Every phase passed and the acceptance criterion was met."
            "rejected" -> "The pipeline ran to the end, but its acceptance criterion was not met."
            "killed" -> "Stopped by hand. Anything the run had already committed is still on its branch."
            else -> "The engine could not finish this run."
        }
    }

    val hasPr = !run.prUrl.isNullOrBlank()
    val canCreatePr = !hasPr && !run.merged && !run.branch.isNullOrBlank() &&
        (run.status.equals("accepted", ignoreCase = true) || run.status.equals("rejected", ignoreCase = true))
    val isGhAvailable = ghStatus?.available ?: true

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
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (run.merged) {
                    StatusBadge(status = "accepted", customLabel = "MERGED")
                }
                StatusBadge(status = run.status)
            }
        }

        Text(
            text = explanation,
            style = typography.body,
            color = colors.textPrimary
        )

        // PR / Issue actions
        when {
            hasPr -> {
                val prUrl = run.prUrl.orEmpty()
                val prNum = run.prNumber ?: prUrl.substringAfterLast("/").takeIf { it.all(Char::isDigit) }?.toIntOrNull()
                val buttonText = if (prNum != null) "Open PR #$prNum ↗" else "Open PR ↗"

                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    FoundryPrimaryButton(
                        text = buttonText,
                        onClick = { onOpenPr(prUrl) },
                        enabled = isConnected
                    )

                    FoundrySecondaryButton(
                        text = if (isCopied) "Copied URL" else "Copy PR URL",
                        onClick = {
                            clipboardManager.setText(AnnotatedString(prUrl))
                            isCopied = true
                            onCopyPrUrl?.invoke(prUrl)
                        },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }

            canCreatePr -> {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    FoundryPrimaryButton(
                        text = if (isCreatingPr) "Creating PR…" else "Create PR…",
                        onClick = onCreatePr,
                        enabled = isConnected && !isCreatingPr && isGhAvailable,
                        isLoading = isCreatingPr
                    )

                    if (!isGhAvailable) {
                        val ghDetail = ghStatus?.detail?.ifBlank { "GitHub CLI (gh) is not available on your Mac." }
                            ?: "GitHub CLI (gh) is not available on your Mac."
                        Text(
                            text = ghDetail,
                            style = typography.metaMono,
                            color = colors.textFaint
                        )
                    } else if (!isConnected) {
                        Text(
                            text = "Reconnect to create PR",
                            style = typography.metaMono,
                            color = colors.textFaint
                        )
                    }
                }
            }

            !run.issueUrl.isNullOrBlank() -> {
                val issueNum = run.issueNumber ?: run.issueUrl.substringAfterLast("/").takeIf { it.all(Char::isDigit) }?.toIntOrNull()
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
