package com.foundry.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.foundry.companion.ui.theme.FoundryTheme

@Composable
fun FoundryTopBar(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    subtitleContent: (@Composable () -> Unit)? = null,
    onBackClick: (() -> Unit)? = null,
    isCloseAction: Boolean = false,
    eyebrowStyle: Boolean = false,
    actions: @Composable RowScope.() -> Unit = {}
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.bgBase)
            .statusBarsPadding()
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (onBackClick != null) {
                IconButton(
                    onClick = onBackClick,
                    modifier = Modifier.size(44.dp)
                ) {
                    Icon(
                        imageVector = if (isCloseAction) Icons.Default.Close else Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = if (isCloseAction) "Close" else "Back",
                        tint = colors.textPrimary
                    )
                }
            } else {
                Spacer(modifier = Modifier.width(8.dp))
            }

            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 4.dp),
                verticalArrangement = Arrangement.Center
            ) {
                Text(
                    text = title,
                    style = if (eyebrowStyle) typography.eyebrowMono else typography.screenTitle,
                    color = if (eyebrowStyle) colors.textDim else colors.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                if (subtitleContent != null) {
                    subtitleContent()
                } else if (!subtitle.isNullOrBlank()) {
                    Text(
                        text = subtitle,
                        style = typography.metaMono,
                        color = colors.textFaint,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                content = actions
            )
        }

        HorizontalDivider(
            color = colors.line,
            thickness = 1.dp
        )
    }
}
