package com.foundry.companion

import com.foundry.companion.data.model.CompanionPairingPayload
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.PairedSession
import com.foundry.companion.data.repository.HttpCompanionRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class OriginFailoverTest {
    private val lan = "http://192.168.1.22:52810"
    private val tail = "http://100.88.1.22:52810"
    private val pairBody = """{"token":"paired-token","deviceId":"phone","desktopId":"mac","desktopName":"Mac","protocolVersion":6}"""

    private fun client(respond: (Request) -> Pair<Int, String>) = OkHttpClient.Builder()
        .addInterceptor { chain ->
            val (code, body) = respond(chain.request())
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(code).message("Test response").body(body.toResponseBody()).build()
        }.build()

    private fun session(origins: List<String>) = PairedSession(
        token = "paired-token", desktopId = "mac", desktopName = "Mac",
        hostOrigin = lan, pairedAt = "2026-09-12T00:00:00Z", origins = origins
    )

    @Test
    fun pairingFallsBackOnTransportFailureAndPersistsNormalizedOrigins() = runTest {
        val attempts = mutableListOf<String>()
        val repo = HttpCompanionRepository(client = client { request ->
            attempts += request.url.toString()
            if (request.url.host == "192.168.1.22") throw IOException("Unreachable LAN")
            200 to pairBody
        }, coroutineScope = backgroundScope)
        val result = repo.pair(CompanionPairingPayload(
            origin = lan, secret = "single-use", origins = listOf(" $lan/ ", "", tail, "$tail/")
        ), "Phone")
        assertTrue(result.isSuccess)
        assertEquals(listOf("$lan/pair", "$tail/pair"), attempts)
        val paired = repo.activeSession.value!!
        assertEquals(tail, paired.hostOrigin)
        assertEquals(listOf(lan, tail), paired.origins)
        val saved = Json.encodeToString(PairedSession.serializer(), paired)
        assertEquals(paired, Json.decodeFromString(PairedSession.serializer(), saved))
    }

    @Test
    fun legacyV6PayloadAndSessionStillDecodeAndPair() = runTest {
        val payload = Json.decodeFromString(CompanionPairingPayload.serializer(),
            """{"protocolVersion":6,"origin":"$lan","secret":"single-use"}""")
        assertTrue(payload.origins.isEmpty())
        val repo = HttpCompanionRepository(client = client { 200 to pairBody }, coroutineScope = backgroundScope)
        assertTrue(repo.pair(payload, "Phone").isSuccess)
        assertEquals(lan, repo.activeSession.value?.hostOrigin)
        val legacy = Json.decodeFromString(PairedSession.serializer(),
            """{"token":"t","desktopId":"mac","desktopName":"Mac","hostOrigin":"$lan","pairedAt":"today"}""")
        assertTrue(legacy.origins.isEmpty())
    }

    @Test
    fun reachablePairingRejectionsNeverTryAnotherOrigin() = runTest {
        for (status in listOf(401, 409, 500)) {
            val attempts = mutableListOf<String>()
            val repo = HttpCompanionRepository(client = client { request ->
                attempts += request.url.toString()
                status to "rejected"
            }, coroutineScope = backgroundScope)
            assertTrue(repo.pair(CompanionPairingPayload(
                origin = lan, secret = "single-use", origins = listOf(lan, tail)
            ), "Phone").isFailure)
            assertEquals(listOf("$lan/pair"), attempts)
            assertNull(repo.activeSession.value)
        }
    }

    @Test
    fun reconnectPromotesReachableAlternateAndKeepsFallbacksAndToken() = runTest {
        val unavailable = "http://100.88.1.23:52810"
        val attempts = mutableListOf<String>()
        val repo = HttpCompanionRepository(client = client { request ->
            attempts += request.url.toString()
            assertEquals("Bearer paired-token", request.header("Authorization"))
            when (request.url.host) {
                "192.168.1.22" -> throw IOException("Unreachable LAN")
                "100.88.1.23" -> 503 to "unavailable"
                else -> 200 to "{}"
            }
        }, coroutineScope = backgroundScope)
        val original = session(listOf(lan, unavailable, tail))
        repo.injectFakeSession(original)
        assertTrue(repo.getProjects().isFailure)
        runCurrent()
        advanceTimeBy(1000)
        runCurrent()
        assertEquals(listOf("$lan/v1/projects", "$lan/v1/session", "$unavailable/v1/session", "$tail/v1/session"), attempts)
        val promoted = repo.activeSession.value!!
        assertEquals(original.copy(hostOrigin = tail), promoted)
        assertEquals(ConnectionStatus.Connected("Mac", tail), repo.connectionStatus.value)
        assertEquals(promoted, Json.decodeFromString(PairedSession.serializer(), Json.encodeToString(PairedSession.serializer(), promoted)))
    }

    @Test
    fun alternateRevocationUnpairsWithoutProbingFurtherOrigins() = runTest {
        val attempts = mutableListOf<String>()
        val repo = HttpCompanionRepository(client = client { request ->
            attempts += request.url.toString()
            if (request.url.host == "192.168.1.22") throw IOException("Unreachable LAN")
            401 to "revoked"
        }, coroutineScope = backgroundScope)
        repo.injectFakeSession(session(listOf(lan, tail, "http://100.88.1.23:52810")))
        repo.getProjects()
        runCurrent()
        advanceTimeBy(1000)
        runCurrent()
        assertNull(repo.activeSession.value)
        assertEquals(ConnectionStatus.Unpaired, repo.connectionStatus.value)
        assertEquals(listOf("$lan/v1/projects", "$lan/v1/session", "$tail/v1/session"), attempts)
    }

    @Test
    fun reachablePrimaryReconnectFailureDoesNotProbeAlternates() = runTest {
        val attempts = mutableListOf<String>()
        val repo = HttpCompanionRepository(client = client { request ->
            attempts += request.url.toString()
            if (request.url.encodedPath == "/v1/projects") throw IOException("Disconnected")
            503 to "unavailable"
        }, coroutineScope = backgroundScope)
        val original = session(listOf(lan, tail))
        repo.injectFakeSession(original)
        repo.getProjects()
        runCurrent()
        advanceTimeBy(1000)
        runCurrent()
        assertEquals(original, repo.activeSession.value)
        assertEquals(listOf("$lan/v1/projects", "$lan/v1/session"), attempts)
        assertFalse(repo.connectionStatus.value is ConnectionStatus.Connected)
    }
}
