package com.foundry.companion.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.foundry.companion.data.model.*
import com.foundry.companion.data.repository.CompanionRepository
import com.foundry.companion.data.session.SessionManager
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class CompanionUiState(
    val connectionStatus: ConnectionStatus = ConnectionStatus.Unpaired,
    val activeSession: PairedSession? = null,
    val sessionInfo: CompanionSessionInfo? = null,
    val projects: List<CompanionProjectSummary> = emptyList(),
    val selectedProjectId: String = "",
    val runs: List<RunRow> = emptyList(),
    val currentRunDetail: RunDetail? = null,
    val transcriptEvents: List<TranscriptEvent> = emptyList(),
    val pendingInterrupts: List<PendingInterrupt> = emptyList(),
    val isNotifyOnSettleEnabled: Boolean = true,
    val isPairing: Boolean = false,
    val isStartingRun: Boolean = false,
    val isCreatingPr: Boolean = false,
    val validationIssues: List<ValidationIssue> = emptyList(),
    val errorMessage: String? = null
)

class CompanionViewModel(
    private val repository: CompanionRepository,
    private val sessionManager: SessionManager? = null,
    private val enablePolling: Boolean = true
) : ViewModel() {

    private val _uiState = MutableStateFlow(CompanionUiState())
    val uiState: StateFlow<CompanionUiState> = _uiState.asStateFlow()

    private var pollingJob: Job? = null

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
                _uiState.update { it.copy(activeSession = session) }
                if (session != null) {
                    sessionManager?.saveSession(session)
                } else {
                    sessionManager?.clearSession()
                }
            }
        }

        viewModelScope.launch {
            repository.pendingInterrupts.collect { interrupts ->
                _uiState.update { it.copy(pendingInterrupts = interrupts) }
            }
        }

        val notify = sessionManager?.isNotifyOnSettleEnabled() ?: true
        _uiState.update { it.copy(isNotifyOnSettleEnabled = notify) }
    }

    fun loadInitialData() {
        viewModelScope.launch {
            repository.getSessionInfo().onSuccess { info ->
                _uiState.update { it.copy(sessionInfo = info) }
            }

            repository.getProjects().onSuccess { projects ->
                val selected = if (_uiState.value.selectedProjectId.isEmpty()) {
                    projects.firstOrNull()?.id.orEmpty()
                } else _uiState.value.selectedProjectId

                _uiState.update {
                    it.copy(projects = projects, selectedProjectId = selected)
                }

                if (selected.isNotEmpty()) {
                    loadRuns(selected)
                    if (enablePolling) {
                        startPolling(selected)
                    }
                }
            }
        }
    }

    fun selectProject(projectId: String) {
        _uiState.update { it.copy(selectedProjectId = projectId) }
        loadRuns(projectId)
        if (enablePolling) {
            startPolling(projectId)
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
                _uiState.update { it.copy(runs = unarchived) }
            }
        }
    }

    fun loadRunDetail(runId: String) {
        val projectId = _uiState.value.selectedProjectId
        viewModelScope.launch {
            repository.getRunDetail(projectId, runId).onSuccess { detail ->
                _uiState.update { it.copy(currentRunDetail = detail) }
            }
        }
    }

    fun loadTranscriptEvents(runId: String, phaseId: String) {
        val projectId = _uiState.value.selectedProjectId
        viewModelScope.launch {
            repository.getTranscriptEvents(projectId, runId, phaseId).onSuccess { events ->
                _uiState.update { it.copy(transcriptEvents = events) }
            }
        }
    }

    fun pair(payload: CompanionPairingPayload) {
        _uiState.update { it.copy(isPairing = true, errorMessage = null) }
        viewModelScope.launch {
            val result = repository.pair(payload)
            _uiState.update { it.copy(isPairing = false) }
            result.onFailure { error ->
                _uiState.update { it.copy(errorMessage = error.message ?: "Pairing failed") }
            }
        }
    }

    fun unpair() {
        viewModelScope.launch {
            repository.unpair()
            _uiState.update {
                it.copy(
                    runs = emptyList(),
                    currentRunDetail = null,
                    transcriptEvents = emptyList(),
                    sessionInfo = null
                )
            }
        }
    }

    fun startRun(
        projectId: String,
        pipelineId: String,
        request: String,
        onSuccess: (runId: String) -> Unit
    ) {
        _uiState.update { it.copy(isStartingRun = true, validationIssues = emptyList()) }
        viewModelScope.launch {
            val result = repository.startRun(StartRunInput(projectId, pipelineId, request))
            _uiState.update { it.copy(isStartingRun = false) }
            result.onSuccess { startResult ->
                if (startResult.ok && startResult.runId != null) {
                    loadRuns(projectId)
                    onSuccess(startResult.runId)
                } else {
                    _uiState.update { it.copy(validationIssues = startResult.issues) }
                }
            }.onFailure { err ->
                _uiState.update {
                    it.copy(
                        validationIssues = listOf(ValidationIssue("error", err.message ?: "Failed to start run"))
                    )
                }
            }
        }
    }

    fun killRun(runId: String) {
        val projectId = _uiState.value.selectedProjectId
        viewModelScope.launch {
            repository.killRun(projectId, runId).onSuccess {
                loadRunDetail(runId)
                loadRuns(projectId)
            }
        }
    }

    fun answerInterrupt(interruptId: String, approved: Boolean, notes: String?) {
        viewModelScope.launch {
            repository.answerInterrupt(InterruptAnswer(interruptId, approved, notes))
        }
    }

    fun createPr(runId: String) {
        val projectId = _uiState.value.selectedProjectId
        _uiState.update { it.copy(isCreatingPr = true) }
        viewModelScope.launch {
            repository.createPr(projectId, runId, CompanionPrCreateRequest()).onSuccess {
                _uiState.update { it.copy(isCreatingPr = false) }
                loadRunDetail(runId)
                loadRuns(projectId)
            }.onFailure {
                _uiState.update { it.copy(isCreatingPr = false) }
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

    companion object {
        fun provideFactory(
            repository: CompanionRepository,
            sessionManager: SessionManager? = null
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                return CompanionViewModel(repository, sessionManager) as T
            }
        }
    }
}
