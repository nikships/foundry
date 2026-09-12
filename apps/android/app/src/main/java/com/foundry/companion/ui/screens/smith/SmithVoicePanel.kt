package com.foundry.companion.ui.screens.smith

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.foundry.companion.ui.components.FoundryPrimaryButton
import com.foundry.companion.ui.components.FoundrySecondaryButton
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.ui.theme.foundryReduceMotionEnabled
import com.foundry.companion.voice.SmithVoiceController
import com.foundry.companion.voice.SmithVoiceState
import com.foundry.companion.voice.VoicePhase
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

@Composable
fun SmithVoicePanel(controller: SmithVoiceController, onDismiss: () -> Unit) {
    val state by controller.state.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var permissionError by remember { mutableStateOf<String?>(null) }
    var mayStart by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (mayStart && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            if (granted) controller.start()
            else permissionError = "Microphone permission is needed. Allow it in Android Settings if it was previously denied."
        }
        mayStart = false
    }
    DisposableEffect(controller, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) {
                mayStart = false
                controller.end()
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            mayStart = false
            lifecycle.removeObserver(observer)
            controller.end()
        }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = FoundryTheme.colors.bgBase) {
        SmithVoiceContent(
            state = state,
            error = permissionError,
            onStart = {
                permissionError = null
                mayStart = true
                permission.launch(Manifest.permission.RECORD_AUDIO)
            },
            onMute = controller::mute,
            onEnd = { mayStart = false; controller.end() },
            onDismiss = onDismiss
        )
    }
}

@Composable
internal fun SmithVoiceContent(
    state: SmithVoiceState,
    error: String? = null,
    onStart: () -> Unit,
    onMute: () -> Unit,
    onEnd: () -> Unit,
    onDismiss: () -> Unit
) {
    val colors = FoundryTheme.colors
    val type = FoundryTheme.typography
    val active = state.phase == VoicePhase.Live || state.phase == VoicePhase.Connecting
    val status = when {
        state.phase == VoicePhase.Connecting -> "CONNECTING"
        state.phase == VoicePhase.Error -> "VOICE UNAVAILABLE"
        state.phase != VoicePhase.Live -> "READY WHEN YOU ARE"
        state.amplitude > 0.01f -> "SMITH IS SPEAKING"
        state.muted -> "MICROPHONE MUTED"
        else -> "LISTENING"
    }
    Column(
        modifier = Modifier.fillMaxWidth().heightIn(max = 640.dp)
            .verticalScroll(rememberScrollState()).navigationBarsPadding().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Text("SMITH · LIVE VOICE", style = type.eyebrowMono, color = colors.accent)
        SmithSpeakingOrb(state.amplitude, Modifier.size(180.dp))
        Text(status, style = type.labelMono, color = colors.textPrimary)
        Text(
            "Same Smith conversation. Voice ends when you leave this screen or background Foundry; Smith work continues. Headphones recommended.",
            style = type.body, color = colors.textDim
        )
        (error ?: state.detail)?.let { Text(it, style = type.body, color = colors.statusFailed) }
        if (state.captions.isNotEmpty()) {
            val scroll = rememberScrollState()
            LaunchedEffect(state.captions) { scroll.scrollTo(scroll.maxValue) }
            Column(Modifier.fillMaxWidth().heightIn(max = 160.dp).verticalScroll(scroll),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                state.captions.forEach { caption ->
                    Text("${caption.speaker}: ${caption.text}", style = type.body, color = colors.textPrimary)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (active) {
                FoundrySecondaryButton(if (state.muted) "Unmute" else "Mute", onMute,
                    enabled = state.phase == VoicePhase.Live)
                FoundryPrimaryButton("End voice", onEnd)
            } else FoundryPrimaryButton("Start voice", onStart)
        }
        TextButton(onClick = onDismiss) { Text("Back to chat & approvals", color = colors.textDim) }
    }
}

/** Filament geometry and glow respond to PCM actually being played, not network events. */
@Composable
private fun SmithSpeakingOrb(amplitude: Float, modifier: Modifier = Modifier) {
    val energy = if (foundryReduceMotionEnabled()) 0f else amplitude.coerceIn(0f, 1f)
    val copper = Color(0xFFE99259)
    Canvas(modifier.semantics { contentDescription = "Smith voice orb" }) {
        val radius = size.minDimension * (0.32f + energy * 0.09f)
        drawCircle(Brush.radialGradient(listOf(copper.copy(alpha = 0.12f + energy * 0.2f), Color.Transparent)),
            radius = size.minDimension / 2)
        repeat(18) { strand ->
            val path = Path()
            val tilt = strand * PI / 18
            for (step in 0..120) {
                val angle = step * PI * 2 / 120
                val ripple = 1 + energy * 0.14 * sin(angle * 7 + strand)
                val x = radius * cos(angle) * ripple
                val y = radius * sin(angle) * cos(tilt) * ripple
                val rotation = tilt + energy * 0.2
                val point = Offset(
                    center.x + (x * cos(rotation) - y * sin(rotation)).toFloat(),
                    center.y + (x * sin(rotation) + y * cos(rotation)).toFloat()
                )
                if (step == 0) path.moveTo(point.x, point.y) else path.lineTo(point.x, point.y)
            }
            drawPath(path, copper.copy(alpha = 0.24f + energy * 0.5f), style = Stroke(1.dp.toPx()))
        }
    }
}
