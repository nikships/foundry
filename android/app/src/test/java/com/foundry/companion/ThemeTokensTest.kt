package com.foundry.companion

import androidx.compose.ui.graphics.Color
import com.foundry.companion.ui.theme.FoundryColors
import org.junit.Assert.assertEquals
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
}
