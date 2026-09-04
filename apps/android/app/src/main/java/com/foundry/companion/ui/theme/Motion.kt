package com.foundry.companion.ui.theme

import android.content.Context
import android.os.Build
import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode

/**
 * Compose reduce-motion, when a host provides it. Default false so a missing
 * platform LocalReduceMotion is not invented as a new animation gate.
 */
val LocalFoundryReduceMotion = staticCompositionLocalOf { false }

/** Persistent pulses and the running-status spin are the only animations in
 *  the companion. Tests and inspection previews must not start an infinite
 *  transition or Espresso never goes idle. OS "remove animations"
 *  (animator duration scale == 0) and [LocalFoundryReduceMotion] also
 *  suppress them. */
@Composable
fun foundryPulseEnabled(active: Boolean): Boolean {
    if (!active) return false
    if (!foundryLiveClockEnabled()) return false
    if (foundryReduceMotionEnabled()) return false
    return true
}

@Composable
fun foundryPulseAlpha(active: Boolean): Float {
    if (!foundryPulseEnabled(active)) return 1f
    val infiniteTransition = rememberInfiniteTransition(label = "pulse")
    val alpha by infiniteTransition.animateFloat(
        initialValue = 0.35f,
        targetValue = 1.0f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 750, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "alpha"
    )
    return alpha
}

@Composable
fun foundrySpinRotation(active: Boolean): Float {
    if (!foundryPulseEnabled(active)) return 0f
    val infiniteTransition = rememberInfiniteTransition(label = "spin")
    val rotation by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 900, easing = LinearEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "rotation"
    )
    return rotation
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
