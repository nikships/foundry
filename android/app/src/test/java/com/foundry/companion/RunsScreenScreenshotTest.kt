package com.foundry.companion

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.ui.platform.ComposeView
import com.foundry.companion.data.model.*
import com.foundry.companion.ui.screens.runs.RunsScreen
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
class RunsScreenScreenshotTest {

    private val samplePipelines = listOf(
        PipelineSummary(
            id = "pipe_default",
            name = "Feature Pipeline",
            description = "Standard 5-phase feature development workflow with review gate."
        ),
        PipelineSummary(
            id = "pipe_bugfix",
            name = "Bugfix & Verify",
            description = "Fast turnaround pipeline for isolated regression repairs."
        )
    )

    private val sampleProjects = listOf(
        CompanionProjectSummary("proj_foundry_core", "Foundry Core", samplePipelines),
        CompanionProjectSummary("proj_foundry_docs", "Foundry Docs", samplePipelines)
    )

    private val sampleLiveRun = RunRow(
        runId = "run_260818_live99",
        projectId = "proj_foundry_core",
        pipelineId = "pipe_default",
        pipelineName = "Feature Pipeline",
        request = "Stand up the Android companion scaffold with Compose navigation and Foundry dark visual system.",
        status = "running",
        startedAt = "2026-08-18T23:30:00Z",
        durationMs = 81700,
        totalTokens = 30770,
        branch = "foundry/run_260818_live99",
        phases = listOf(
            PhaseRunSummary("p1", "Plan", "agent", "success"),
            PhaseRunSummary("p2", "Spec", "agent", "success"),
            PhaseRunSummary("p3", "Code", "code", "running"),
            PhaseRunSummary("p4", "Review", "review", "queued"),
            PhaseRunSummary("p5", "PR", "agent", "queued")
        )
    )

    private val sampleHistoryRuns = listOf(
        RunRow(
            runId = "run_260818_acc01",
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default",
            pipelineName = "Feature Pipeline",
            request = "LAN pairing host and authenticated companion protocol (FOU-83).",
            status = "accepted",
            startedAt = "2026-08-18T22:10:00Z",
            endedAt = "2026-08-18T22:15:34Z",
            durationMs = 334000,
            totalTokens = 52140,
            branch = "foundry/run_260818_acc01",
            prNumber = 132,
            prUrl = "https://github.com/foundry-app/foundry/pull/132",
            outcomeDetail = "All 5 phases passed. Authenticated companion routes verified with token auth."
        ),
        RunRow(
            runId = "run_260818_rej02",
            projectId = "proj_foundry_core",
            pipelineId = "pipe_bugfix",
            pipelineName = "Bugfix & Verify",
            request = "Refactor main electron bootstrap process initialization order.",
            status = "rejected",
            startedAt = "2026-08-18T21:00:00Z",
            endedAt = "2026-08-18T21:03:12Z",
            durationMs = 192000,
            totalTokens = 24100,
            branch = "foundry/run_260818_rej02",
            outcomeDetail = "Boundary check failed: src/main/main.ts is a protected path."
        ),
        RunRow(
            runId = "run_260818_fail03",
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default",
            pipelineName = "Feature Pipeline",
            request = "Migrate better-sqlite3 native bindings to async worker thread pool.",
            status = "failed",
            startedAt = "2026-08-18T19:30:00Z",
            endedAt = "2026-08-18T19:34:45Z",
            durationMs = 285000,
            totalTokens = 39800,
            branch = "foundry/run_260818_fail03",
            issueNumber = 140,
            issueUrl = "https://github.com/foundry-app/foundry/issues/140",
            outcomeDetail = "Phase Code failed compilation gate after 3 retry attempts."
        ),
        RunRow(
            runId = "run_260818_kill04",
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default",
            pipelineName = "Feature Pipeline",
            request = "Implement experimental web-based renderer backend prototype.",
            status = "killed",
            startedAt = "2026-08-18T18:00:00Z",
            endedAt = "2026-08-18T18:02:10Z",
            durationMs = 130000,
            totalTokens = 15200,
            branch = "foundry/run_260818_kill04",
            outcomeDetail = "Operator killed run. In-flight agent turns stopped; worktree branch preserved."
        )
    )

    private fun renderToBitmap(content: @androidx.compose.runtime.Composable () -> Unit): Bitmap {
        val activityController = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        val activity = activityController.get()

        val composeView = ComposeView(activity).apply {
            setContent {
                FoundryTheme {
                    content()
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
        return bitmap
    }

    private fun saveScreenshot(bitmap: Bitmap, filename: String) {
        // Resolve directory relative to repo root
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

    @Test
    fun captureRunsLiveAndHistory() {
        val bitmap = renderToBitmap {
            RunsScreen(
                runs = listOf(sampleLiveRun) + sampleHistoryRuns,
                connectionStatus = ConnectionStatus.Connected("Nik’s Mac Studio", "http://192.168.1.100:52810"),
                projectName = "Foundry Core",
                projects = sampleProjects,
                selectedProjectId = "proj_foundry_core",
                onRunClick = {},
                onStartRunClick = {},
                onConnectionPillClick = {},
                onRetryConnection = {},
                onInspectorClick = {}
            )
        }
        saveScreenshot(bitmap, "android-runs-live-and-history.png")
    }

    @Test
    fun captureRunsEmptyState() {
        val bitmap = renderToBitmap {
            RunsScreen(
                runs = emptyList(),
                connectionStatus = ConnectionStatus.Connected("Nik’s Mac Studio", "http://192.168.1.100:52810"),
                projectName = "Foundry Core",
                projects = sampleProjects,
                selectedProjectId = "proj_foundry_core",
                onRunClick = {},
                onStartRunClick = {},
                onConnectionPillClick = {},
                onRetryConnection = {},
                onInspectorClick = {}
            )
        }
        saveScreenshot(bitmap, "android-runs-empty.png")
    }
}
