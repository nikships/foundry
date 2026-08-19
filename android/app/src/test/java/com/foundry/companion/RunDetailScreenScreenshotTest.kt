package com.foundry.companion

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalInspectionMode
import com.foundry.companion.data.model.*
import com.foundry.companion.ui.components.InterruptBottomSheet
import com.foundry.companion.ui.screens.run.RunDetailScreen
import com.foundry.companion.ui.theme.FoundryTheme
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
class RunDetailScreenScreenshotTest {

    private val livePhases = listOf(
        PhaseRunSummary(
            id = "p_1",
            name = "Plan",
            kind = "agent",
            status = "success",
            attempt = 1,
            durationMs = 12400,
            tokens = 4120,
            model = "anthropic/claude-3-7-sonnet",
            gateResults = listOf(GateResult("plan_approved", true)),
            envelopeVerdict = "Architecture plan validated against invariants."
        ),
        PhaseRunSummary(
            id = "p_2",
            name = "Spec",
            kind = "agent",
            status = "success",
            attempt = 1,
            durationMs = 24100,
            tokens = 8200,
            model = "anthropic/claude-3-7-sonnet",
            gateResults = listOf(GateResult("spec_complete", true)),
            envelopeVerdict = "Spec and contract definitions generated cleanly."
        ),
        PhaseRunSummary(
            id = "p_3",
            name = "Code",
            kind = "code",
            status = "running",
            attempt = 2,
            durationMs = 45200,
            tokens = 18450,
            model = "anthropic/claude-3-7-sonnet"
        ),
        PhaseRunSummary(
            id = "p_4",
            name = "Review",
            kind = "review",
            status = "queued",
            attempt = 1
        ),
        PhaseRunSummary(
            id = "p_5",
            name = "PR",
            kind = "agent",
            status = "queued",
            attempt = 1
        )
    )

    private val liveRun = RunRow(
        runId = "run_260818_live99",
        projectId = "proj_foundry_core",
        pipelineId = "pipe_default",
        pipelineName = "Feature Pipeline",
        request = "Stand up the Android companion scaffold with Compose navigation and Foundry dark visual system.",
        status = "running",
        startedAt = "2026-08-18T23:30:00Z",
        createdAt = "2026-08-18T23:30:00Z",
        durationMs = 81700,
        totalTokens = 30770,
        branch = "foundry/run_260818_live99",
        phases = livePhases
    )

    private val settledPhases = listOf(
        PhaseRunSummary(
            id = "acc_p1",
            name = "Plan",
            kind = "agent",
            status = "success",
            attempt = 1,
            durationMs = 14200,
            tokens = 3100,
            model = "anthropic/claude-3-7-sonnet",
            gateResults = listOf(GateResult("plan_valid", true)),
            envelopeVerdict = "Architecture invariants verified."
        ),
        PhaseRunSummary(
            id = "acc_p2",
            name = "Spec",
            kind = "agent",
            status = "success",
            attempt = 1,
            durationMs = 28100,
            tokens = 7800,
            model = "anthropic/claude-3-7-sonnet"
        ),
        PhaseRunSummary(
            id = "acc_p3",
            name = "Code",
            kind = "code",
            status = "success",
            attempt = 1,
            durationMs = 189000,
            tokens = 28400,
            model = "anthropic/claude-3-7-sonnet",
            gateResults = listOf(GateResult("compilation_gate", true)),
            envelopeVerdict = "Implementation complete."
        ),
        PhaseRunSummary(
            id = "acc_p4",
            name = "Review",
            kind = "review",
            status = "success",
            attempt = 1,
            durationMs = 45200,
            tokens = 8900,
            model = "anthropic/claude-3-7-sonnet"
        ),
        PhaseRunSummary(
            id = "acc_p5",
            name = "PR",
            kind = "agent",
            status = "success",
            attempt = 1,
            durationMs = 57500,
            tokens = 3940,
            model = "anthropic/claude-3-7-sonnet"
        )
    )

    private val settledRun = RunRow(
        runId = "run_260818_acc01",
        projectId = "proj_foundry_core",
        pipelineId = "pipe_default",
        pipelineName = "Feature Pipeline",
        request = "LAN pairing host and authenticated companion protocol (FOU-83).",
        status = "accepted",
        startedAt = "2026-08-18T22:10:00Z",
        endedAt = "2026-08-18T22:15:34Z",
        createdAt = "2026-08-18T22:10:00Z",
        finishedAt = "2026-08-18T22:15:34Z",
        durationMs = 334000,
        totalTokens = 52140,
        branch = "foundry/run_260818_acc01",
        prNumber = 132,
        prUrl = "https://github.com/foundry-app/foundry/pull/132",
        outcomeDetail = "All 5 phases passed. Authenticated companion routes verified with token auth.",
        phases = settledPhases
    )

    private val sampleInterrupt = PendingInterrupt(
        interruptId = "int_live_01",
        runId = "run_260818_live99",
        pipelineName = "Feature Pipeline",
        phaseName = "Engineer Checkpoint",
        question = "Database schema migration detected. Approve automatic migration rollout to worktree?",
        kind = "engineer"
    )

    @Test
    fun captureLiveRunDetail() {
        val bitmap = renderToBitmap {
            RunDetailScreen(
                runDetail = RunDetail(run = liveRun, phases = livePhases, live = true),
                connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                onBackClick = {},
                onOpenInspector = {},
                onKillRun = {},
                onOpenPr = {},
                onCreatePr = {},
                onOpenIssue = {}
            )
        }
        saveScreenshot(bitmap, "android-run-detail-live.png")
    }

    @Test
    fun captureSettledRunDetail() {
        val bitmap = renderToBitmap {
            RunDetailScreen(
                runDetail = RunDetail(run = settledRun, phases = settledPhases, live = false),
                connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                onBackClick = {},
                onOpenInspector = {},
                onKillRun = {},
                onOpenPr = {},
                onCreatePr = {},
                onOpenIssue = {}
            )
        }
        saveScreenshot(bitmap, "android-run-detail-settled.png")
    }

    @Test
    fun captureLiveRunWithInterruptSheet() {
        val bitmap = renderToBitmap {
            Box(modifier = Modifier.fillMaxSize()) {
                RunDetailScreen(
                    runDetail = RunDetail(run = liveRun, phases = livePhases, live = true),
                    connectionStatus = ConnectionStatus.Connected("Nik's Mac", "http://192.168.1.100"),
                    pendingInterrupt = sampleInterrupt,
                    onBackClick = {},
                    onOpenInspector = {},
                    onKillRun = {},
                    onOpenPr = {},
                    onCreatePr = {},
                    onOpenIssue = {}
                )
                InterruptBottomSheet(
                    interrupt = sampleInterrupt,
                    onApprove = {},
                    onReject = {},
                    onDismiss = {}
                )
            }
        }
        saveScreenshot(bitmap, "android-run-detail-interrupt.png")
    }

    private fun renderToBitmap(content: @androidx.compose.runtime.Composable () -> Unit): Bitmap {
        val activityController = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        val activity = activityController.get()

        val composeView = ComposeView(activity).apply {
            setContent {
                CompositionLocalProvider(LocalInspectionMode provides true) {
                    FoundryTheme {
                        content()
                    }
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
        val canvas = Canvas(bitmap)
        composeView.draw(canvas)
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
        val file = File(dir, filename)
        FileOutputStream(file).use { out ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        }
        println("Saved screenshot to ${file.absolutePath}")
    }
}
