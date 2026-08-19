package com.foundry.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.ui.theme.FoundryTheme

@Composable
fun ConnectionPill(
    status: ConnectionStatus,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    val (desktopName, dotColor) = when (status) {
        is ConnectionStatus.Connected -> status.desktopName to colors.statusAccepted
        is ConnectionStatus.Reconnecting -> status.desktopName to colors.statusRejected
        is ConnectionStatus.Offline -> status.desktopName to colors.statusFailed
        is ConnectionStatus.Unpaired -> "Unpaired" to colors.textFaint
    }

    Row(
        modifier = modifier
            .clip(shapes.chip)
            .background(colors.bgRaised)
            .border(1.dp, colors.line, shapes.chip)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Box(
            modifier = Modifier
                .size(6.dp)
                .background(dotColor, CircleShape)
        )
        Text(
            text = desktopName,
            style = typography.metaMono,
            color = colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}
