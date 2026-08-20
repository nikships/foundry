package com.foundry.companion.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.foundry.companion.R

/**
 * Geist / Geist Mono (SIL OFL 1.1), instantiated from the desktop-vendored
 * variable woff2 files into static TTF so Android [Font] can load them.
 * Weights 400 / 500 / 600 match spec §2.3. Never ship a style below 10sp.
 */
val GeistFontFamily = FontFamily(
    Font(R.font.geist_regular, FontWeight.Normal),
    Font(R.font.geist_medium, FontWeight.Medium),
    Font(R.font.geist_semibold, FontWeight.SemiBold)
)

val GeistMonoFontFamily = FontFamily(
    Font(R.font.geist_mono_regular, FontWeight.Normal),
    Font(R.font.geist_mono_medium, FontWeight.Medium),
    Font(R.font.geist_mono_semibold, FontWeight.SemiBold)
)

@Immutable
data class FoundryTypography(
    val screenTitle: TextStyle = TextStyle(
        fontFamily = GeistFontFamily,
        fontWeight = FontWeight.SemiBold,
        fontSize = 22.sp,
        lineHeight = 28.sp
    ),
    val requestText: TextStyle = TextStyle(
        fontFamily = GeistFontFamily,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp
    ),
    val body: TextStyle = TextStyle(
        fontFamily = GeistFontFamily,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 21.sp
    ),
    val bodyStrong: TextStyle = TextStyle(
        fontFamily = GeistFontFamily,
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        lineHeight = 21.sp
    ),
    val metaMono: TextStyle = TextStyle(
        fontFamily = GeistMonoFontFamily,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        fontFeatureSettings = "tnum"
    ),
    val labelMono: TextStyle = TextStyle(
        fontFamily = GeistMonoFontFamily,
        fontWeight = FontWeight.SemiBold,
        fontSize = 11.sp,
        lineHeight = 14.sp,
        letterSpacing = 0.08.em
    ),
    val eyebrowMono: TextStyle = TextStyle(
        fontFamily = GeistMonoFontFamily,
        fontWeight = FontWeight.SemiBold,
        fontSize = 10.sp,
        lineHeight = 13.sp,
        letterSpacing = 0.16.em
    ),
    val transcriptMono: TextStyle = TextStyle(
        fontFamily = GeistMonoFontFamily,
        fontWeight = FontWeight.Normal,
        fontSize = 13.sp,
        lineHeight = 20.sp
    )
)

val LocalFoundryTypography = staticCompositionLocalOf { FoundryTypography() }
