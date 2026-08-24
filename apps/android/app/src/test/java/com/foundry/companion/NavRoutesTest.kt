package com.foundry.companion

import com.foundry.companion.ui.navigation.NavRoute
import com.foundry.companion.ui.navigation.needsSynthesizedHome
import com.foundry.companion.ui.navigation.resolveDeepLink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NavRoutesTest {

    @Test
    fun testRouteTemplates() {
        assertEquals("pair", NavRoute.Pair.route)
        assertEquals("runs", NavRoute.Runs.route)
        assertEquals("new-run", NavRoute.NewRun.route)
        assertEquals("smith", NavRoute.Smith.route)
        assertEquals("run/{runId}?interrupt={interruptId}", NavRoute.RunDetail.route)
        assertEquals("run/{runId}/inspector?phase={phaseId}", NavRoute.Inspector.route)
    }

    @Test
    fun testRouteBuilders() {
        assertEquals("run/run_123", NavRoute.RunDetail.createRoute("run_123"))
        assertEquals("run/run_123", NavRoute.RunDetail.createRoute("run_123", ""))
        assertEquals("run/run_123?interrupt=int_9", NavRoute.RunDetail.createRoute("run_123", "int_9"))
        assertEquals("run/run_123/inspector", NavRoute.Inspector.createRoute("run_123"))
        assertEquals("run/run_123/inspector?phase=phase_code", NavRoute.Inspector.createRoute("run_123", "phase_code"))
    }

    @Test
    fun testInterruptNotificationExtrasResolveToTheInterruptRoute() {
        // The interrupt notification sets both extras; the extra was previously
        // dropped and the tap landed on the run with no sheet.
        val fromExtras = resolveDeepLink(
            uriRunId = null,
            uriInterruptId = null,
            extraRunId = "run_123",
            extraInterruptId = "int_9"
        )
        assertEquals("run_123", fromExtras?.runId)
        assertEquals("int_9", fromExtras?.interruptId)
        assertEquals("run/run_123?interrupt=int_9", fromExtras?.route)
    }

    @Test
    fun testDeepLinkUriCarriesInterruptQueryAndSettledRunHasNone() {
        val fromUri = resolveDeepLink(
            uriRunId = "run_123",
            uriInterruptId = "int_9",
            extraRunId = null,
            extraInterruptId = null
        )
        assertEquals("run/run_123?interrupt=int_9", fromUri?.route)

        // A settled-run notification names no interrupt, so no sheet is asked for.
        val settled = resolveDeepLink(
            uriRunId = "run_123",
            uriInterruptId = null,
            extraRunId = "run_123",
            extraInterruptId = null
        )
        assertNull(settled?.interruptId)
        assertEquals("run/run_123", settled?.route)
    }

    @Test
    fun testNotificationExtrasWinOverUriRunId() {
        val mixed = resolveDeepLink(
            uriRunId = "run_stale",
            uriInterruptId = null,
            extraRunId = "run_123",
            extraInterruptId = "int_9"
        )
        assertEquals("run_123", mixed?.runId)
        assertEquals("int_9", mixed?.interruptId)
    }

    @Test
    fun testDeepLinkWithoutARunIsIgnored() {
        assertNull(resolveDeepLink(null, "int_9", null, "int_9"))
        assertNull(resolveDeepLink("", null, "", null))
    }

    @Test
    fun testDeepLinkCarriesTheProjectSoAColdStartDoesNotGuess() {
        val fromExtras = resolveDeepLink(
            uriRunId = "run_123",
            uriInterruptId = null,
            extraRunId = "run_123",
            extraInterruptId = null,
            extraProjectId = "proj_foundry_core"
        )
        assertEquals("proj_foundry_core", fromExtras?.projectId)

        val fromUri = resolveDeepLink(
            uriRunId = "run_123",
            uriInterruptId = null,
            extraRunId = null,
            extraInterruptId = null,
            uriProjectId = "proj_from_uri"
        )
        assertEquals("proj_from_uri", fromUri?.projectId)

        // A background notifier that never saw the run's project simply omits it.
        val none = resolveDeepLink("run_123", null, "run_123", null)
        assertNull(none?.projectId)
    }

    @Test
    fun testKilledProcessDeepLinkGetsHomeSynthesizedUnderTheRun() {
        // Cold start from a notification: nothing on the stack, so Back off the
        // run would leave the app unless Home is pushed first.
        assertTrue(needsSynthesizedHome(emptyList()))
        assertTrue(needsSynthesizedHome(listOf(NavRoute.Pair.route)))

        // Warm app already showing Home (or a run above it) needs no synthesis.
        assertFalse(needsSynthesizedHome(listOf(NavRoute.Runs.route)))
        assertFalse(needsSynthesizedHome(listOf(NavRoute.Runs.route, NavRoute.RunDetail.route)))
    }
}
