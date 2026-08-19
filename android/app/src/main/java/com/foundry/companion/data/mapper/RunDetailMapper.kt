package com.foundry.companion.data.mapper

import com.foundry.companion.data.model.GateResult
import com.foundry.companion.data.model.HostAgentSessionRow
import com.foundry.companion.data.model.HostEnvelopeRow
import com.foundry.companion.data.model.HostGateResultRow
import com.foundry.companion.data.model.HostPhaseRow
import com.foundry.companion.data.model.HostRunDetail
import com.foundry.companion.data.model.PhaseRunSummary
import com.foundry.companion.data.model.RunDetail
import com.foundry.companion.util.RunFormatters
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.io.IOException

/**
 * The desktop no longer has this run. Distinct from a transport failure so the
 * UI can say so instead of retrying a run that will never come back.
 */
class RunNotFoundException(runId: String) :
    IOException("That run is no longer on the desktop ($runId).")

/**
 * Folds the desktop's `RunDetail` into the phone's single view model.
 *
 * The desktop hands back five parallel tables keyed on `phaseId` (phases,
 * envelopes, gates, sessions, plus the run row). Every screen wants one
 * `PhaseRunSummary` per phase, so the join happens here exactly once rather
 * than in each composable.
 */
object RunDetailMapper {

    /**
     * Returns null when the host reports no such run. The host answers 200 with
     * `run: null` for a missing run (`emptyRunDetail`), so absence is a body
     * shape rather than a status code and the caller has to notice it here.
     */
    fun map(host: HostRunDetail, nowMs: Long = System.currentTimeMillis()): RunDetail? {
        val run = host.run ?: return null

        val gatesByPhase = host.gates.groupBy { it.phaseId }
        val envelopesByPhase = host.envelopes.groupBy { it.phaseId }
        val sessionsByAgent = host.sessions.groupBy { it.agent }

        val phases = host.phases.map { phase ->
            phase.toSummary(
                gates = gatesByPhase[phase.phaseId].orEmpty(),
                envelopes = envelopesByPhase[phase.phaseId].orEmpty(),
                sessions = sessionsByAgent[phase.owner].orEmpty(),
                nowMs = nowMs
            )
        }

        return RunDetail(
            run = run.copy(phases = phases),
            phases = phases,
            live = host.live
        )
    }
}

private fun HostPhaseRow.toSummary(
    gates: List<HostGateResultRow>,
    envelopes: List<HostEnvelopeRow>,
    sessions: List<HostAgentSessionRow>,
    nowMs: Long
): PhaseRunSummary {
    // The desktop starts a phase at attempt 0 and stamps 1 on the first turn;
    // the phone counts attempts from 1 so "×2" means a real retry.
    val displayAttempt = if (attempt < 1) 1 else attempt

    return PhaseRunSummary(
        id = phaseId,
        phaseId = phaseId,
        name = name,
        kind = kind,
        owner = owner,
        status = status,
        attempt = displayAttempt,
        startedAt = startedAt,
        endedAt = endedAt,
        durationMs = RunFormatters.phaseDurationMs(
            startedAt = startedAt,
            endedAt = endedAt,
            isRunning = status.equals("running", ignoreCase = true),
            nowMs = nowMs
        ),
        tokens = sessions.takeIf { it.isNotEmpty() }?.sumOf { it.contextTokens },
        model = sessions.firstOrNull { it.model.isNotBlank() }?.model,
        gateResults = gates.map { GateResult(name = it.gate, passed = it.passed) },
        envelopeVerdict = envelopes.latest()?.verdict(),
        errorMessage = error?.takeIf { it.isNotBlank() }
    )
}

/**
 * The host orders envelopes by creation, so the last row for a phase is the one
 * that settled it — earlier rows are rejected attempts kept for the record.
 */
private fun List<HostEnvelopeRow>.latest(): HostEnvelopeRow? =
    maxWithOrNull(compareBy({ it.attempt }, { it.createdAt }))

private fun HostEnvelopeRow.verdict(): String? {
    val kind = schemaKind.ifBlank { "envelope" }
    val summary = payload.stringField("summary")
    val status = payload.stringField("status")

    if (!valid) {
        return if (summary.isNullOrBlank()) "$kind envelope rejected" else "$kind envelope rejected: $summary"
    }
    if (!summary.isNullOrBlank()) return summary
    if (!status.isNullOrBlank()) return "$kind: $status"
    return null
}

private fun JsonObject.stringField(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.trim()
