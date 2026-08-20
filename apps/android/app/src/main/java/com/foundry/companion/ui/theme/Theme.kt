package com.foundry.companion.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable

private val darkScheme = darkColorScheme(
    primary = FoundryColors().accent,
    background = FoundryColors().bgBase,
    surface = FoundryColors().bgPanel,
    surfaceVariant = FoundryColors().bgRaised,
    onPrimary = FoundryColors().bgBase,
    onBackground = FoundryColors().textPrimary,
    onSurface = FoundryColors().textPrimary,
    onSurfaceVariant = FoundryColors().textDim,
    outline = FoundryColors().line,
    outlineVariant = FoundryColors().lineStrong
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
