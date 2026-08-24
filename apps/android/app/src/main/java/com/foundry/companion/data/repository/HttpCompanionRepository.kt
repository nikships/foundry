package com.foundry.companion.data.repository

import com.foundry.companion.data.mapper.RunDetailMapper
import com.foundry.companion.data.mapper.RunNotFoundException
import com.foundry.companion.data.model.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
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
    },
    private val coroutineScope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
) : CompanionRepository {

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private val _activeSession = MutableStateFlow<PairedSession?>(null)
    override val activeSession: StateFlow<PairedSession?> = _activeSession.asStateFlow()

    private val _connectionStatus = MutableStateFlow<ConnectionStatus>(ConnectionStatus.Unpaired)
    override val connectionStatus: StateFlow<ConnectionStatus> = _connectionStatus.asStateFlow()

    private val _pendingInterrupts = MutableStateFlow<List<PendingInterrupt>>(emptyList())
    override val pendingInterrupts: StateFlow<List<PendingInterrupt>> = _pendingInterrupts.asStateFlow()

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
        _pendingInterrupts.value = emptyList()
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
        _pendingInterrupts.value = emptyList()
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
                        consecutiveFailures++
                        if (consecutiveFailures >= 3) {
                            _connectionStatus.value = ConnectionStatus.Offline(session.desktopName, session.hostOrigin)
                        }
                    }
                } catch (_: Exception) {
                    consecutiveFailures++
                    if (consecutiveFailures >= 3) {
                        _connectionStatus.value = ConnectionStatus.Offline(session.desktopName, session.hostOrigin)
                    }
                }
                backoffDelay = minOf(15000L, backoffDelay * 2)
            }
        }
    }

    override suspend fun getSessionInfo(): Result<CompanionSessionInfo> = withContext(Dispatchers.IO) {
        try {
            val request = authenticatedRequestBuilder("/v1/session").get().build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            val session = _activeSession.value
            if (session != null && _connectionStatus.value !is ConnectionStatus.Connected) {
                _connectionStatus.value = ConnectionStatus.Connected(session.desktopName, session.hostOrigin)
            }
            Result.success(json.decodeFromString(CompanionSessionInfo.serializer(), body))
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun getProjects(): Result<List<CompanionProjectSummary>> = withContext(Dispatchers.IO) {
        try {
            val request = authenticatedRequestBuilder("/v1/projects").get().build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            val projects = json.decodeFromString<List<CompanionProjectSummary>>(body)
            Result.success(projects)
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun getRuns(projectId: String): Result<List<RunRow>> = withContext(Dispatchers.IO) {
        try {
            val request = authenticatedRequestBuilder("/v1/projects/$projectId/runs").get().build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            val runs = json.decodeFromString<List<RunRow>>(body)
            Result.success(runs)
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun getRunDetail(projectId: String, runId: String): Result<RunDetail> = withContext(Dispatchers.IO) {
        try {
            val request = authenticatedRequestBuilder("/v1/projects/$projectId/runs/$runId").get().build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            val host = json.decodeFromString(HostRunDetail.serializer(), body)
            // The desktop answers 200 with `run: null` for a run it does not have,
            // so a missing run is a body shape rather than a status code.
            val detail = RunDetailMapper.map(host)
                ?: return@withContext Result.failure(RunNotFoundException(runId))
            Result.success(detail)
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun getEventPage(
        projectId: String,
        runId: String,
        after: Long
    ): Result<EventPage> = withContext(Dispatchers.IO) {
        try {
            val url = if (after > 0) "/v1/projects/$projectId/runs/$runId/events?after=$after"
            else "/v1/projects/$projectId/runs/$runId/events"
            val request = authenticatedRequestBuilder(url).get().build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            val eventPage = json.decodeFromString(EventPage.serializer(), body)
            Result.success(eventPage)
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun getTranscriptEvents(
        projectId: String,
        runId: String,
        phaseId: String
    ): Result<List<TranscriptEvent>> = withContext(Dispatchers.IO) {
        try {
            val res = getEventPage(projectId, runId, 0L)
            if (res.isSuccess) {
                val page = res.getOrThrow()
                val phaseEvents = if (phaseId.isBlank()) page.events else page.events.filter { it.phaseId == phaseId }
                val transcriptEvents = phaseEvents.map { ev ->
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
                Result.success(transcriptEvents)
            } else {
                Result.failure(res.exceptionOrNull() ?: IOException("Failed to fetch events"))
            }
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun getInterrupts(): Result<List<PendingInterrupt>> = withContext(Dispatchers.IO) {
        try {
            val request = authenticatedRequestBuilder("/v1/interrupts").get().build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            val interrupts = json.decodeFromString<List<PendingInterrupt>>(body)
            _pendingInterrupts.value = interrupts
            Result.success(interrupts)
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun startRun(input: StartRunInput): Result<CompanionStartResult> = withContext(Dispatchers.IO) {
        try {
            val reqBody = json.encodeToString(StartRunInput.serializer(), input).toRequestBody(jsonMediaType)
            val request = authenticatedRequestBuilder("/v1/runs").post(reqBody).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            val res = json.decodeFromString(CompanionStartResult.serializer(), body)
            Result.success(res)
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun killRun(projectId: String, runId: String): Result<CompanionKillResult> = withContext(Dispatchers.IO) {
        try {
            val request = authenticatedRequestBuilder("/v1/projects/$projectId/runs/$runId/kill")
                .post("{}".toRequestBody(jsonMediaType))
                .build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            val res = json.decodeFromString(CompanionKillResult.serializer(), body)
            Result.success(res)
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun continueRun(projectId: String, runId: String): Result<CompanionContinueResult> = withContext(Dispatchers.IO) {
        try {
            val request = authenticatedRequestBuilder("/v1/projects/$projectId/runs/$runId/continue")
                .post("{}".toRequestBody(jsonMediaType))
                .build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            Result.success(json.decodeFromString(CompanionContinueResult.serializer(), body))
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun answerInterrupt(answer: InterruptAnswer): Result<CompanionAnswerResult> = withContext(Dispatchers.IO) {
        try {
            val reqBody = json.encodeToString(InterruptAnswer.serializer(), answer).toRequestBody(jsonMediaType)
            val request = authenticatedRequestBuilder("/v1/interrupts/answer").post(reqBody).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            val res = json.decodeFromString(CompanionAnswerResult.serializer(), body)
            _pendingInterrupts.value = _pendingInterrupts.value.filterNot { it.interruptId == answer.interruptId }
            Result.success(res)
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun getPrStatus(projectId: String): Result<GhStatus> = withContext(Dispatchers.IO) {
        try {
            val request = authenticatedRequestBuilder("/v1/projects/$projectId/pr-status").get().build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            val res = json.decodeFromString(GhStatus.serializer(), body)
            Result.success(res)
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun getPrDraft(
        projectId: String,
        runId: String
    ): Result<CompanionPrDraft> = withContext(Dispatchers.IO) {
        try {
            val request = authenticatedRequestBuilder("/v1/projects/$projectId/runs/$runId/pr-draft")
                .get()
                .build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            val res = json.decodeFromString(CompanionPrDraft.serializer(), body)
            Result.success(res)
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun createPr(
        projectId: String,
        runId: String,
        request: CompanionPrCreateRequest
    ): Result<PrAction> = withContext(Dispatchers.IO) {
        try {
            val reqBody = json.encodeToString(CompanionPrCreateRequest.serializer(), request).toRequestBody(jsonMediaType)
            val req = authenticatedRequestBuilder("/v1/projects/$projectId/runs/$runId/pr").post(reqBody).build()
            val response = client.newCall(req).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            val res = json.decodeFromString(PrAction.serializer(), body)
            Result.success(res)
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun getSmithState(projectId: String?): Result<SmithChatState> = withContext(Dispatchers.IO) {
        try {
            val path = if (projectId.isNullOrBlank()) "/v1/smith" else "/v1/smith?projectId=$projectId"
            val request = authenticatedRequestBuilder(path).get().build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            Result.success(json.decodeFromString(SmithChatState.serializer(), body))
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun sendSmith(
        projectId: String?,
        text: String,
        screen: SmithScreenContext
    ): Result<SmithChatState> = withContext(Dispatchers.IO) {
        try {
            val reqBody = json.encodeToString(
                SmithSendRequest.serializer(),
                SmithSendRequest(projectId = projectId?.takeIf { it.isNotBlank() }, text = text, screen = screen)
            ).toRequestBody(jsonMediaType)
            val request = authenticatedRequestBuilder("/v1/smith/send").post(reqBody).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            Result.success(json.decodeFromString(SmithChatState.serializer(), body))
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun cancelSmith(projectId: String?): Result<SmithChatState> =
        postSmithScope("/v1/smith/cancel", projectId)

    override suspend fun newSmithChat(projectId: String?): Result<SmithChatState> =
        postSmithScope("/v1/smith/new", projectId)

    private suspend fun postSmithScope(path: String, projectId: String?): Result<SmithChatState> =
        withContext(Dispatchers.IO) {
            try {
                val reqBody = json.encodeToString(
                    SmithScopeRequest.serializer(),
                    SmithScopeRequest(projectId = projectId?.takeIf { it.isNotBlank() })
                ).toRequestBody(jsonMediaType)
                val request = authenticatedRequestBuilder(path).post(reqBody).build()
                val response = client.newCall(request).execute()
                val body = response.body?.string().orEmpty()
                if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
                consecutiveFailures = 0
                Result.success(json.decodeFromString(SmithChatState.serializer(), body))
            } catch (e: Exception) {
                handleNetworkError(e)
                Result.failure(e)
            }
        }

    override suspend fun getSmithProposals(): Result<List<SmithProposal>> = withContext(Dispatchers.IO) {
        try {
            val request = authenticatedRequestBuilder("/v1/smith/proposals").get().build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            Result.success(json.decodeFromString(kotlinx.serialization.builtins.ListSerializer(SmithProposal.serializer()), body))
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

    override suspend fun answerSmithProposal(
        id: String,
        answer: SmithProposalAnswer
    ): Result<SmithProposalAnswerResult> = withContext(Dispatchers.IO) {
        try {
            val reqBody = json.encodeToString(
                SmithProposalAnswerRequest.serializer(),
                SmithProposalAnswerRequest(id = id, answer = answer)
            ).toRequestBody(jsonMediaType)
            val request = authenticatedRequestBuilder("/v1/smith/proposals/answer").post(reqBody).build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            consecutiveFailures = 0
            Result.success(json.decodeFromString(SmithProposalAnswerResult.serializer(), body))
        } catch (e: Exception) {
            handleNetworkError(e)
            Result.failure(e)
        }
    }

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
