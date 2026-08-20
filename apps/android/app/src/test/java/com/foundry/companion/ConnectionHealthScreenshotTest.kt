package com.foundry.companion

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.*
import com.foundry.companion.ui.components.ReconnectBanner
import com.foundry.companion.ui.screens.connection.ConnectionBottomSheet
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
class ConnectionHealthScreenshotTest {

    private val sampleSession = PairedSession(
        token = "test_token_123",
        desktopId = "desk_01",
        desktopName = "Nik’s Mac Studio",
        hostOrigin = "http://192.168.1.100:52810",
        pairedAt = "2026-08-18T20:00:00Z",
        protocolVersion = 1
    )

    private val sampleSessionInfo = CompanionSessionInfo(
        desktopId = "desk_01",
        desktopName = "Nik’s Mac Studio",
        protocolVersion = 1,
        appVersion = "0.1.1"
    )

    private val sampleProjects = listOf(
        CompanionProjectSummary("proj_foundry_core", "Foundry", emptyList()),
        CompanionProjectSummary("proj_foundry_docs", "Foundry Documentation", emptyList())
    )

    private fun renderToBitmap(
        width: Int = 1080,
        height: Int = 2400,
        content: @androidx.compose.runtime.Composable () -> Unit
    ): Bitmap {
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
            View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY)
        )
        composeView.layout(0, 0, width, height)

        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
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
    fun captureConnectionSheet() {
        val bitmap = renderToBitmap {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(FoundryTheme.colors.bgBase)
            ) {
                ConnectionBottomSheet(
                    session = sampleSession,
                    sessionInfo = sampleSessionInfo,
                    connectionStatus = ConnectionStatus.Connected("Nik’s Mac Studio", "http://192.168.1.100:52810"),
                    projects = sampleProjects,
                    selectedProjectId = "proj_foundry_core",
                    onSelectProject = {},
                    isNotifyOnSettleEnabled = true,
                    onToggleNotifyOnSettle = {},
                    onUnpair = {},
                    onDismiss = {}
                )
            }
        }
        saveScreenshot(bitmap, "android-connection-sheet.png")
    }

    @Test
    fun captureReconnectBanner() {
        val bitmap = renderToBitmap {
            RunsScreen(
                runs = emptyList(),
                connectionStatus = ConnectionStatus.Reconnecting("Nik’s Mac Studio", "http://192.168.1.100:52810"),
                projectName = "Foundry",
                onRunClick = {},
                onStartRunClick = {},
                onConnectionPillClick = {},
                onRetryConnection = {},
                onInspectorClick = {}
            )
        }
        saveScreenshot(bitmap, "android-reconnect-banner.png")
    }
}
