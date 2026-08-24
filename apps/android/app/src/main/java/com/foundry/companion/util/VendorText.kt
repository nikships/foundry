package com.foundry.companion.util

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * Some providers echo a tool invocation as assistant text — a JSON object
 * whose only key is `functionCall` / `functionResponse`, or a one-line
 * `Ran \`tool\`.` narration. The real work already has a tool row.
 */
private val RAN_TOOL = Regex("""^Ran\s+`[^`]+`\.?\s*$""", RegexOption.IGNORE_CASE)
private val FUNCTION_CALL_START = Regex("""^\s*\{\s*"(?:functionCall|functionResponse)"(\s|:|$)""")
private val FUNCTION_CALL_OBJECT = Regex("""\s*\{\s*"(?:functionCall|functionResponse)"\s*:""")

fun isVendorFunctionCallPayload(text: String): Boolean =
    isVendorFunctionPayload(parseObject(text.trim()))

fun isIncompleteFunctionCallJson(text: String): Boolean {
    val trimmed = text.trim()
    if (!trimmed.startsWith("{") || isVendorFunctionCallPayload(trimmed)) return false
    if (parseObject(trimmed) != null) return false
    return FUNCTION_CALL_START.containsMatchIn(trimmed)
}

fun stripVendorToolEcho(text: String): String {
    val withoutRan = text.lineSequence().filterNot { RAN_TOOL.matches(it.trim()) }.joinToString("\n")
    val trimmed = withoutRan.trim()
    if (trimmed.isEmpty()) return ""
    if (isVendorFunctionCallPayload(trimmed)) return ""
    val match = FUNCTION_CALL_OBJECT.find(withoutRan)
    if (match != null && isVendorFunctionCallPayload(withoutRan.substring(match.range.first))) {
        return withoutRan.substring(0, match.range.first).trimEnd()
    }
    return withoutRan
}

fun isHiddenVendorText(text: String): Boolean {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return true
    if (isIncompleteFunctionCallJson(trimmed)) return true
    return stripVendorToolEcho(text).trim().isEmpty()
}

private fun isVendorFunctionPayload(value: JsonObject?): Boolean {
    if (value == null || value.size != 1) return false
    val key = value.keys.single()
    return key == "functionCall" || key == "functionResponse"
}

private fun parseObject(text: String): JsonObject? = runCatching {
    Json.parseToJsonElement(text) as? JsonObject
}.getOrNull()
