package com.foundry.companion.voice

import kotlinx.serialization.json.*

internal fun voiceObject(vararg fields: Pair<String, JsonElement>) = JsonObject(mapOf(*fields))
internal fun voiceText(text: String) = JsonPrimitive(text)

internal object SmithVoiceProtocol {
    fun inputAudio(base64: String) = voiceObject(
        "type" to voiceText("session.input_audio.append"),
        "audio" to voiceText(base64)
    )

    fun mute(muted: Boolean) = voiceObject(
        "type" to voiceText(if (muted) "session.input_audio.mute" else "session.input_audio.unmute")
    )

    fun commentary(delegationId: String, content: String) = voiceObject(
        "type" to voiceText("session.commentary.append"),
        "delegation_id" to voiceText(delegationId),
        "content" to voiceText(content)
    )
}

data class VoiceCaption(val speaker: String, val text: String)

internal fun appendVoiceCaption(captions: List<VoiceCaption>, speaker: String, text: String): List<VoiceCaption> {
    if (text.isEmpty()) return captions
    val last = captions.lastOrNull()
    val next = if (last?.speaker == speaker) {
        captions.dropLast(1) + last.copy(text = (last.text + text).takeLast(2000))
    } else captions + VoiceCaption(speaker, text.takeLast(2000))
    return next.takeLast(12)
}
