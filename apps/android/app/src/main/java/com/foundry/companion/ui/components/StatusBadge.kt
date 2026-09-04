package com.foundry.companion.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.dp
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.ui.theme.foundrySpinRotation

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
        if (isRunning) {
            RunningStatusSpinner(color = statusColor)
        } else {
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .background(color = statusColor, shape = CircleShape)
            )
        }
        Text(
            text = displayLabel,
            style = typography.labelMono,
            color = statusColor
        )
    }
}

@Composable
private fun RunningStatusSpinner(
    color: Color,
    modifier: Modifier = Modifier
) {
    val rotation = foundrySpinRotation(active = true)
    Canvas(modifier = modifier.size(11.dp)) {
        val strokeWidth = 1.75.dp.toPx()
        val inset = strokeWidth / 2f
        val diameter = size.minDimension - strokeWidth
        rotate(rotation) {
            drawArc(
                color = color,
                startAngle = -90f,
                sweepAngle = 300f,
                useCenter = false,
                topLeft = Offset(inset, inset),
                size = Size(diameter, diameter),
                style = Stroke(width = strokeWidth, cap = StrokeCap.Round)
            )
        }
    }
}
