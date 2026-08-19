package com.foundry.companion

import com.foundry.companion.ui.navigation.NavRoute
import org.junit.Assert.assertEquals
import org.junit.Test

class NavRoutesTest {

    @Test
    fun testRouteTemplates() {
        assertEquals("pair", NavRoute.Pair.route)
        assertEquals("runs", NavRoute.Runs.route)
        assertEquals("new-run", NavRoute.NewRun.route)
        assertEquals("run/{runId}", NavRoute.RunDetail.route)
        assertEquals("run/{runId}/inspector?phase={phaseId}", NavRoute.Inspector.route)
    }

    @Test
    fun testRouteBuilders() {
        assertEquals("run/run_123", NavRoute.RunDetail.createRoute("run_123"))
        assertEquals("run/run_123/inspector", NavRoute.Inspector.createRoute("run_123"))
        assertEquals("run/run_123/inspector?phase=phase_code", NavRoute.Inspector.createRoute("run_123", "phase_code"))
    }
}
