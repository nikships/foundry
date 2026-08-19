package com.foundry.companion.ui.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.unit.dp
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.ui.theme.foundryPulseEnabled

@Composable
fun StatusBadge(
    status: String,
    modifier: Modifier = Modifier,
    customLabel: String? = null
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    val statusColor = colors.statusColorFor(status)
    val isRunning = status.equals("running", ignoreCase = true)

    val pulseAlpha = if (foundryPulseEnabled(isRunning)) {
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
        alpha
    } else {
        1.0f
    }

    val displayLabel = (customLabel ?: status).uppercase()

    Row(
        modifier = modifier
            .background(
                color = statusColor.copy(alpha = 0.14f),
                shape = shapes.badge
            )
            .padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp)
    ) {
        Box(
            modifier = Modifier
                .size(6.dp)
                .alpha(if (isRunning) pulseAlpha else 1f)
                .background(color = statusColor, shape = CircleShape)
        )
        Text(
            text = displayLabel,
            style = typography.labelMono,
            color = statusColor
        )
    }
}
