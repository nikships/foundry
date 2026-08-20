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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
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

    val (desktopName, dotColor, statusLabel) = when (status) {
        is ConnectionStatus.Connected -> Triple(status.desktopName, colors.statusAccepted, "connected")
        is ConnectionStatus.Reconnecting -> Triple(status.desktopName, colors.statusRejected, "reconnecting")
        is ConnectionStatus.Offline -> Triple(status.desktopName, colors.statusFailed, "unreachable")
        is ConnectionStatus.Unpaired -> Triple("Unpaired", colors.textFaint, "unpaired")
    }

    Row(
        modifier = modifier
            .defaultMinSize(minHeight = 48.dp)
            .widthIn(max = 220.dp)
            .clip(shapes.chip)
            .background(colors.bgRaised)
            .border(1.dp, colors.line, shapes.chip)
            .semantics { contentDescription = "Connection, $desktopName, $statusLabel" }
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
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
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false)
        )
    }
}
