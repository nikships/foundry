package com.foundry.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.PendingInterrupt
import com.foundry.companion.ui.theme.FoundryTheme

/**
 * The amber strip pinned above the Run header while an engineer phase waits.
 * It is the only in-app path to the sheet: nothing opens the sheet on its own.
 */
@Composable
fun InterruptStrip(
    onAnswerClick: () -> Unit,
    isConnected: Boolean,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.statusRejected.copy(alpha = 0.18f), shapes.card)
            .border(1.dp, colors.statusRejected.copy(alpha = 0.5f), shapes.card)
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp)
        ) {
            Text(
                text = "ENGINEER INTERRUPT",
                style = typography.eyebrowMono,
                color = colors.statusRejected
            )
            Text(
                text = "An engineer phase is waiting for your answer.",
                style = typography.body,
                color = colors.textPrimary
            )
        }

        if (isConnected) {
            Button(
                onClick = onAnswerClick,
                shape = shapes.button,
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.statusRejected.copy(alpha = 0.25f),
                    contentColor = colors.statusRejected
                )
            ) {
                Text(text = "Answer…", style = typography.labelMono)
            }
        } else {
            Text(
                text = "Reconnect to answer",
                style = typography.metaMono,
                color = colors.textFaint,
                modifier = Modifier.padding(start = 8.dp)
            )
        }
    }
}

@Composable
fun InterruptContent(
    interrupt: PendingInterrupt,
    onApprove: (notes: String?) -> Unit,
    onReject: (notes: String?) -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    var notes by remember { mutableStateOf("") }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 8.dp)
            .padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text(
            text = "ENGINEER INTERRUPT · ${interrupt.displayPipeline.uppercase()}",
            style = typography.eyebrowMono,
            color = colors.statusRejected
        )

        Text(
            text = interrupt.displayQuestion,
            style = typography.requestText,
            color = colors.textPrimary
        )

        OutlinedTextField(
            value = notes,
            onValueChange = { notes = it },
            placeholder = {
                Text(
                    text = "Optional operator notes or guidance…",
                    style = typography.body,
                    color = colors.textFaint
                )
            },
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 96.dp),
            shape = shapes.card,
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = colors.bgInput,
                unfocusedContainerColor = colors.bgInput,
                focusedBorderColor = colors.lineStrong,
                unfocusedBorderColor = colors.line,
                focusedTextColor = colors.textPrimary,
                unfocusedTextColor = colors.textPrimary
            ),
            textStyle = typography.body
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Button(
                onClick = { onReject(notes.ifBlank { null }) },
                modifier = Modifier
                    .weight(1f)
                    .height(48.dp),
                shape = shapes.button,
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.statusFailed.copy(alpha = 0.18f),
                    contentColor = colors.statusFailed
                )
            ) {
                Text(text = "REJECT", style = typography.labelMono)
            }

            Button(
                onClick = { onApprove(notes.ifBlank { null }) },
                modifier = Modifier
                    .weight(1f)
                    .height(48.dp),
                shape = shapes.button,
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.accent,
                    contentColor = androidx.compose.ui.graphics.Color.Black
                )
            ) {
                Text(text = "APPROVE", style = typography.labelMono)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InterruptBottomSheet(
    interrupt: PendingInterrupt,
    onApprove: (notes: String?) -> Unit,
    onReject: (notes: String?) -> Unit,
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
        shape = shapes.sheet,
        dragHandle = {
            BottomSheetDefaults.DragHandle(color = colors.lineStrong)
        }
    ) {
        InterruptContent(
            interrupt = interrupt,
            onApprove = onApprove,
            onReject = onReject,
            modifier = modifier
        )
    }
}
