package com.foundry.companion

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalInspectionMode
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.EventRow
import com.foundry.companion.data.model.PhaseRunSummary
import com.foundry.companion.data.model.RunDetail
import com.foundry.companion.data.model.RunRow
import com.foundry.companion.ui.screens.inspector.InspectorScreen
import com.foundry.companion.ui.theme.FoundryTheme
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.io.FileOutputStream

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class InspectorScreenScreenshotTest {

    @Test
    fun captureInspectorCollapsedTools() {
        val phases = listOf(
            PhaseRunSummary(id = "p_1", name = "Plan", status = "success"),
            PhaseRunSummary(id = "p_3", name = "Code", status = "running", attempt = 1)
        )
        val run = RunRow(
            runId = "run_260818_live99",
            pipelineName = "Feature Pipeline",
            request = "Mobile Inspector transcript",
            status = "running",
            phases = phases
        )
        val events = listOf(
            EventRow(
                eventId = "ev_text",
                phaseId = "p_3",
                type = "assistant_text",
                name = "assistant_text",
                payload = buildJsonObject {
                    put("text", "Scaffolding the phone Inspector as one readable column.")
                },
                startedAt = "23:30:18Z",
                endedAt = "23:30:20Z"
            ),
            EventRow(
                eventId = "ev_tool",
                phaseId = "p_3",
                type = "tool_call",
                name = "read: specs/companion-android-ui.md",
                payload = buildJsonObject {
                    put("kind", "read")
                    putJsonObject("args") { put("file_path", "specs/companion-android-ui.md") }
                    put("result", "Section 3.5 Inspector layout")
                },
                startedAt = "23:30:21Z",
                endedAt = "23:30:22Z"
            ),
            EventRow(
                eventId = "ev_gate",
                phaseId = "p_3",
                type = "gate_pass",
                name = "gate_pass",
                payload = buildJsonObject { put("detail", "Theme tokens pass.") },
                startedAt = "23:30:23Z",
                endedAt = "23:30:23Z"
            )
        )

        val bitmap = renderToBitmap {
            InspectorScreen(
                runDetail = RunDetail(run = run, phases = phases, live = true),
                events = events,
                initialPhaseId = "p_3",
                connectionStatus = ConnectionStatus.Connected("Nik’s Mac Studio", "http://192.168.1.100"),
                onBackClick = {},
                onPhaseSelected = {}
            )
        }
        saveScreenshot(bitmap, "android-inspector-collapsed.png")
    }

    private fun renderToBitmap(content: @androidx.compose.runtime.Composable () -> Unit): Bitmap {
        val activityController = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        val activity = activityController.get()
        val composeView = ComposeView(activity).apply {
            setContent {
                CompositionLocalProvider(LocalInspectionMode provides true) {
                    FoundryTheme { content() }
                }
            }
        }
        activity.setContentView(composeView)
        composeView.measure(
            View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(2400, View.MeasureSpec.EXACTLY)
        )
        composeView.layout(0, 0, 1080, 2400)
        val bitmap = Bitmap.createBitmap(1080, 2400, Bitmap.Config.ARGB_8888)
        composeView.draw(Canvas(bitmap))
        composeView.disposeComposition()
        activityController.pause().stop().destroy()
        return bitmap
    }

    private fun saveScreenshot(bitmap: Bitmap, filename: String) {
        val currentDir = File(System.getProperty("user.dir") ?: ".")
        val repoRoot = if (currentDir.name == "app" && currentDir.parentFile?.name == "android") {
            currentDir.parentFile?.parentFile ?: currentDir
        } else if (currentDir.name == "android") {
            currentDir.parentFile ?: currentDir
        } else {
            currentDir
        }
        val dir = File(repoRoot, "screenshots")
        dir.mkdirs()
        FileOutputStream(File(dir, filename)).use { out ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        }
    }
}
