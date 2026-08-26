package com.foundry.companion.viewmodel

import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.foundry.companion.data.mapper.RunNotFoundException
import com.foundry.companion.data.model.*
import com.foundry.companion.data.repository.CompanionRepository
import com.foundry.companion.data.session.SessionManager
import com.foundry.companion.notification.CompanionNotifier
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** One-shot operator haptics. Collected once; never fired from a recomposing effect. */
enum class CompanionHapticEvent {
    PairSuccess,
    RunSettle
}

data class CompanionUiState(
    val connectionStatus: ConnectionStatus = ConnectionStatus.Unpaired,
    val activeSession: PairedSession? = null,
    val sessionInfo: CompanionSessionInfo? = null,
    val projects: List<CompanionProjectSummary> = emptyList(),
    val selectedProjectId: String = "",
    val runs: List<RunRow> = emptyList(),
    val currentRunDetail: RunDetail? = null,
    /** Set when the desktop answered that it has no such run. */
    val missingRunId: String? = null,
    val transcriptEvents: List<TranscriptEvent> = emptyList(),
    val eventRows: List<EventRow> = emptyList(),
    val eventsCursor: Long = 0L,
    val ghStatus: GhStatus? = null,
    /** Host-drafted title/body for the Create PR confirm sheet. */
    val prDraft: CompanionPrDraft? = null,
    val prDraftRunId: String? = null,
    val smithChat: SmithChatState? = null,
    val smithProposal: SmithProposal? = null,
    val smithModels: List<SmithModelInfo> = emptyList(),
    val smithSending: Boolean = false,
    val orchestratorOptions: OrchestratorOptions? = null,
    val orchestratorState: OrchestratorState? = null,
    val isPlanning: Boolean = false,
    val linearConnection: LinearConnectionState? = null,
    val linearIssues: List<LinearIssueSnapshot> = emptyList(),
    val selectedLinearIssue: LinearIssueSnapshot? = null,
    val linearWorkflowStates: List<LinearWorkflowState> = emptyList(),
    val linearStatusMapping: LinearStatusMapping = LinearStatusMapping(),
    val isSearchingLinear: Boolean = false,
    val isLoadingLinearWorkflow: Boolean = false,
    val restorableCheckpoints: RestorableCheckpointList? = null,
    val isLoadingCheckpoints: Boolean = false,
    val isRestoringCheckpoint: Boolean = false,
    val restoreMessage: String? = null,
    /** Which run the restore banner belongs to, so switching runs cannot leak it. */
    val restoreMessageRunId: String? = null,
    val isNotifyOnSettleEnabled: Boolean = true,
    val isPairing: Boolean = false,
    val isStartingRun: Boolean = false,
    val isContinuingRun: Boolean = false,
    val isCreatingPr: Boolean = false,
    val validationIssues: List<ValidationIssue> = emptyList(),
    val errorMessage: String? = null
)

class CompanionViewModel(
    private val repository: CompanionRepository,
    private val sessionManager: SessionManager? = null,
    /**
     * The same instance the background watcher feeds. The screen must not own a
     * second notification path, or a transition seen by both would announce twice.
     */
    private val notifier: CompanionNotifier? = null,
    private val enablePolling: Boolean = true,
    private val deviceName: String = defaultCompanionDeviceName()
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        CompanionUiState(
            connectionStatus = repository.connectionStatus.value,
            activeSession = repository.activeSession.value,
            selectedProjectId = sessionManager?.getSelectedProjectId().orEmpty(),
            isNotifyOnSettleEnabled = sessionManager?.isNotifyOnSettleEnabled() ?: true
        )
    )
    val uiState: StateFlow<CompanionUiState> = _uiState.asStateFlow()

    private val _hapticEvents = MutableSharedFlow<CompanionHapticEvent>(extraBufferCapacity = 8)
    val hapticEvents: SharedFlow<CompanionHapticEvent> = _hapticEvents.asSharedFlow()

    private val hapticRunStatuses = mutableMapOf<String, String>()

    private var pollingJob: Job? = null
    private var orchestratorPollingJob: Job? = null
    private var isManualUnpair = false

    init {
        viewModelScope.launch {
            repository.connectionStatus.collect { status ->
                _uiState.update { it.copy(connectionStatus = status) }
                if (status is ConnectionStatus.Connected) {
                    loadInitialData()
                    if (enablePolling) {
                        startPolling()
                    }
                } else {
                    pollingJob?.cancel()
                }
            }
        }

        viewModelScope.launch {
            repository.activeSession.collect { session ->
                val previousSession = _uiState.value.activeSession
                _uiState.update { it.copy(activeSession = session) }
                if (session != null) {
                    sessionManager?.saveSession(session)
                } else {
                    sessionManager?.clearSession()
                    if (previousSession != null && !isManualUnpair && _uiState.value.errorMessage.isNullOrBlank()) {
                        _uiState.update {
                            it.copy(errorMessage = "The desktop revoked this phone's pairing. Scan a fresh code in Settings → Companion to reconnect.")
                        }
                    }
                }
            }
        }

        if (_uiState.value.activeSession != null && _uiState.value.connectionStatus is ConnectionStatus.Connected) {
            loadInitialData()
        }
    }

    fun loadInitialData() {
        viewModelScope.launch {
            val sessionInfo = repository.getSessionInfo().getOrElse { error ->
                _uiState.update {
                    it.copy(errorMessage = error.message ?: "Could not read desktop session")
                }
                return@launch
            }
            if (sessionInfo.protocolVersion != COMPANION_PROTOCOL_VERSION) {
                _uiState.update {
                    it.copy(
                        sessionInfo = sessionInfo,
                        errorMessage = "Protocol mismatch: desktop is v${sessionInfo.protocolVersion}, " +
                            "phone is v$COMPANION_PROTOCOL_VERSION. Update the older app."
                    )
                }
                return@launch
            }
            _uiState.update { it.copy(sessionInfo = sessionInfo) }

            repository.getProjects().onSuccess { projects ->
                val selected = resolveSelectedProjectId(
                    projects = projects,
                    current = _uiState.value.selectedProjectId,
                    persisted = sessionManager?.getSelectedProjectId().orEmpty()
                )
                if (selected.isNotEmpty()) {
                    sessionManager?.setSelectedProjectId(selected)
                }

                _uiState.update {
                    it.copy(projects = projects, selectedProjectId = selected)
                }

                if (selected.isNotEmpty()) {
                    loadRuns(selected)
                    loadPrStatus(selected)
                    loadSmith(selected)
                    if (enablePolling) {
                        startPolling(selected)
                    }
                }
            }
        }
    }

    fun selectProject(projectId: String) {
        if (projectId.isBlank()) return
        sessionManager?.setSelectedProjectId(projectId)
        _uiState.update { it.copy(selectedProjectId = projectId) }
        loadRuns(projectId)
        loadPrStatus(projectId)
        loadSmith(projectId)
        if (enablePolling) {
            startPolling(projectId)
        }
    }

    fun loadPrStatus(projectId: String = _uiState.value.selectedProjectId) {
        if (projectId.isBlank()) return
        viewModelScope.launch {
            repository.getPrStatus(projectId).onSuccess { status ->
                _uiState.update { it.copy(ghStatus = status) }
            }
        }
    }

    fun startPolling(projectId: String = _uiState.value.selectedProjectId) {
        pollingJob?.cancel()
        if (projectId.isBlank()) return
        pollingJob = viewModelScope.launch {
            while (isActive) {
                delay(2000L)
                if (_uiState.value.connectionStatus is ConnectionStatus.Connected) {
                    loadRuns(projectId)
                    loadSmith(projectId)
                    val activeRun = _uiState.value.currentRunDetail?.run
                    if (activeRun != null && activeRun.isRunning && _uiState.value.missingRunId != activeRun.runId) {
                        loadRunDetail(activeRun.runId)
                        val cursor = _uiState.value.eventsCursor
                        repository.getEventPage(projectId, activeRun.runId, cursor).onSuccess { page ->
                            if (page.events.isNotEmpty()) {
                                _uiState.update { current ->
                                    val existingMap = current.eventRows.associateBy { it.eventId.ifBlank { "row_${it.rowid}" } }.toMutableMap()
                                    for (ev in page.events) {
                                        existingMap[ev.eventId.ifBlank { "row_${ev.rowid}" }] = ev
                                    }
                                    val merged = existingMap.values.sortedBy { it.rowid }
                                    current.copy(
                                        eventRows = merged,
                                        eventsCursor = maxOf(cursor, page.cursor)
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    fun stopPolling() {
        pollingJob?.cancel()
        pollingJob = null
    }

    fun loadRuns(projectId: String = _uiState.value.selectedProjectId) {
        if (projectId.isBlank()) return
        viewModelScope.launch {
            repository.getRuns(projectId).onSuccess { runs ->
                val unarchived = runs.filterNot { it.archived }
                    .map { if (it.projectId.isBlank()) it.copy(projectId = projectId) else it }
                noteRunHaptics(unarchived)
                _uiState.update { it.copy(runs = unarchived) }
                notifier?.onRuns(unarchived)
            }
        }
    }

    fun loadRunDetail(runId: String) {
        val projectId = _uiState.value.selectedProjectId
        viewModelScope.launch {
            if (projectId.isNotBlank() && _uiState.value.ghStatus == null) {
                loadPrStatus(projectId)
            }
            repository.getRunDetail(projectId, runId).onSuccess { detail ->
                val canRestore = detail.run.status.lowercase() in RESTORABLE_RUN_STATUSES
                _uiState.update {
                    it.copy(
                        currentRunDetail = detail,
                        missingRunId = null,
                        errorMessage = null,
                        prDraft = if (it.prDraftRunId == runId) it.prDraft else null,
                        prDraftRunId = if (it.prDraftRunId == runId) it.prDraftRunId else null,
                        restorableCheckpoints = if (canRestore &&
                            it.restorableCheckpoints?.runId == runId
                        ) {
                            it.restorableCheckpoints
                        } else {
                            null
                        },
                        restoreMessage = if (it.restoreMessageRunId == runId) {
                            it.restoreMessage
                        } else {
                            null
                        },
                    )
                }
                if (canRestore) {
                    loadRestorableCheckpoints(runId)
                }
                if (canDraftPr(detail.run)) {
                    loadPrDraft(projectId, runId)
                }
            }.onFailure { err ->
                // A run the desktop no longer has is terminal, not a blip: stop
                // polling it rather than waterfalling empty phases forever.
                // Dedicated missing-run UI owns this — do not also park the
                // message on actionError or it sticks on the next run.
                if (err is RunNotFoundException) {
                    _uiState.update {
                        it.copy(
                            currentRunDetail = null,
                            missingRunId = runId,
                            prDraft = null,
                            prDraftRunId = null,
                            restorableCheckpoints = null,
                            restoreMessage = null,
                        )
                    }
                }
            }
        }
    }

    fun loadTranscriptEvents(runId: String, phaseId: String = "") {
        val projectId = _uiState.value.selectedProjectId
        viewModelScope.launch {
            repository.getEventPage(projectId, runId, 0L).onSuccess { page ->
                _uiState.update {
                    it.copy(
                        eventRows = page.events,
                        eventsCursor = page.cursor
                    )
                }
            }
            repository.getTranscriptEvents(projectId, runId, phaseId).onSuccess { events ->
                _uiState.update { it.copy(transcriptEvents = events) }
            }
        }
    }

    fun pair(payload: CompanionPairingPayload) {
        _uiState.update { it.copy(isPairing = true, errorMessage = null) }
        viewModelScope.launch {
            val result = repository.pair(payload, deviceName)
            _uiState.update { it.copy(isPairing = false) }
            result.onSuccess {
                emitHaptic(CompanionHapticEvent.PairSuccess)
            }.onFailure { error ->
                _uiState.update { it.copy(errorMessage = error.message ?: "Pairing failed") }
            }
        }
    }

    fun unpair() {
        isManualUnpair = true
        orchestratorPollingJob?.cancel()
        notifier?.reset()
        resetHapticWatch()
        viewModelScope.launch {
            repository.unpair()
            _uiState.update {
                it.copy(
                    runs = emptyList(),
                    currentRunDetail = null,
                    missingRunId = null,
                    transcriptEvents = emptyList(),
                    eventRows = emptyList(),
                    eventsCursor = 0L,
                    sessionInfo = null,
                    prDraft = null,
                    prDraftRunId = null,
                    smithChat = null,
                    smithProposal = null,
                    smithModels = emptyList(),
                    smithSending = false,
                    orchestratorOptions = null,
                    orchestratorState = null,
                    isPlanning = false,
                    linearConnection = null,
                    linearIssues = emptyList(),
                    selectedLinearIssue = null,
                    linearWorkflowStates = emptyList(),
                    linearStatusMapping = LinearStatusMapping(),
                    isSearchingLinear = false,
                    isLoadingLinearWorkflow = false,
                    restorableCheckpoints = null,
                    isLoadingCheckpoints = false,
                    isRestoringCheckpoint = false,
                    restoreMessage = null,
                    restoreMessageRunId = null,
                    errorMessage = null
                )
            }
            isManualUnpair = false
        }
    }

    fun getLastUsedPipeline(projectId: String): String? {
        return sessionManager?.getLastUsedPipeline(projectId)
    }

    fun setLastUsedPipeline(projectId: String, pipelineId: String) {
        sessionManager?.setLastUsedPipeline(projectId, pipelineId)
    }

    fun getNewRunDraft(): String {
        return sessionManager?.getNewRunDraft().orEmpty()
    }

    fun setNewRunDraft(request: String) {
        sessionManager?.setNewRunDraft(request)
    }

    fun clearNewRunDraft() {
        sessionManager?.clearNewRunDraft()
    }

    fun clearValidationIssues() {
        _uiState.update { it.copy(validationIssues = emptyList()) }
    }

    fun loadNewRunCapabilities() {
        viewModelScope.launch {
            // Independent host reads run concurrently; the issue search below
            // additionally depends on Linear being connected (keySet).
            val options = async { repository.getOrchestratorOptions() }
            val linear = async { repository.getLinearState() }
            options.await().onSuccess { fetched ->
                _uiState.update { it.copy(orchestratorOptions = fetched) }
            }.onFailure { error ->
                _uiState.update {
                    it.copy(errorMessage = error.message ?: "Could not load Orchestrator options")
                }
            }

            linear.await().onSuccess { state ->
                _uiState.update {
                    it.copy(
                        linearConnection = state,
                        linearStatusMapping = state.statusMapping
                    )
                }
                // Single owner of the initial seed: the composer's debounced
                // effect skips blank queries, so this fires exactly once.
                if (state.keySet) searchLinearIssues("")
            }.onFailure { error ->
                _uiState.update {
                    it.copy(errorMessage = error.message ?: "Could not read Linear connection")
                }
            }
        }
    }

    fun generateOrchestratorPlan(
        projectId: String,
        prompt: String,
        model: String,
        reasoningEffort: String
    ) {
        val request = prompt.trim()
        if (projectId.isBlank() || request.isBlank() || _uiState.value.isPlanning) return
        orchestratorPollingJob?.cancel()
        _uiState.update {
            it.copy(
                orchestratorState = null,
                isPlanning = true,
                validationIssues = emptyList(),
                errorMessage = null
            )
        }
        viewModelScope.launch {
            repository.startOrchestratorPlan(
                OrchestratorStartRequest(
                    projectId = projectId,
                    prompt = request,
                    model = model.ifBlank { "inherit" },
                    reasoningEffort = reasoningEffort
                )
            ).onSuccess { started ->
                val planId = started.planId
                if (planId.isNullOrBlank()) {
                    _uiState.update {
                        it.copy(
                            isPlanning = false,
                            validationIssues = listOf(
                                ValidationIssue(
                                    "error",
                                    started.error ?: "Could not open the planning session",
                                    "orchestrator"
                                )
                            )
                        )
                    }
                    return@onSuccess
                }
                pollOrchestratorPlan(
                    planId = planId,
                    projectId = projectId,
                    prompt = request,
                    model = model,
                    reasoningEffort = reasoningEffort
                )
            }.onFailure { error ->
                _uiState.update {
                    it.copy(
                        isPlanning = false,
                        validationIssues = listOf(
                            ValidationIssue(
                                "error",
                                error.message ?: "Could not open the planning session",
                                "orchestrator"
                            )
                        )
                    )
                }
            }
        }
    }

    private fun pollOrchestratorPlan(
        planId: String,
        projectId: String,
        prompt: String,
        model: String,
        reasoningEffort: String
    ) {
        _uiState.update {
            it.copy(
                orchestratorState = OrchestratorState(
                    planId = planId,
                    projectId = projectId,
                    status = "running",
                    model = model,
                    reasoningEffort = reasoningEffort,
                    prompt = prompt,
                    detail = "Opening the planning session…",
                    startedAt = System.currentTimeMillis()
                )
            )
        }
        orchestratorPollingJob?.cancel()
        orchestratorPollingJob = viewModelScope.launch {
            while (isActive) {
                val result = repository.getOrchestratorPlan(planId)
                result.onSuccess { state ->
                    val live = state.status == "running"
                    _uiState.update {
                        it.copy(
                            orchestratorState = state,
                            isPlanning = live,
                            validationIssues = if (state.status == "failed") {
                                listOf(
                                    ValidationIssue(
                                        "error",
                                        state.detail.ifBlank { "Planning failed" },
                                        "orchestrator"
                                    )
                                )
                            } else {
                                it.validationIssues
                            }
                        )
                    }
                    if (!live) return@launch
                }.onFailure { error ->
                    _uiState.update {
                        it.copy(
                            // A dead poll must not leave a "running" snapshot behind:
                            // the composer would keep its planning spinner forever.
                            orchestratorState = null,
                            isPlanning = false,
                            validationIssues = listOf(
                                ValidationIssue(
                                    "error",
                                    error.message ?: "Could not read the generated plan",
                                    "orchestrator"
                                )
                            )
                        )
                    }
                    return@launch
                }
                delay(500L)
            }
        }
    }

    fun cancelOrchestratorPlan() {
        val planId = _uiState.value.orchestratorState?.planId
        orchestratorPollingJob?.cancel()
        orchestratorPollingJob = null
        _uiState.update {
            it.copy(orchestratorState = null, isPlanning = false, validationIssues = emptyList())
        }
        if (!planId.isNullOrBlank()) {
            viewModelScope.launch { repository.cancelOrchestratorPlan(planId) }
        }
    }

    fun discardOrchestratorPlan() {
        if (_uiState.value.isPlanning) {
            cancelOrchestratorPlan()
        } else {
            _uiState.update {
                it.copy(orchestratorState = null, validationIssues = emptyList())
            }
        }
    }

    fun setPlanPhaseModel(phaseName: String, model: String) {
        _uiState.update { current ->
            val plan = current.orchestratorState?.plan ?: return@update current
            current.copy(
                orchestratorState = current.orchestratorState.copy(
                    plan = plan.withPhaseModel(phaseName, model)
                )
            )
        }
    }

    fun searchLinearIssues(query: String) {
        if (_uiState.value.linearConnection?.keySet != true) return
        _uiState.update { it.copy(isSearchingLinear = true) }
        viewModelScope.launch {
            repository.searchLinearIssues(query).onSuccess { issues ->
                _uiState.update {
                    it.copy(linearIssues = issues, isSearchingLinear = false)
                }
            }.onFailure { error ->
                _uiState.update {
                    it.copy(
                        linearIssues = emptyList(),
                        isSearchingLinear = false,
                        errorMessage = error.message ?: "Could not search Linear issues"
                    )
                }
            }
        }
    }

    fun selectLinearIssue(issue: LinearIssueSnapshot?) {
        discardOrchestratorPlan()
        if (issue == null) {
            _uiState.update {
                it.copy(
                    selectedLinearIssue = null,
                    linearWorkflowStates = emptyList(),
                    linearStatusMapping = it.linearConnection?.statusMapping ?: LinearStatusMapping(),
                    isLoadingLinearWorkflow = false,
                    validationIssues = emptyList()
                )
            }
            return
        }
        _uiState.update {
            it.copy(
                selectedLinearIssue = issue,
                linearWorkflowStates = emptyList(),
                isLoadingLinearWorkflow = true,
                validationIssues = emptyList()
            )
        }
        viewModelScope.launch {
            repository.getLinearWorkflowStates(issue.team.id).onSuccess { states ->
                _uiState.update { current ->
                    current.copy(
                        linearWorkflowStates = states,
                        linearStatusMapping = suggestedLinearMapping(
                            current.linearConnection?.statusMapping ?: LinearStatusMapping(),
                            states
                        ),
                        isLoadingLinearWorkflow = false
                    )
                }
            }.onFailure { error ->
                _uiState.update {
                    it.copy(
                        isLoadingLinearWorkflow = false,
                        validationIssues = listOf(
                            ValidationIssue(
                                "error",
                                error.message ?: "Could not load the Linear workflow",
                                "linear"
                            )
                        )
                    )
                }
            }
        }
    }

    fun setLinearStatus(stage: String, stateId: String) {
        _uiState.update { current ->
            val mapping = when (stage) {
                "started" -> current.linearStatusMapping.copy(started = stateId)
                "completed" -> current.linearStatusMapping.copy(completed = stateId)
                "failed" -> current.linearStatusMapping.copy(failed = stateId)
                else -> current.linearStatusMapping
            }
            current.copy(linearStatusMapping = mapping, validationIssues = emptyList())
        }
    }

    fun startRun(
        projectId: String,
        pipelineId: String,
        request: String,
        onSuccess: (runId: String) -> Unit
    ) {
        setLastUsedPipeline(projectId, pipelineId)
        _uiState.update { it.copy(isStartingRun = true, validationIssues = emptyList()) }
        viewModelScope.launch {
            val result = repository.startRun(StartRunInput(projectId, pipelineId, request))
            handleStartResult(projectId, result, onSuccess)
        }
    }

    fun startOrchestratedRun(
        projectId: String,
        onSuccess: (runId: String) -> Unit
    ) {
        val plan = _uiState.value.orchestratorState?.plan ?: return
        _uiState.update { it.copy(isStartingRun = true, validationIssues = emptyList()) }
        viewModelScope.launch {
            val result = repository.startRun(
                StartRunInput(
                    projectId = projectId,
                    pipelineId = plan.pipelineId,
                    request = plan.prompt,
                    plan = plan
                )
            )
            handleStartResult(projectId, result, onSuccess)
        }
    }

    fun startLinearRun(
        projectId: String,
        pipelineId: String,
        plan: GeneratedRunPlan? = null,
        onSuccess: (runId: String) -> Unit
    ) {
        val issue = _uiState.value.selectedLinearIssue ?: return
        val mapping = _uiState.value.linearStatusMapping
        if (!mapping.isComplete) {
            _uiState.update {
                it.copy(
                    validationIssues = listOf(
                        ValidationIssue(
                            "error",
                            "Map all three Linear lifecycle statuses before starting.",
                            "linear"
                        )
                    )
                )
            }
            return
        }
        if (plan == null) setLastUsedPipeline(projectId, pipelineId)
        _uiState.update { it.copy(isStartingRun = true, validationIssues = emptyList()) }
        viewModelScope.launch {
            val result = repository.startLinearRun(
                LinearStartRunInput(
                    projectId = projectId,
                    pipelineId = plan?.pipelineId ?: pipelineId,
                    issueId = issue.id,
                    statusMapping = mapping,
                    plan = plan
                )
            )
            handleStartResult(projectId, result, onSuccess)
        }
    }

    private fun handleStartResult(
        projectId: String,
        result: Result<CompanionStartResult>,
        onSuccess: (runId: String) -> Unit
    ) {
        _uiState.update { it.copy(isStartingRun = false) }
        result.onSuccess { startResult ->
            if (startResult.ok && startResult.runId != null) {
                clearNewRunDraft()
                orchestratorPollingJob?.cancel()
                _uiState.update {
                    it.copy(
                        orchestratorState = null,
                        isPlanning = false,
                        selectedLinearIssue = null,
                        linearWorkflowStates = emptyList(),
                        validationIssues = emptyList()
                    )
                }
                loadRuns(projectId)
                onSuccess(startResult.runId)
            } else {
                _uiState.update { it.copy(validationIssues = startResult.issues) }
            }
        }.onFailure { error ->
            _uiState.update {
                it.copy(
                    validationIssues = listOf(
                        ValidationIssue(
                            "error",
                            error.message ?: "Failed to start run",
                            "start"
                        )
                    )
                )
            }
        }
    }

    fun resetNewRunComposer() {
        if (_uiState.value.isPlanning) {
            cancelOrchestratorPlan()
        }
        _uiState.update {
            it.copy(
                orchestratorState = null,
                isPlanning = false,
                selectedLinearIssue = null,
                linearWorkflowStates = emptyList(),
                linearStatusMapping = it.linearConnection?.statusMapping ?: LinearStatusMapping(),
                validationIssues = emptyList()
            )
        }
    }

    fun killRun(runId: String, onResult: ((Boolean) -> Unit)? = null) {
        val projectId = _uiState.value.selectedProjectId
        viewModelScope.launch {
            repository.killRun(projectId, runId).onSuccess { res ->
                if (res.ok) {
                    loadRunDetail(runId)
                    loadRuns(projectId)
                }
                onResult?.invoke(res.ok)
            }.onFailure { err ->
                _uiState.update { it.copy(errorMessage = err.message ?: "Failed to kill run") }
                onResult?.invoke(false)
            }
        }
    }

    fun continueRun(runId: String, onResult: ((Boolean) -> Unit)? = null) {
        val projectId = _uiState.value.selectedProjectId
        _uiState.update { it.copy(isContinuingRun = true, errorMessage = null) }
        viewModelScope.launch {
            repository.continueRun(projectId, runId).onSuccess { res ->
                _uiState.update {
                    it.copy(
                        isContinuingRun = false,
                        errorMessage = res.detail.takeUnless { res.ok || it.isBlank() }
                    )
                }
                if (res.ok) {
                    _uiState.update {
                        it.copy(restorableCheckpoints = null, restoreMessage = null)
                    }
                    loadRunDetail(runId)
                    loadRuns(projectId)
                }
                onResult?.invoke(res.ok)
            }.onFailure { err ->
                _uiState.update {
                    it.copy(
                        isContinuingRun = false,
                        errorMessage = err.message ?: "Failed to continue run"
                    )
                }
                onResult?.invoke(false)
            }
        }
    }

    fun loadRestorableCheckpoints(runId: String) {
        val projectId = _uiState.value.selectedProjectId
        if (projectId.isBlank() || runId.isBlank()) return
        _uiState.update { it.copy(isLoadingCheckpoints = true) }
        viewModelScope.launch {
            repository.getRestorableCheckpoints(projectId, runId).onSuccess { checkpoints ->
                _uiState.update {
                    it.copy(
                        restorableCheckpoints = checkpoints,
                        isLoadingCheckpoints = false
                    )
                }
            }.onFailure { error ->
                _uiState.update {
                    it.copy(
                        isLoadingCheckpoints = false,
                        errorMessage = error.message ?: "Could not load phase checkpoints"
                    )
                }
            }
        }
    }

    fun restoreCheckpoint(
        runId: String,
        checkpointId: String,
        acceptPartial: Boolean,
        onResult: ((Boolean) -> Unit)? = null
    ) {
        val projectId = _uiState.value.selectedProjectId
        if (projectId.isBlank() || runId.isBlank() || checkpointId.isBlank()) return
        _uiState.update {
            it.copy(
                isRestoringCheckpoint = true,
                restoreMessage = null,
                restoreMessageRunId = null,
                errorMessage = null
            )
        }
        viewModelScope.launch {
            repository.restoreCheckpoint(
                projectId,
                runId,
                RestoreCheckpointRequest(
                    checkpointId = checkpointId,
                    acceptPartial = acceptPartial
                )
            ).onSuccess { result ->
                _uiState.update {
                    it.copy(
                        isRestoringCheckpoint = false,
                        restoreMessage = result.detail.takeIf { result.ok },
                        restoreMessageRunId = result.detail.takeIf { result.ok }?.let { runId },
                        errorMessage = result.detail.takeUnless { result.ok }
                    )
                }
                if (result.ok) {
                    loadRunDetail(runId)
                    loadRuns(projectId)
                }
                onResult?.invoke(result.ok)
            }.onFailure { error ->
                _uiState.update {
                    it.copy(
                        isRestoringCheckpoint = false,
                        errorMessage = error.message ?: "Could not restore checkpoint"
                    )
                }
                onResult?.invoke(false)
            }
        }
    }

    fun clearActionError() {
        _uiState.update { it.copy(errorMessage = null) }
    }

    fun clearRestoreMessage() {
        _uiState.update { it.copy(restoreMessage = null, restoreMessageRunId = null) }
    }

    fun loadPrDraft(projectId: String = _uiState.value.selectedProjectId, runId: String) {
        if (projectId.isBlank() || runId.isBlank()) return
        viewModelScope.launch {
            repository.getPrDraft(projectId, runId).onSuccess { draft ->
                _uiState.update {
                    it.copy(prDraft = draft, prDraftRunId = runId)
                }
            }
        }
    }

    fun createPr(runId: String, onResult: ((Boolean, String?) -> Unit)? = null) {
        val projectId = _uiState.value.selectedProjectId
        _uiState.update { it.copy(isCreatingPr = true, errorMessage = null) }
        viewModelScope.launch {
            val cached = _uiState.value.prDraft?.takeIf { _uiState.value.prDraftRunId == runId }
            val draft = cached ?: repository.getPrDraft(projectId, runId).getOrElse { err ->
                val msg = err.message ?: "Failed to load PR draft"
                _uiState.update { it.copy(isCreatingPr = false, errorMessage = msg) }
                onResult?.invoke(false, msg)
                return@launch
            }
            if (cached == null) {
                _uiState.update { it.copy(prDraft = draft, prDraftRunId = runId) }
            }
            repository.createPr(
                projectId,
                runId,
                CompanionPrCreateRequest(title = draft.title, body = draft.body)
            ).onSuccess { res ->
                _uiState.update { it.copy(isCreatingPr = false) }
                if (res.ok) {
                    _uiState.update { it.copy(prDraft = null, prDraftRunId = null) }
                    loadRunDetail(runId)
                    loadRuns(projectId)
                    onResult?.invoke(true, res.effectiveUrl)
                } else {
                    val detail = res.detail ?: "Failed to create PR"
                    _uiState.update { it.copy(errorMessage = detail) }
                    onResult?.invoke(false, detail)
                }
            }.onFailure { err ->
                val msg = err.message ?: "Failed to create PR"
                _uiState.update { it.copy(isCreatingPr = false, errorMessage = msg) }
                onResult?.invoke(false, msg)
            }
        }
    }

    fun loadSmith(projectId: String = _uiState.value.selectedProjectId) {
        viewModelScope.launch {
            val scope = projectId.takeIf { it.isNotBlank() }
            repository.getSmithState(scope).onSuccess { chat ->
                _uiState.update { it.copy(smithChat = chat) }
            }
            repository.getSmithProposals().onSuccess { proposals ->
                _uiState.update { current ->
                    current.copy(smithProposal = proposals.firstOrNull { it.projectId == scope || it.projectId.isNullOrBlank() })
                }
            }
            if (_uiState.value.smithModels.isEmpty()) {
                repository.getSmithModels().onSuccess { models ->
                    _uiState.update { it.copy(smithModels = models) }
                }
            }
        }
    }

    fun setSmithModel(model: String) {
        val trimmed = model.trim()
        if (trimmed.isBlank()) return
        val projectId = _uiState.value.selectedProjectId.takeIf { it.isNotBlank() }
        viewModelScope.launch {
            repository.setSmithModel(projectId, trimmed).onSuccess { chat ->
                _uiState.update { it.copy(smithChat = chat) }
            }.onFailure { err ->
                _uiState.update { it.copy(errorMessage = err.message ?: "Could not switch model") }
            }
        }
    }

    fun setSmithEffort(effort: String) {
        val trimmed = effort.trim()
        if (trimmed.isBlank()) return
        val projectId = _uiState.value.selectedProjectId.takeIf { it.isNotBlank() }
        viewModelScope.launch {
            repository.setSmithEffort(projectId, trimmed).onSuccess { chat ->
                _uiState.update { it.copy(smithChat = chat) }
            }.onFailure { err ->
                _uiState.update { it.copy(errorMessage = err.message ?: "Could not switch reasoning") }
            }
        }
    }

    fun sendSmith(text: String, route: String = "smith") {
        val trimmed = text.trim()
        if (trimmed.isBlank() || _uiState.value.smithSending) return
        val projectId = _uiState.value.selectedProjectId.takeIf { it.isNotBlank() }
        _uiState.update { it.copy(smithSending = true, errorMessage = null) }
        viewModelScope.launch {
            val result = repository.sendSmith(projectId, trimmed, SmithScreenContext(route = route))
            result.onSuccess { chat ->
                _uiState.update { it.copy(smithChat = chat, smithSending = false) }
                loadSmith(projectId.orEmpty())
            }.onFailure { err ->
                _uiState.update { it.copy(smithSending = false, errorMessage = err.message ?: "Smith could not send") }
            }
        }
    }

    fun cancelSmith() {
        val projectId = _uiState.value.selectedProjectId.takeIf { it.isNotBlank() }
        viewModelScope.launch {
            repository.cancelSmith(projectId).onSuccess { chat ->
                _uiState.update { it.copy(smithChat = chat, smithSending = false) }
            }
        }
    }

    fun newSmithChat() {
        val projectId = _uiState.value.selectedProjectId.takeIf { it.isNotBlank() }
        viewModelScope.launch {
            repository.newSmithChat(projectId).onSuccess { chat ->
                _uiState.update { it.copy(smithChat = chat, smithProposal = null, smithSending = false) }
            }
        }
    }

    fun answerSmithProposal(approved: Boolean, secret: String? = null) {
        val proposal = _uiState.value.smithProposal ?: return
        viewModelScope.launch {
            val result = repository.answerSmithProposal(
                proposal.id,
                SmithProposalAnswer(approved = approved, secret = secret?.takeIf { it.isNotBlank() })
            )
            result.onSuccess { answer ->
                if (answer.ok) {
                    _uiState.update { it.copy(smithProposal = null) }
                    loadSmith()
                } else {
                    _uiState.update { it.copy(errorMessage = answer.error ?: "Smith could not apply that answer") }
                }
            }.onFailure { err ->
                _uiState.update { it.copy(errorMessage = err.message ?: "Smith could not apply that answer") }
            }
        }
    }

    fun toggleNotifyOnSettle(enabled: Boolean) {
        sessionManager?.setNotifyOnSettleEnabled(enabled)
        _uiState.update { it.copy(isNotifyOnSettleEnabled = enabled) }
    }

    fun retryConnection() {
        viewModelScope.launch {
            repository.retryConnection()
        }
    }

    private fun resolveSelectedProjectId(
        projects: List<CompanionProjectSummary>,
        current: String,
        persisted: String
    ): String {
        if (current.isNotEmpty() && (projects.isEmpty() || projects.any { it.id == current })) {
            return current
        }
        if (persisted.isNotEmpty() && projects.any { it.id == persisted }) {
            return persisted
        }
        return projects.firstOrNull()?.id.orEmpty()
    }

    private fun emitHaptic(event: CompanionHapticEvent) {
        _hapticEvents.tryEmit(event)
    }

    private fun resetHapticWatch() {
        hapticRunStatuses.clear()
    }

    /**
     * First sight of a run only seeds its status. A later transition from
     * `running` to a settled status is the settle haptic — one shot per run.
     */
    private fun noteRunHaptics(runs: List<RunRow>) {
        for (run in runs) {
            val status = run.status.lowercase()
            val previous = hapticRunStatuses.put(run.runId, status)
            if (previous == "running" && status in SETTLED_HAPTIC_STATUSES) {
                emitHaptic(CompanionHapticEvent.RunSettle)
            }
        }
    }

    private fun canDraftPr(run: RunRow): Boolean {
        val hasPr = !run.prUrl.isNullOrBlank()
        return !hasPr &&
            !run.merged &&
            !run.branch.isNullOrBlank() &&
            (run.status.equals("accepted", ignoreCase = true) ||
                run.status.equals("rejected", ignoreCase = true))
    }

    companion object {
        val SETTLED_HAPTIC_STATUSES = setOf("accepted", "rejected", "failed", "killed")
        val RESTORABLE_RUN_STATUSES = setOf("rejected", "failed", "killed")

        fun provideFactory(
            repository: CompanionRepository,
            sessionManager: SessionManager? = null,
            notifier: CompanionNotifier? = null,
            enablePolling: Boolean = true
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                return CompanionViewModel(repository, sessionManager, notifier, enablePolling) as T
            }
        }
    }
}

internal fun suggestedLinearMapping(
    saved: LinearStatusMapping,
    states: List<LinearWorkflowState>
): LinearStatusMapping {
    val known = states.mapTo(mutableSetOf()) { it.id }
    fun savedOrType(savedId: String?, type: String): String? {
        return savedId?.takeIf { it in known }
            ?: states.firstOrNull { it.type == type }?.id
    }
    return LinearStatusMapping(
        started = savedOrType(saved.started, "started"),
        completed = savedOrType(saved.completed, "completed"),
        failed = saved.failed?.takeIf { it in known }
            ?: states.firstOrNull { it.type == "canceled" || it.type == "cancelled" }?.id
    )
}

/** The name Settings → Phone lists. Blank MODEL is the only fallback. */
fun defaultCompanionDeviceName(): String {
    val model = Build.MODEL.trim()
    return model.ifBlank { "Android Device" }
}
