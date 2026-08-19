package com.foundry.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.foundry.companion.data.model.COMPANION_PROTOCOL_VERSION
import com.foundry.companion.data.model.PairedSession
import com.foundry.companion.ui.navigation.FoundryNavHost
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.viewmodel.CompanionViewModel

class MainActivity : ComponentActivity() {

    private val app by lazy { application as FoundryApplication }
    private val viewModel: CompanionViewModel by viewModels {
        CompanionViewModel.provideFactory(app.repository, app.sessionManager)
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

        // Handle deep links: e.g. foundry://run/<runId>
        val data = intent?.data
        if (data != null && data.scheme == "foundry" && data.host == "run") {
            val deepRunId = data.pathSegments.firstOrNull()
            if (!deepRunId.isNullOrBlank()) {
                viewModel.loadRunDetail(deepRunId)
            }
        }

        setContent {
            FoundryTheme {
                FoundryNavHost(viewModel = viewModel)
            }
        }
    }
}
