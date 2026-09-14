package com.foundry.companion.voice

import android.content.Context
import android.util.Base64
import com.foundry.companion.data.repository.CompanionRepository
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.*
import okhttp3.*
import okio.ByteString
import java.util.concurrent.TimeUnit

enum class VoicePhase { Idle, Connecting, Live, Error }

data class SmithVoiceState(
    val phase: VoicePhase = VoicePhase.Idle,
    val muted: Boolean = false,
    val amplitude: Float = 0f,
    val captions: List<VoiceCaption> = emptyList(),
    val detail: String? = null
)

/** Main-thread session owner. Generation fencing rejects callbacks from ended sockets. */
class SmithVoiceController(
    context: Context,
    private val repository: CompanionRepository,
    private val projectId: String?
) {
    private val context = context.applicationContext
    private val mutableState = MutableStateFlow(SmithVoiceState())
    val state = mutableState.asStateFlow()
    private var generation = 0
    @Volatile private var microphoneGeneration = 0
    private var scope: CoroutineScope? = null
    private var socket: WebSocket? = null
    private var audio: SmithVoiceAudio? = null
    private var deadline: Job? = null
    private var tools: SmithVoiceTools? = null
    private var inputTranscript = StringBuilder()
    private var pendingDelegationId: String? = null

    fun start() {
        if (state.value.phase == VoicePhase.Live || state.value.phase == VoicePhase.Connecting) return
        end()
        val id = generation
        val session = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        scope = session
        mutableState.value = SmithVoiceState(phase = VoicePhase.Connecting)
        val pairing = repository.activeSession.value
        session.launch {
            repository.activeSession.collect { if (it == null || it != pairing) end() }
        }
        if (id != generation) return
        tools = SmithVoiceTools(repository, projectId, session) { result ->
            val delegationId = pendingDelegationId
            if (id == generation && delegationId != null) {
                send(SmithVoiceProtocol.commentary(delegationId, result.take(1800)))
            }
        }
        deadline = session.launch {
            delay(20000)
            fail("Voice connection timed out. Try again.")
        }
        session.launch {
            try {
                val origin = pairing?.hostOrigin ?: error("Not paired")
                val wsUrl = origin.replaceFirst("http://", "ws://").replaceFirst("https://", "wss://") +
                    "/v1/smith/voice/live"
                socket = client.newWebSocket(
                    Request.Builder()
                        .url(wsUrl)
                        .header("Authorization", "Bearer ${pairing.token}")
                        .build(),
                    listener(id, session)
                )
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { if (id == generation) fail("Could not start voice. Connect the Mac and configure its OpenAI voice key, then retry.") }
        }
    }

    private fun listener(id: Int, session: CoroutineScope) = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            session.launch { if (id != generation) webSocket.cancel() }
        }
        override fun onMessage(webSocket: WebSocket, text: String) {
            session.launch {
                if (id != generation) return@launch
                try { receive(Json.parseToJsonElement(text).jsonObject, id, session) }
                catch (e: CancellationException) { throw e }
                catch (_: Exception) { fail("Voice received an invalid response. Please reconnect.") }
            }
        }
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = onMessage(webSocket, bytes.utf8())
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            session.launch { if (id == generation) fail("Voice disconnected. Check your connection and retry.") }
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            session.launch { if (id == generation) fail("Voice session ended. Start again to reconnect.") }
        }
    }

    private fun receive(message: JsonObject, id: Int, session: CoroutineScope) {
        val type = message["type"]?.jsonPrimitive?.contentOrNull
        if (type == "session.started" && state.value.phase == VoicePhase.Connecting) {
            deadline?.cancel()
            val device = SmithVoiceAudio(context, session, onInput = { bytes ->
                val capture = microphoneGeneration
                session.launch {
                    if (id == generation && capture == microphoneGeneration && !state.value.muted) {
                        send(SmithVoiceProtocol.inputAudio(Base64.encodeToString(bytes, Base64.NO_WRAP)))
                    }
                }
            }, onError = { session.launch { if (id == generation) fail("Audio became unavailable. Check microphone permission and try again.") } })
            audio = device
            device.start()
            mutableState.update { it.copy(phase = VoicePhase.Live) }
            session.launch {
                while (isActive) {
                    mutableState.update { it.copy(amplitude = device.level) }
                    delay(20)
                }
            }
            return
        }
        if (type == "session.closed") {
            fail("Voice session ended. Start again to reconnect.")
            return
        }
        if (type == "error") {
            fail("Voice session ended. Start again to reconnect.")
            return
        }
        if (type == "session.input_transcript.delta") {
            val delta = message["delta"]?.jsonPrimitive?.content.orEmpty()
            inputTranscript.append(delta)
            mutableState.update { it.copy(captions = appendVoiceCaption(it.captions, "You", delta)) }
            return
        }
        if (type == "session.output_transcript.delta") {
            val delta = message["delta"]?.jsonPrimitive?.content.orEmpty()
            mutableState.update { it.copy(captions = appendVoiceCaption(it.captions, "Smith", delta)) }
            return
        }
        if (type == "session.output_audio.delta") {
            val data = message["delta"]?.jsonPrimitive?.content ?: return
            if (audio?.enqueue(Base64.decode(data, Base64.DEFAULT)) == false) {
                fail("Voice playback fell behind. Please reconnect.")
            }
            return
        }
        if (type == "session.delegation.created") {
            val delegationId = message["delegation"]?.jsonObject?.get("id")?.jsonPrimitive?.content ?: return
            val request = inputTranscript.toString().trim()
            inputTranscript = StringBuilder()
            pendingDelegationId = delegationId
            val bridge = tools ?: return
            session.launch {
                val response = bridge.call("smith_delegate", voiceObject("text" to voiceText(request)))
                ensureActive()
                if (id != generation) return@launch
                val error = response["error"]?.jsonPrimitive?.content
                if (error != null) send(SmithVoiceProtocol.commentary(delegationId, error.take(1800)))
            }
        }
    }

    fun mute() {
        if (state.value.phase != VoicePhase.Live) return
        microphoneGeneration++
        val muted = !state.value.muted
        mutableState.update { it.copy(muted = muted) }
        try {
            audio?.mute(muted)
            send(SmithVoiceProtocol.mute(muted))
        } catch (_: Exception) { fail("Microphone unavailable. Check permission and try again.") }
    }

    private fun send(message: JsonObject) {
        val current = socket ?: return
        if (current.queueSize() > 512_000 || !current.send(message.toString())) {
            fail("Voice connection is too slow. Please reconnect.")
        }
    }

    fun end() {
        generation++
        microphoneGeneration++
        scope?.cancel()
        scope = null
        socket?.cancel()
        socket = null
        audio?.close()
        audio = null
        tools = null
        pendingDelegationId = null
        inputTranscript = StringBuilder()
        mutableState.update { it.copy(phase = VoicePhase.Idle, muted = false, amplitude = 0f, detail = null) }
    }

    private fun fail(detail: String) {
        end()
        mutableState.update { it.copy(phase = VoicePhase.Error, detail = detail) }
    }

    companion object {
        private val client = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS).pingInterval(20, TimeUnit.SECONDS).build()
    }
}
