package com.foundry.companion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import com.foundry.companion.data.model.COMPANION_PROTOCOL_VERSION
import com.foundry.companion.data.model.PairedSession
import com.foundry.companion.ui.navigation.FoundryNavHost
import com.foundry.companion.ui.navigation.resolveDeepLink
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.viewmodel.CompanionViewModel
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {

    private val app by lazy { application as FoundryApplication }
    private val viewModel: CompanionViewModel by viewModels {
        CompanionViewModel.provideFactory(app.repository, app.sessionManager, app.notifier)
    }

    /**
     * Held rather than emitted, because a cold start resolves the link in
     * `onCreate` — before the nav host exists to receive it. A hot-buffered
     * emission would be dropped and the tap would land on Home.
     */
    private val pendingDeepLinkRoute = MutableStateFlow<String?>(null)
    private var notificationPromptInFlight = false

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ ->
        // Asked once, recorded whatever the answer was: a denied prompt must not
        // come back on every launch.
        notificationPromptInFlight = false
        app.sessionManager.setPromptedNotificationPermission(true)
        app.startWatchIfAllowed()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        if (intent?.getBooleanExtra("inject_fake_session", false) == true) {
            val fake = PairedSession(
                token = "fake_companion_bearer_token_12345",
                desktopId = "desk_macbook_pro_m3",
                desktopName = "Nik’s Mac Studio",
                hostOrigin = "http://192.168.1.100:52810",
                pairedAt = "2026-08-18T20:00:00Z",
                protocolVersion = COMPANION_PROTOCOL_VERSION
            )
            app.sessionManager.saveSession(fake)
            app.repository.injectFakeSession(fake)
        }

        handleDeepLink(intent)

        setContent {
            FoundryTheme {
                FoundryNavHost(
                    viewModel = viewModel,
                    sessionManager = app.sessionManager,
                    deepLinkRoute = pendingDeepLinkRoute,
                    onDeepLinkHandled = { pendingDeepLinkRoute.value = null }
                )
            }
        }
    }

    override fun onStart() {
        super.onStart()
        // A foreground start is always allowed, so this is the reliable moment to
        // (re)claim the watcher after a permission grant or a system-killed service.
        requestNotificationPermissionIfNeeded()
        app.startWatchIfAllowed()
    }

    /**
     * Notifications are an after-pair concern. Asking on a fresh launch covers
     * the viewfinder and can drop the camera prompt.
     */
    fun requestNotificationPermissionIfNeeded() {
        if (notificationPromptInFlight) return
        if (app.sessionManager.getSession() == null) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            app.startWatchIfAllowed()
            return
        }
        if (app.sessionManager.hasPromptedNotificationPermission()) {
            app.startWatchIfAllowed()
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            app.sessionManager.setPromptedNotificationPermission(true)
            app.startWatchIfAllowed()
            return
        }
        notificationPromptInFlight = true
        notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        if (intent == null) return

        val data = intent.data?.takeIf { it.scheme == "foundry" && it.host == "run" }
        val target = resolveDeepLink(
            uriRunId = data?.pathSegments?.firstOrNull(),
            extraRunId = intent.getStringExtra("runId"),
            uriProjectId = data?.getQueryParameter("project"),
            extraProjectId = intent.getStringExtra("projectId")
        ) ?: return

        val projectId = target.projectId
        if (!projectId.isNullOrBlank()) {
            viewModel.selectProject(projectId)
        }
        viewModel.loadRunDetail(target.runId)
        pendingDeepLinkRoute.value = target.route
    }
}
