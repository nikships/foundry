package com.foundry.companion

import com.foundry.companion.data.model.CompanionPairingPayload
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.StartRunInput
import com.foundry.companion.data.repository.FakeCompanionRepository
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class CompanionRepositoryTest {

    private lateinit var repository: FakeCompanionRepository

    @Before
    fun setup() {
        repository = FakeCompanionRepository(initialPaired = false)
    }

    @Test
    fun testInitialUnpairedState() {
        assertTrue(repository.connectionStatus.value is ConnectionStatus.Unpaired)
        assertNull(repository.activeSession.value)
    }

    @Test
    fun testPairingSuccess() = runBlocking {
        val payload = CompanionPairingPayload(
            protocolVersion = 1,
            origin = "http://192.168.1.50:52810",
            desktopId = "desk_test_1",
            desktopName = "Test Mac",
            secret = "sec_123",
            expiresAt = "2026-08-19T00:00:00Z"
        )

        val pairResult = repository.pair(payload, "Test Phone")
        assertTrue(pairResult.isSuccess)
        val result = pairResult.getOrThrow()
        assertEquals("desk_test_1", result.desktopId)
        assertEquals("Test Mac", result.desktopName)

        val connState = repository.connectionStatus.value
        assertTrue(connState is ConnectionStatus.Connected)
        assertEquals("Test Mac", (connState as ConnectionStatus.Connected).desktopName)
    }

    @Test
    fun testUnpairWipesSession() = runBlocking {
        val payload = CompanionPairingPayload(
            protocolVersion = 1,
            origin = "http://192.168.1.50:52810",
            desktopId = "desk_test_1",
            desktopName = "Test Mac",
            secret = "sec_123",
            expiresAt = "2026-08-19T00:00:00Z"
        )
        repository.pair(payload)
        assertTrue(repository.connectionStatus.value is ConnectionStatus.Connected)

        repository.unpair()
        assertTrue(repository.connectionStatus.value is ConnectionStatus.Unpaired)
        assertNull(repository.activeSession.value)
    }

    @Test
    fun testGetProjectsAndRuns() = runBlocking {
        val projects = repository.getProjects().getOrThrow()
        assertTrue(projects.isNotEmpty())
        assertEquals("Foundry", projects.first().name)

        val runs = repository.getRuns(projects.first().id).getOrThrow()
        assertTrue(runs.isNotEmpty())
        assertTrue(runs.any { it.status == "running" })
    }

    @Test
    fun testStartAndKillRun() = runBlocking {
        val projects = repository.getProjects().getOrThrow()
        val project = projects.first()
        val pipeline = project.pipelines.first()

        val startResult = repository.startRun(
            StartRunInput(
                projectId = project.id,
                pipelineId = pipeline.id,
                request = "Build new feature test"
            )
        ).getOrThrow()

        assertTrue(startResult.ok)
        assertNotNull(startResult.runId)

        val runId = startResult.runId!!
        val runDetail = repository.getRunDetail(project.id, runId).getOrThrow()
        assertEquals("running", runDetail.run.status)

        val killResult = repository.killRun(project.id, runId).getOrThrow()
        assertTrue(killResult.ok)

        val updatedDetail = repository.getRunDetail(project.id, runId).getOrThrow()
        assertEquals("killed", updatedDetail.run.status)
    }
}
