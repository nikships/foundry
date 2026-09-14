package com.foundry.companion.voice

import com.foundry.companion.data.model.SmithVoiceToken
import kotlinx.serialization.json.*

internal fun voiceObject(vararg fields: Pair<String, JsonElement>) = JsonObject(mapOf(*fields))
internal fun voiceText(text: String) = JsonPrimitive(text)

internal object SmithVoiceProtocol {
    private fun declaration(name: String, description: String, properties: JsonObject = voiceObject()) =
        buildJsonObject {
            put("name", name)
            put("description", description)
            putJsonObject("parameters") {
                put("type", "OBJECT")
                put("properties", properties)
                put("required", JsonArray(properties.keys.map(::JsonPrimitive)))
            }
        }

    fun setup(token: SmithVoiceToken): JsonObject = buildJsonObject {
        putJsonObject("setup") {
            put("model", "models/${token.model.removePrefix("models/")}")
            putJsonObject("generationConfig") {
                put("responseModalities", JsonArray(listOf(voiceText("AUDIO"))))
                putJsonObject("thinkingConfig") { put("thinkingLevel", "HIGH") }
            }
            putJsonObject("systemInstruction") {
                put("parts", JsonArray(listOf(voiceObject("text" to voiceText(token.systemInstruction)))))
            }
            put("inputAudioTranscription", voiceObject())
            put("outputAudioTranscription", voiceObject())
            put("contextWindowCompression", voiceObject("slidingWindow" to voiceObject()))
            put("tools", JsonArray(listOf(voiceObject("functionDeclarations" to JsonArray(listOf(
                declaration("smith_delegate", "Start work in the existing Smith chat; completion arrives later.",
                    voiceObject("text" to voiceObject("type" to voiceText("STRING")))),
                declaration("smith_cancel", "Cancel work in this Smith chat."),
                declaration("smith_proposal_read", "Read the pending proposal before asking for approval."),
                declaration("smith_proposal_answer", "Answer only the proposal just read, with explicit user consent. Never request or send secrets by voice.",
                    voiceObject("approved" to voiceObject("type" to voiceText("BOOLEAN"))))
            ))))))
        }
    }

    fun realtime(field: String, value: JsonElement) = voiceObject("realtimeInput" to voiceObject(field to value))

    fun reply(id: String, name: String, response: JsonObject) = voiceObject(
        "toolResponse" to voiceObject("functionResponses" to JsonArray(listOf(voiceObject(
            "id" to voiceText(id), "name" to voiceText(name), "response" to response
        ))))
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
