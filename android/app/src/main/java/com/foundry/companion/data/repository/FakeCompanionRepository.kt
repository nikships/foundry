package com.foundry.companion.data.repository

import com.foundry.companion.data.model.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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

    override suspend fun getTranscriptEvents(
        projectId: String,
        runId: String,
        phaseId: String
    ): Result<List<TranscriptEvent>> {
        val events = listOf(
            TranscriptEvent(
                id = "ev_1",
                phaseId = phaseId,
                type = "text",
                timestamp = "23:30:05",
                content = "Inspecting workspace and reading specs/companion-android-ui.md to understand the companion visual architecture."
            ),
            TranscriptEvent(
                id = "ev_2",
                phaseId = phaseId,
                type = "tool_call",
                timestamp = "23:30:12",
                content = "Read specs/companion-android-ui.md",
                toolName = "Read",
                durationMs = 240,
                isSuccess = true,
                toolArgs = "{\"file_path\": \"specs/companion-android-ui.md\"}",
                toolOutput = "# Companion Android UI and Information Architecture (FOU-82)..."
            ),
            TranscriptEvent(
                id = "ev_3",
                phaseId = phaseId,
                type = "text",
                timestamp = "23:30:18",
                content = "Scaffolding Jetpack Compose theme tokens and navigation graph matching the dark industrial palette."
            ),
            TranscriptEvent(
                id = "ev_4",
                phaseId = phaseId,
                type = "tool_call",
                timestamp = "23:30:25",
                content = "Create android/app/src/main/java/com/foundry/companion/ui/theme/Color.kt",
                toolName = "Create",
                durationMs = 180,
                isSuccess = true,
                toolArgs = "{\"file_path\": \"android/app/.../Color.kt\"}",
                toolOutput = "File created successfully."
            ),
            TranscriptEvent(
                id = "ev_5",
                phaseId = phaseId,
                type = "gate",
                timestamp = "23:30:35",
                content = "Gate: Theme tokens pass strict dark palette requirements.",
                isSuccess = true
            ),
            TranscriptEvent(
                id = "ev_6",
                phaseId = phaseId,
                type = "text",
                timestamp = "23:30:42",
                content = "Verifying Gradle assembleDebug build and test execution."
            )
        )
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

    override suspend fun createPr(
        projectId: String,
        runId: String,
        request: CompanionPrCreateRequest
    ): Result<PrAction> {
        val index = runsList.indexOfFirst { it.runId == runId }
        if (index != -1) {
            val existing = runsList[index]
            val updated = existing.copy(
                prUrl = "https://github.com/foundry-app/foundry/pull/133"
            )
            runsList[index] = updated
        }
        return Result.success(
            PrAction(
                ok = true,
                prUrl = "https://github.com/foundry-app/foundry/pull/133"
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
