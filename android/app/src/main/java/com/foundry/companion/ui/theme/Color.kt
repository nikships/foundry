package com.foundry.companion.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

@Immutable
data class FoundryColors(
    val bgBase: Color = Color(0xFF020202),
    val bgPanel: Color = Color(0xFF0A0A0A),
    val bgRaised: Color = Color(0xFF101010),
    val bgInput: Color = Color(0xFF050505),
    val line: Color = Color(0x17FFFFFF),          // 9% white
    val lineStrong: Color = Color(0x2EFFFFFF),    // 18% white
    val textPrimary: Color = Color(0xFFEEEEEE),
    val textDim: Color = Color(0xFF8C8C8C),
    val textFaint: Color = Color(0x52FFFFFF),      // 32% white
    val accent: Color = Color(0xFFEE6018),         // Factory Orange

    // Status Tokens
    val statusRunning: Color = Color(0xFFEE6018),
    val statusAccepted: Color = Color(0xFF34D399),
    val statusSuccess: Color = Color(0xFF34D399),
    val statusRejected: Color = Color(0xFFF5A623),
    val statusFailed: Color = Color(0xFFEF4444),
    val statusKilled: Color = Color(0x52FFFFFF),
    val statusQueued: Color = Color(0x52FFFFFF),
    val statusSkipped: Color = Color(0x52FFFFFF),

    // Reconnecting / Warning
    val statusWarning: Color = Color(0xFFF5A623)
) {
    fun statusColorFor(status: String): Color {
        return when (status.lowercase()) {
            "running" -> statusRunning
            "accepted", "success" -> statusAccepted
            "rejected" -> statusRejected
            "failed", "fail" -> statusFailed
            "killed" -> statusKilled
            "queued" -> statusQueued
            "skipped" -> statusSkipped
            else -> textFaint
        }
    }
}

val LocalFoundryColors = staticCompositionLocalOf { FoundryColors() }
