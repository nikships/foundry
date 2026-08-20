package com.foundry.companion.ui.theme

import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp

@Immutable
data class FoundryShapes(
    val card: Shape = RoundedCornerShape(4.dp),
    val button: Shape = RoundedCornerShape(4.dp),
    val badge: Shape = RoundedCornerShape(3.dp),
    val chip: Shape = RoundedCornerShape(4.dp),
    val sheet: Shape = RoundedCornerShape(topStart = 6.dp, topEnd = 6.dp),
    val circle: Shape = CircleShape
)

val LocalFoundryShapes = staticCompositionLocalOf { FoundryShapes() }
