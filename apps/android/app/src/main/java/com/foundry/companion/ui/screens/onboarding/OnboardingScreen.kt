package com.foundry.companion.ui.screens.onboarding

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import com.foundry.companion.R
import com.foundry.companion.ui.components.FoundryPrimaryButton
import com.foundry.companion.ui.components.FoundrySecondaryButton
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.FoundryApplication
import kotlinx.coroutines.launch

private data class OnboardingPage(
    val eyebrow: String,
    val title: String,
    val body: String,
    val icon: @Composable (Color) -> Unit
)

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun OnboardingScreen(
    onFinished: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val pagerState = rememberPagerState(pageCount = { 4 })
    val notificationLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Record the prompt centrally so MainActivity does not duplicate it after pairing.
            (context as? com.foundry.companion.MainActivity)?.let {
                (it.application as FoundryApplication).sessionManager.setPromptedNotificationPermission(true)
            }
        }
    }
    val pages = listOf(
        OnboardingPage("WELCOME TO FOUNDRY", "Ideas in. Finished work out.", "Your desktop runs stay close at hand, without turning your phone into another dashboard.", {
            Image(
                painter = painterResource(R.drawable.foundry_cube),
                contentDescription = "Foundry logo",
                modifier = Modifier.size(88.dp)
            )
        }),
        OnboardingPage("STAY IN THE LOOP", "See what needs you.", "Watch runs move from accepted to complete, then step in when your attention is the only thing missing.", { color ->
            Icon(Icons.Outlined.QrCodeScanner, null, tint = color, modifier = Modifier.size(56.dp))
        }),
        OnboardingPage("OPTIONAL ALERTS", "Quiet when you want. Ready when it matters.", "Allow notifications to hear when a run settles. You can skip this and enable alerts later in system settings.", { color ->
            Icon(Icons.Outlined.NotificationsNone, null, tint = color, modifier = Modifier.size(56.dp))
        }),
        OnboardingPage("READY WHEN YOU ARE", "Pair once. Keep building.", "Connect Foundry to your Mac by scanning the QR code in Settings → Companion. Camera access is only requested when you choose to scan.", { color ->
            Icon(Icons.Outlined.QrCodeScanner, null, tint = color, modifier = Modifier.size(56.dp))
        })
    )

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bgBase)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .semantics { contentDescription = "Foundry onboarding" }
    ) {
        Column(
            modifier = Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End
            ) {
                TextButton(
                    onClick = onFinished,
                    modifier = Modifier.semantics {
                        contentDescription = "Skip onboarding"
                        role = Role.Button
                    }
                ) {
                    Text("SKIP", style = typography.labelMono, color = colors.textDim)
                }
            }
            HorizontalPager(
                state = pagerState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                userScrollEnabled = true
            ) { page ->
                val item = pages[page]
                Column(
                    modifier = Modifier.fillMaxSize().padding(horizontal = 4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center
                ) {
                    Box(
                        modifier = Modifier.size(128.dp).background(colors.bgRaised, MaterialTheme.shapes.large),
                        contentAlignment = Alignment.Center
                    ) {
                        item.icon(colors.accent)
                    }
                    Spacer(Modifier.height(36.dp))
                    Text(item.eyebrow, style = typography.eyebrowMono, color = colors.accent)
                    Spacer(Modifier.height(14.dp))
                    Text(
                        item.title,
                        style = typography.screenTitle.copy(fontSize = MaterialTheme.typography.headlineMedium.fontSize),
                        color = colors.textPrimary,
                        textAlign = TextAlign.Center
                    )
                    Spacer(Modifier.height(12.dp))
                    Text(item.body, style = typography.requestText, color = colors.textDim, textAlign = TextAlign.Center)
                    if (page == 2 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        Spacer(Modifier.height(20.dp))
                        FoundrySecondaryButton(
                            text = if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) "Alerts enabled" else "Enable alerts",
                            onClick = {
                                if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                                    notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                                }
                            },
                            modifier = Modifier.fillMaxWidth(0.78f)
                        )
                    }
                }
            }
            Row(
                modifier = Modifier.padding(bottom = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                repeat(pages.size) { index ->
                    Box(
                        modifier = Modifier.size(if (index == pagerState.currentPage) 24.dp else 6.dp, 6.dp)
                            .background(if (index == pagerState.currentPage) colors.accent else colors.lineStrong, MaterialTheme.shapes.small)
                            .semantics { contentDescription = "Onboarding page ${index + 1} of ${pages.size}" }
                    )
                }
            }
            val isLast = pagerState.currentPage == pages.lastIndex
            FoundryPrimaryButton(
                text = if (isLast) "Pair with Foundry" else "Next",
                onClick = {
                    if (isLast) onFinished() else scope.launch { pagerState.animateScrollToPage(pagerState.currentPage + 1) }
                },
                contentDescription = if (isLast) "Pair with Foundry" else "Next onboarding page"
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = if (isLast) "You can revisit onboarding from foundry://onboarding" else "Swipe or select Next to continue",
                style = typography.metaMono,
                color = colors.textFaint,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(bottom = 4.dp)
            )
        }
    }
}