package com.foundry.companion.ui.navigation

sealed class NavRoute(val route: String) {
    data object Pair : NavRoute("pair")
    data object Runs : NavRoute("runs")
    data object NewRun : NavRoute("new-run")
    data object Smith : NavRoute("smith")

    data object RunDetail : NavRoute("run/{runId}") {
        fun createRoute(runId: String): String = "run/$runId"
    }

    data object Inspector : NavRoute("run/{runId}/inspector?phase={phaseId}") {
        fun createRoute(runId: String, phaseId: String? = null): String {
            return if (phaseId != null) "run/$runId/inspector?phase=$phaseId"
            else "run/$runId/inspector"
        }
    }
}

/**
 * A notification tap on a killed process lands the operator on Run with nothing
 * beneath it, so Back would leave the app. Home is pushed underneath first
 * whenever the stack does not already carry one.
 */
fun needsSynthesizedHome(backStackRoutes: List<String>): Boolean =
    NavRoute.Runs.route !in backStackRoutes
