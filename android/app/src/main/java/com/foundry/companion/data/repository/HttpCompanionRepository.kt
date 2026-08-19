package com.foundry.companion.data.repository

import com.foundry.companion.data.model.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
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
    }
) : CompanionRepository {

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private val _activeSession = MutableStateFlow<PairedSession?>(null)
    override val activeSession: StateFlow<PairedSession?> = _activeSession.asStateFlow()

    private val _connectionStatus = MutableStateFlow<ConnectionStatus>(ConnectionStatus.Unpaired)
    override val connectionStatus: StateFlow<ConnectionStatus> = _connectionStatus.asStateFlow()

    private val _pendingInterrupts = MutableStateFlow<List<PendingInterrupt>>(emptyList())
    override val pendingInterrupts: StateFlow<List<PendingInterrupt>> = _pendingInterrupts.asStateFlow()

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
                    401 -> "That code is expired or already used. Foundry shows a fresh one in Settings → Phone."
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
            return IOException("Unauthorized: Token revoked or invalid (HTTP 401)")
        }
        return IOException("HTTP $code: $body")
    }

    private fun handleUnauthorized() {
        _activeSession.value = null
        _connectionStatus.value = ConnectionStatus.Unpaired
        _pendingInterrupts.value = emptyList()
    }

    override suspend fun getSessionInfo(): Result<CompanionSessionInfo> = withContext(Dispatchers.IO) {
        try {
            val request = authenticatedRequestBuilder("/v1/session").get().build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
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
            val detail = json.decodeFromString(RunDetail.serializer(), body)
            Result.success(detail)
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
            val request = authenticatedRequestBuilder("/v1/projects/$projectId/runs/$runId/events").get().build()
            val response = client.newCall(request).execute()
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) return@withContext Result.failure(handleResponseError(response.code, body))
            val events = json.decodeFromString<List<TranscriptEvent>>(body)
            Result.success(events)
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
            val res = json.decodeFromString(CompanionKillResult.serializer(), body)
            Result.success(res)
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
            val res = json.decodeFromString(CompanionAnswerResult.serializer(), body)
            _pendingInterrupts.value = _pendingInterrupts.value.filterNot { it.interruptId == answer.interruptId }
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
            val res = json.decodeFromString(PrAction.serializer(), body)
            Result.success(res)
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
            _connectionStatus.value = ConnectionStatus.Connected(session.desktopName, session.hostOrigin)
        } else {
            _connectionStatus.value = ConnectionStatus.Offline(session.desktopName, session.hostOrigin)
        }
    }

    private fun handleNetworkError(e: Throwable) {
        val session = _activeSession.value ?: return
        _connectionStatus.value = ConnectionStatus.Reconnecting(session.desktopName, session.hostOrigin)
    }
}
