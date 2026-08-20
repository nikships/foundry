package com.foundry.companion.ui.theme

import android.content.Context
import android.os.Build
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode

/**
 * Compose reduce-motion, when a host provides it. Default false so a missing
 * platform LocalReduceMotion is not invented as a new animation gate.
 */
val LocalFoundryReduceMotion = staticCompositionLocalOf { false }

/** Persistent pulses are the only animation in the companion. Tests and
 *  inspection previews must not start an infinite transition or Espresso
 *  never goes idle. OS "remove animations" (animator duration scale == 0)
 *  and [LocalFoundryReduceMotion] also suppress the running-status pulse. */
@Composable
fun foundryPulseEnabled(active: Boolean): Boolean {
    if (!active) return false
    if (!foundryLiveClockEnabled()) return false
    if (foundryReduceMotionEnabled()) return false
    return true
}

@Composable
fun foundryLiveClockEnabled(): Boolean {
    if (LocalInspectionMode.current) return false
    return !Build.FINGERPRINT.contains("robolectric", ignoreCase = true)
}

@Composable
fun foundryReduceMotionEnabled(): Boolean {
    val context = LocalContext.current
    if (isAnimatorDurationOff(context)) return true
    return LocalFoundryReduceMotion.current
}

fun isAnimatorDurationOff(context: Context): Boolean {
    val scale = Settings.Global.getFloat(
        context.contentResolver,
        Settings.Global.ANIMATOR_DURATION_SCALE,
        1f
    )
    return scale == 0f
}
