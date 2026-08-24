package com.foundry.companion.ui.navigation

sealed class NavRoute(val route: String) {
    data object Pair : NavRoute("pair")
    data object Runs : NavRoute("runs")
    data object NewRun : NavRoute("new-run")
    data object Smith : NavRoute("smith")

    /**
     * `interrupt` is optional and only set by a notification tap: it names the
     * interrupt whose sheet should open on arrival, so the strip stays the
     * in-app entry point and the sheet is never raised on its own.
     */
    data object RunDetail : NavRoute("run/{runId}?interrupt={interruptId}") {
        fun createRoute(runId: String, interruptId: String? = null): String {
            return if (!interruptId.isNullOrBlank()) "run/$runId?interrupt=$interruptId"
            else "run/$runId"
        }
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
