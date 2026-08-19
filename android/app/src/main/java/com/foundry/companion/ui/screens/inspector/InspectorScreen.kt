package com.foundry.companion.ui.screens.inspector

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.RunDetail
import com.foundry.companion.data.model.TranscriptEvent
import com.foundry.companion.ui.components.FoundryTopBar
import com.foundry.companion.ui.components.StatusBadge
import com.foundry.companion.ui.screens.inspector.components.PhaseChipsRow
import com.foundry.companion.ui.screens.inspector.components.TranscriptLane
import com.foundry.companion.ui.theme.FoundryTheme

@Composable
fun InspectorScreen(
    runDetail: RunDetail?,
    events: List<TranscriptEvent>,
    initialPhaseId: String?,
    connectionStatus: ConnectionStatus,
    onBackClick: () -> Unit,
    onPhaseSelected: (phaseId: String) -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography

    if (runDetail == null) {
        Box(
            modifier = modifier
                .fillMaxSize()
                .background(colors.bgBase),
            contentAlignment = Alignment.Center
        ) {
            CircularProgressIndicator(color = colors.accent)
        }
        return
    }

    val phases = runDetail.phases
    var selectedPhaseId by remember(initialPhaseId, phases) {
        mutableStateOf(
            initialPhaseId
                ?: phases.find { it.status.equals("running", ignoreCase = true) }?.id
                ?: phases.find { it.status.equals("fail", ignoreCase = true) }?.id
                ?: phases.firstOrNull()?.id
        )
    }

    val currentPhase = phases.find { it.id == selectedPhaseId } ?: phases.firstOrNull()
    val isPhaseRunning = currentPhase?.status?.equals("running", ignoreCase = true) == true

    Scaffold(
        modifier = modifier.fillMaxSize(),
        containerColor = colors.bgBase,
        topBar = {
            FoundryTopBar(
                title = "Inspector · ${currentPhase?.name ?: "Phase"}",
                onBackClick = onBackClick,
                actions = {
                    StatusBadge(status = runDetail.run.status)
                }
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            // Horizontal phase chips row
            if (phases.isNotEmpty()) {
                PhaseChipsRow(
                    phases = phases,
                    selectedPhaseId = selectedPhaseId,
                    onSelectPhase = {
                        selectedPhaseId = it
                        onPhaseSelected(it)
                    }
                )
            }

            // Transcript Lane
            TranscriptLane(
                events = events,
                isRunning = isPhaseRunning
            )
        }
    }
}
