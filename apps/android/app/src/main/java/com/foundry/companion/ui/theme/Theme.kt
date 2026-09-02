package com.foundry.companion.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable

private val defaultColors = FoundryColors()

private val darkScheme = darkColorScheme(
    primary = defaultColors.accent,
    background = defaultColors.bgBase,
    surface = defaultColors.bgPanel,
    surfaceVariant = defaultColors.bgRaised,
    onPrimary = defaultColors.bgBase,
    onBackground = defaultColors.textPrimary,
    onSurface = defaultColors.textPrimary,
    onSurfaceVariant = defaultColors.textDim,
    outline = defaultColors.line,
    outlineVariant = defaultColors.lineStrong
)

@Composable
fun FoundryTheme(
    colors: FoundryColors = FoundryColors(),
    typography: FoundryTypography = FoundryTypography(),
    shapes: FoundryShapes = FoundryShapes(),
    spacing: FoundrySpacing = FoundrySpacing(),
    content: @Composable () -> Unit
) {
    CompositionLocalProvider(
        LocalFoundryColors provides colors,
        LocalFoundryTypography provides typography,
        LocalFoundryShapes provides shapes,
        LocalFoundrySpacing provides spacing
    ) {
        MaterialTheme(
            colorScheme = darkScheme,
            content = content
        )
    }
}

object FoundryTheme {
    val colors: FoundryColors
        @Composable
        @ReadOnlyComposable
        get() = LocalFoundryColors.current

    val typography: FoundryTypography
        @Composable
        @ReadOnlyComposable
        get() = LocalFoundryTypography.current

    val shapes: FoundryShapes
        @Composable
        @ReadOnlyComposable
        get() = LocalFoundryShapes.current

    val spacing: FoundrySpacing
        @Composable
        @ReadOnlyComposable
        get() = LocalFoundrySpacing.current
}
