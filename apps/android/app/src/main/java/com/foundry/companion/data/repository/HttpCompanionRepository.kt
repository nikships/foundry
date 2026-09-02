package com.foundry.companion.data.repository

import com.foundry.companion.data.mapper.RunDetailMapper
import com.foundry.companion.data.mapper.RunNotFoundException
import com.foundry.companion.data.model.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

class HttpCompanionRepository(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build(),
    private val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
        // A null plan must mean "no plan", not a malformed `"plan":null` body.
        explicitNulls = false
    },
    private val coroutineScope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
) : CompanionRepository {

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private val _activeSession = MutableStateFlow<PairedSession?>(null)
    override val activeSession: StateFlow<PairedSession?> = _activeSession.asStateFlow()

    private val _connectionStatus = MutableStateFlow<ConnectionStatus>(ConnectionStatus.Unpaired)
    override val connectionStatus: StateFlow<ConnectionStatus> = _connectionStatus.asStateFlow()

    private var consecutiveFailures = 0
    private var reconnectJob: Job? = null

    override suspend fun pair(
        payload: CompanionPairingPayload,
        deviceName: String
    ): Result<CompanionPairResult> = withContext(Dispatchers.IO) {
        try {
            val reqBody = json.encodeToString(
                CompanionPairRequest.serializer(),
                CompanionPairRequest(
                    protocolVersion = payload.protocolVersion,
                    secret = payload.secret,
                    deviceName = deviceName
                )
            ).toRequestBody(jsonMediaType)

            val request = Request.Builder()
                .url("${payload.origin}/pair")
                .post(reqBody)
                .build()

            val response = client.newCall(request).execute()
            val bodyString = response.body?.string().orEmpty()

            if (!response.isSuccessful) {
                val errorMsg = when (response.code) {
                    401 -> "That code is expired or already used. Foundry shows a fresh one in Settings → Companion."
                    409 -> "Protocol mismatch: Desktop is v${payload.protocolVersion}, Phone is v$COMPANION_PROTOCOL_VERSION. Update the older app."
                    else -> "Pairing failed (HTTP ${response.code}): $bodyString"
                }
                return@withContext Result.failure(IOException(errorMsg))
            }

            val pairResult = json.decodeFromString(CompanionPairResult.serializer(), bodyString)
            val session = PairedSession(
                token = pairResult.token,
                desktopId = pairResult.desktopId,
                desktopName = pairResult.desktopName,
                hostOrigin = payload.origin,
                pairedAt = java.time.Instant.now().toString(),
                protocolVersion = pairResult.protocolVersion
            )
            consecutiveFailures = 0
            reconnectJob?.cancel()
            _activeSession.value = session
            _connectionStatus.value = ConnectionStatus.Connected(session.desktopName, session.hostOrigin)
            Result.success(pairResult)
        } catch (e: Exception) {
            val failure = if (e is IOException && e.message?.contains("Pairing failed") != true && e.message?.contains("That code is") != true && e.message?.contains("Protocol mismatch") != true) {
                IOException("Found the code, but can't reach the desktop (${payload.origin}) — is this phone on the same Wi-Fi?")
            } else {
                e
            }
            Result.failure(failure)
        }
    }

    override suspend fun unpair() = withContext(Dispatchers.IO) {
        reconnectJob?.cancel()
        reconnectJob = null
        consecutiveFailures = 0
        val session = _activeSession.value
        if (session != null) {
            try {
                val req = authenticatedRequestBuilder("/v1/unpair")
                    .post("{}".toRequestBody(jsonMediaType))
                    .build()
                client.newCall(req).execute()
            } catch (_: Exception) {
                // Best-effort remote unpair
            }
        }
        _activeSession.value = null
        _connectionStatus.value = ConnectionStatus.Unpaired
    }

    override fun injectFakeSession(session: PairedSession) {
        consecutiveFailures = 0
        reconnectJob?.cancel()
        _activeSession.value = session
        _connectionStatus.value = ConnectionStatus.Connected(session.desktopName, session.hostOrigin)
    }

    private fun authenticatedRequestBuilder(path: String): Request.Builder {
        val session = _activeSession.value ?: throw IllegalStateException("Not paired")
        return Request.Builder()
            .url("${session.hostOrigin}$path")
            .header("Authorization", "Bearer ${session.token}")
    }

    private fun handleResponseError(code: Int, body: String): IOException {
        if (code == 401) {
            handleUnauthorized()
            return IOException("The desktop revoked this phone's pairing. Scan a fresh code in Settings → Companion to reconnect.")
        }
        return IOException("HTTP $code: $body")
    }

    private fun handleUnauthorized() {
        reconnectJob?.cancel()
        reconnectJob = null
        consecutiveFailures = 0
        _activeSession.value = null
        _connectionStatus.value = ConnectionStatus.Unpaired
    }

    private fun handleNetworkError(e: Throwable) {
        val session = _activeSession.value ?: return
        consecutiveFailures++
        if (consecutiveFailures >= 3) {
            _connectionStatus.value = ConnectionStatus.Offline(session.desktopName, session.hostOrigin)
        } else {
            _connectionStatus.value = ConnectionStatus.Reconnecting(session.desktopName, session.hostOrigin)
        }
        startAutoReconnect(session)
    }

    private fun noteReconnectFailure(session: PairedSession) {
        consecutiveFailures++
        if (consecutiveFailures >= 3) {
            _connectionStatus.value = ConnectionStatus.Offline(session.desktopName, session.hostOrigin)
        }
    }

    private fun startAutoReconnect(session: PairedSession) {
        if (reconnectJob?.isActive == true) return
        reconnectJob = coroutineScope.launch {
            var backoffDelay = 1000L
            while (isActive && _activeSession.value != null && _connectionStatus.value !is ConnectionStatus.Connected) {
                delay(backoffDelay)
                if (_activeSession.value == null) break
                try {
                    val request = authenticatedRequestBuilder("/v1/session").get().build()
                    val response = client.newCall(request).execute()
                    if (response.isSuccessful) {
                        consecutiveFailures = 0
                        _connectionStatus.value = ConnectionStatus.Connected(session.desktopName, session.hostOrigin)
                        break
                    } else if (response.code == 401) {
                        handleUnauthorized()
                        break
                    } else {
                        noteReconnectFailure(session)
                    }
                } catch (_: Exception) {
                    noteReconnectFailure(session)
                }
                backoffDelay = minOf(15000L, backoffDelay * 2)
            }
        }
    }

    private fun Request.Builder.postJson(body: String = "{}"): Request.Builder =
        post(body.toRequestBody(jsonMediaType))

    private suspend fun <T> authenticatedCall(
        path: String,
        configure: (Request.Builder) -> Request.Builder,
        decode: (String) -> T
    ): Result<T> = withContext(Dispatchers.IO) {
        try {
            val request = configure(authenticatedRequestBuilder(path)).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                return@withContext Result.failure(handleResponseError(response.code, body))
            }
            consecutiveFailures = 0
            Result.success(decode(body))
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    private suspend fun <T> getJson(path: String, serializer: KSerializer<T>): Result<T> =
        authenticatedCall(path, { it.get() }) { json.decodeFromString(serializer, it) }

    private suspend fun <T> postJson(
        path: String,
        serializer: KSerializer<T>,
        body: String = "{}"
    ): Result<T> =
        authenticatedCall(path, { it.postJson(body) }) { json.decodeFromString(serializer, it) }

    private fun <T> encode(serializer: KSerializer<T>, value: T): String =
        json.encodeToString(serializer, value)

    private fun scopedProjectId(projectId: String?): String? =
        projectId?.takeIf { it.isNotBlank() }

    override suspend fun getSessionInfo(): Result<CompanionSessionInfo> {
        val result = getJson("/v1/session", CompanionSessionInfo.serializer())
        if (result.isSuccess) {
            val session = _activeSession.value
            if (session != null && _connectionStatus.value !is ConnectionStatus.Connected) {
                _connectionStatus.value = ConnectionStatus.Connected(session.desktopName, session.hostOrigin)
            }
        }
        return result
    }

    override suspend fun getProjects(): Result<List<CompanionProjectSummary>> =
        getJson("/v1/projects", ListSerializer(CompanionProjectSummary.serializer()))

    override suspend fun getRuns(projectId: String): Result<List<RunRow>> =
        getJson("/v1/projects/$projectId/runs", ListSerializer(RunRow.serializer()))

    override suspend fun getRunDetail(projectId: String, runId: String): Result<RunDetail> {
        val result = getJson("/v1/projects/$projectId/runs/$runId", HostRunDetail.serializer())
        val host = result.getOrElse { return Result.failure(it) }
        // The desktop answers 200 with `run: null` for a run it does not have,
        // so a missing run is a body shape rather than a status code.
        val detail = RunDetailMapper.map(host) ?: return Result.failure(RunNotFoundException(runId))
        return Result.success(detail)
    }

    override suspend fun getEventPage(
        projectId: String,
        runId: String,
        after: Long
    ): Result<EventPage> {
        val url = if (after > 0) "/v1/projects/$projectId/runs/$runId/events?after=$after"
        else "/v1/projects/$projectId/runs/$runId/events"
        return getJson(url, EventPage.serializer())
    }

    override suspend fun getTranscriptEvents(
        projectId: String,
        runId: String,
        phaseId: String
    ): Result<List<TranscriptEvent>> {
        return getEventPage(projectId, runId, 0L).map { page ->
            val phaseEvents = if (phaseId.isBlank()) page.events else page.events.filter { it.phaseId == phaseId }
            phaseEvents.map { it.toTranscriptEvent() }
        }
    }

    override suspend fun startRun(input: StartRunInput): Result<CompanionStartResult> =
        postJson("/v1/runs", CompanionStartResult.serializer(), encode(StartRunInput.serializer(), input))

    override suspend fun getOrchestratorOptions(): Result<OrchestratorOptions> =
        getJson("/v1/orchestrator/options", OrchestratorOptions.serializer())

    override suspend fun startOrchestratorPlan(
        request: OrchestratorStartRequest
    ): Result<OrchestratorStartResult> =
        postJson(
            "/v1/orchestrator/plans",
            OrchestratorStartResult.serializer(),
            encode(OrchestratorStartRequest.serializer(), request)
        )

    override suspend fun getOrchestratorPlan(planId: String): Result<OrchestratorState> =
        getJson("/v1/orchestrator/plans/$planId", OrchestratorState.serializer())

    override suspend fun cancelOrchestratorPlan(planId: String): Result<Boolean> =
        authenticatedCall(
            "/v1/orchestrator/plans/$planId/cancel",
            { it.postJson() }
        ) { json.decodeFromString(CompanionKillResult.serializer(), it).ok }

    override suspend fun getLinearState(): Result<LinearConnectionState> =
        getJson("/v1/linear", LinearConnectionState.serializer())

    override suspend fun searchLinearIssues(
        query: String
    ): Result<List<LinearIssueSnapshot>> {
        val encoded = URLEncoder.encode(query, StandardCharsets.UTF_8.name())
        return getJson("/v1/linear/issues?query=$encoded", ListSerializer(LinearIssueSnapshot.serializer()))
    }

    override suspend fun getLinearWorkflowStates(
        teamId: String
    ): Result<List<LinearWorkflowState>> =
        getJson(
            "/v1/linear/teams/$teamId/workflow-states",
            ListSerializer(LinearWorkflowState.serializer())
        )

    override suspend fun startLinearRun(
        input: LinearStartRunInput
    ): Result<CompanionStartResult> =
        postJson(
            "/v1/linear/runs",
            CompanionStartResult.serializer(),
            encode(LinearStartRunInput.serializer(), input)
        )

    override suspend fun killRun(projectId: String, runId: String): Result<CompanionKillResult> =
        postJson("/v1/projects/$projectId/runs/$runId/kill", CompanionKillResult.serializer())

    override suspend fun continueRun(projectId: String, runId: String): Result<CompanionContinueResult> =
        postJson("/v1/projects/$projectId/runs/$runId/continue", CompanionContinueResult.serializer())

    override suspend fun getRestorableCheckpoints(
        projectId: String,
        runId: String
    ): Result<RestorableCheckpointList> =
        getJson(
            "/v1/projects/$projectId/runs/$runId/checkpoints",
            RestorableCheckpointList.serializer()
        )

    override suspend fun restoreCheckpoint(
        projectId: String,
        runId: String,
        request: RestoreCheckpointRequest
    ): Result<RestoreResult> =
        postJson(
            "/v1/projects/$projectId/runs/$runId/restore",
            RestoreResult.serializer(),
            encode(RestoreCheckpointRequest.serializer(), request)
        )

    override suspend fun getPrStatus(projectId: String): Result<GhStatus> =
        getJson("/v1/projects/$projectId/pr-status", GhStatus.serializer())

    override suspend fun getPrDraft(
        projectId: String,
        runId: String
    ): Result<CompanionPrDraft> =
        getJson("/v1/projects/$projectId/runs/$runId/pr-draft", CompanionPrDraft.serializer())

    override suspend fun createPr(
        projectId: String,
        runId: String,
        request: CompanionPrCreateRequest
    ): Result<PrAction> =
        postJson(
            "/v1/projects/$projectId/runs/$runId/pr",
            PrAction.serializer(),
            encode(CompanionPrCreateRequest.serializer(), request)
        )

    override suspend fun getSmithState(projectId: String?): Result<SmithChatState> {
        val path = if (projectId.isNullOrBlank()) "/v1/smith" else "/v1/smith?projectId=$projectId"
        return getJson(path, SmithChatState.serializer())
    }

    override suspend fun sendSmith(
        projectId: String?,
        text: String,
        screen: SmithScreenContext
    ): Result<SmithChatState> =
        postJson(
            "/v1/smith/send",
            SmithChatState.serializer(),
            encode(
                SmithSendRequest.serializer(),
                SmithSendRequest(projectId = scopedProjectId(projectId), text = text, screen = screen)
            )
        )

    override suspend fun cancelSmith(projectId: String?): Result<SmithChatState> =
        postSmithScope("/v1/smith/cancel", projectId)

    override suspend fun newSmithChat(projectId: String?): Result<SmithChatState> =
        postSmithScope("/v1/smith/new", projectId)

    private suspend fun postSmithScope(path: String, projectId: String?): Result<SmithChatState> =
        postJson(
            path,
            SmithChatState.serializer(),
            encode(
                SmithScopeRequest.serializer(),
                SmithScopeRequest(projectId = scopedProjectId(projectId))
            )
        )

    override suspend fun getSmithProposals(): Result<List<SmithProposal>> =
        getJson("/v1/smith/proposals", ListSerializer(SmithProposal.serializer()))

    override suspend fun answerSmithProposal(
        id: String,
        answer: SmithProposalAnswer
    ): Result<SmithProposalAnswerResult> =
        postJson(
            "/v1/smith/proposals/answer",
            SmithProposalAnswerResult.serializer(),
            encode(
                SmithProposalAnswerRequest.serializer(),
                SmithProposalAnswerRequest(id = id, answer = answer)
            )
        )

    override suspend fun getSmithModels(): Result<List<SmithModelInfo>> =
        getJson("/v1/smith/models", ListSerializer(SmithModelInfo.serializer()))

    override suspend fun setSmithModel(projectId: String?, model: String): Result<SmithChatState> =
        postJson(
            "/v1/smith/model",
            SmithChatState.serializer(),
            encode(
                SmithModelRequest.serializer(),
                SmithModelRequest(projectId = scopedProjectId(projectId), model = model)
            )
        )

    override suspend fun setSmithEffort(projectId: String?, effort: String): Result<SmithChatState> =
        postJson(
            "/v1/smith/effort",
            SmithChatState.serializer(),
            encode(
                SmithEffortRequest.serializer(),
                SmithEffortRequest(projectId = scopedProjectId(projectId), effort = effort)
            )
        )

    override suspend fun retryConnection() {
        val session = _activeSession.value ?: return
        _connectionStatus.value = ConnectionStatus.Reconnecting(session.desktopName, session.hostOrigin)
        val result = getSessionInfo()
        if (result.isSuccess) {
            consecutiveFailures = 0
            _connectionStatus.value = ConnectionStatus.Connected(session.desktopName, session.hostOrigin)
            reconnectJob?.cancel()
            reconnectJob = null
        } else {
            consecutiveFailures++
            _connectionStatus.value = ConnectionStatus.Offline(session.desktopName, session.hostOrigin)
            startAutoReconnect(session)
        }
    }
}
