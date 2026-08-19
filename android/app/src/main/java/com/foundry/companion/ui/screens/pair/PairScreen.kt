package com.foundry.companion.ui.screens.pair

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.CompanionPairingPayload
import com.foundry.companion.ui.components.FoundryPrimaryButton
import com.foundry.companion.ui.components.FoundrySecondaryButton
import com.foundry.companion.ui.theme.FoundryTheme

@Composable
fun PairScreen(
    onPairSuccess: () -> Unit,
    onPairScanned: (CompanionPairingPayload) -> Unit,
    errorMessage: String? = null,
    isPairing: Boolean = false,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bgBase)
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            // Header
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.padding(top = 16.dp)
            ) {
                Text(
                    text = "FOUNDRY",
                    style = typography.labelMono,
                    color = colors.accent
                )
                Text(
                    text = "Pair Companion",
                    style = typography.screenTitle,
                    color = colors.textPrimary
                )
                Text(
                    text = "Scan the QR code in Foundry → Settings → Companion",
                    style = typography.body,
                    color = colors.textDim,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center
                )
            }

            // Viewfinder reticle
            Box(
                modifier = Modifier
                    .size(260.dp)
                    .background(colors.bgInput, shapes.card)
                    .border(1.dp, colors.lineStrong, shapes.card),
                contentAlignment = Alignment.Center
            ) {
                // Corner reticle accents
                Canvas(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                    val strokeWidth = 3.dp.toPx()
                    val cornerLength = 24.dp.toPx()
                    val color = colors.accent

                    // Top-Left
                    drawLine(color, Offset(0f, 0f), Offset(cornerLength, 0f), strokeWidth)
                    drawLine(color, Offset(0f, 0f), Offset(0f, cornerLength), strokeWidth)

                    // Top-Right
                    drawLine(color, Offset(size.width, 0f), Offset(size.width - cornerLength, 0f), strokeWidth)
                    drawLine(color, Offset(size.width, 0f), Offset(size.width, cornerLength), strokeWidth)

                    // Bottom-Left
                    drawLine(color, Offset(0f, size.height), Offset(cornerLength, size.height), strokeWidth)
                    drawLine(color, Offset(0f, size.height), Offset(0f, size.height - cornerLength), strokeWidth)

                    // Bottom-Right
                    drawLine(color, Offset(size.width, size.height), Offset(size.width - cornerLength, size.height), strokeWidth)
                    drawLine(color, Offset(size.width, size.height), Offset(size.width, size.height - cornerLength), strokeWidth)
                }

                if (isPairing) {
                    CircularProgressIndicator(
                        color = colors.accent,
                        strokeWidth = 2.dp
                    )
                } else {
                    Text(
                        text = "Camera Active",
                        style = typography.metaMono,
                        color = colors.textFaint
                    )
                }
            }

            // Error display if scanned code failed
            if (!errorMessage.isNullOrBlank()) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.statusFailed.copy(alpha = 0.14f), shapes.card)
                        .padding(12.dp)
                ) {
                    Text(
                        text = errorMessage,
                        style = typography.body,
                        color = colors.statusFailed
                    )
                }
            }

            // Quick demo pairing action (for dev & emulator)
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                FoundryPrimaryButton(
                    text = "Pair with Demo Desktop",
                    onClick = {
                        onPairScanned(
                            CompanionPairingPayload(
                                protocolVersion = 1,
                                origin = "http://192.168.1.100:52810",
                                desktopId = "desktop_demo_01",
                                desktopName = "Nik’s Mac Studio",
                                secret = "demo_secret_token",
                                expiresAt = "2026-08-19T00:00:00Z"
                            )
                        )
                    },
                    isLoading = isPairing
                )

                Text(
                    text = "PAIRING IS QR-ONLY IN PRODUCTION",
                    style = typography.eyebrowMono,
                    color = colors.textFaint
                )
            }
        }
    }
}
