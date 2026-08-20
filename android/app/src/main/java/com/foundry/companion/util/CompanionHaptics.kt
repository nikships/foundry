package com.foundry.companion.util

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * One short click for the three operator events. Missing vibrators (Robolectric,
 * devices without a motor) must be a no-op, never a crash.
 */
object CompanionHaptics {
    fun perform(context: Context) {
        val vibrator = resolveVibrator(context) ?: return
        val hasMotor = try {
            vibrator.hasVibrator()
        } catch (_: RuntimeException) {
            false
        }
        if (!hasMotor) return
        try {
            vibrator.vibrate(
                VibrationEffect.createOneShot(24, VibrationEffect.DEFAULT_AMPLITUDE)
            )
        } catch (_: RuntimeException) {
            // Shadow / permission / hardware absence
        }
    }

    private fun resolveVibrator(context: Context): Vibrator? {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                context.getSystemService(VibratorManager::class.java)?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
        } catch (_: RuntimeException) {
            null
        }
    }
}
