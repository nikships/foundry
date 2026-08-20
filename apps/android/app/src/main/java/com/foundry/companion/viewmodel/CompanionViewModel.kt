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
    InterruptArrival,
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
    val pendingInterrupts: List<PendingInterrupt> = emptyList(),
    val ghStatus: GhStatus? = null,
    /** Host-drafted title/body for the Create PR confirm sheet. */
    val prDraft: CompanionPrDraft? = null,
    val prDraftRunId: String? = null,
    val isNotifyOnSettleEnabled: Boolean = true,
    val isPairing: Boolean = false,
    val isStartingRun: Boolean = false,
    val isContinuingRun: Boolean = false,
    val isCreatingPr: Boolean = false,
    val validationIssues: List<ValidationIssue> = emptyList(),
    val errorMessage: String? = null
) {
    /** The interrupt a run is blocked on, if any. `runId` is the only join key. */
    fun interruptForRun(runId: String): PendingInterrupt? =
        pendingInterrupts.firstOrNull { it.runId == runId }
}

/**
 * The host serves runs and interrupts as two independent lists and never stamps
 * `waitingInterrupt` on a row, so the chip is derived here by joining them on
 * `runId` rather than trusting a field only the fake repository ever set.
 */
private fun markWaiting(runs: List<RunRow>, interrupts: List<PendingInterrupt>): List<RunRow> {
    val waitingRunIds = interrupts.map { it.runId }.filter { it.isNotBlank() }.toSet()
    return runs.map { run ->
        val waiting = run.runId in waitingRunIds
        if (run.waitingInterrupt == waiting) run else run.copy(waitingInterrupt = waiting)
    }
}

private fun CompanionUiState.withInterrupts(interrupts: List<PendingInterrupt>): CompanionUiState =
    copy(pendingInterrupts = interrupts, runs = markWaiting(runs, interrupts))

private fun CompanionUiState.withRuns(nextRuns: List<RunRow>): CompanionUiState =
    copy(runs = markWaiting(nextRuns, pendingInterrupts))

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
    private val hapticInterruptIds = mutableSetOf<String>()
    private var hapticInterruptsPrimed = false

    private var pollingJob: Job? = null
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

        viewModelScope.launch {
            repository.pendingInterrupts.collect { interrupts ->
                noteInterruptHaptics(interrupts)
                _uiState.update { it.withInterrupts(interrupts) }
            }
        }

        if (_uiState.value.activeSession != null && _uiState.value.connectionStatus is ConnectionStatus.Connected) {
            loadInitialData()
        }
    }

    fun loadInitialData() {
        viewModelScope.launch {
            repository.getSessionInfo().onSuccess { info ->
                _uiState.update { it.copy(sessionInfo = info) }
            }

            loadPendingInterrupts()

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
                    loadPendingInterrupts()
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

    fun loadPendingInterrupts() {
        viewModelScope.launch {
            repository.getInterrupts().onSuccess { interrupts ->
                noteInterruptHaptics(interrupts)
                _uiState.update { it.withInterrupts(interrupts) }
                notifier?.onInterrupts(interrupts)
            }
        }
    }

    fun loadRuns(projectId: String = _uiState.value.selectedProjectId) {
        if (projectId.isBlank()) return
        viewModelScope.launch {
            repository.getRuns(projectId).onSuccess { runs ->
                val unarchived = runs.filterNot { it.archived }
                    .map { if (it.projectId.isBlank()) it.copy(projectId = projectId) else it }
                noteRunHaptics(unarchived)
                _uiState.update { it.withRuns(unarchived) }
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
                _uiState.update {
                    it.copy(
                        currentRunDetail = detail,
                        missingRunId = null,
                        errorMessage = null,
                        prDraft = if (it.prDraftRunId == runId) it.prDraft else null,
                        prDraftRunId = if (it.prDraftRunId == runId) it.prDraftRunId else null,
                    )
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
            _uiState.update { it.copy(isStartingRun = false) }
            result.onSuccess { startResult ->
                if (startResult.ok && startResult.runId != null) {
                    clearNewRunDraft()
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

    fun answerInterrupt(interruptId: String, approved: Boolean, notes: String?) {
        val decision = if (approved) "approve" else "reject"
        viewModelScope.launch {
            repository.answerInterrupt(InterruptAnswer(interruptId = interruptId, decision = decision, text = notes)).onSuccess {
                loadPendingInterrupts()
                val currentRun = _uiState.value.currentRunDetail?.run
                if (currentRun != null) {
                    loadRunDetail(currentRun.runId)
                }
            }
        }
    }

    fun clearActionError() {
        _uiState.update { it.copy(errorMessage = null) }
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
        hapticInterruptIds.clear()
        hapticInterruptsPrimed = false
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

    /**
     * The first interrupt snapshot (including an empty one) only primes. A
     * later unseen id is an arrival. Reloading the same id does not retrigger.
     */
    private fun noteInterruptHaptics(interrupts: List<PendingInterrupt>) {
        val incoming = interrupts.map { it.interruptId }.filter { it.isNotBlank() }
        if (!hapticInterruptsPrimed) {
            hapticInterruptIds.addAll(incoming)
            hapticInterruptsPrimed = true
            return
        }
        for (id in incoming) {
            if (hapticInterruptIds.add(id)) {
                emitHaptic(CompanionHapticEvent.InterruptArrival)
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

/** The name Settings → Phone lists. Blank MODEL is the only fallback. */
fun defaultCompanionDeviceName(): String {
    val model = Build.MODEL.trim()
    return model.ifBlank { "Android Device" }
}
