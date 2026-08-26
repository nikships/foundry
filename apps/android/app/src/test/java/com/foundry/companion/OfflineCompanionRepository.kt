package com.foundry.companion

import com.foundry.companion.data.model.*
import com.foundry.companion.data.repository.CompanionRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.IOException

/**
 * A paired desktop that is simply not answering, and can be made to answer
 * again. Counts attempts so a test can assert the watcher backs off and then
 * stops rather than retrying forever.
 */
class OfflineCompanionRepository(
    var reachable: Boolean = false
) : CompanionRepository {

    private val session = PairedSession(
        token = "tok_offline",
        desktopId = "desk_offline",
        desktopName = "Unreachable Mac",
        hostOrigin = "http://192.168.1.100:52810",
        pairedAt = "2026-08-19T09:00:00Z"
    )

    private val _activeSession = MutableStateFlow<PairedSession?>(session)
    override val activeSession: StateFlow<PairedSession?> = _activeSession.asStateFlow()

    private val _connectionStatus = MutableStateFlow<ConnectionStatus>(
        ConnectionStatus.Connected(session.desktopName, session.hostOrigin)
    )
    override val connectionStatus: StateFlow<ConnectionStatus> = _connectionStatus.asStateFlow()

    private val runs = mutableListOf<RunRow>()

    /**
     * Every outbound request, not just `/runs`: an unreachable host fails at the
     * project list first, so counting only `/runs` would never move and would
     * make a "stopped polling" assertion pass for the wrong reason.
     */
    var attempts = 0
        private set

    fun setRun(run: RunRow) {
        val index = runs.indexOfFirst { it.runId == run.runId }
        if (index >= 0) runs[index] = run else runs.add(run)
    }

    private fun <T> answer(value: T): Result<T> =
        if (reachable) Result.success(value) else Result.failure(IOException("unreachable"))

    override suspend fun pair(payload: CompanionPairingPayload, deviceName: String) =
        Result.failure<CompanionPairResult>(IOException("unreachable"))

    override suspend fun unpair() {
        _activeSession.value = null
        _connectionStatus.value = ConnectionStatus.Unpaired
    }

    override fun injectFakeSession(session: PairedSession) {
        _activeSession.value = session
    }

    override suspend fun getSessionInfo(): Result<CompanionSessionInfo> = answer(
        CompanionSessionInfo(session.desktopId, session.desktopName, session.protocolVersion, "0.1.0")
    )

    override suspend fun getProjects(): Result<List<CompanionProjectSummary>> {
        attempts++
        return answer(listOf(CompanionProjectSummary(id = "proj_foundry_core", name = "Foundry")))
    }

    override suspend fun getRuns(projectId: String): Result<List<RunRow>> {
        attempts++
        return answer(runs.toList())
    }

    override suspend fun getRunDetail(projectId: String, runId: String): Result<RunDetail> {
        val run = runs.firstOrNull { it.runId == runId }
            ?: return Result.failure(IOException("no run"))
        return answer(RunDetail(run = run, phases = run.phases))
    }

    override suspend fun getTranscriptEvents(projectId: String, runId: String, phaseId: String) =
        answer(emptyList<TranscriptEvent>())

    override suspend fun getEventPage(projectId: String, runId: String, after: Long) =
        answer(EventPage())

    override suspend fun startRun(input: StartRunInput) = answer(CompanionStartResult(ok = false))

    override suspend fun killRun(projectId: String, runId: String) = answer(CompanionKillResult(ok = false))

    override suspend fun continueRun(projectId: String, runId: String) =
        answer(CompanionContinueResult(ok = false, detail = "unreachable"))

    override suspend fun getPrStatus(projectId: String) = answer(GhStatus())

    override suspend fun getPrDraft(projectId: String, runId: String) =
        answer(CompanionPrDraft(title = "", body = "", source = "run"))

    override suspend fun createPr(projectId: String, runId: String, request: CompanionPrCreateRequest) =
        answer(PrAction(ok = false))

    override suspend fun getSmithState(projectId: String?) = answer(SmithChatState(projectId = projectId))

    override suspend fun sendSmith(projectId: String?, text: String, screen: SmithScreenContext) =
        answer(SmithChatState(projectId = projectId))

    override suspend fun cancelSmith(projectId: String?) = answer(SmithChatState(projectId = projectId))

    override suspend fun newSmithChat(projectId: String?) = answer(SmithChatState(projectId = projectId))

    override suspend fun getSmithProposals() = answer(emptyList<SmithProposal>())

    override suspend fun answerSmithProposal(id: String, answer: SmithProposalAnswer) =
        this.answer(SmithProposalAnswerResult(ok = false))

    override suspend fun getSmithModels() = answer(emptyList<SmithModelInfo>())

    override suspend fun setSmithModel(projectId: String?, model: String) =
        answer(SmithChatState(projectId = projectId, model = model))

    override suspend fun setSmithEffort(projectId: String?, effort: String) =
        answer(SmithChatState(projectId = projectId, reasoningEffort = effort))

    override suspend fun retryConnection() {
        if (reachable) {
            _connectionStatus.value = ConnectionStatus.Connected(session.desktopName, session.hostOrigin)
        }
    }
}
