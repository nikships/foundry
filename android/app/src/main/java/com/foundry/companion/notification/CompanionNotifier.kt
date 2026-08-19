package com.foundry.companion.notification

import com.foundry.companion.data.model.PendingInterrupt
import com.foundry.companion.data.model.RunRow
import com.foundry.companion.data.session.SessionManager

/**
 * The single place that turns a poll result into a notification decision.
 *
 * Both the foreground watcher and the UI ViewModel feed the same instance, so a
 * transition is announced exactly once no matter which observer saw it first,
 * and neither path needs its own copy of the settle/interrupt rules.
 *
 * A run is only announced when this process watched it leave a non-settled
 * status. A run first observed already settled finished before anyone was
 * watching, so it seeds silently rather than replaying history on every fresh
 * project or process start.
 */
class CompanionNotifier(
    private val notificationManager: CompanionNotificationManager?,
    private val sessionManager: SessionManager? = null
) {

    private val knownRunStatuses = mutableMapOf<String, String>()
    private val knownRunProjects = mutableMapOf<String, String>()
    private val knownInterruptIds = mutableSetOf<String>()

    @Synchronized
    fun onRuns(runs: List<RunRow>) {
        val notified = sessionManager?.getNotifiedSettledRunIds().orEmpty()
        // Read per sweep rather than cached: the toggle lives in the Connection
        // sheet and the background watcher never sees that screen change.
        val settleEnabled = sessionManager?.isNotifyOnSettleEnabled() ?: true
        val canPost = notificationManager?.hasNotificationPermission() ?: false

        for (run in runs) {
            if (run.projectId.isNotBlank()) {
                knownRunProjects[run.runId] = run.projectId
            }
            val status = run.status.lowercase()
            val previous = knownRunStatuses.put(run.runId, status)
            val settled = status in SETTLED_STATUSES

            if (previous == null) {
                if (settled) sessionManager?.addNotifiedSettledRunId(run.runId)
                continue
            }
            if (!settled || previous in SETTLED_STATUSES) continue
            if (run.runId in notified) continue
            if (!settleEnabled || !canPost) continue

            sessionManager?.addNotifiedSettledRunId(run.runId)
            notificationManager?.postRunSettledNotification(run)
        }
    }

    @Synchronized
    fun onInterrupts(interrupts: List<PendingInterrupt>) {
        val notified = sessionManager?.getNotifiedInterruptIds().orEmpty()
        val canPost = notificationManager?.hasNotificationPermission() ?: false

        if (!canPost) return

        for (interrupt in interrupts) {
            if (interrupt.interruptId.isBlank()) continue
            // Marked seen only when it can actually be posted, so a denied
            // permission does not silently swallow the retry after a grant.
            if (!knownInterruptIds.add(interrupt.interruptId)) continue
            if (interrupt.interruptId in notified) continue

            sessionManager?.addNotifiedInterruptId(interrupt.interruptId)
            // An interrupt blocks a run, so it notifies regardless of the settle
            // toggle (spec §3.7).
            notificationManager?.postInterruptNotification(
                interrupt,
                knownRunProjects[interrupt.runId].orEmpty()
            )
        }
    }

    /** Drops watch state so a re-pair starts from a clean slate. */
    @Synchronized
    fun reset() {
        knownRunStatuses.clear()
        knownRunProjects.clear()
        knownInterruptIds.clear()
    }

    companion object {
        val SETTLED_STATUSES = setOf("accepted", "rejected", "failed", "killed")
    }
}
