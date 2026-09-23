package com.foundry.companion.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.graphics.Color

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

private val lightScheme = lightColorScheme(
    primary = Color(0xFFB83D08),
    background = Color(0xFFFFFBF8),
    surface = Color(0xFFFFFBF8),
    surfaceVariant = Color(0xFFF5E8E0),
    onPrimary = Color.White,
    onBackground = Color(0xFF201512),
    onSurface = Color(0xFF201512),
    onSurfaceVariant = Color(0xFF5E504A),
    outline = Color(0xFF806C64),
    outlineVariant = Color(0xFFD9C8BE)
)

@Composable
fun FoundryTheme(
    colors: FoundryColors = FoundryColors(),
    typography: FoundryTypography = FoundryTypography(),
    shapes: FoundryShapes = FoundryShapes(),
    spacing: FoundrySpacing = FoundrySpacing(),
    darkTheme: Boolean = true,
    content: @Composable () -> Unit
) {
    val resolvedColors = if (darkTheme) colors else colors.copy(
        bgBase = Color(0xFFFFFBF8),
        bgPanel = Color(0xFFFFF7F1),
        bgRaised = Color(0xFFF5E8E0),
        bgInput = Color(0xFFFFFFFF),
        line = Color(0x1F5E504A),
        lineStrong = Color(0x4D5E504A),
        textPrimary = Color(0xFF201512),
        textDim = Color(0xFF5E504A),
        textFaint = Color(0x995E504A),
        scrim = Color(0x52000000),
        accent = Color(0xFFB83D08)
    )
    CompositionLocalProvider(
        LocalFoundryColors provides resolvedColors,
        LocalFoundryTypography provides typography,
        LocalFoundryShapes provides shapes,
        LocalFoundrySpacing provides spacing
    ) {
        MaterialTheme(
            colorScheme = if (darkTheme) darkScheme else lightScheme,
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
