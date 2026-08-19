package com.foundry.companion.ui.navigation

import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavController
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.session.SessionManager
import com.foundry.companion.ui.components.InterruptBottomSheet
import com.foundry.companion.ui.screens.connection.ConnectionBottomSheet
import com.foundry.companion.ui.screens.inspector.InspectorScreen
import com.foundry.companion.ui.screens.newrun.NewRunScreen
import com.foundry.companion.ui.screens.pair.PairScreen
import com.foundry.companion.ui.screens.run.RunDetailScreen
import com.foundry.companion.ui.screens.runs.RunsScreen
import com.foundry.companion.viewmodel.CompanionViewModel
import kotlinx.coroutines.flow.StateFlow

@Composable
fun FoundryNavHost(
    viewModel: CompanionViewModel,
    modifier: Modifier = Modifier,
    sessionManager: SessionManager? = null,
    deepLinkRoute: StateFlow<String?>? = null,
    navController: NavHostController = rememberNavController()
) {
    val context = LocalContext.current
    val uiState by viewModel.uiState.collectAsState()

    var showConnectionSheet by remember { mutableStateOf(false) }

    // Start destination based on whether paired
    val isPaired = uiState.activeSession != null
    val startDestination = if (isPaired) NavRoute.Runs.route else NavRoute.Pair.route

    // Save active route on destination change
    DisposableEffect(navController, sessionManager) {
        val listener = NavController.OnDestinationChangedListener { _, destination, arguments ->
            val route = destination.route ?: return@OnDestinationChangedListener
            val formattedRoute = when {
                route == NavRoute.RunDetail.route -> {
                    val runId = arguments?.getString("runId").orEmpty()
                    if (runId.isNotBlank()) "run/$runId" else "runs"
                }
                route == NavRoute.Inspector.route -> {
                    val runId = arguments?.getString("runId").orEmpty()
                    val phaseId = arguments?.getString("phaseId")
                    if (runId.isNotBlank()) {
                        if (phaseId != null) "run/$runId/inspector?phase=$phaseId" else "run/$runId/inspector"
                    } else "runs"
                }
                route == NavRoute.Pair.route -> "pair"
                route == NavRoute.NewRun.route -> "new-run"
                else -> "runs"
            }
            sessionManager?.setLastActiveRoute(formattedRoute)
        }
        navController.addOnDestinationChangedListener(listener)
        onDispose {
            navController.removeOnDestinationChangedListener(listener)
        }
    }

    // Restore last active route across app restart / process death if session is valid
    var hasRestoredLastRoute by remember { mutableStateOf(false) }
    LaunchedEffect(isPaired, hasRestoredLastRoute) {
        if (isPaired && !hasRestoredLastRoute) {
            hasRestoredLastRoute = true
            val lastRoute = sessionManager?.getLastActiveRoute()
            if (!lastRoute.isNullOrBlank() && lastRoute != "pair" && lastRoute != "runs") {
                try {
                    navController.navigate(lastRoute)
                } catch (_: Exception) {
                    // Fallback to default
                }
            }
        }
    }

    // Handle incoming deep link route (from push notifications / intents)
    val incomingDeepLink by (deepLinkRoute?.collectAsState() ?: remember { mutableStateOf<String?>(null) })
    LaunchedEffect(incomingDeepLink) {
        val route = incomingDeepLink
        if (!route.isNullOrBlank()) {
            try {
                navController.navigate(route)
            } catch (_: Exception) {
                // Ignore navigation failure
            }
        }
    }

    // React to pairing state changes
    LaunchedEffect(isPaired) {
        if (!isPaired && navController.currentDestination?.route != NavRoute.Pair.route) {
            navController.navigate(NavRoute.Pair.route) {
                popUpTo(0) { inclusive = true }
            }
        } else if (isPaired && navController.currentDestination?.route == NavRoute.Pair.route) {
            navController.navigate(NavRoute.Runs.route) {
                popUpTo(NavRoute.Pair.route) { inclusive = true }
            }
        }
    }

    NavHost(
        navController = navController,
        startDestination = startDestination,
        modifier = modifier
    ) {
        // 1. Pair Screen
        composable(NavRoute.Pair.route) {
            PairScreen(
                onPairSuccess = {
                    navController.navigate(NavRoute.Runs.route) {
                        popUpTo(NavRoute.Pair.route) { inclusive = true }
                    }
                },
                onPairScanned = { payload ->
                    viewModel.pair(payload)
                },
                errorMessage = uiState.errorMessage,
                isPairing = uiState.isPairing
            )
        }

        // 2. Home / Runs Screen
        composable(NavRoute.Runs.route) {
            val currentProject = uiState.projects.find { it.id == uiState.selectedProjectId }
            RunsScreen(
                runs = uiState.runs,
                connectionStatus = uiState.connectionStatus,
                projectName = currentProject?.name ?: "Foundry",
                projects = uiState.projects,
                selectedProjectId = uiState.selectedProjectId,
                onSelectProject = { viewModel.selectProject(it) },
                onRunClick = { runId ->
                    viewModel.loadRunDetail(runId)
                    navController.navigate(NavRoute.RunDetail.createRoute(runId))
                },
                onInspectorClick = { runId ->
                    navController.navigate(NavRoute.Inspector.createRoute(runId))
                },
                onStartRunClick = {
                    navController.navigate(NavRoute.NewRun.route)
                },
                onConnectionPillClick = {
                    showConnectionSheet = true
                },
                onRetryConnection = {
                    viewModel.retryConnection()
                },
                onOpenPr = { url ->
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    context.startActivity(intent)
                }
            )
        }

        // 3. New Run Screen
        composable(NavRoute.NewRun.route) {
            NewRunScreen(
                projects = uiState.projects,
                selectedProjectId = uiState.selectedProjectId,
                lastUsedPipelineId = viewModel.getLastUsedPipeline(uiState.selectedProjectId),
                onProjectSelect = { viewModel.selectProject(it) },
                onPipelineSelect = { projId, pipeId ->
                    viewModel.setLastUsedPipeline(projId, pipeId)
                },
                onDismiss = {
                    viewModel.clearValidationIssues()
                    navController.popBackStack()
                },
                onRetryConnection = { viewModel.retryConnection() },
                onStartRun = { projectId, pipelineId, request ->
                    viewModel.startRun(projectId, pipelineId, request) { newRunId ->
                        viewModel.loadRunDetail(newRunId)
                        navController.navigate(NavRoute.RunDetail.createRoute(newRunId)) {
                            popUpTo(NavRoute.Runs.route)
                        }
                    }
                },
                connectionStatus = uiState.connectionStatus,
                isStarting = uiState.isStartingRun,
                validationIssues = uiState.validationIssues
            )
        }

        // 4. Run Detail Screen
        composable(
            route = NavRoute.RunDetail.route,
            arguments = listOf(navArgument("runId") { type = NavType.StringType })
        ) { backStackEntry ->
            val runId = backStackEntry.arguments?.getString("runId").orEmpty()
            LaunchedEffect(runId) {
                viewModel.loadRunDetail(runId)
            }

            val matchingInterrupt = uiState.pendingInterrupts.find { it.runId == runId || it.runId.isBlank() }

            RunDetailScreen(
                runDetail = uiState.currentRunDetail,
                isRunMissing = uiState.missingRunId == runId,
                connectionStatus = uiState.connectionStatus,
                pendingInterrupt = matchingInterrupt,
                actionError = uiState.errorMessage,
                onDismissActionError = { viewModel.clearActionError() },
                ghStatus = uiState.ghStatus,
                isCreatingPr = uiState.isCreatingPr,
                onBackClick = { navController.popBackStack() },
                onOpenInspector = { phaseId ->
                    navController.navigate(NavRoute.Inspector.createRoute(runId, phaseId))
                },
                onKillRun = { viewModel.killRun(it) },
                onAnswerInterrupt = { interruptId, approved, notes ->
                    viewModel.answerInterrupt(interruptId, approved, notes)
                },
                onRetryConnection = { viewModel.retryConnection() },
                onOpenPr = { url ->
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    context.startActivity(intent)
                },
                onCreatePr = { viewModel.createPr(it) },
                onOpenIssue = { url ->
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    context.startActivity(intent)
                }
            )
        }

        // 5. Inspector Screen
        composable(
            route = NavRoute.Inspector.route,
            arguments = listOf(
                navArgument("runId") { type = NavType.StringType },
                navArgument("phaseId") {
                    type = NavType.StringType
                    nullable = true
                    defaultValue = null
                }
            )
        ) { backStackEntry ->
            val runId = backStackEntry.arguments?.getString("runId").orEmpty()
            val phaseId = backStackEntry.arguments?.getString("phaseId")

            LaunchedEffect(runId) {
                viewModel.loadRunDetail(runId)
                viewModel.loadTranscriptEvents(runId)
            }

            InspectorScreen(
                runDetail = uiState.currentRunDetail,
                events = uiState.eventRows,
                initialPhaseId = phaseId,
                connectionStatus = uiState.connectionStatus,
                hasProject = uiState.selectedProjectId.isNotBlank() && uiState.projects.isNotEmpty(),
                onBackClick = { navController.popBackStack() },
                onPhaseSelected = { },
                onRetryConnection = { viewModel.retryConnection() }
            )
        }
    }

    // 6. Connection Bottom Sheet Overlay
    if (showConnectionSheet) {
        ConnectionBottomSheet(
            session = uiState.activeSession,
            sessionInfo = uiState.sessionInfo,
            connectionStatus = uiState.connectionStatus,
            projects = uiState.projects,
            selectedProjectId = uiState.selectedProjectId,
            onSelectProject = { viewModel.selectProject(it) },
            isNotifyOnSettleEnabled = uiState.isNotifyOnSettleEnabled,
            onToggleNotifyOnSettle = { viewModel.toggleNotifyOnSettle(it) },
            onUnpair = { viewModel.unpair() },
            onDismiss = { showConnectionSheet = false }
        )
    }

    // 7. Engineer Interrupt Sheet Overlay (if active)
    val activeInterrupt = uiState.pendingInterrupts.firstOrNull()
    if (activeInterrupt != null) {
        InterruptBottomSheet(
            interrupt = activeInterrupt,
            onApprove = { notes ->
                viewModel.answerInterrupt(activeInterrupt.interruptId, approved = true, notes = notes)
            },
            onReject = { notes ->
                viewModel.answerInterrupt(activeInterrupt.interruptId, approved = false, notes = notes)
            },
            onDismiss = { /* Non-dismissible without explicit answer */ }
        )
    }
}

