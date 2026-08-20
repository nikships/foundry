package com.foundry.companion.ui.navigation

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
import com.foundry.companion.ui.components.LocalOpenConnectionSheet
import com.foundry.companion.ui.screens.connection.ConnectionBottomSheet
import com.foundry.companion.ui.screens.inspector.InspectorScreen
import com.foundry.companion.ui.screens.newrun.NewRunScreen
import com.foundry.companion.ui.screens.pair.PairScreen
import com.foundry.companion.ui.screens.run.RunDetailScreen
import com.foundry.companion.ui.screens.runs.RunsScreen
import com.foundry.companion.util.CompanionHaptics
import com.foundry.companion.util.CustomTabs
import com.foundry.companion.viewmodel.CompanionViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

@Composable
fun FoundryNavHost(
    viewModel: CompanionViewModel,
    modifier: Modifier = Modifier,
    sessionManager: SessionManager? = null,
    /**
     * Held state rather than an event stream: a notification tap on a killed
     * process resolves the route before this composition exists, and a hot
     * emission at that moment lands on nobody.
     */
    deepLinkRoute: StateFlow<String?>? = null,
    onDeepLinkHandled: () -> Unit = {},
    navController: NavHostController = rememberNavController()
) {
    val context = LocalContext.current
    val uiState by viewModel.uiState.collectAsState()

    var showConnectionSheet by remember { mutableStateOf(false) }

    LaunchedEffect(viewModel) {
        viewModel.hapticEvents.collect { CompanionHaptics.perform(context) }
    }

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

    val pendingDeepLink by remember(deepLinkRoute) { deepLinkRoute ?: MutableStateFlow(null) }
        .collectAsState()

    // Restore last active route across app restart / process death if session is valid
    var hasRestoredLastRoute by remember { mutableStateOf(false) }
    LaunchedEffect(isPaired, hasRestoredLastRoute, pendingDeepLink) {
        // A notification tap names the destination outright, so restoring the
        // route the operator happened to leave open would only fight it.
        if (pendingDeepLink != null) {
            hasRestoredLastRoute = true
            return@LaunchedEffect
        }
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

    // Handle incoming deep link route (from notifications / intents). Home is
    // popped to rather than stacked on, so Back from a notification tap lands on
    // Home instead of walking a pile of previously opened runs — and when the
    // process was killed there is no Home to pop to, so one is pushed first.
    LaunchedEffect(pendingDeepLink, isPaired) {
        val route = pendingDeepLink?.takeIf { it.isNotBlank() } ?: return@LaunchedEffect
        if (!isPaired) return@LaunchedEffect
        try {
            val stackRoutes = navController.currentBackStack.value.mapNotNull { it.destination.route }
            if (needsSynthesizedHome(stackRoutes)) {
                navController.navigate(NavRoute.Runs.route) {
                    popUpTo(0) { inclusive = true }
                }
            }
            navController.navigate(route) {
                popUpTo(NavRoute.Runs.route)
                launchSingleTop = true
            }
        } catch (_: Exception) {
            // Ignore navigation failure
        }
        onDeepLinkHandled()
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

    CompositionLocalProvider(LocalOpenConnectionSheet provides { showConnectionSheet = true }) {
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
                onOpenPr = { url -> CustomTabs.open(context, url) }
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
                    viewModel.clearNewRunDraft()
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
                validationIssues = uiState.validationIssues,
                initialRequestText = viewModel.getNewRunDraft(),
                onRequestChange = { viewModel.setNewRunDraft(it) }
            )
        }

        // 4. Run Detail Screen
        composable(
            route = NavRoute.RunDetail.route,
            arguments = listOf(
                navArgument("runId") { type = NavType.StringType },
                navArgument("interruptId") {
                    type = NavType.StringType
                    nullable = true
                    defaultValue = null
                }
            )
        ) { backStackEntry ->
            val runId = backStackEntry.arguments?.getString("runId").orEmpty()
            val requestedInterruptId = backStackEntry.arguments?.getString("interruptId")
            LaunchedEffect(runId) {
                viewModel.loadRunDetail(runId)
            }

            val matchingInterrupt = uiState.interruptForRun(runId)

            RunDetailScreen(
                initialInterruptId = requestedInterruptId,
                runDetail = uiState.currentRunDetail?.takeIf { it.run.runId == runId },
                isRunMissing = uiState.missingRunId == runId,
                events = uiState.eventRows,
                connectionStatus = uiState.connectionStatus,
                pendingInterrupt = matchingInterrupt,
                actionError = uiState.errorMessage,
                onDismissActionError = { viewModel.clearActionError() },
                ghStatus = uiState.ghStatus,
                isContinuingRun = uiState.isContinuingRun,
                isCreatingPr = uiState.isCreatingPr,
                onBackClick = { navController.popBackStack() },
                onOpenInspector = { phaseId ->
                    navController.navigate(NavRoute.Inspector.createRoute(runId, phaseId))
                },
                onKillRun = { viewModel.killRun(it) },
                onContinueRun = { viewModel.continueRun(it) },
                onAnswerInterrupt = { interruptId, approved, notes ->
                    viewModel.answerInterrupt(interruptId, approved, notes)
                },
                onRetryConnection = { viewModel.retryConnection() },
                onOpenPr = { url -> CustomTabs.open(context, url) },
                onCreatePr = { viewModel.createPr(it) },
                onOpenIssue = { url -> CustomTabs.open(context, url) },
                prDraftTitle = uiState.prDraft
                    ?.takeIf { uiState.prDraftRunId == runId }
                    ?.title
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
                runDetail = uiState.currentRunDetail?.takeIf { it.run.runId == runId },
                isRunMissing = uiState.missingRunId == runId,
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

    // An interrupt never raises a sheet on its own: Home shows the run's amber
    // `waiting` chip and the Run screen pins the strip with `Answer…` (spec §3.7).
}
