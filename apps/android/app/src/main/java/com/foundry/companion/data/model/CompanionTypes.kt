package com.foundry.companion.data.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

const val COMPANION_PROTOCOL_VERSION = 4

@Serializable
data class CompanionPairingPayload(
    val protocolVersion: Int = COMPANION_PROTOCOL_VERSION,
    val origin: String,
    val desktopId: String = "",
    val desktopName: String = "",
    val secret: String,
    val expiresAt: String = ""
)

@Serializable
data class CompanionPairRequest(
    val protocolVersion: Int = COMPANION_PROTOCOL_VERSION,
    val secret: String,
    val deviceName: String
)

@Serializable
data class CompanionPairResult(
    val token: String,
    val deviceId: String,
    val desktopId: String,
    val desktopName: String,
    val protocolVersion: Int
)

@Serializable
data class CompanionSessionInfo(
    val desktopId: String,
    val desktopName: String,
    val protocolVersion: Int,
    val appVersion: String
)

@Serializable
data class CompanionProjectSummary(
    val id: String,
    val name: String,
    val pipelines: List<PipelineSummary> = emptyList()
)

@Serializable
data class PipelineSummary(
    val id: String,
    val name: String,
    val description: String = "",
    val phases: List<PhaseTemplateSummary> = emptyList()
)

@Serializable
data class PhaseTemplateSummary(
    val id: String = "",
    val name: String,
    val kind: String = "agent", // "agent" | "code" | "review" | "engineer"
    val isFeedbackTarget: Boolean = false,
    val feedbackTo: String? = null
)

@Serializable
data class PhaseSummaryItem(
    val name: String,
    val status: String = "queued",
    val kind: String = "agent"
)

@Serializable
data class RunRow(
    val runId: String,
    val projectId: String = "",
    val pipelineId: String = "",
    val pipelineName: String = "",
    val request: String = "",
    val status: String = "queued", // "running" | "accepted" | "rejected" | "failed" | "killed"
    val startedAt: String = "",
    val endedAt: String? = null,
    val createdAt: String = "",
    val finishedAt: String? = null,
    val durationMs: Long? = null,
    val totalTokens: Long? = null,
    val worktreePath: String? = null,
    val branch: String? = null,
    val prNumber: Int? = null,
    val prUrl: String? = null,
    val issueNumber: Int? = null,
    val issueUrl: String? = null,
    val outcomeDetail: String? = null,
    val merged: Boolean = false,
    val archived: Boolean = false,
    val engineer: String = "",
    val waitingInterrupt: Boolean = false,
    val phases: List<PhaseRunSummary> = emptyList(),
    val phaseSummary: List<PhaseSummaryItem> = emptyList()
) {
    val isRunning: Boolean get() = status.equals("running", ignoreCase = true)
    val effectiveStartedAt: String get() = startedAt.ifEmpty { createdAt }
    val effectiveEndedAt: String? get() = endedAt ?: finishedAt
}

@Serializable
data class PhaseRunSummary(
    val id: String = "",
    val name: String,
    val kind: String = "agent",
    val status: String = "queued", // "queued" | "running" | "success" | "fail" | "skipped"
    val attempt: Int = 1,
    val durationMs: Long? = null,
    val tokens: Long? = null,
    val model: String? = null,
    val gateResults: List<GateResult> = emptyList(),
    val envelopeVerdict: String? = null,
    val changedFiles: List<String> = emptyList(),
    val errorMessage: String? = null,
    val phaseId: String = "",
    /** The agent that ran the phase, `"code"` for a command phase. */
    val owner: String = "",
    val startedAt: String? = null,
    val endedAt: String? = null
) {
    val resolvedId: String get() = id.ifBlank { phaseId }

    val isRunning: Boolean get() = status.equals("running", ignoreCase = true)
}

@Serializable
data class GateResult(
    val name: String,
    val passed: Boolean
)

@Serializable
data class RunDetail(
    val run: RunRow,
    val phases: List<PhaseRunSummary> = emptyList(),
    val live: Boolean = false
)

@Serializable
data class EventPage(
    val events: List<EventRow> = emptyList(),
    val cursor: Long = 0L
)

@Serializable
data class EventRow(
    val rowid: Long = 0L,
    val changeId: Long = 0L,
    val eventId: String = "",
    val runId: String = "",
    val phaseId: String? = null,
    val parentId: String? = null,
    val type: String = "",
    val name: String = "",
    val payload: JsonObject = JsonObject(emptyMap()),
    val tokens: Long = 0L,
    val startedAt: String = "",
    val endedAt: String? = null
) {
    val isOpen: Boolean get() = endedAt == null

    val isError: Boolean
        get() = payload.booleanOrNull("isError") == true || payload.booleanOrNull("passed") == false

    val inferKind: String get() {
        val kind = payload.stringOrNull("kind")
        if (!kind.isNullOrBlank()) return kind
        if (payload["argv"] != null) return "command"
        val head = name.split(":").firstOrNull()?.trim()?.lowercase() ?: ""
        return when (head) {
            "bash", "command" -> "command"
            "read" -> "read"
            "edit", "write", "create" -> "edit"
            "grep", "find", "ls", "search", "glob" -> "search"
            "report_progress" -> "progress"
            "submit_envelope", "read_phase_context" -> "envelope"
            "todo" -> "todo"
            "task" -> "task"
            "ask" -> "ask"
            else -> "other"
        }
    }

    val commandString: String get() {
        val fromArgs = payload.objOrNull("args")?.stringOrNull("command")
        if (!fromArgs.isNullOrBlank()) return fromArgs
        val argv = payload["argv"] as? JsonArray
        if (argv != null) {
            return argv.joinToString(" ") { (it as? JsonPrimitive)?.contentOrNull.orEmpty() }
        }
        val colon = name.indexOf(": ")
        return if (colon > 0) name.substring(colon + 2) else name
    }

    val toolName: String get() {
        val colon = name.indexOf(": ")
        return if (colon > 0) name.substring(0, colon) else name
    }

    val toolSummary: String get() {
        val colon = name.indexOf(": ")
        if (colon > 0) return name.substring(colon + 2)
        val argsObj = payload.objOrNull("args")
        if (argsObj != null) {
            val parts = mutableListOf<String>()
            for ((k, v) in argsObj) {
                val strVal = (v as? JsonPrimitive)?.contentOrNull
                if (!strVal.isNullOrBlank()) {
                    val trimmed = strVal.trim()
                    val truncated = if (trimmed.length > 35) trimmed.take(32) + "…" else trimmed
                    parts.add("$k: \"$truncated\"")
                }
            }
            if (parts.isNotEmpty()) return parts.take(3).joinToString(" · ")
        }
        return name
    }

    val resultText: String
        get() = payload.stringOrNull("result").orEmpty()

    val argsText: String
        get() = payload.objOrNull("args")?.toString() ?: payload.stringOrNull("args").orEmpty()

    val textContent: String
        get() = (
            payload.stringOrNull("text")
                ?: payload.stringOrNull("content")
                ?: payload.stringOrNull("message")
                ?: payload.stringOrNull("detail")
            ).orEmpty()

    val durationLabel: String
        get() = if (isOpen) "…" else "—"

    val parsedEnvelope: EnvelopePayload? get() {
        val raw = textContent.trim()
        if (!raw.startsWith("{") || !raw.endsWith("}")) return null
        return try {
            val parsed = Json.parseToJsonElement(raw).jsonObject
            if (parsed.containsKey("status") || parsed.containsKey("summary") || parsed.containsKey("commit_message") || parsed.containsKey("notes_for_next_agent")) {
                EnvelopePayload(
                    status = parsed["status"]?.jsonPrimitive?.contentOrNull,
                    summary = parsed["summary"]?.jsonPrimitive?.contentOrNull,
                    notesForNextAgent = parsed["notes_for_next_agent"]?.jsonPrimitive?.contentOrNull,
                    changedFiles = parsed["changed_files"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty(),
                    commitMessage = parsed["commit_message"]?.jsonPrimitive?.contentOrNull
                )
            } else null
        } catch (_: Exception) {
            null
        }
    }

    val parsedTodos: List<TodoItem> get() {
        val todosStr = payload.objOrNull("args")?.stringOrNull("todos")
            ?: payload.stringOrNull("todos")
            ?: textContent
        if (todosStr.isBlank()) return emptyList()
        val regex = Regex("^(\\d+)\\.\\s*\\[(completed|in_progress|pending)\\]\\s*(.*)$")
        return todosStr.lines().mapNotNull { line ->
            val match = regex.find(line.trim())
            if (match != null) {
                val (idStr, status, text) = match.destructured
                TodoItem(id = idStr.toIntOrNull() ?: 1, status = status, text = text.trim())
            } else null
        }
    }
}

@Serializable
data class EnvelopePayload(
    val status: String? = null,
    val summary: String? = null,
    val notesForNextAgent: String? = null,
    val changedFiles: List<String> = emptyList(),
    val commitMessage: String? = null
)

@Serializable
data class TodoItem(
    val id: Int,
    val status: String,
    val text: String
)

enum class DiffType { ADD, DEL, CTX, HUNK }

data class DiffLine(
    val type: DiffType,
    val text: String
)

data class DiffResult(
    val lines: List<DiffLine>,
    val addCount: Int,
    val delCount: Int
)

@Serializable
data class TranscriptEvent(
    val id: String,
    val phaseId: String,
    val type: String, // "text" | "tool_call" | "gate" | "correction" | "interrupt" | "error"
    val timestamp: String,
    val content: String,
    val toolName: String? = null,
    val durationMs: Long? = null,
    val isSuccess: Boolean? = null,
    val toolArgs: String? = null,
    val toolOutput: String? = null
)

@Serializable
data class InterruptOption(
    val id: String = "",
    val label: String = "",
    val kind: String = "approve" // "approve" | "reject" | "edit"
)

@Serializable
data class PendingInterrupt(
    val interruptId: String,
    val runId: String,
    val phaseId: String? = null,
    val kind: String = "engineer",
    val title: String = "",
    val body: String = "",
    val options: List<InterruptOption> = emptyList(),
    val createdAt: String = "",
    val pipelineName: String = "",
    val phaseName: String = "",
    val question: String = "",
    val notes: String? = null
) {
    val displayQuestion: String get() = body.ifBlank { question.ifBlank { title } }
    val displayPipeline: String get() = pipelineName.ifBlank { "Engineer Phase" }
}

@Serializable
data class InterruptAnswer(
    val interruptId: String,
    val decision: String, // "approve" | "reject"
    val text: String? = null
)

@Serializable
data class StartRunInput(
    val projectId: String,
    val pipelineId: String,
    val request: String
)

@Serializable
data class ValidationIssue(
    val level: String, // "error" | "warning"
    val message: String
)

@Serializable
data class CompanionStartResult(
    val ok: Boolean,
    val runId: String? = null,
    val issues: List<ValidationIssue> = emptyList()
)

@Serializable
data class CompanionKillResult(
    val ok: Boolean
)

@Serializable
data class CompanionContinueResult(
    val ok: Boolean,
    val detail: String = ""
)

@Serializable
data class CompanionAnswerResult(
    val ok: Boolean
)

@Serializable
data class GhStatus(
    val available: Boolean = false,
    val detail: String = "",
    val repo: String? = null
)

@Serializable
data class CompanionPrCreateRequest(
    val title: String = "",
    val body: String = ""
)

@Serializable
data class CompanionPrDraft(
    val title: String,
    val body: String,
    val source: String = "run"
)

@Serializable
data class SmithScreenContext(
    val route: String,
    val entity: SmithScreenEntity? = null
)

@Serializable
data class SmithScreenEntity(
    val kind: String,
    val id: String
)

@Serializable
data class SmithChatState(
    val projectId: String? = null,
    val model: String = "",
    val activeModel: String = "",
    val reasoningEffort: String = "medium",
    val activeReasoningEffort: String = "medium",
    val running: Boolean = false,
    val error: String? = null,
    val transcript: List<SmithTranscriptEntry> = emptyList()
)

@Serializable
data class SmithTranscriptEntry(
    val id: String = "",
    val kind: String = "text",
    val text: String = "",
    val source: String = "smith",
    val toolKind: String? = null,
    val done: Boolean? = null,
    val failed: Boolean? = null,
    val at: Long = 0L,
    val artifact: JsonObject? = null
) {
    val isArtifact: Boolean get() = kind == "artifact"
    val isOperator: Boolean get() = source == "operator"
    val artifactKind: String
        get() = artifact?.stringOrNull("kind").orEmpty()
    val artifactTitle: String
        get() = artifact?.stringOrNull("title")
            ?: artifact?.stringOrNull("name")
            ?: artifactKind.replace('_', ' ')
    val artifactSummary: String
        get() = artifact?.stringOrNull("rationale")
            ?: artifact?.stringOrNull("summary")
            ?: artifact?.stringOrNull("detail").orEmpty()
}

@Serializable
data class SmithModelInfo(
    val id: String,
    val displayName: String = "",
    val provider: String = "",
    val supportedReasoningEfforts: List<String> = emptyList(),
    val defaultReasoningEffort: String = "medium",
    val isCustom: Boolean = false,
    val deprecated: Boolean = false,
    val contextWindow: Long? = null
) {
    val label: String get() = displayName.ifBlank { id.substringAfterLast('/') }
}

@Serializable
data class SmithModelRequest(
    val projectId: String? = null,
    val model: String
)

@Serializable
data class SmithEffortRequest(
    val projectId: String? = null,
    val effort: String
)

@Serializable
data class SmithSendRequest(
    val projectId: String? = null,
    val text: String,
    val screen: SmithScreenContext? = null
)

@Serializable
data class SmithScopeRequest(
    val projectId: String? = null
)

@Serializable
data class SmithProposal(
    val id: String,
    val type: String,
    val projectId: String? = null,
    val createdAt: String = "",
    val kind: String? = null,
    val mode: String? = null,
    val name: String? = null,
    val operation: String? = null,
    val title: String? = null,
    val summary: String? = null,
    val risk: String? = null,
    val overwrites: Boolean = false,
    val secretRequest: SmithSecretRequest? = null,
    val args: JsonObject = JsonObject(emptyMap()),
    val validation: List<ValidationIssue> = emptyList()
) {
    val headline: String
        get() = title?.takeIf { it.isNotBlank() }
            ?: name?.takeIf { it.isNotBlank() }
            ?: operation.orEmpty()
    val body: String
        get() = summary?.takeIf { it.isNotBlank() }
            ?: if (type == "entity") "${mode.orEmpty()} $kind".trim() else operation.orEmpty()
    val needsSecret: Boolean get() = secretRequest != null
}

@Serializable
data class SmithSecretRequest(
    val kind: String = "api-key",
    val label: String = "API key",
    val placeholder: String? = null
)

@Serializable
data class SmithProposalAnswer(
    val approved: Boolean,
    val note: String? = null,
    val secret: String? = null
)

@Serializable
data class SmithProposalAnswerRequest(
    val id: String,
    val answer: SmithProposalAnswer
)

@Serializable
data class SmithProposalAnswerResult(
    val ok: Boolean,
    val error: String? = null
)

@Serializable
data class PrAction(
    val ok: Boolean,
    val prUrl: String? = null,
    val detail: String? = null,
    val number: Int? = null,
    val url: String? = null
) {
    val effectiveUrl: String? get() = prUrl ?: url
    val effectiveNumber: Int? get() = number
}

@Serializable
data class PairedSession(
    val token: String,
    val desktopId: String,
    val desktopName: String,
    val hostOrigin: String,
    val pairedAt: String,
    val protocolVersion: Int = COMPANION_PROTOCOL_VERSION
)

sealed interface ConnectionStatus {
    data object Unpaired : ConnectionStatus
    data class Connected(val desktopName: String, val hostOrigin: String) : ConnectionStatus
    data class Reconnecting(val desktopName: String, val hostOrigin: String) : ConnectionStatus
    data class Offline(val desktopName: String, val hostOrigin: String) : ConnectionStatus
}

internal fun JsonElement.asStringOrNull(): String? = when (this) {
    is JsonPrimitive -> contentOrNull ?: booleanOrNull?.toString() ?: content
    is JsonArray, is JsonObject -> toString()
}

internal fun JsonObject.stringOr(key: String, fallback: String = ""): String =
    stringOrNull(key) ?: fallback

internal fun JsonObject.longOrNull(key: String): Long? {
    val el = this[key] as? JsonPrimitive ?: return null
    return el.longOrNull ?: el.contentOrNull?.toLongOrNull()
}

internal fun JsonObject.intOrNull(key: String): Int? = longOrNull(key)?.toInt()

internal fun JsonObject.doubleOrNull(key: String): Double? {
    val el = this[key] as? JsonPrimitive ?: return null
    return el.doubleOrNull ?: el.contentOrNull?.toDoubleOrNull()
}

internal fun JsonObject.arrayOrEmpty(key: String): List<JsonElement> =
    (this[key] as? JsonArray)?.toList().orEmpty()

internal fun JsonObject.objList(key: String): List<JsonObject> =
    arrayOrEmpty(key).mapNotNull { it as? JsonObject }

internal fun JsonObject.stringList(key: String): List<String> =
    arrayOrEmpty(key).mapNotNull { it.asStringOrNull() }.filter { it.isNotBlank() }

internal fun JsonElement.prettyJson(indent: String = "  "): String {
    fun write(value: JsonElement, depth: Int, out: StringBuilder) {
        val pad = indent.repeat(depth)
        when (value) {
            is JsonNull -> out.append("null")
            is JsonPrimitive -> out.append(if (value.isString) "\"${value.content}\"" else value.content)
            is JsonArray -> {
                if (value.isEmpty()) {
                    out.append("[]")
                    return
                }
                out.append("[\n")
                value.forEachIndexed { index, child ->
                    out.append(indent.repeat(depth + 1))
                    write(child, depth + 1, out)
                    if (index < value.size - 1) out.append(',')
                    out.append('\n')
                }
                out.append(pad).append(']')
            }
            is JsonObject -> {
                if (value.isEmpty()) {
                    out.append("{}")
                    return
                }
                out.append("{\n")
                val entries = value.entries.toList()
                entries.forEachIndexed { index, (k, child) ->
                    out.append(indent.repeat(depth + 1)).append('"').append(k).append("\": ")
                    write(child, depth + 1, out)
                    if (index < entries.size - 1) out.append(',')
                    out.append('\n')
                }
                out.append(pad).append('}')
            }
        }
    }
    return buildString { write(this@prettyJson, 0, this) }
}

internal fun JsonObject.stringOrNull(key: String): String? {
    val el = this[key] ?: return null
    return when (el) {
        is JsonPrimitive -> el.contentOrNull
        else -> el.toString()
    }
}

internal fun JsonObject.booleanOrNull(key: String): Boolean? {
    val el = this[key] as? JsonPrimitive ?: return null
    return el.booleanOrNull
}

internal fun JsonObject.objOrNull(key: String): JsonObject? = this[key] as? JsonObject
