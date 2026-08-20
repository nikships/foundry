package com.foundry.companion

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalInspectionMode
import com.foundry.companion.data.model.*
import com.foundry.companion.ui.screens.newrun.NewRunScreen
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
class NewRunScreenScreenshotTest {

    private val samplePipelines = listOf(
        PipelineSummary(
            id = "pipe_default",
            name = "Feature Pipeline",
            description = "Standard 5-phase feature development workflow with review gate.",
            phases = listOf(
                PhaseTemplateSummary("p1", "Plan", "agent"),
                PhaseTemplateSummary("p2", "Spec", "agent"),
                PhaseTemplateSummary("p3", "Code", "code"),
                PhaseTemplateSummary("p4", "Review", "review", isFeedbackTarget = true),
                PhaseTemplateSummary("p5", "PR", "agent")
            )
        ),
        PipelineSummary(
            id = "pipe_bugfix",
            name = "Bugfix & Verify",
            description = "Fast turnaround pipeline for isolated regression repairs.",
            phases = listOf(
                PhaseTemplateSummary("b1", "Triage", "agent"),
                PhaseTemplateSummary("b2", "Patch", "code"),
                PhaseTemplateSummary("b3", "Verify", "agent")
            )
        )
    )

    private val sampleProjects = listOf(
        CompanionProjectSummary("proj_foundry_core", "Foundry Core", samplePipelines),
        CompanionProjectSummary("proj_foundry_docs", "Foundry Docs", samplePipelines)
    )

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

    @Test
    fun captureNewRunComposer() {
        val bitmap = renderToBitmap {
            NewRunScreen(
                projects = sampleProjects,
                selectedProjectId = "proj_foundry_core",
                onProjectSelect = {},
                onDismiss = {},
                onStartRun = { _, _, _ -> },
                connectionStatus = ConnectionStatus.Connected("Nik’s Mac Studio", "http://192.168.1.100:52810")
            )
        }
        saveScreenshot(bitmap, "android-new-run-composer.png")
    }

    @Test
    fun captureNewRunWithValidationIssues() {
        val bitmap = renderToBitmap {
            NewRunScreen(
                projects = sampleProjects,
                selectedProjectId = "proj_foundry_core",
                onProjectSelect = {},
                onDismiss = {},
                onStartRun = { _, _, _ -> },
                connectionStatus = ConnectionStatus.Connected("Nik’s Mac Studio", "http://192.168.1.100:52810"),
                validationIssues = listOf(
                    ValidationIssue("error", "Project command 'test' is not configured on your Mac."),
                    ValidationIssue("warning", "Agent 'reviewer' is using fallback reasoning effort.")
                )
            )
        }
        saveScreenshot(bitmap, "android-new-run-validation-issues.png")
    }
}
