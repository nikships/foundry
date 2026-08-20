package com.foundry.companion

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.foundry.companion.util.CompanionHaptics
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class HapticsTest {

    @Test
    fun performDoesNotCrashWhenVibratorIsAbsent() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        CompanionHaptics.perform(context)
    }
}
