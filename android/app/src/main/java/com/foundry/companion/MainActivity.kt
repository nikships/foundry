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
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.viewmodel.CompanionViewModel
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {

    private val app by lazy { application as FoundryApplication }
    private val viewModel: CompanionViewModel by viewModels {
        CompanionViewModel.provideFactory(app.repository, app.sessionManager, app.notificationManager)
    }

    private val deepLinkRoute = MutableStateFlow<String?>(null)

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ ->
        app.sessionManager.setPromptedNotificationPermission(true)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !app.sessionManager.hasPromptedNotificationPermission()) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                app.sessionManager.setPromptedNotificationPermission(true)
            }
        }

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
                    deepLinkRoute = deepLinkRoute
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        if (intent == null) return
        val data = intent.data
        if (data != null && data.scheme == "foundry" && data.host == "run") {
            val deepRunId = data.pathSegments.firstOrNull()
            if (!deepRunId.isNullOrBlank()) {
                viewModel.loadRunDetail(deepRunId)
                deepLinkRoute.value = "run/$deepRunId"
                return
            }
        }

        val extraRunId = intent.getStringExtra("runId")
        if (!extraRunId.isNullOrBlank()) {
            viewModel.loadRunDetail(extraRunId)
            deepLinkRoute.value = "run/$extraRunId"
        }
    }
}

