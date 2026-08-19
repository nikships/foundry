package com.foundry.companion.ui.theme

import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalInspectionMode

/** Persistent pulses are the only animation in the companion. Tests and
 *  inspection previews must not start an infinite transition or Espresso
 *  never goes idle. */
@Composable
fun foundryPulseEnabled(active: Boolean): Boolean {
    if (!active) return false
    return foundryLiveClockEnabled()
}

@Composable
fun foundryLiveClockEnabled(): Boolean {
    if (LocalInspectionMode.current) return false
    return !Build.FINGERPRINT.contains("robolectric", ignoreCase = true)
}
