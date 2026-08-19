package com.foundry.companion.ui.navigation

sealed class NavRoute(val route: String) {
    data object Pair : NavRoute("pair")
    data object Runs : NavRoute("runs")
    data object NewRun : NavRoute("new-run")

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
