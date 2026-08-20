package com.foundry.companion.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.foundry.companion.ui.theme.FoundryTheme

@Composable
fun FoundryPrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isLoading: Boolean = false,
    contentDescription: String? = null
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    Button(
        onClick = onClick,
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .then(
                if (contentDescription != null) {
                    Modifier.semantics { this.contentDescription = contentDescription }
                } else {
                    Modifier
                }
            ),
        enabled = enabled && !isLoading,
        shape = shapes.button,
        colors = ButtonDefaults.buttonColors(
            containerColor = colors.accent,
            contentColor = Color.Black,
            disabledContainerColor = colors.bgRaised,
            disabledContentColor = colors.textFaint
        )
    ) {
        if (isLoading) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                color = Color.Black,
                strokeWidth = 2.dp
            )
        } else {
            Text(
                text = text.uppercase(),
                style = typography.labelMono
            )
        }
    }
}

@Composable
fun FoundrySecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    OutlinedButton(
        onClick = onClick,
        modifier = modifier.heightIn(min = 48.dp),
        enabled = enabled,
        shape = shapes.button,
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = colors.bgRaised,
            contentColor = colors.textPrimary,
            disabledContainerColor = colors.bgPanel,
            disabledContentColor = colors.textFaint
        ),
        border = BorderStroke(1.dp, colors.lineStrong)
    ) {
        Text(
            text = text.uppercase(),
            style = typography.labelMono
        )
    }
}

@Composable
fun FoundryDangerButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    Button(
        onClick = onClick,
        modifier = modifier.heightIn(min = 48.dp),
        enabled = enabled,
        shape = shapes.button,
        colors = ButtonDefaults.buttonColors(
            containerColor = colors.statusFailed.copy(alpha = 0.18f),
            contentColor = colors.statusFailed,
            disabledContainerColor = colors.bgRaised,
            disabledContentColor = colors.textFaint
        )
    ) {
        Text(
            text = text.uppercase(),
            style = typography.labelMono
        )
    }
}
