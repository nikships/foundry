package com.foundry.companion

import android.content.Intent
import androidx.browser.customtabs.CustomTabsIntent
import com.foundry.companion.util.CustomTabs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CustomTabsTest {

    @Test
    fun testOpenPrUsesCustomTabSessionNotBareView() {
        val customTabs = CustomTabs.intent()
        val intent = customTabs.intent
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertTrue(
            "Open PR must launch through CustomTabsIntent, not a raw VIEW",
            intent.hasExtra(CustomTabsIntent.EXTRA_SESSION)
        )
        assertEquals(
            CustomTabsIntent.SHOW_PAGE_TITLE,
            intent.getIntExtra(
                CustomTabsIntent.EXTRA_TITLE_VISIBILITY_STATE,
                CustomTabsIntent.NO_TITLE
            )
        )
    }
}
