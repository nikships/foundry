package com.foundry.companion.data.repository

import com.foundry.companion.data.model.*
import kotlinx.coroutines.flow.StateFlow

interface CompanionRepository {
    val connectionStatus: StateFlow<ConnectionStatus>
    val activeSession: StateFlow<PairedSession?>

    suspend fun pair(payload: CompanionPairingPayload, deviceName: String = "Android Device"): Result<CompanionPairResult>
    suspend fun unpair()
    fun injectFakeSession(session: PairedSession)

    suspend fun getSessionInfo(): Result<CompanionSessionInfo>
    suspend fun getProjects(): Result<List<CompanionProjectSummary>>
    suspend fun getRuns(projectId: String): Result<List<RunRow>>
    suspend fun getRunDetail(projectId: String, runId: String): Result<RunDetail>
    suspend fun getTranscriptEvents(projectId: String, runId: String, phaseId: String): Result<List<TranscriptEvent>>
    suspend fun getEventPage(projectId: String, runId: String, after: Long = 0L): Result<EventPage>
    suspend fun startRun(input: StartRunInput): Result<CompanionStartResult>
    suspend fun getOrchestratorOptions(): Result<OrchestratorOptions>
    suspend fun startOrchestratorPlan(request: OrchestratorStartRequest): Result<OrchestratorStartResult>
    suspend fun getOrchestratorPlan(planId: String): Result<OrchestratorState>
    suspend fun cancelOrchestratorPlan(planId: String): Result<Boolean>
    suspend fun getLinearState(): Result<LinearConnectionState>
    suspend fun searchLinearIssues(query: String): Result<List<LinearIssueSnapshot>>
    suspend fun getLinearIssue(issueId: String): Result<LinearIssueSnapshot>
    suspend fun getLinearWorkflowStates(teamId: String): Result<List<LinearWorkflowState>>
    suspend fun startLinearRun(input: LinearStartRunInput): Result<CompanionStartResult>
    suspend fun killRun(projectId: String, runId: String): Result<CompanionKillResult>
    suspend fun continueRun(projectId: String, runId: String): Result<CompanionContinueResult>
    suspend fun getRestorableCheckpoints(projectId: String, runId: String): Result<RestorableCheckpointList>
    suspend fun restoreCheckpoint(
        projectId: String,
        runId: String,
        request: RestoreCheckpointRequest
    ): Result<RestoreResult>
    suspend fun getPrStatus(projectId: String): Result<GhStatus>
    suspend fun getPrDraft(projectId: String, runId: String): Result<CompanionPrDraft>
    suspend fun createPr(projectId: String, runId: String, request: CompanionPrCreateRequest): Result<PrAction>
    suspend fun getSmithState(projectId: String?): Result<SmithChatState>
    suspend fun sendSmith(projectId: String?, text: String, screen: SmithScreenContext): Result<SmithChatState>
    suspend fun cancelSmith(projectId: String?): Result<SmithChatState>
    suspend fun newSmithChat(projectId: String?): Result<SmithChatState>
    suspend fun getSmithProposals(): Result<List<SmithProposal>>
    suspend fun answerSmithProposal(id: String, answer: SmithProposalAnswer): Result<SmithProposalAnswerResult>
    suspend fun getSmithModels(): Result<List<SmithModelInfo>>
    suspend fun setSmithModel(projectId: String?, model: String): Result<SmithChatState>
    suspend fun setSmithEffort(projectId: String?, effort: String): Result<SmithChatState>
    suspend fun retryConnection()
}
