package com.foundry.companion

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.foundry.companion.data.model.CompanionPairingPayload
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.PairedSession
import com.foundry.companion.data.model.StartRunInput
import com.foundry.companion.data.repository.FakeCompanionRepository
import com.foundry.companion.data.repository.HttpCompanionRepository
import com.foundry.companion.data.session.SessionManager
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CompanionRepositoryTest {

    private lateinit var fakeRepository: FakeCompanionRepository
    private lateinit var server: MockWebServer
    private lateinit var httpRepository: HttpCompanionRepository
    private lateinit var sessionManager: SessionManager

    @Before
    fun setup() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        sessionManager = SessionManager(context)
        sessionManager.clearSession()

        fakeRepository = FakeCompanionRepository(initialPaired = false)
        server = MockWebServer()
        server.start()
        httpRepository = HttpCompanionRepository()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun testInitialUnpairedState() {
        assertTrue(fakeRepository.connectionStatus.value is ConnectionStatus.Unpaired)
        assertNull(fakeRepository.activeSession.value)
    }

    @Test
    fun testFakePairingSuccess() = runBlocking {
        val payload = CompanionPairingPayload(
            protocolVersion = 1,
            origin = "http://192.168.1.50:52810",
            desktopId = "desk_test_1",
            desktopName = "Test Mac",
            secret = "sec_123",
            expiresAt = "2026-08-19T00:00:00Z"
        )

        val pairResult = fakeRepository.pair(payload, "Test Phone")
        assertTrue(pairResult.isSuccess)
        val result = pairResult.getOrThrow()
        assertEquals("desk_test_1", result.desktopId)
        assertEquals("Test Mac", result.desktopName)

        val connState = fakeRepository.connectionStatus.value
        assertTrue(connState is ConnectionStatus.Connected)
        assertEquals("Test Mac", (connState as ConnectionStatus.Connected).desktopName)
    }

    @Test
    fun testHttpPairingSuccessAndSessionState() = runBlocking {
        val hostOrigin = server.url("").toString().removeSuffix("/")
        val mockPairResponse = """
            {
                "token": "bearer_token_xyz_123",
                "deviceId": "dev_phone_1",
                "desktopId": "desk_mac_studio_01",
                "desktopName": "Nik’s Mac Studio",
                "protocolVersion": 1
            }
        """.trimIndent()
        server.enqueue(MockResponse().setResponseCode(200).setBody(mockPairResponse))

        val payload = CompanionPairingPayload(
            protocolVersion = 1,
            origin = hostOrigin,
            desktopId = "desk_mac_studio_01",
            desktopName = "Nik’s Mac Studio",
            secret = "secret_valid_nonce",
            expiresAt = "2026-08-19T12:00:00Z"
        )

        val result = httpRepository.pair(payload, "Pixel 9")
        assertTrue(result.isSuccess)
        val pairResult = result.getOrThrow()
        assertEquals("bearer_token_xyz_123", pairResult.token)
        assertEquals("Nik’s Mac Studio", pairResult.desktopName)

        val session = httpRepository.activeSession.value
        assertNotNull(session)
        assertEquals("bearer_token_xyz_123", session?.token)
        assertEquals(hostOrigin, session?.hostOrigin)

        assertTrue(httpRepository.connectionStatus.value is ConnectionStatus.Connected)

        val recordedRequest = server.takeRequest()
        assertEquals("/pair", recordedRequest.path)
        assertEquals("POST", recordedRequest.method)
        assertTrue(recordedRequest.body.readUtf8().contains("secret_valid_nonce"))
    }

    @Test
    fun testHttpPairingExpiredSecret() = runBlocking {
        val hostOrigin = server.url("").toString().removeSuffix("/")
        val mockErrorResponse = """
            {
                "error": {
                    "code": "pairing_invalid",
                    "message": "that pairing code is expired or already used"
                }
            }
        """.trimIndent()
        server.enqueue(MockResponse().setResponseCode(401).setBody(mockErrorResponse))

        val payload = CompanionPairingPayload(
            protocolVersion = 1,
            origin = hostOrigin,
            desktopId = "desk_01",
            desktopName = "Mac",
            secret = "expired_secret",
            expiresAt = "2026-08-19T00:00:00Z"
        )

        val result = httpRepository.pair(payload, "Pixel")
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()?.message?.contains("expired or already used") == true)
        assertTrue(httpRepository.connectionStatus.value is ConnectionStatus.Unpaired)
    }

    @Test
    fun testHttpUnpairCallsRevokeAndClearsState() = runBlocking {
        val hostOrigin = server.url("").toString().removeSuffix("/")
        httpRepository.injectFakeSession(
            PairedSession(
                token = "active_token_123",
                desktopId = "desk_01",
                desktopName = "Mac",
                hostOrigin = hostOrigin,
                pairedAt = "2026-08-19T00:00:00Z"
            )
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))

        httpRepository.unpair()

        assertNull(httpRepository.activeSession.value)
        assertTrue(httpRepository.connectionStatus.value is ConnectionStatus.Unpaired)

        val recorded = server.takeRequest()
        assertEquals("/v1/unpair", recorded.path)
        assertEquals("Bearer active_token_123", recorded.getHeader("Authorization"))
    }

    @Test
    fun testHttp401UnauthorizedRevokesSession() = runBlocking {
        val hostOrigin = server.url("").toString().removeSuffix("/")
        httpRepository.injectFakeSession(
            PairedSession(
                token = "revoked_token",
                desktopId = "desk_01",
                desktopName = "Mac",
                hostOrigin = hostOrigin,
                pairedAt = "2026-08-19T00:00:00Z"
            )
        )
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"unauthorized"}}"""))

        val result = httpRepository.getProjects()
        assertTrue(result.isFailure)

        // Active session must be cleared on 401
        assertNull(httpRepository.activeSession.value)
        assertTrue(httpRepository.connectionStatus.value is ConnectionStatus.Unpaired)
    }

    @Test
    fun testSessionManagerPersistence() {
        val session = PairedSession(
            token = "persist_token_123",
            desktopId = "desk_persist_01",
            desktopName = "Studio Mac",
            hostOrigin = "http://192.168.1.50:52810",
            pairedAt = "2026-08-19T10:00:00Z"
        )
        sessionManager.saveSession(session)

        val loaded = sessionManager.getSession()
        assertNotNull(loaded)
        assertEquals(session.token, loaded?.token)
        assertEquals(session.desktopId, loaded?.desktopId)
        assertEquals(session.hostOrigin, loaded?.hostOrigin)

        sessionManager.clearSession()
        assertNull(sessionManager.getSession())
    }

    @Test
    fun testGetProjectsAndRunsFake() = runBlocking {
        val projects = fakeRepository.getProjects().getOrThrow()
        assertTrue(projects.isNotEmpty())
        assertEquals("Foundry", projects.first().name)

        val runs = fakeRepository.getRuns(projects.first().id).getOrThrow()
        assertTrue(runs.isNotEmpty())
        assertTrue(runs.any { it.status == "running" })
    }

    @Test
    fun testStartAndKillRunFake() = runBlocking {
        val projects = fakeRepository.getProjects().getOrThrow()
        val project = projects.first()
        val pipeline = project.pipelines.first()

        val startResult = fakeRepository.startRun(
            StartRunInput(
                projectId = project.id,
                pipelineId = pipeline.id,
                request = "Build new feature test"
            )
        ).getOrThrow()

        assertTrue(startResult.ok)
        assertNotNull(startResult.runId)

        val runId = startResult.runId!!
        val runDetail = fakeRepository.getRunDetail(project.id, runId).getOrThrow()
        assertEquals("running", runDetail.run.status)

        val killResult = fakeRepository.killRun(project.id, runId).getOrThrow()
        assertTrue(killResult.ok)

        val updatedDetail = fakeRepository.getRunDetail(project.id, runId).getOrThrow()
        assertEquals("killed", updatedDetail.run.status)
    }

    @Test
    fun testHttpEventPageCursorAndUnknownKeys() = runBlocking {
        val hostOrigin = server.url("").toString().removeSuffix("/")
        httpRepository.injectFakeSession(
            PairedSession(
                token = "test_token",
                desktopId = "desk_01",
                desktopName = "Mac",
                hostOrigin = hostOrigin,
                pairedAt = "2026-08-19T00:00:00Z"
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "events": [
                    {
                      "rowid": 1,
                      "changeId": 12,
                      "eventId": "ev_1",
                      "runId": "run_123",
                      "phaseId": "p_3",
                      "type": "tool_call",
                      "name": "read: spec.md",
                      "payload": { "kind": "read", "args": { "file_path": "spec.md" }, "result": "ok" },
                      "tokens": 0,
                      "startedAt": "2026-08-18T23:30:00Z",
                      "endedAt": "2026-08-18T23:30:01Z",
                      "unexpected": true
                    }
                  ],
                  "cursor": 12
                }
                """.trimIndent()
            )
        )

        val page = httpRepository.getEventPage("proj_1", "run_123", after = 4).getOrThrow()
        assertEquals(1, page.events.size)
        assertEquals("ev_1", page.events[0].eventId)
        assertEquals("p_3", page.events[0].phaseId)
        assertEquals("tool_call", page.events[0].type)
        assertEquals(12L, page.cursor)

        val req = server.takeRequest()
        assertEquals("/v1/projects/proj_1/runs/run_123/events?after=4", req.path)
    }

    @Test
    fun testHttpKillRun() = runBlocking {
        val hostOrigin = server.url("").toString().removeSuffix("/")
        httpRepository.injectFakeSession(
            PairedSession(
                token = "test_token",
                desktopId = "desk_01",
                desktopName = "Mac",
                hostOrigin = hostOrigin,
                pairedAt = "2026-08-19T00:00:00Z"
            )
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))

        val res = httpRepository.killRun("proj_1", "run_123").getOrThrow()
        assertTrue(res.ok)

        val req = server.takeRequest()
        assertEquals("/v1/projects/proj_1/runs/run_123/kill", req.path)
        assertEquals("POST", req.method)
    }

    @Test
    fun testHttpContinueRun() = runBlocking {
        val hostOrigin = server.url("").toString().removeSuffix("/")
        httpRepository.injectFakeSession(
            PairedSession(
                token = "test_token",
                desktopId = "desk_01",
                desktopName = "Mac",
                hostOrigin = hostOrigin,
                pairedAt = "2026-08-19T00:00:00Z"
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"ok":true,"detail":"Continuing from build"}"""
            )
        )

        val res = httpRepository.continueRun("proj_1", "run_123").getOrThrow()
        assertTrue(res.ok)
        assertEquals("Continuing from build", res.detail)

        val req = server.takeRequest()
        assertEquals("/v1/projects/proj_1/runs/run_123/continue", req.path)
        assertEquals("POST", req.method)
    }

    @Test
    fun testHttpGetPrStatus() = runBlocking {
        val hostOrigin = server.url("").toString().removeSuffix("/")
        httpRepository.injectFakeSession(
            PairedSession(
                token = "test_token",
                desktopId = "desk_01",
                desktopName = "Mac",
                hostOrigin = hostOrigin,
                pairedAt = "2026-08-19T00:00:00Z"
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"available":true,"detail":"gh is signed in; repo resolves to foundry-app/foundry","repo":"foundry-app/foundry"}"""
            )
        )

        val res = httpRepository.getPrStatus("proj_1").getOrThrow()
        assertTrue(res.available)
        assertEquals("foundry-app/foundry", res.repo)

        val req = server.takeRequest()
        assertEquals("/v1/projects/proj_1/pr-status", req.path)
        assertEquals("GET", req.method)
    }

    @Test
    fun testHttpGetPrDraft() = runBlocking {
        val hostOrigin = server.url("").toString().removeSuffix("/")
        httpRepository.injectFakeSession(
            PairedSession(
                token = "test_token",
                desktopId = "desk_01",
                desktopName = "Mac",
                hostOrigin = hostOrigin,
                pairedAt = "2026-08-19T00:00:00Z"
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"title":"p: make a change","body":"make a change","source":"run"}"""
            )
        )

        val res = httpRepository.getPrDraft("proj_1", "run_1").getOrThrow()
        assertEquals("p: make a change", res.title)
        assertEquals("make a change", res.body)
        assertEquals("run", res.source)

        val req = server.takeRequest()
        assertEquals("/v1/projects/proj_1/runs/run_1/pr-draft", req.path)
        assertEquals("GET", req.method)
    }

    @Test
    fun testHttpCreatePr() = runBlocking {
        val hostOrigin = server.url("").toString().removeSuffix("/")
        httpRepository.injectFakeSession(
            PairedSession(
                token = "test_token",
                desktopId = "desk_01",
                desktopName = "Mac",
                hostOrigin = hostOrigin,
                pairedAt = "2026-08-19T00:00:00Z"
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"ok":true,"number":133,"url":"https://github.com/foundry-app/foundry/pull/133"}"""
            )
        )

        val res = httpRepository.createPr(
            "proj_1",
            "run_1",
            com.foundry.companion.data.model.CompanionPrCreateRequest()
        ).getOrThrow()
        assertTrue(res.ok)
        assertEquals(133, res.number)
        assertEquals("https://github.com/foundry-app/foundry/pull/133", res.url)

        val req = server.takeRequest()
        assertEquals("/v1/projects/proj_1/runs/run_1/pr", req.path)
        assertEquals("POST", req.method)
    }

    @Test
    fun testHttpSmithStateSendAndProposalAnswer() = runBlocking {
        val hostOrigin = server.url("").toString().removeSuffix("/")
        httpRepository.injectFakeSession(
            PairedSession(
                token = "test_token",
                desktopId = "desk_01",
                desktopName = "Mac",
                hostOrigin = hostOrigin,
                pairedAt = "2026-08-19T00:00:00Z"
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"model":"scripted","activeModel":"scripted","reasoningEffort":"medium","activeReasoningEffort":"medium","running":false,"transcript":[]}"""
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"projectId":"proj_1","model":"scripted","activeModel":"scripted","reasoningEffort":"medium","activeReasoningEffort":"medium","running":false,"transcript":[{"id":"op_0","kind":"text","text":"hello","source":"operator","at":1}]}"""
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """[{"id":"prop_1","type":"action","title":"Change a setting","summary":"Flip","risk":"write"}]"""
            )
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))

        val empty = httpRepository.getSmithState("proj_1").getOrThrow()
        assertTrue(empty.transcript.isEmpty())

        val sent = httpRepository.sendSmith(
            "proj_1",
            "hello",
            com.foundry.companion.data.model.SmithScreenContext(route = "smith")
        ).getOrThrow()
        assertEquals("hello", sent.transcript.first().text)

        val proposals = httpRepository.getSmithProposals().getOrThrow()
        assertEquals("prop_1", proposals.single().id)

        val answered = httpRepository.answerSmithProposal(
            "prop_1",
            com.foundry.companion.data.model.SmithProposalAnswer(approved = true)
        ).getOrThrow()
        assertTrue(answered.ok)

        assertEquals("/v1/smith?projectId=proj_1", server.takeRequest().path)
        val sendReq = server.takeRequest()
        assertEquals("/v1/smith/send", sendReq.path)
        assertEquals("POST", sendReq.method)
        assertTrue(sendReq.body.readUtf8().contains("hello"))
        assertEquals("/v1/smith/proposals", server.takeRequest().path)
        assertEquals("/v1/smith/proposals/answer", server.takeRequest().path)
    }

    @Test
    fun testHttpSmithModelsAndSetters() = runBlocking {
        val hostOrigin = server.url("").toString().removeSuffix("/")
        httpRepository.injectFakeSession(
            PairedSession(
                token = "test_token",
                desktopId = "desk_01",
                desktopName = "Mac",
                hostOrigin = hostOrigin,
                pairedAt = "2026-08-19T00:00:00Z"
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """[{"id":"scripted/alpha","displayName":"Alpha","provider":"scripted","supportedReasoningEfforts":["low","medium","high"],"defaultReasoningEffort":"medium"}]"""
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"model":"scripted/alpha","activeModel":"scripted/alpha","reasoningEffort":"medium","activeReasoningEffort":"medium","running":false,"transcript":[]}"""
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"model":"scripted/alpha","activeModel":"scripted/alpha","reasoningEffort":"high","activeReasoningEffort":"high","running":false,"transcript":[]}"""
            )
        )

        val models = httpRepository.getSmithModels().getOrThrow()
        assertEquals("scripted/alpha", models.single().id)
        assertEquals("scripted/alpha", httpRepository.setSmithModel("proj_1", "scripted/alpha").getOrThrow().model)
        assertEquals("high", httpRepository.setSmithEffort("proj_1", "high").getOrThrow().reasoningEffort)

        assertEquals("/v1/smith/models", server.takeRequest().path)
        assertEquals("/v1/smith/model", server.takeRequest().path)
        assertEquals("/v1/smith/effort", server.takeRequest().path)
    }

    @Test
    fun testHttpOrchestratorPlanLifecycleAndLosslessRoundTrip() = runBlocking {
        val hostOrigin = server.url("").toString().removeSuffix("/")
        httpRepository.injectFakeSession(
            PairedSession(
                token = "test_token",
                desktopId = "desk_01",
                desktopName = "Mac",
                hostOrigin = hostOrigin,
                pairedAt = "2026-08-19T00:00:00Z"
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"models":[{"id":"scripted/alpha","displayName":"Alpha","provider":"scripted","supportedReasoningEfforts":["low","medium","high"],"defaultReasoningEffort":"medium"}],"model":"scripted/alpha","reasoningEffort":"high"}"""
            )
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"planId":"plan_http_1"}"""))
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "planId": "plan_http_1",
                  "projectId": "proj_1",
                  "status": "done",
                  "model": "scripted/alpha",
                  "reasoningEffort": "high",
                  "prompt": "Build the parity change",
                  "entries": [],
                  "plan": {
                    "planId": "plan_http_1",
                    "projectId": "proj_1",
                    "prompt": "Build the parity change",
                    "refinedRequest": "Build the parity change with focused tests.",
                    "rationale": "Keep implementation and verification together.",
                    "pipeline": {
                      "id": "generated-plan-1",
                      "name": "Generated plan",
                      "description": "A plan",
                      "phases": [
                        {
                          "name": "build",
                          "kind": "agent",
                          "agent": "builder",
                          "model": "scripted/alpha",
                          "prompt": {"inputs": ["request"]}
                        }
                      ],
                      "acceptance": {"kind": "all_phases_pass"}
                    },
                    "agents": [],
                    "warnings": [],
                    "model": "scripted/alpha",
                    "reasoningEffort": "high"
                  },
                  "rawReply": "{}",
                  "detail": "Plan ready.",
                  "startedAt": 1,
                  "endedAt": 2
                }
                """.trimIndent()
            )
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"ok":true,"runId":"run_http_1","issues":[]}"""
            )
        )

        val options = httpRepository.getOrchestratorOptions().getOrThrow()
        assertEquals("scripted/alpha", options.model)

        val started = httpRepository.startOrchestratorPlan(
            com.foundry.companion.data.model.OrchestratorStartRequest(
                projectId = "proj_1",
                prompt = "Build the parity change",
                model = "scripted/alpha",
                reasoningEffort = "high"
            )
        ).getOrThrow()
        assertEquals("plan_http_1", started.planId)

        val state = httpRepository.getOrchestratorPlan("plan_http_1").getOrThrow()
        assertEquals("done", state.status)
        val plan = state.plan!!
        assertEquals("generated-plan-1", plan.pipelineId)
        assertEquals("Generated plan", plan.pipelineName)
        assertEquals(1, plan.phases.size)
        assertEquals("scripted/alpha", plan.phases.single().model)

        // Re-cast one phase; the raw pipeline JSON must keep every other field.
        val recast = plan.withPhaseModel("build", "scripted/beta")
        assertEquals("scripted/beta", recast.phases.single().model)
        assertEquals("generated-plan-1", recast.pipelineId)
        assertEquals("Build the parity change", recast.prompt)
        assertTrue(recast.pipeline.toString().contains("\"kind\":\"all_phases_pass\""))

        assertTrue(httpRepository.cancelOrchestratorPlan("plan_http_1").getOrThrow())

        val runResult = httpRepository.startRun(
            com.foundry.companion.data.model.StartRunInput(
                projectId = "proj_1",
                pipelineId = recast.pipelineId,
                request = recast.prompt,
                plan = recast
            )
        ).getOrThrow()
        assertTrue(runResult.ok)
        assertEquals("run_http_1", runResult.runId)

        assertEquals("/v1/orchestrator/options", server.takeRequest().path)
        assertEquals("/v1/orchestrator/plans", server.takeRequest().path)
        assertEquals("/v1/orchestrator/plans/plan_http_1", server.takeRequest().path)
        assertEquals("/v1/orchestrator/plans/plan_http_1/cancel", server.takeRequest().path)
        val startReq = server.takeRequest()
        assertEquals("/v1/runs", startReq.path)
        val body = startReq.body.readUtf8()
        assertTrue(body.contains("generated-plan-1"))
        assertTrue(body.contains("scripted/beta"))
        assertTrue(body.contains("acceptance"))
    }

    @Test
    fun testHttpLinearStateSearchWorkflowAndSourcedStart() = runBlocking {
        val hostOrigin = server.url("").toString().removeSuffix("/")
        httpRepository.injectFakeSession(
            PairedSession(
                token = "test_token",
                desktopId = "desk_01",
                desktopName = "Mac",
                hostOrigin = hostOrigin,
                pairedAt = "2026-08-19T00:00:00Z"
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"keySet":true,"detail":"Connected.","statusMapping":{"started":"s1","completed":"s2","failed":null}}"""
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """[{"id":"iss_1","identifier":"FOU-204","title":"Parity","description":"","url":"https://linear.app/foundry-nik/issue/FOU-204","updatedAt":"2026-08-26T18:00:00Z","team":{"id":"team_1","name":"Foundry"},"state":{"id":"s0","name":"Backlog","type":"backlog"}}]"""
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """[{"id":"s1","name":"In Progress","type":"started"},{"id":"s2","name":"Done","type":"completed"},{"id":"s3","name":"Cancelled","type":"canceled"}]"""
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"ok":true,"runId":"run_linear_1","issues":[]}"""
            )
        )

        val state = httpRepository.getLinearState().getOrThrow()
        assertTrue(state.keySet)
        assertEquals("s1", state.statusMapping.started)
        assertNull(state.statusMapping.failed)

        val issues = httpRepository.searchLinearIssues("FOU-204").getOrThrow()
        assertEquals("FOU-204", issues.single().identifier)

        val states = httpRepository.getLinearWorkflowStates("team_1").getOrThrow()
        assertEquals(listOf("s1", "s2", "s3"), states.map { it.id })

        val started = httpRepository.startLinearRun(
            com.foundry.companion.data.model.LinearStartRunInput(
                projectId = "proj_1",
                pipelineId = "pipe_1",
                issueId = "iss_1",
                statusMapping = com.foundry.companion.data.model.LinearStatusMapping(
                    started = "s1",
                    completed = "s2",
                    failed = "s3"
                )
            )
        ).getOrThrow()
        assertTrue(started.ok)
        assertEquals("run_linear_1", started.runId)

        assertEquals("/v1/linear", server.takeRequest().path)
        assertEquals("/v1/linear/issues?query=FOU-204", server.takeRequest().path)
        assertEquals("/v1/linear/teams/team_1/workflow-states", server.takeRequest().path)
        val startReq = server.takeRequest()
        assertEquals("/v1/linear/runs", startReq.path)
        val body = startReq.body.readUtf8()
        assertTrue(body.contains("iss_1"))
        assertTrue(body.contains("\"failed\":\"s3\""))
    }

    @Test
    fun testHttpCheckpointListAndRestore() = runBlocking {
        val hostOrigin = server.url("").toString().removeSuffix("/")
        httpRepository.injectFakeSession(
            PairedSession(
                token = "test_token",
                desktopId = "desk_01",
                desktopName = "Mac",
                hostOrigin = hostOrigin,
                pairedAt = "2026-08-19T00:00:00Z"
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "runId": "run_1",
                  "refusal": null,
                  "detail": "",
                  "checkpoints": [
                    {
                      "checkpointId": "cp_1",
                      "runId": "run_1",
                      "phaseId": "ph_3",
                      "phaseName": "Code",
                      "phaseKind": "agent",
                      "generation": 1,
                      "createdAt": "2026-08-26T18:00:00Z",
                      "headSha": "abc123",
                      "model": "scripted/alpha",
                      "agent": "builder",
                      "fileCount": 4,
                      "untrackedCount": 1,
                      "bytesStored": 9001,
                      "restorable": true,
                      "exactRestorePossible": true,
                      "omittedPaths": [],
                      "commitsSince": 2,
                      "commitsSinceShas": ["bead123", "face456"]
                    }
                  ]
                }
                """.trimIndent()
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "ok": true,
                  "detail": "Restored Code; the run remains stopped.",
                  "restored": {
                    "checkpointId": "cp_1",
                    "phaseId": "ph_3",
                    "phaseName": "Code",
                    "generation": 1,
                    "previousHeadSha": "deadcafe",
                    "headSha": "abc123",
                    "droppedCommits": ["bead123", "face456"],
                    "droppedCommitCount": 2,
                    "filesRestored": 4,
                    "filesRemoved": 0,
                    "omittedPaths": [],
                    "partial": false,
                    "driftEnumerated": true,
                    "freshSessions": [{"agent": "builder", "previousSessionId": "s_old"}],
                    "fromStatus": "killed"
                  }
                }
                """.trimIndent()
            )
        )

        val list = httpRepository.getRestorableCheckpoints("proj_1", "run_1").getOrThrow()
        assertNull(list.refusal)
        val checkpoint = list.checkpoints.single()
        assertEquals("Code", checkpoint.phaseName)
        assertTrue(checkpoint.exactRestorePossible)
        assertEquals(2, checkpoint.commitsSince)

        val restored = httpRepository.restoreCheckpoint(
            "proj_1",
            "run_1",
            com.foundry.companion.data.model.RestoreCheckpointRequest(checkpointId = "cp_1")
        ).getOrThrow()
        assertTrue(restored.ok)
        assertEquals("Code", restored.restored?.phaseName)
        assertEquals("s_old", restored.restored?.freshSessions?.single()?.previousSessionId)

        assertEquals("/v1/projects/proj_1/runs/run_1/checkpoints", server.takeRequest().path)
        val restoreReq = server.takeRequest()
        assertEquals("/v1/projects/proj_1/runs/run_1/restore", restoreReq.path)
        assertEquals("POST", restoreReq.method)
        assertTrue(restoreReq.body.readUtf8().contains("cp_1"))
    }
}
