package com.foundry.companion.util

import com.foundry.companion.data.model.RunRow
import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.Locale

object RunFormatters {

    /**
     * Parses an ISO-8601 string to epoch millis, returning null if parsing fails.
     */
    fun parseIsoToEpochMs(isoString: String?): Long? {
        if (isoString.isNullOrBlank()) return null
        return try {
            Instant.parse(isoString).toEpochMilli()
        } catch (_: DateTimeParseException) {
            try {
                // Try appending Z if no timezone offset
                if (!isoString.endsWith("Z") && !isoString.contains("+")) {
                    Instant.parse("${isoString}Z").toEpochMilli()
                } else null
            } catch (_: Exception) {
                null
            }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Calculates the duration in milliseconds for a run.
     */
    fun computeDurationMs(run: RunRow, nowMs: Long = System.currentTimeMillis()): Long? {
        if (run.durationMs != null && run.durationMs > 0) return run.durationMs
        val startIso = run.startedAt.ifEmpty { run.createdAt }
        val startMs = parseIsoToEpochMs(startIso) ?: return null
        val endIso = run.endedAt ?: run.finishedAt
        val endMs = parseIsoToEpochMs(endIso)
        return if (endMs != null) {
            (endMs - startMs).coerceAtLeast(0L)
        } else if (run.status.equals("running", ignoreCase = true)) {
            (nowMs - startMs).coerceAtLeast(0L)
        } else {
            null
        }
    }

    /**
     * Formats duration into compact human readable text: "42s", "5m 34s", "1h 12m", or "—".
     */
    fun formatDuration(durationMs: Long?): String {
        if (durationMs == null || durationMs <= 0) return "—"
        val totalSec = durationMs / 1000
        val hrs = totalSec / 3600
        val min = (totalSec % 3600) / 60
        val sec = totalSec % 60
        return when {
            hrs > 0 -> "${hrs}h ${min}m"
            min > 0 -> "${min}m ${sec}s"
            else -> "${sec}s"
        }
    }

    /**
     * Formats ticking elapsed timer for live runs: "01:23", "12:45", or "01:12:34".
     */
    fun formatElapsedTimer(elapsedMs: Long): String {
        val totalSec = elapsedMs.coerceAtLeast(0L) / 1000
        val hrs = totalSec / 3600
        val min = (totalSec % 3600) / 60
        val sec = totalSec % 60
        return if (hrs > 0) {
            String.format(Locale.US, "%02d:%02d:%02d", hrs, min, sec)
        } else {
            String.format(Locale.US, "%02d:%02d", min, sec)
        }
    }

    /**
     * Formats relative time: "just now", "5m ago", "2h ago", "yesterday", "3d ago", or date.
     */
    fun formatRelativeTime(isoString: String?, nowMs: Long = System.currentTimeMillis()): String {
        val timeMs = parseIsoToEpochMs(isoString) ?: return "—"
        val diffSec = (nowMs - timeMs) / 1000
        if (diffSec < 0) return "just now"
        return when {
            diffSec < 45 -> "just now"
            diffSec < 90 -> "1m ago"
            diffSec < 3600 -> "${diffSec / 60}m ago"
            diffSec < 7200 -> "1h ago"
            diffSec < 86400 -> "${diffSec / 3600}h ago"
            diffSec < 172800 -> "yesterday"
            diffSec < 86400 * 7 -> "${diffSec / 86400}d ago"
            else -> {
                val days = diffSec / 86400
                "${days}d ago"
            }
        }
    }

    /**
     * Formats token count: "52k tokens", "30.8k tokens", "1.2M tokens", or null.
     */
    fun formatTokens(tokens: Long?): String? {
        if (tokens == null || tokens <= 0) return null
        return when {
            tokens >= 1_000_000 -> String.format(Locale.US, "%.1fM tokens", tokens / 1_000_000.0)
            tokens >= 1_000 -> {
                if (tokens % 1000 == 0L) {
                    "${tokens / 1000}k tokens"
                } else {
                    String.format(Locale.US, "%.1fk tokens", tokens / 1000.0)
                }
            }
            else -> "$tokens tokens"
        }
    }

    /**
     * Returns the short branch name tail (e.g. "run_260818_live99" from "foundry/run_260818_live99").
     */
    fun branchTail(branch: String?): String {
        if (branch.isNullOrBlank()) return "—"
        return branch.substringAfterLast('/')
    }
}
