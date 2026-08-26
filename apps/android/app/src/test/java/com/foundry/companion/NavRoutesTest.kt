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
        assertEquals("run/{runId}", NavRoute.RunDetail.route)
        assertEquals("run/{runId}/inspector?phase={phaseId}", NavRoute.Inspector.route)
    }

    @Test
    fun testRouteBuilders() {
        assertEquals("run/run_123", NavRoute.RunDetail.createRoute("run_123"))
        assertEquals("run/run_123/inspector", NavRoute.Inspector.createRoute("run_123"))
        assertEquals("run/run_123/inspector?phase=phase_code", NavRoute.Inspector.createRoute("run_123", "phase_code"))
    }

    @Test
    fun testNotificationExtrasResolveToTheRunRoute() {
        val fromExtras = resolveDeepLink(
            uriRunId = null,
            extraRunId = "run_123"
        )
        assertEquals("run_123", fromExtras?.runId)
        assertEquals("run/run_123", fromExtras?.route)
    }

    @Test
    fun testDeepLinkUriResolvesToTheRunRoute() {
        val fromUri = resolveDeepLink(
            uriRunId = "run_123",
            extraRunId = null
        )
        assertEquals("run/run_123", fromUri?.route)

        val settled = resolveDeepLink(
            uriRunId = "run_123",
            extraRunId = "run_123"
        )
        assertEquals("run/run_123", settled?.route)
    }

    @Test
    fun testNotificationExtrasWinOverUriRunId() {
        val mixed = resolveDeepLink(
            uriRunId = "run_stale",
            extraRunId = "run_123"
        )
        assertEquals("run_123", mixed?.runId)
    }

    @Test
    fun testDeepLinkWithoutARunIsIgnored() {
        assertNull(resolveDeepLink(null, null))
        assertNull(resolveDeepLink("", ""))
    }

    @Test
    fun testDeepLinkCarriesTheProjectSoAColdStartDoesNotGuess() {
        val fromExtras = resolveDeepLink(
            uriRunId = "run_123",
            extraRunId = "run_123",
            extraProjectId = "proj_foundry_core"
        )
        assertEquals("proj_foundry_core", fromExtras?.projectId)

        val fromUri = resolveDeepLink(
            uriRunId = "run_123",
            extraRunId = null,
            uriProjectId = "proj_from_uri"
        )
        assertEquals("proj_from_uri", fromUri?.projectId)

        val none = resolveDeepLink("run_123", "run_123")
        assertNull(none?.projectId)
    }

    @Test
    fun testKilledProcessDeepLinkGetsHomeSynthesizedUnderTheRun() {
        assertTrue(needsSynthesizedHome(emptyList()))
        assertTrue(needsSynthesizedHome(listOf(NavRoute.Pair.route)))
        assertFalse(needsSynthesizedHome(listOf(NavRoute.Runs.route)))
        assertFalse(needsSynthesizedHome(listOf(NavRoute.Runs.route, NavRoute.RunDetail.route)))
    }
}
