package com.foundry.companion.background

import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.repository.CompanionRepository
import com.foundry.companion.notification.CompanionNotifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Polls `/v1/projects/:id/runs` on the same LAN and feeds
 * every result to the shared [CompanionNotifier]. This is the path that keeps
 * working when the activity is gone: the UI ViewModel's own poll dies with the
 * screen, this one lives in whatever holder keeps the process up.
 *
 * It owns its own backoff rather than leaning on the repository's reconnect
 * loop, because an unreachable desktop must make this worker quieter and then
 * make it stop — a phone off the LAN should not wake its radio every few
 * seconds for a host that is not there.
 */
class CompanionWatcher(
    private val repository: CompanionRepository,
    private val notifier: CompanionNotifier,
    private val scope: CoroutineScope,
    private val pollIntervalMs: Long = DEFAULT_POLL_INTERVAL_MS,
    private val maxBackoffMs: Long = MAX_BACKOFF_MS,
    private val failureLimit: Int = DEFAULT_FAILURE_LIMIT
) {

    enum class StopReason {
        /** The session is gone: unpaired here, or revoked by the desktop. */
        UNPAIRED,

        /** The host stayed unreachable through the whole backoff ramp. */
        UNREACHABLE,

        /** A caller asked for the stop. */
        REQUESTED
    }

    private val _stopReason = MutableStateFlow<StopReason?>(null)

    /** Latest reason the loop ended; null while it is running. */
    val stopReason: StateFlow<StopReason?> = _stopReason.asStateFlow()

    private var job: Job? = null
    private var cachedProjectIds: List<String> = emptyList()
    private var cyclesSinceProjectRefresh = Int.MAX_VALUE

    val isRunning: Boolean get() = job?.isActive == true

    /** Starts the loop. No-op when already running; false when there is nothing to watch. */
    fun start(): Boolean {
        if (isRunning) return true
        if (repository.activeSession.value == null) {
            _stopReason.value = StopReason.UNPAIRED
            return false
        }
        _stopReason.value = null
        cachedProjectIds = emptyList()
        cyclesSinceProjectRefresh = Int.MAX_VALUE
        job = scope.launch { runLoop() }
        return true
    }

    fun stop(reason: StopReason = StopReason.REQUESTED) {
        job?.cancel()
        job = null
        _stopReason.value = reason
    }

    private suspend fun runLoop() {
        var backoffMs = pollIntervalMs
        var consecutiveFailures = 0

        while (currentCoroutineContext().isActive) {
            if (repository.activeSession.value == null ||
                repository.connectionStatus.value is ConnectionStatus.Unpaired
            ) {
                finish(StopReason.UNPAIRED)
                return
            }

            if (pollOnce()) {
                consecutiveFailures = 0
                backoffMs = pollIntervalMs
            } else {
                consecutiveFailures++
                if (consecutiveFailures >= failureLimit) {
                    finish(StopReason.UNREACHABLE)
                    return
                }
                backoffMs = minOf(maxBackoffMs, backoffMs * 2)
            }

            delay(backoffMs)
        }
    }

    private fun finish(reason: StopReason) {
        job = null
        _stopReason.value = reason
    }

    /** One sweep of every paired project. */
    private suspend fun pollOnce(): Boolean {
        val projectIds = resolveProjectIds() ?: return false
        var reachable = true

        for (projectId in projectIds) {
            repository.getRuns(projectId)
                .onSuccess { runs ->
                    notifier.onRuns(
                        runs.filterNot { it.archived }
                            .map { if (it.projectId.isBlank()) it.copy(projectId = projectId) else it }
                    )
                }
                .onFailure { reachable = false }
        }

        return reachable
    }

    /**
     * The project list barely changes, so it is cached and refreshed on a slow
     * cadence: every cycle would triple the request count for a list that is
     * stable for the life of a pairing.
     */
    private suspend fun resolveProjectIds(): List<String>? {
        if (cachedProjectIds.isNotEmpty() && cyclesSinceProjectRefresh < PROJECT_REFRESH_CYCLES) {
            cyclesSinceProjectRefresh++
            return cachedProjectIds
        }
        val result = repository.getProjects()
        val projects = result.getOrNull() ?: return cachedProjectIds.ifEmpty { null }
        cachedProjectIds = projects.map { it.id }.filter { it.isNotBlank() }
        cyclesSinceProjectRefresh = 0
        return cachedProjectIds
    }

    companion object {
        const val DEFAULT_POLL_INTERVAL_MS = 5_000L
        const val MAX_BACKOFF_MS = 60_000L

        /** Backoff doubles 5s → 80s across these tries before the worker gives up. */
        const val DEFAULT_FAILURE_LIMIT = 6

        private const val PROJECT_REFRESH_CYCLES = 12
    }
}
