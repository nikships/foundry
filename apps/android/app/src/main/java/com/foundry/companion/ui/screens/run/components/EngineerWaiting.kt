package com.foundry.companion.ui.screens.run.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.PendingInterrupt
import com.foundry.companion.ui.theme.FoundryTheme

/**
 * Pinned amber strip for spec §3.7 engineer-waiting (read-only).
 *
 * Exact spec copy: "An engineer phase is waiting for your answer." + `Answer…`.
 * Offline: the strip shows but `Answer…` is disabled with "Reconnect to answer".
 *
 * There is deliberately no answer network call here: `shared/companion.ts`
 * exposes no companion interrupt-answer route, so the phone never invents one
 * (see `TranscriptEvents.pendingInterrupt` and `CompanionUiState.pendingInterrupt`).
 * Tapping `Answer…` opens the read-only waiting detail sheet; dismissing that
 * sheet never answers and the strip persists until the desktop trace clears.
 */
@Composable
fun EngineerWaitingStrip(
    pending: PendingInterrupt,
    isConnected: Boolean,
    onAnswerClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.statusWarning.copy(alpha = 0.14f), shapes.card)
            .border(1.dp, colors.statusWarning.copy(alpha = 0.45f), shapes.card)
            .padding(horizontal = 14.dp, vertical = 10.dp)
            .testTag("engineer-waiting-strip"),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = "An engineer phase is waiting for your answer.",
                style = typography.bodyStrong,
                color = colors.statusWarning,
                modifier = Modifier.weight(1f)
            )
            TextButton(
                onClick = onAnswerClick,
                enabled = isConnected,
                modifier = Modifier
                    .padding(start = 8.dp)
                    .semantics { contentDescription = "Answer engineer request" }
                    .testTag("engineer-answer-button")
            ) {
                Text(
                    text = "Answer…",
                    style = typography.labelMono,
                    color = if (isConnected) colors.statusWarning else colors.textFaint
                )
            }
        }
        if (!isConnected) {
            Text(
                text = "Reconnect to answer",
                style = typography.metaMono,
                color = colors.textFaint,
                modifier = Modifier.testTag("engineer-waiting-offline-hint")
            )
        }
    }
}

/**
 * Read-only waiting detail. This is NOT an answer sheet: with no companion
 * interrupt-answer route on the desktop, there is nothing to POST, so there
 * are no Approve/Reject actions. The question comes from
 * `TranscriptEvents.interruptDetail` (desktop Inspector Banner order:
 * detail → question → reason → text).
 */
@Composable
fun EngineerWaitingSheetContent(
    pending: PendingInterrupt,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 8.dp)
            .padding(bottom = 32.dp)
            .testTag("engineer-waiting-sheet"),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text(
            text = "ENGINEER WAITING",
            style = typography.eyebrowMono,
            color = colors.statusWarning
        )
        Text(
            text = pending.question.ifBlank { "An engineer phase is waiting." },
            style = typography.requestText,
            color = colors.textPrimary,
            modifier = Modifier.testTag("engineer-waiting-question")
        )
        Text(
            text = "Answer on your Mac — this phone build shows waiting state only.",
            style = typography.body,
            color = colors.textDim
        )
        Text(
            text = "Dismissing this sheet does not answer. The strip stays until the desktop confirms.",
            style = typography.metaMono,
            color = colors.textFaint
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Button(
                onClick = onDismiss,
                modifier = Modifier
                    .weight(1f)
                    .height(48.dp)
                    .testTag("engineer-waiting-dismiss"),
                shape = shapes.button,
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.statusWarning.copy(alpha = 0.18f),
                    contentColor = colors.statusWarning,
                    disabledContainerColor = colors.bgRaised,
                    disabledContentColor = colors.textFaint
                )
            ) {
                Text(text = "GOT IT", style = typography.labelMono)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EngineerWaitingSheet(
    pending: PendingInterrupt,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val shapes = FoundryTheme.shapes
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.bgRaised,
        scrimColor = colors.scrim,
        shape = shapes.sheet,
        dragHandle = {
            BottomSheetDefaults.DragHandle(color = colors.lineStrong)
        }
    ) {
        EngineerWaitingSheetContent(
            pending = pending,
            onDismiss = onDismiss,
            modifier = modifier
        )
    }
}
