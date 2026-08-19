package com.foundry.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.ui.theme.FoundryTheme

@Composable
fun ReconnectBanner(
    status: ConnectionStatus,
    onRetryClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography

    when (status) {
        is ConnectionStatus.Reconnecting -> {
            Row(
                modifier = modifier
                    .fillMaxWidth()
                    .background(colors.statusRejected.copy(alpha = 0.18f))
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = "Reconnecting to ${status.desktopName}…",
                    style = typography.body,
                    color = colors.statusRejected,
                    modifier = Modifier.weight(1f)
                )
                Text(
                    text = "Retry now",
                    style = typography.labelMono,
                    color = colors.textPrimary,
                    modifier = Modifier
                        .clickable(onClick = onRetryClick)
                        .padding(start = 8.dp)
                )
            }
        }
        is ConnectionStatus.Offline -> {
            Row(
                modifier = modifier
                    .fillMaxWidth()
                    .background(colors.statusFailed.copy(alpha = 0.18f))
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = "Can't reach ${status.desktopName}. Is Foundry running on the same Wi-Fi?",
                    style = typography.body,
                    color = colors.statusFailed,
                    modifier = Modifier.weight(1f)
                )
                Text(
                    text = "Retry",
                    style = typography.labelMono,
                    color = colors.textPrimary,
                    modifier = Modifier
                        .clickable(onClick = onRetryClick)
                        .padding(start = 8.dp)
                )
            }
        }
        else -> Unit
    }
}
