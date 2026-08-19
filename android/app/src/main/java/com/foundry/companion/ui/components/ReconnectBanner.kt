package com.foundry.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.ui.theme.FoundryTheme

/**
 * Opens the Connection sheet from any screen that shows [ReconnectBanner].
 * [FoundryNavHost] provides the real opener so Inspector does not need a new
 * callback just to honor spec §1.4.
 */
val LocalOpenConnectionSheet = staticCompositionLocalOf { {} }

@Composable
fun ReconnectBanner(
    status: ConnectionStatus,
    onRetryClick: () -> Unit,
    modifier: Modifier = Modifier,
    onConnectionClick: (() -> Unit)? = null
) {
    val colors = FoundryTheme.colors
    val openConnection = onConnectionClick ?: LocalOpenConnectionSheet.current

    when (status) {
        is ConnectionStatus.Reconnecting -> {
            ReconnectBannerRow(
                text = "Reconnecting to ${status.desktopName}…",
                background = colors.statusRejected.copy(alpha = 0.18f),
                textColor = colors.statusRejected,
                retryLabel = "Retry now",
                onRetryClick = onRetryClick,
                onConnectionClick = openConnection,
                modifier = modifier
            )
        }
        is ConnectionStatus.Offline -> {
            ReconnectBannerRow(
                text = "Can't reach ${status.desktopName}. Is Foundry running on the same Wi-Fi?",
                background = colors.statusFailed.copy(alpha = 0.18f),
                textColor = colors.statusFailed,
                retryLabel = "Retry",
                onRetryClick = onRetryClick,
                onConnectionClick = openConnection,
                modifier = modifier
            )
        }
        else -> Unit
    }
}

@Composable
private fun ReconnectBannerRow(
    text: String,
    background: Color,
    textColor: Color,
    retryLabel: String,
    onRetryClick: () -> Unit,
    onConnectionClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(background)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(
            text = text,
            style = typography.body,
            color = textColor,
            modifier = Modifier.weight(1f)
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = retryLabel,
                style = typography.labelMono,
                color = colors.textPrimary,
                modifier = Modifier
                    .clickable(onClick = onRetryClick)
                    .padding(start = 8.dp)
            )
            Text(
                text = "Connection…",
                style = typography.labelMono,
                color = colors.textPrimary,
                modifier = Modifier.clickable(onClick = onConnectionClick)
            )
        }
    }
}
