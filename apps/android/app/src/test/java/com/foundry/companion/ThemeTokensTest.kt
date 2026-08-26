package com.foundry.companion

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.sp
import com.foundry.companion.ui.theme.FoundryColors
import com.foundry.companion.ui.theme.FoundryTypography
import com.foundry.companion.ui.theme.GeistFontFamily
import com.foundry.companion.ui.theme.GeistMonoFontFamily
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ThemeTokensTest {

    private val colors = FoundryColors()

    @Test
    fun testBasePaletteValues() {
        assertEquals(Color(0xFF020202), colors.bgBase)
        assertEquals(Color(0xFF0A0A0A), colors.bgPanel)
        assertEquals(Color(0xFF101010), colors.bgRaised)
        assertEquals(Color(0xFF050505), colors.bgInput)
        assertEquals(Color(0xFFEE6018), colors.accent)
        assertEquals(Color(0xFFEEEEEE), colors.textPrimary)
        assertEquals(Color(0xFF8C8C8C), colors.textDim)
        assertEquals(Color(0x99FFFFFF), colors.textFaint)
        assertEquals(Color(0x9E000000), colors.scrim)
    }

    @Test
    fun testStatusTokensMapping() {
        assertEquals(colors.statusRunning, colors.statusColorFor("running"))
        assertEquals(colors.statusAccepted, colors.statusColorFor("accepted"))
        assertEquals(colors.statusSuccess, colors.statusColorFor("success"))
        assertEquals(colors.statusRejected, colors.statusColorFor("rejected"))
        assertEquals(colors.statusFailed, colors.statusColorFor("failed"))
        assertEquals(colors.statusFailed, colors.statusColorFor("fail"))
        assertEquals(colors.statusKilled, colors.statusColorFor("killed"))
        assertEquals(colors.statusQueued, colors.statusColorFor("queued"))
        assertEquals(colors.statusSkipped, colors.statusColorFor("skipped"))
    }

    @Test
    fun testTypeScaleMatchesSpecAndNeverDropsBelow10sp() {
        val typography = FoundryTypography()
        assertEquals(22.sp, typography.screenTitle.fontSize)
        assertEquals(16.sp, typography.requestText.fontSize)
        assertEquals(14.sp, typography.body.fontSize)
        assertEquals(14.sp, typography.bodyStrong.fontSize)
        assertEquals(12.sp, typography.metaMono.fontSize)
        assertEquals(11.sp, typography.labelMono.fontSize)
        assertEquals(10.sp, typography.eyebrowMono.fontSize)
        assertEquals(13.sp, typography.transcriptMono.fontSize)

        val sizes = listOf(
            typography.screenTitle.fontSize,
            typography.requestText.fontSize,
            typography.body.fontSize,
            typography.bodyStrong.fontSize,
            typography.metaMono.fontSize,
            typography.labelMono.fontSize,
            typography.eyebrowMono.fontSize,
            typography.transcriptMono.fontSize
        )
        assertTrue(sizes.all { it.value >= 10f })

        assertEquals(GeistFontFamily, typography.screenTitle.fontFamily)
        assertEquals(GeistFontFamily, typography.requestText.fontFamily)
        assertEquals(GeistFontFamily, typography.body.fontFamily)
        assertEquals(GeistMonoFontFamily, typography.metaMono.fontFamily)
        assertEquals(GeistMonoFontFamily, typography.labelMono.fontFamily)
        assertEquals(GeistMonoFontFamily, typography.eyebrowMono.fontFamily)
        assertEquals(GeistMonoFontFamily, typography.transcriptMono.fontFamily)
    }
}
