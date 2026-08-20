package com.foundry.companion

import com.foundry.companion.ui.screens.connection.companionFinePrint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionSheetTest {

    @Test
    fun finePrintUsesBuildConfigVersionName() {
        assertTrue(BuildConfig.VERSION_NAME.isNotBlank())
        assertEquals("0.1.0", BuildConfig.VERSION_NAME)
        assertEquals(
            "Companion v${BuildConfig.VERSION_NAME} · Desktop v1.4.2 · Protocol v1",
            companionFinePrint(BuildConfig.VERSION_NAME, "1.4.2", 1)
        )
        assertEquals(
            "Companion v${BuildConfig.VERSION_NAME} · Desktop v— · Protocol v1",
            companionFinePrint(BuildConfig.VERSION_NAME, null, 1)
        )
    }
}
