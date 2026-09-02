package com.foundry.companion.notification

import com.foundry.companion.data.model.RunRow
import com.foundry.companion.data.session.SessionManager

/**
 * The single place that turns a poll result into a notification decision.
 *
 * Both the foreground watcher and the UI ViewModel feed the same instance, so a
 * transition is announced exactly once no matter which observer saw it first,
 * and neither path needs its own copy of the settle rules.
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

    @Synchronized
    fun onRuns(runs: List<RunRow>) {
        val notified = sessionManager?.getNotifiedSettledRunIds().orEmpty()
        // Read per sweep rather than cached: the toggle lives in the Connection
        // sheet and the background watcher never sees that screen change.
        val settleEnabled = sessionManager?.isNotifyOnSettleEnabled() ?: true
        val canPost = notificationManager?.hasNotificationPermission() ?: false

        for (run in runs) {
            val status = run.status.lowercase()
            val previous = knownRunStatuses[run.runId]
            val settled = status in SETTLED_STATUSES

            if (previous == null) {
                knownRunStatuses[run.runId] = status
                if (settled) sessionManager?.addNotifiedSettledRunId(run.runId)
                continue
            }
            if (!settled || previous in SETTLED_STATUSES) {
                knownRunStatuses[run.runId] = status
                continue
            }
            if (run.runId in notified || !settleEnabled) {
                knownRunStatuses[run.runId] = status
                continue
            }
            if (!canPost) continue

            knownRunStatuses[run.runId] = status
            sessionManager?.addNotifiedSettledRunId(run.runId)
            notificationManager?.postRunSettledNotification(run)
        }
    }

    /** Drops watch state so a re-pair starts from a clean slate. */
    @Synchronized
    fun reset() {
        knownRunStatuses.clear()
    }

    companion object {
        val SETTLED_STATUSES = setOf("accepted", "rejected", "failed", "killed")
    }
}
