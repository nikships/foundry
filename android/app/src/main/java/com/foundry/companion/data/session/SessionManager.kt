package com.foundry.companion.data.session

import android.content.Context
import android.content.SharedPreferences
import com.foundry.companion.data.model.PairedSession
import kotlinx.serialization.json.Json

class SessionManager(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("foundry_companion_prefs", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    fun saveSession(session: PairedSession) {
        val serialized = json.encodeToString(PairedSession.serializer(), session)
        prefs.edit().putString(KEY_SESSION, serialized).apply()
    }

    fun getSession(): PairedSession? {
        val raw = prefs.getString(KEY_SESSION, null) ?: return null
        return try {
            json.decodeFromString(PairedSession.serializer(), raw)
        } catch (e: Exception) {
            null
        }
    }

    fun clearSession() {
        prefs.edit().remove(KEY_SESSION).apply()
    }

    fun isNotifyOnSettleEnabled(): Boolean {
        return prefs.getBoolean(KEY_NOTIFY_SETTLE, true)
    }

    fun setNotifyOnSettleEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_NOTIFY_SETTLE, enabled).apply()
    }

    fun getLastUsedPipeline(projectId: String): String? {
        if (projectId.isBlank()) return null
        return prefs.getString("${KEY_LAST_PIPELINE_PREFIX}_$projectId", null)
    }

    fun setLastUsedPipeline(projectId: String, pipelineId: String) {
        if (projectId.isBlank() || pipelineId.isBlank()) return
        prefs.edit().putString("${KEY_LAST_PIPELINE_PREFIX}_$projectId", pipelineId).apply()
    }

    fun getNewRunDraft(): String {
        return prefs.getString(KEY_NEW_RUN_DRAFT, "").orEmpty()
    }

    fun setNewRunDraft(text: String) {
        if (text.isEmpty()) {
            prefs.edit().remove(KEY_NEW_RUN_DRAFT).apply()
        } else {
            prefs.edit().putString(KEY_NEW_RUN_DRAFT, text).apply()
        }
    }

    fun clearNewRunDraft() {
        prefs.edit().remove(KEY_NEW_RUN_DRAFT).apply()
    }

    fun getSelectedProjectId(): String? {
        return prefs.getString(KEY_SELECTED_PROJECT, null)?.takeIf { it.isNotBlank() }
    }

    fun setSelectedProjectId(projectId: String?) {
        if (projectId.isNullOrBlank()) {
            prefs.edit().remove(KEY_SELECTED_PROJECT).apply()
        } else {
            prefs.edit().putString(KEY_SELECTED_PROJECT, projectId).apply()
        }
    }

    fun hasPromptedNotificationPermission(): Boolean {
        return prefs.getBoolean(KEY_NOTIFY_PROMPTED, false)
    }

    fun setPromptedNotificationPermission(prompted: Boolean) {
        prefs.edit().putBoolean(KEY_NOTIFY_PROMPTED, prompted).apply()
    }

    fun getLastActiveRoute(): String? {
        return prefs.getString(KEY_LAST_ROUTE, null)
    }

    fun setLastActiveRoute(route: String?) {
        if (route == null) {
            prefs.edit().remove(KEY_LAST_ROUTE).apply()
        } else {
            prefs.edit().putString(KEY_LAST_ROUTE, route).apply()
        }
    }

    fun getNotifiedSettledRunIds(): Set<String> {
        return prefs.getStringSet(KEY_NOTIFIED_RUNS, emptySet()) ?: emptySet()
    }

    fun addNotifiedSettledRunId(runId: String) {
        if (runId.isBlank()) return
        val current = getNotifiedSettledRunIds().toMutableSet()
        current.add(runId)
        prefs.edit().putStringSet(KEY_NOTIFIED_RUNS, current).apply()
    }

    fun getNotifiedInterruptIds(): Set<String> {
        return prefs.getStringSet(KEY_NOTIFIED_INTERRUPTS, emptySet()) ?: emptySet()
    }

    fun addNotifiedInterruptId(interruptId: String) {
        if (interruptId.isBlank()) return
        val current = getNotifiedInterruptIds().toMutableSet()
        current.add(interruptId)
        prefs.edit().putStringSet(KEY_NOTIFIED_INTERRUPTS, current).apply()
    }

    companion object {
        private const val KEY_SESSION = "paired_session"
        private const val KEY_NOTIFY_SETTLE = "notify_settle"
        private const val KEY_NOTIFY_PROMPTED = "notify_prompted"
        private const val KEY_LAST_ROUTE = "last_active_route"
        private const val KEY_NOTIFIED_RUNS = "notified_runs"
        private const val KEY_NOTIFIED_INTERRUPTS = "notified_interrupts"
        private const val KEY_LAST_PIPELINE_PREFIX = "last_pipeline"
        private const val KEY_NEW_RUN_DRAFT = "new_run_draft"
        private const val KEY_SELECTED_PROJECT = "selected_project_id"
    }
}
