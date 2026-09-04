package com.foundry.companion

import android.content.Context
import android.provider.Settings
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import com.foundry.companion.ui.theme.LocalFoundryReduceMotion
import com.foundry.companion.ui.theme.foundryPulseEnabled
import com.foundry.companion.ui.theme.foundryReduceMotionEnabled
import com.foundry.companion.ui.theme.foundrySpinRotation
import com.foundry.companion.ui.theme.isAnimatorDurationOff
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MotionTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun animatorDurationScaleZeroIsReduceMotion() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        assertTrue(isAnimatorDurationOff(context))

        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        assertFalse(isAnimatorDurationOff(context))
    }

    @Test
    fun composeReduceMotionSuppressesOnlyThePulseGate() {
        var reduced: Boolean? = null
        var pulse: Boolean? = null
        var spin: Float? = null
        composeTestRule.setContent {
            CompositionLocalProvider(LocalFoundryReduceMotion provides true) {
                reduced = foundryReduceMotionEnabled()
                pulse = foundryPulseEnabled(true)
                spin = foundrySpinRotation(true)
            }
        }
        assertTrue(reduced == true)
        assertFalse(pulse == true)
        assertEquals(0f, spin)
    }

    @Test
    fun animatorDurationScaleZeroSuppressesPulse() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)

        var reduced: Boolean? = null
        var pulse: Boolean? = null
        var spin: Float? = null
        composeTestRule.setContent {
            reduced = foundryReduceMotionEnabled()
            pulse = foundryPulseEnabled(true)
            spin = foundrySpinRotation(true)
        }
        assertTrue(reduced == true)
        assertFalse(pulse == true)
        assertEquals(0f, spin)
    }

    @Test
    fun robolectricDoesNotStartTheRunningStatusSpin() {
        var spin: Float? = null
        composeTestRule.setContent {
            spin = foundrySpinRotation(true)
        }
        assertEquals(0f, spin)
    }
}
