package com.foundry.companion.data.repository

import com.foundry.companion.data.model.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.*
import java.util.UUID

class FakeCompanionRepository(
    initialPaired: Boolean = false
) : CompanionRepository {

    private val defaultSession = PairedSession(
        token = "fake_companion_bearer_token_12345",
        desktopId = "desk_macbook_pro_m3",
        desktopName = "Nik’s Mac Studio",
        hostOrigin = "http://192.168.1.100:52810",
        pairedAt = "2026-08-18T20:00:00Z",
        protocolVersion = COMPANION_PROTOCOL_VERSION
    )

    private val _activeSession = MutableStateFlow<PairedSession?>(if (initialPaired) defaultSession else null)
    override val activeSession: StateFlow<PairedSession?> = _activeSession.asStateFlow()

    private val _connectionStatus = MutableStateFlow<ConnectionStatus>(
        if (initialPaired) ConnectionStatus.Connected(defaultSession.desktopName, defaultSession.hostOrigin)
        else ConnectionStatus.Unpaired
    )
    override val connectionStatus: StateFlow<ConnectionStatus> = _connectionStatus.asStateFlow()

    private val _pendingInterrupts = MutableStateFlow<List<PendingInterrupt>>(emptyList())
    override val pendingInterrupts: StateFlow<List<PendingInterrupt>> = _pendingInterrupts.asStateFlow()

    private val extraEvents = mutableListOf<EventRow>()

    private val samplePipelines = listOf(
        PipelineSummary(
            id = "pipe_default",
            name = "Feature Pipeline",
            description = "Standard 5-phase feature development workflow with review gate.",
            phases = listOf(
                PhaseTemplateSummary("phase_plan", "Plan", "agent"),
                PhaseTemplateSummary("phase_spec", "Spec", "agent"),
                PhaseTemplateSummary("phase_code", "Code", "code"),
                PhaseTemplateSummary("phase_review", "Review", "review", isFeedbackTarget = true),
                PhaseTemplateSummary("phase_pr", "PR", "agent")
            )
        ),
        PipelineSummary(
            id = "pipe_bugfix",
            name = "Bugfix & Verify",
            description = "Fast turnaround pipeline for isolated regression repairs.",
            phases = listOf(
                PhaseTemplateSummary("phase_triage", "Triage", "agent"),
                PhaseTemplateSummary("phase_patch", "Patch", "code"),
                PhaseTemplateSummary("phase_verify", "Verify", "agent")
            )
        )
    )

    private val sampleProjects = listOf(
        CompanionProjectSummary(
            id = "proj_foundry_core",
            name = "Foundry",
            pipelines = samplePipelines
        ),
        CompanionProjectSummary(
            id = "proj_foundry_docs",
            name = "Foundry Documentation",
            pipelines = samplePipelines
        )
    )

    private val livePhaseSummaries = listOf(
        PhaseRunSummary(
            id = "p_1",
            name = "Plan",
            kind = "agent",
            status = "success",
            attempt = 1,
            durationMs = 12400,
            tokens = 4120,
            model = "anthropic/claude-3-7-sonnet",
            gateResults = listOf(GateResult("plan_approved", true)),
            envelopeVerdict = "Architecture plan validated against invariants."
        ),
        PhaseRunSummary(
            id = "p_2",
            name = "Spec",
            kind = "agent",
            status = "success",
            attempt = 1,
            durationMs = 24100,
            tokens = 8200,
            model = "anthropic/claude-3-7-sonnet",
            gateResults = listOf(GateResult("spec_complete", true)),
            envelopeVerdict = "Spec and contract definitions generated cleanly."
        ),
        PhaseRunSummary(
            id = "p_3",
            name = "Code",
            kind = "code",
            status = "running",
            attempt = 1,
            durationMs = 45200,
            tokens = 18450,
            model = "anthropic/claude-3-7-sonnet"
        ),
        PhaseRunSummary(
            id = "p_4",
            name = "Review",
            kind = "review",
            status = "queued",
            attempt = 1
        ),
        PhaseRunSummary(
            id = "p_5",
            name = "PR",
            kind = "agent",
            status = "queued",
            attempt = 1
        )
    )

    private val runsList = mutableListOf(
        RunRow(
            runId = "run_260818_live99",
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default",
            pipelineName = "Feature Pipeline",
            request = "Stand up the Android companion scaffold with Compose navigation and Foundry dark visual system.",
            status = "running",
            startedAt = "2026-08-18T23:30:00Z",
            createdAt = "2026-08-18T23:30:00Z",
            durationMs = 81700,
            totalTokens = 30770,
            branch = "foundry/run_260818_live99",
            phases = livePhaseSummaries
        ),
        RunRow(
            runId = "run_260818_acc01",
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default",
            pipelineName = "Feature Pipeline",
            request = "LAN pairing host and authenticated companion protocol (FOU-83).",
            status = "accepted",
            startedAt = "2026-08-18T22:10:00Z",
            endedAt = "2026-08-18T22:15:34Z",
            createdAt = "2026-08-18T22:10:00Z",
            finishedAt = "2026-08-18T22:15:34Z",
            durationMs = 334000,
            totalTokens = 52140,
            branch = "foundry/run_260818_acc01",
            prNumber = 132,
            prUrl = "https://github.com/foundry-app/foundry/pull/132",
            outcomeDetail = "All 5 phases passed. Authenticated companion routes verified with token auth.",
            phases = listOf(
                PhaseRunSummary("acc_p1", "Plan", "agent", "success", 1, 14200, 3100, "anthropic/claude-3-7-sonnet"),
                PhaseRunSummary("acc_p2", "Spec", "agent", "success", 1, 28100, 7800, "anthropic/claude-3-7-sonnet"),
                PhaseRunSummary("acc_p3", "Code", "code", "success", 1, 189000, 28400, "anthropic/claude-3-7-sonnet"),
                PhaseRunSummary("acc_p4", "Review", "review", "success", 1, 45200, 8900, "anthropic/claude-3-7-sonnet"),
                PhaseRunSummary("acc_p5", "PR", "agent", "success", 1, 57500, 3940, "anthropic/claude-3-7-sonnet")
            )
        ),
        RunRow(
            runId = "run_260818_rej02",
            projectId = "proj_foundry_core",
            pipelineId = "pipe_bugfix",
            pipelineName = "Bugfix & Verify",
            request = "Refactor main electron bootstrap process initialization order.",
            status = "rejected",
            startedAt = "2026-08-18T21:00:00Z",
            endedAt = "2026-08-18T21:03:12Z",
            createdAt = "2026-08-18T21:00:00Z",
            finishedAt = "2026-08-18T21:03:12Z",
            durationMs = 192000,
            totalTokens = 24100,
            branch = "foundry/run_260818_rej02",
            outcomeDetail = "Boundary check failed: src/main/main.ts is a protected path.",
            phases = listOf(
                PhaseRunSummary("rej_p1", "Triage", "agent", "success", 1, 22000, 4200, "anthropic/claude-3-7-sonnet"),
                PhaseRunSummary("rej_p2", "Patch", "code", "fail", 1, 140000, 16900, "anthropic/claude-3-7-sonnet", errorMessage = "Boundary violation on protected path."),
                PhaseRunSummary("rej_p3", "Verify", "agent", "skipped", 1)
            )
        ),
        RunRow(
            runId = "run_260818_fail03",
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default",
            pipelineName = "Feature Pipeline",
            request = "Migrate better-sqlite3 native bindings to async worker thread pool.",
            status = "failed",
            startedAt = "2026-08-18T19:30:00Z",
            endedAt = "2026-08-18T19:34:45Z",
            createdAt = "2026-08-18T19:30:00Z",
            finishedAt = "2026-08-18T19:34:45Z",
            durationMs = 285000,
            totalTokens = 39800,
            branch = "foundry/run_260818_fail03",
            issueNumber = 140,
            issueUrl = "https://github.com/foundry-app/foundry/issues/140",
            outcomeDetail = "Phase Code failed compilation gate after 3 retry attempts.",
            phases = listOf(
                PhaseRunSummary("fail_p1", "Plan", "agent", "success", 1, 18000, 3900, "anthropic/claude-3-7-sonnet"),
                PhaseRunSummary("fail_p2", "Spec", "agent", "success", 1, 31000, 8100, "anthropic/claude-3-7-sonnet"),
                PhaseRunSummary("fail_p3", "Code", "code", "fail", 3, 236000, 27800, "anthropic/claude-3-7-sonnet", errorMessage = "Typecheck compilation failed in worker pool implementation.")
            )
        ),
        RunRow(
            runId = "run_260818_kill04",
            projectId = "proj_foundry_core",
            pipelineId = "pipe_default",
            pipelineName = "Feature Pipeline",
            request = "Implement experimental web-based renderer backend prototype.",
            status = "killed",
            startedAt = "2026-08-18T18:00:00Z",
            endedAt = "2026-08-18T18:02:10Z",
            createdAt = "2026-08-18T18:00:00Z",
            finishedAt = "2026-08-18T18:02:10Z",
            durationMs = 130000,
            totalTokens = 15200,
            branch = "foundry/run_260818_kill04",
            outcomeDetail = "Operator killed run. In-flight agent turns stopped; worktree branch preserved.",
            phases = listOf(
                PhaseRunSummary("kill_p1", "Plan", "agent", "success", 1, 19000, 4100, "anthropic/claude-3-7-sonnet"),
                PhaseRunSummary("kill_p2", "Spec", "agent", "success", 1, 35000, 7900, "anthropic/claude-3-7-sonnet"),
                PhaseRunSummary("kill_p3", "Code", "code", "skipped", 1, errorMessage = "Run terminated by operator.")
            )
        )
    )

    override suspend fun pair(payload: CompanionPairingPayload, deviceName: String): Result<CompanionPairResult> {
        val session = PairedSession(
            token = "paired_token_${UUID.randomUUID()}",
            desktopId = payload.desktopId,
            desktopName = payload.desktopName,
            hostOrigin = payload.origin,
            pairedAt = "2026-08-18T23:45:00Z",
            protocolVersion = payload.protocolVersion
        )
        _activeSession.value = session
        _connectionStatus.value = ConnectionStatus.Connected(session.desktopName, session.hostOrigin)
        return Result.success(
            CompanionPairResult(
                token = session.token,
                deviceId = "android_${UUID.randomUUID()}",
                desktopId = session.desktopId,
                desktopName = session.desktopName,
                protocolVersion = session.protocolVersion
            )
        )
    }

    override suspend fun unpair() {
        _activeSession.value = null
        _connectionStatus.value = ConnectionStatus.Unpaired
        _pendingInterrupts.value = emptyList()
    }

    override fun injectFakeSession(session: PairedSession) {
        _activeSession.value = session
        _connectionStatus.value = ConnectionStatus.Connected(session.desktopName, session.hostOrigin)
    }

    override suspend fun getSessionInfo(): Result<CompanionSessionInfo> {
        val session = _activeSession.value ?: return Result.failure(IllegalStateException("Unpaired"))
        return Result.success(
            CompanionSessionInfo(
                desktopId = session.desktopId,
                desktopName = session.desktopName,
                protocolVersion = session.protocolVersion,
                appVersion = "0.1.1"
            )
        )
    }

    override suspend fun getProjects(): Result<List<CompanionProjectSummary>> {
        return Result.success(sampleProjects)
    }

    override suspend fun getRuns(projectId: String): Result<List<RunRow>> {
        return Result.success(runsList.toList())
    }

    override suspend fun getRunDetail(projectId: String, runId: String): Result<RunDetail> {
        val run = runsList.find { it.runId == runId }
            ?: return Result.failure(IllegalArgumentException("Run not found: $runId"))
        return Result.success(RunDetail(run = run, phases = run.phases))
    }

    override suspend fun getEventPage(
        projectId: String,
        runId: String,
        after: Long
    ): Result<EventPage> {
        val sampleEvents = listOf(
            EventRow(
                rowid = 1,
                changeId = 1,
                eventId = "ev_01",
                runId = runId,
                phaseId = "p_1",
                type = "assistant_text",
                name = "assistant_text",
                payload = buildJsonObject {
                    put("text", "I am planning the feature architecture and checking invariants.")
                },
                startedAt = "23:30:02Z",
                endedAt = "23:30:04Z"
            ),
            EventRow(
                rowid = 2,
                changeId = 2,
                eventId = "ev_02",
                runId = runId,
                phaseId = "p_1",
                type = "tool_call",
                name = "read: specs/companion-android-ui.md",
                payload = buildJsonObject {
                    put("kind", "read")
                    put("args", buildJsonObject {
                        put("file_path", "specs/companion-android-ui.md")
                        put("offset", 1)
                        put("limit", 50)
                    })
                    put("result", "# Companion Android UI and Information Architecture (FOU-82)\nSection 3.5 Inspector layout and contracts.")
                },
                startedAt = "23:30:05Z",
                endedAt = "23:30:08Z"
            ),
            EventRow(
                rowid = 3,
                changeId = 3,
                eventId = "ev_03",
                runId = runId,
                phaseId = "p_1",
                type = "gate_pass",
                name = "gate_pass",
                payload = buildJsonObject {
                    put("gate", "plan_approved")
                    put("passed", true)
                    put("detail", "Architecture plan verified against invariants.")
                },
                startedAt = "23:30:10Z",
                endedAt = "23:30:10Z"
            ),
            EventRow(
                rowid = 4,
                changeId = 4,
                eventId = "ev_04",
                runId = runId,
                phaseId = "p_3",
                type = "thinking",
                name = "thinking",
                payload = buildJsonObject {
                    put("text", "Implementing InspectorScreen and TranscriptLane in Jetpack Compose. Tool calls must be collapsed by default.")
                },
                startedAt = "23:30:15Z",
                endedAt = "23:30:18Z"
            ),
            EventRow(
                rowid = 5,
                changeId = 5,
                eventId = "ev_05",
                runId = runId,
                phaseId = "p_3",
                type = "tool_call",
                name = "edit: android/.../InspectorScreen.kt",
                payload = buildJsonObject {
                    put("kind", "edit")
                    put("args", buildJsonObject {
                        put("file_path", "android/app/.../InspectorScreen.kt")
                        put("old_str", "// TODO: implement inspector")
                        put("new_string", "val isLive = true\nval expanded = false")
                    })
                    put("result", "@@ -1,2 +1,3 @@\n-// TODO: implement inspector\n+val isLive = true\n+val expanded = false")
                },
                startedAt = "23:30:20Z",
                endedAt = "23:30:25Z"
            ),
            EventRow(
                rowid = 6,
                changeId = 6,
                eventId = "ev_06",
                runId = runId,
                phaseId = "p_3",
                type = "tool_call",
                name = "bash: cd android && ./gradlew test",
                payload = buildJsonObject {
                    put("kind", "command")
                    put("args", buildJsonObject {
                        put("command", "cd android && ./gradlew test")
                    })
                    put("result", "BUILD SUCCESSFUL in 3s\n28 actionable tasks: 2 executed, 26 up-to-date")
                    put("isError", false)
                },
                startedAt = "23:30:28Z",
                endedAt = "23:30:32Z"
            ),
            EventRow(
                rowid = 7,
                changeId = 7,
                eventId = "ev_07",
                runId = runId,
                phaseId = "p_3",
                type = "tool_call",
                name = "todo: update task list",
                payload = buildJsonObject {
                    put("kind", "todo")
                    put("args", buildJsonObject {
                        put("todos", "1. [completed] Inspect UI spec\n2. [completed] Implement Inspector transcript\n3. [in_progress] Verify unit tests\n4. [pending] Take screenshot")
                    })
                },
                startedAt = "23:30:35Z",
                endedAt = "23:30:36Z"
            ),
            EventRow(
                rowid = 8,
                changeId = 8,
                eventId = "ev_08",
                runId = runId,
                phaseId = "p_3",
                type = "assistant_text",
                name = "assistant_text",
                payload = buildJsonObject {
                    put("text", "{\n  \"status\": \"success\",\n  \"summary\": \"Mobile Inspector transcript completed with collapsible tool calls.\",\n  \"changed_files\": [\"android/app/.../InspectorScreen.kt\", \"android/app/.../TranscriptLane.kt\"],\n  \"commit_message\": \"[companion] mobile Inspector transcript\"\n}")
                },
                startedAt = "23:30:40Z",
                endedAt = "23:30:42Z"
            ),
            EventRow(
                rowid = 9,
                changeId = 9,
                eventId = "ev_09",
                runId = runId,
                phaseId = "p_3",
                type = "tool_call",
                name = "search: grep transcript",
                payload = buildJsonObject {
                    put("kind", "search")
                    put("args", buildJsonObject {
                        put("pattern", "TranscriptLane")
                        put("path", "android/app/src/main")
                    })
                    put("result", "android/.../TranscriptLane.kt: @Composable fun TranscriptLane(...)")
                },
                startedAt = "23:30:45Z",
                endedAt = null
            ),
            EventRow(
                rowid = 10,
                changeId = 10,
                eventId = "ev_10",
                runId = runId,
                phaseId = "p_1",
                type = "phase_start",
                name = "phase_start",
                payload = buildJsonObject { put("detail", "Plan started") },
                startedAt = "23:30:00Z",
                endedAt = "23:30:00Z"
            ),
            EventRow(
                rowid = 11,
                changeId = 11,
                eventId = "ev_11",
                runId = runId,
                phaseId = "p_3",
                type = "future_widget",
                name = "future_widget",
                payload = buildJsonObject { put("detail", "unknown future type must be skipped") },
                startedAt = "23:30:50Z",
                endedAt = "23:30:50Z"
            ),
            EventRow(
                rowid = 12,
                changeId = 12,
                eventId = "ev_12",
                runId = runId,
                phaseId = "p_3",
                type = "error",
                name = "error",
                payload = buildJsonObject { put("detail", "Typecheck failed in TranscriptLane.") },
                startedAt = "23:30:52Z",
                endedAt = "23:30:52Z"
            )
        )
        val allEvents = sampleEvents + extraEvents.filter { it.runId == runId || it.runId.isBlank() }
        val filtered = if (after > 0) allEvents.filter { it.changeId > after } else allEvents
        val maxCursor = if (allEvents.isNotEmpty()) allEvents.maxOf { it.changeId } else after
        return Result.success(EventPage(events = filtered, cursor = maxCursor))
    }

    fun appendEvent(event: EventRow) {
        extraEvents += event
    }

    override suspend fun getTranscriptEvents(
        projectId: String,
        runId: String,
        phaseId: String
    ): Result<List<TranscriptEvent>> {
        val page = getEventPage(projectId, runId, 0L).getOrNull()
        val events = page?.events?.let { evList ->
            val phaseEvents = if (phaseId.isBlank()) evList else evList.filter { it.phaseId == phaseId }
            phaseEvents.map { ev ->
                TranscriptEvent(
                    id = ev.eventId.ifBlank { "ev_${ev.rowid}" },
                    phaseId = ev.phaseId.orEmpty(),
                    type = ev.type,
                    timestamp = ev.startedAt,
                    content = ev.textContent.ifBlank { ev.name },
                    toolName = ev.toolName,
                    durationMs = null,
                    isSuccess = !ev.isError,
                    toolArgs = ev.payload["args"]?.toString(),
                    toolOutput = ev.resultText
                )
            }
        } ?: emptyList()
        return Result.success(events)
    }

    override suspend fun getInterrupts(): Result<List<PendingInterrupt>> {
        return Result.success(_pendingInterrupts.value)
    }

    fun setPendingInterrupts(interrupts: List<PendingInterrupt>) {
        _pendingInterrupts.value = interrupts
    }

    override suspend fun startRun(input: StartRunInput): Result<CompanionStartResult> {
        if (input.request.isBlank()) {
            return Result.success(
                CompanionStartResult(
                    ok = false,
                    issues = listOf(ValidationIssue("error", "Describe what to build: request cannot be empty."))
                )
            )
        }
        val newRunId = "run_260818_" + UUID.randomUUID().toString().take(6)
        val newRun = RunRow(
            runId = newRunId,
            projectId = input.projectId,
            pipelineId = input.pipelineId,
            pipelineName = samplePipelines.find { it.id == input.pipelineId }?.name ?: "Custom Pipeline",
            request = input.request,
            status = "running",
            createdAt = "2026-08-18T23:50:00Z",
            durationMs = 1000,
            totalTokens = 450,
            branch = "foundry/$newRunId",
            phases = livePhaseSummaries
        )
        runsList.add(0, newRun)
        return Result.success(CompanionStartResult(ok = true, runId = newRunId))
    }

    override suspend fun killRun(projectId: String, runId: String): Result<CompanionKillResult> {
        val index = runsList.indexOfFirst { it.runId == runId }
        if (index != -1) {
            val existing = runsList[index]
            runsList[index] = existing.copy(
                status = "killed",
                outcomeDetail = "Operator killed run. In-flight agent turns stopped; worktree branch preserved."
            )
        }
        return Result.success(CompanionKillResult(ok = true))
    }

    override suspend fun answerInterrupt(answer: InterruptAnswer): Result<CompanionAnswerResult> {
        _pendingInterrupts.value = _pendingInterrupts.value.filterNot { it.interruptId == answer.interruptId }
        return Result.success(CompanionAnswerResult(ok = true))
    }

    private var fakeGhStatus: GhStatus = GhStatus(
        available = true,
        detail = "gh is signed in; repo resolves to foundry-app/foundry",
        repo = "foundry-app/foundry"
    )

    fun setFakeGhStatus(status: GhStatus) {
        fakeGhStatus = status
    }

    override suspend fun getPrStatus(projectId: String): Result<GhStatus> {
        return Result.success(fakeGhStatus)
    }

    override suspend fun createPr(
        projectId: String,
        runId: String,
        request: CompanionPrCreateRequest
    ): Result<PrAction> {
        if (!fakeGhStatus.available) {
            return Result.success(
                PrAction(
                    ok = false,
                    detail = fakeGhStatus.detail.ifBlank { "GitHub CLI (gh) is not installed or not on PATH" }
                )
            )
        }
        val index = runsList.indexOfFirst { it.runId == runId }
        if (index != -1) {
            val existing = runsList[index]
            val updated = existing.copy(
                prNumber = 133,
                prUrl = "https://github.com/foundry-app/foundry/pull/133"
            )
            runsList[index] = updated
        }
        return Result.success(
            PrAction(
                ok = true,
                number = 133,
                prUrl = "https://github.com/foundry-app/foundry/pull/133",
                url = "https://github.com/foundry-app/foundry/pull/133"
            )
        )
    }

    override suspend fun retryConnection() {
        val session = _activeSession.value
        if (session != null) {
            _connectionStatus.value = ConnectionStatus.Connected(session.desktopName, session.hostOrigin)
        }
    }
}
