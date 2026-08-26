package com.foundry.companion.ui.screens.run.components

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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.foundry.companion.ui.theme.FoundryTheme

@Composable
fun CreatePrConfirmContent(
    title: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    confirmEnabled: Boolean = title.isNotBlank()
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 8.dp)
            .padding(bottom = 32.dp)
            .testTag("create-pr-confirm-sheet"),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text(
            text = "CREATE PULL REQUEST",
            style = typography.eyebrowMono,
            color = colors.accent
        )

        Text(
            text = "Title",
            style = typography.metaMono,
            color = colors.textFaint
        )

        Text(
            text = title.ifBlank { "Loading draft…" },
            style = typography.requestText,
            color = colors.textPrimary,
            modifier = Modifier.testTag("create-pr-draft-title")
        )

        Text(
            text = "This will push the run branch and open a pull request on GitHub.",
            style = typography.body,
            color = colors.textDim
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier
                    .weight(1f)
                    .height(48.dp)
                    .testTag("create-pr-cancel")
            ) {
                Text(text = "CANCEL", style = typography.labelMono, color = colors.textPrimary)
            }

            Button(
                onClick = onConfirm,
                enabled = confirmEnabled,
                modifier = Modifier
                    .weight(1f)
                    .height(48.dp)
                    .testTag("create-pr-confirm"),
                shape = shapes.button,
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.accent,
                    contentColor = Color.Black,
                    disabledContainerColor = colors.bgRaised,
                    disabledContentColor = colors.textFaint
                )
            ) {
                Text(text = "CREATE PR", style = typography.labelMono)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreatePrConfirmSheet(
    title: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    confirmEnabled: Boolean = title.isNotBlank()
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
        CreatePrConfirmContent(
            title = title,
            onConfirm = onConfirm,
            onDismiss = onDismiss,
            confirmEnabled = confirmEnabled,
            modifier = modifier
        )
    }
}
