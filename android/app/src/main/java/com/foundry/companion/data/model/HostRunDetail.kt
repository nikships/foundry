package com.foundry.companion.data.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * The desktop's `RunDetail` exactly as `src/main/engine/operations.ts:runDetail()`
 * serialises it. These are wire rows, not view models: nothing in the UI reads
 * them directly, `RunDetailMapper` folds them into [RunDetail] first.
 *
 * A missing run answers 200 with `run: null` (`emptyRunDetail`), not 404, so
 * `run` is nullable here and the mapper is what turns that into a failure.
 */
@Serializable
data class HostRunDetail(
    val run: RunRow? = null,
    val phases: List<HostPhaseRow> = emptyList(),
    val envelopes: List<HostEnvelopeRow> = emptyList(),
    val gates: List<HostGateResultRow> = emptyList(),
    val sessions: List<HostAgentSessionRow> = emptyList(),
    val live: Boolean = false
)

@Serializable
data class HostPhaseRow(
    val phaseId: String = "",
    val runId: String = "",
    val seq: Int = 0,
    val name: String = "",
    val kind: String = "agent",
    /** The agent that ran the phase; `"code"` for a command phase. */
    val owner: String = "",
    val description: String = "",
    val status: String = "queued",
    val attempt: Int = 0,
    val error: String? = null,
    val startedAt: String? = null,
    val endedAt: String? = null
)

@Serializable
data class HostEnvelopeRow(
    val envelopeId: String = "",
    val runId: String = "",
    val phaseId: String = "",
    val agent: String = "",
    val schemaKind: String = "",
    val payload: JsonObject = JsonObject(emptyMap()),
    val valid: Boolean = false,
    val attempt: Int = 0,
    val createdAt: String = ""
)

@Serializable
data class HostGateResultRow(
    val id: Long = 0L,
    val runId: String = "",
    val phaseId: String = "",
    val attempt: Int = 0,
    val gate: String = "",
    val passed: Boolean = false,
    val createdAt: String = ""
)

@Serializable
data class HostAgentSessionRow(
    val runId: String = "",
    val agent: String = "",
    val model: String = "",
    val reasoningEffort: String = "",
    val agentSessionId: String? = null,
    val mode: String = "pi",
    val color: String = "",
    val contextTokens: Long = 0L,
    val contextWindow: Long = 0L,
    val createdAt: String = "",
    val lastUsedAt: String = ""
)
