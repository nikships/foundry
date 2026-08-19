package com.foundry.companion

import com.foundry.companion.data.mapper.RunDetailMapper
import com.foundry.companion.data.mapper.RunNotFoundException
import com.foundry.companion.data.model.HostRunDetail
import com.foundry.companion.data.model.PairedSession
import com.foundry.companion.data.repository.HttpCompanionRepository
import com.foundry.companion.util.RunFormatters
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Decodes recorded desktop payloads, not hand-written ones. The three fixtures
 * under `src/test/resources/` were captured from the real
 * `src/main/engine/operations.ts:runDetail()` over the companion host, so a
 * change to the desktop's wire shape fails here rather than on a phone.
 */
class RunDetailMapperTest {

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    private lateinit var server: MockWebServer
    private lateinit var repository: HttpCompanionRepository

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()
        repository = HttpCompanionRepository()
        repository.injectFakeSession(
            PairedSession(
                token = "test_token",
                desktopId = "desk_01",
                desktopName = "Mac",
                hostOrigin = server.url("").toString().removeSuffix("/"),
                pairedAt = "2026-08-19T00:00:00Z"
            )
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun fixture(name: String): String =
        checkNotNull(javaClass.classLoader?.getResourceAsStream(name)) { "missing fixture $name" }
            .bufferedReader()
            .use { it.readText() }

    private fun host(name: String): HostRunDetail =
        json.decodeFromString(HostRunDetail.serializer(), fixture(name))

    @Test
    fun everyPhaseCarriesTheHostPhaseId() {
        val detail = RunDetailMapper.map(host("host-run-detail.json"))
        assertNotNull(detail)

        // The host keys phases on `phaseId`; a blank resolvedId is the exact bug
        // that made every phase look identical and the Inspector open nothing.
        assertTrue(detail!!.phases.isNotEmpty())
        for (phase in detail.phases) {
            assertTrue(
                "phase ${phase.name} has a blank resolvedId",
                phase.resolvedId.isNotBlank()
            )
            assertTrue(phase.resolvedId.startsWith("ph_"))
            assertEquals(phase.resolvedId, phase.phaseId)
        }
        assertEquals(
            detail.phases.map { it.resolvedId }.distinct().size,
            detail.phases.size
        )
        assertEquals(listOf("plan", "build", "verify"), detail.phases.map { it.name })
    }

    @Test
    fun settledPhasesCarryDurationModelGatesAndVerdict() {
        val detail = RunDetailMapper.map(host("host-run-detail.json"))!!

        val plan = detail.phases.first { it.name == "plan" }
        assertEquals("success", plan.status)
        assertEquals("planner", plan.owner)
        assertEquals("anthropic/claude-sonnet-4-5", plan.model)
        assertEquals(1234L, plan.tokens)
        assertEquals(listOf("artifacts_exist"), plan.gateResults.map { it.name })
        assertTrue(plan.gateResults.single().passed)
        assertEquals("planned the operator view", plan.envelopeVerdict)
        assertNull(plan.errorMessage)
        // 18:51:11.053Z → 18:51:11.100Z, from the recording's own timestamps.
        assertEquals(47L, plan.durationMs)

        val build = detail.phases.first { it.name == "build" }
        assertEquals("openai/gpt-5-codex", build.model)
        assertEquals("diff_matches_claims", build.gateResults.single().name)
        assertEquals("decoded the host payload", build.envelopeVerdict)
        assertEquals(listOf("built.txt"), build.changedFiles)
        assertEquals(48L, build.durationMs)
        assertTrue(plan.changedFiles.isEmpty())
    }

    @Test
    fun failedCodePhaseCarriesItsErrorAndNoAgentSession() {
        val detail = RunDetailMapper.map(host("host-run-detail.json"))!!
        val verify = detail.phases.first { it.name == "verify" }

        assertEquals("fail", verify.status)
        assertEquals("exit 3", verify.errorMessage)
        // A code phase is owned by "code", which is not an agent session.
        assertNull(verify.model)
        assertNull(verify.tokens)
        assertTrue(verify.gateResults.isEmpty())
        assertNull(verify.envelopeVerdict)
        // The host records attempt 0 for a phase that never took an agent turn;
        // the phone counts from 1 so the waterfall does not print "×0".
        assertEquals(1, verify.attempt)
    }

    @Test
    fun runLevelFieldsSurviveTheFold() {
        val detail = RunDetailMapper.map(host("host-run-detail.json"))!!

        assertEquals("run_fixture_1", detail.run.runId)
        assertEquals("rejected", detail.run.status)
        assertEquals("foundry/run_fixture_1", detail.run.branch)
        assertEquals(240L, detail.run.totalTokens)
        assertEquals(
            "verify exited 3 (every phase had to pass; verify is fail)",
            detail.run.outcomeDetail
        )
        assertEquals(false, detail.live)
        // The run row carries the same folded phases the screens read.
        assertEquals(detail.phases, detail.run.phases)
    }

    @Test
    fun aRunningPhaseTicksAgainstTheSuppliedClock() {
        val host = host("host-run-detail-live.json")
        val startMs = RunFormatters.parseIsoToEpochMs(
            host.phases.first { it.name == "build" }.startedAt
        )!!

        val detail = RunDetailMapper.map(host, nowMs = startMs + 7_500L)!!
        val build = detail.phases.first { it.name == "build" }
        assertEquals("running", build.status)
        assertEquals(7_500L, build.durationMs)

        val later = RunDetailMapper.map(host, nowMs = startMs + 12_000L)!!
        assertEquals(12_000L, later.phases.first { it.name == "build" }.durationMs)

        // A queued phase has no startedAt, so it has no duration to report.
        val verify = detail.phases.first { it.name == "verify" }
        assertEquals("queued", verify.status)
        assertNull(verify.durationMs)
        assertTrue(verify.resolvedId.isNotBlank())

        assertTrue(detail.live)
        assertTrue(detail.run.isRunning)
    }

    @Test
    fun aMissingRunMapsToNothingRatherThanAnEmptyWaterfall() {
        // The desktop answers 200 with `run: null` for a run it does not have.
        assertNull(RunDetailMapper.map(host("host-run-detail-missing.json")))
    }

    @Test
    fun theRepositoryDecodesTheRecordedHostPayload() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("host-run-detail.json")))

        val detail = repository.getRunDetail("proj_1", "run_fixture_1").getOrThrow()

        assertEquals(3, detail.phases.size)
        assertTrue(detail.phases.all { it.resolvedId.isNotBlank() })
        assertEquals("anthropic/claude-sonnet-4-5", detail.phases[0].model)
        assertEquals("exit 3", detail.phases[2].errorMessage)

        val req = server.takeRequest()
        assertEquals("/v1/projects/proj_1/runs/run_fixture_1", req.path)
    }

    @Test
    fun theRepositoryReportsAMissingRunAsNotFound() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(fixture("host-run-detail-missing.json"))
        )

        val result = repository.getRunDetail("proj_1", "run_gone")
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is RunNotFoundException)
        assertTrue(result.exceptionOrNull()?.message?.contains("run_gone") == true)
    }
}
