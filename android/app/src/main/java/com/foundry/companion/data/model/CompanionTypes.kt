package com.foundry.companion.data.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

const val COMPANION_PROTOCOL_VERSION = 1

@Serializable
data class CompanionPairingPayload(
    val protocolVersion: Int = COMPANION_PROTOCOL_VERSION,
    val origin: String,
    val desktopId: String,
    val desktopName: String,
    val secret: String,
    val expiresAt: String
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
    val errorMessage: String? = null,
    val phaseId: String = ""
) {
    val resolvedId: String get() = id.ifBlank { phaseId }
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
data class CompanionAnswerResult(
    val ok: Boolean
)

@Serializable
data class CompanionPrCreateRequest(
    val title: String = "",
    val body: String = ""
)

@Serializable
data class PrAction(
    val ok: Boolean,
    val prUrl: String? = null,
    val detail: String? = null
)

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
