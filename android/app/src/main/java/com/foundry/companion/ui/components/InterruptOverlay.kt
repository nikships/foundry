package com.foundry.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.PendingInterrupt
import com.foundry.companion.ui.theme.FoundryTheme

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
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    var notes by remember { mutableStateOf("") }
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
        Column(
            modifier = modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 8.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(
                text = "ENGINEER INTERRUPT · ${interrupt.pipelineName.uppercase()}",
                style = typography.eyebrowMono,
                color = colors.statusRejected
            )

            Text(
                text = interrupt.question,
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
}
