package com.foundry.companion.ui.screens.connection

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.foundry.companion.BuildConfig
import com.foundry.companion.data.model.CompanionProjectSummary
import com.foundry.companion.data.model.CompanionSessionInfo
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.PairedSession
import com.foundry.companion.ui.components.ApplyFoundryDialogScrim
import com.foundry.companion.ui.theme.FoundryTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectionBottomSheet(
    session: PairedSession?,
    sessionInfo: CompanionSessionInfo?,
    connectionStatus: ConnectionStatus,
    projects: List<CompanionProjectSummary>,
    selectedProjectId: String,
    onSelectProject: (String) -> Unit,
    isNotifyOnSettleEnabled: Boolean,
    onToggleNotifyOnSettle: (Boolean) -> Unit,
    onUnpair: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    var showUnpairConfirm by remember { mutableStateOf(false) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    val desktopName = session?.desktopName ?: "Foundry Desktop"
    val statusText = when (connectionStatus) {
        is ConnectionStatus.Connected -> "Connected · ${session?.hostOrigin ?: ""}"
        is ConnectionStatus.Reconnecting -> "Reconnecting…"
        is ConnectionStatus.Offline -> "Unreachable"
        is ConnectionStatus.Unpaired -> "Unpaired"
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.bgRaised,
        scrimColor = colors.scrim,
        shape = shapes.sheet,
        dragHandle = {
            BottomSheetDefaults.DragHandle(color = colors.lineStrong)
        }
    ) {
        Column(
            modifier = modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 8.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)
        ) {
            // Title
            Text(
                text = "CONNECTION",
                style = typography.eyebrowMono,
                color = colors.textDim
            )

            // 1. Desktop Identity
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgPanel, shapes.card)
                    .border(1.dp, colors.line, shapes.card)
                    .padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Text(
                    text = desktopName,
                    style = typography.bodyStrong,
                    color = colors.textPrimary
                )
                Text(
                    text = statusText,
                    style = typography.metaMono,
                    color = when (connectionStatus) {
                        is ConnectionStatus.Connected -> colors.statusAccepted
                        is ConnectionStatus.Reconnecting -> colors.statusRejected
                        else -> colors.statusFailed
                    }
                )
                if (session?.pairedAt != null) {
                    Text(
                        text = "Paired since ${session.pairedAt.take(10)}",
                        style = typography.metaMono,
                        color = colors.textFaint
                    )
                }
            }

            // 2. Project in focus
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "PROJECT IN FOCUS",
                    style = typography.eyebrowMono,
                    color = colors.textDim
                )

                if (projects.size > 1) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        projects.forEach { proj ->
                            val isSelected = proj.id == selectedProjectId
                            Box(
                                modifier = Modifier
                                    .defaultMinSize(minHeight = 48.dp)
                                    .background(
                                        if (isSelected) colors.bgRaised else colors.bgPanel,
                                        shapes.chip
                                    )
                                    .border(
                                        1.dp,
                                        if (isSelected) colors.accent else colors.line,
                                        shapes.chip
                                    )
                                    .semantics { contentDescription = "Focus project ${proj.name}" }
                                    .clickable { onSelectProject(proj.id) }
                                    .padding(horizontal = 12.dp, vertical = 8.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = proj.name,
                                    style = typography.labelMono,
                                    color = if (isSelected) colors.textPrimary else colors.textDim
                                )
                            }
                        }
                    }
                } else {
                    val singleProjName = projects.firstOrNull()?.name ?: "Foundry"
                    Text(
                        text = singleProjName,
                        style = typography.body,
                        color = colors.textPrimary
                    )
                }
            }

            // 3. Notifications Toggle
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgPanel, shapes.card)
                    .padding(14.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                    modifier = Modifier.weight(1f)
                ) {
                    Text(
                        text = "Notify when a run settles",
                        style = typography.body,
                        color = colors.textPrimary
                    )
                    Text(
                        text = "Alerts on accepted, rejected, or failed runs",
                        style = typography.metaMono,
                        color = colors.textFaint
                    )
                }

                Switch(
                    checked = isNotifyOnSettleEnabled,
                    onCheckedChange = onToggleNotifyOnSettle,
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = colors.accent,
                        checkedTrackColor = colors.bgRaised,
                        uncheckedThumbColor = colors.textFaint,
                        uncheckedTrackColor = colors.bgInput
                    )
                )
            }

            // 4. Unpair button
            Button(
                onClick = { showUnpairConfirm = true },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .semantics { contentDescription = "Unpair from this desktop" },
                shape = shapes.button,
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.statusFailed.copy(alpha = 0.14f),
                    contentColor = colors.statusFailed
                )
            ) {
                Text(
                    text = "UNPAIR FROM THIS DESKTOP",
                    style = typography.labelMono
                )
            }

            // 5. Fine print
            Text(
                text = companionFinePrint(
                    appVersion = BuildConfig.VERSION_NAME,
                    desktopVersion = sessionInfo?.appVersion,
                    protocolVersion = session?.protocolVersion ?: sessionInfo?.protocolVersion ?: 1
                ),
                style = typography.metaMono,
                color = colors.textFaint
            )
        }
    }

    if (showUnpairConfirm) {
        AlertDialog(
            onDismissRequest = { showUnpairConfirm = false },
            containerColor = colors.bgRaised,
            shape = shapes.card,
            title = {
                Column {
                    ApplyFoundryDialogScrim()
                    Text(
                        text = "UNPAIR DESKTOP",
                        style = typography.eyebrowMono,
                        color = colors.statusFailed
                    )
                }
            },
            text = {
                Text(
                    text = "Unpair from $desktopName? The phone forgets this desktop; nothing on the Mac is deleted.",
                    style = typography.body,
                    color = colors.textPrimary
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        showUnpairConfirm = false
                        onUnpair()
                        onDismiss()
                    },
                    shape = shapes.button,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.statusFailed.copy(alpha = 0.18f),
                        contentColor = colors.statusFailed
                    )
                ) {
                    Text(text = "UNPAIR", style = typography.labelMono)
                }
            },
            dismissButton = {
                TextButton(onClick = { showUnpairConfirm = false }) {
                    Text(text = "CANCEL", style = typography.labelMono, color = colors.textPrimary)
                }
            }
        )
    }
}

internal fun companionFinePrint(
    appVersion: String,
    desktopVersion: String?,
    protocolVersion: Int
): String {
    val desktop = desktopVersion ?: "—"
    return "Companion v$appVersion · Desktop v$desktop · Protocol v$protocolVersion"
}
