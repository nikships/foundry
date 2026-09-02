package com.foundry.companion.data.session

import android.content.Context
import android.content.SharedPreferences
import com.foundry.companion.data.model.PairedSession
import kotlinx.serialization.json.Json

class SessionManager(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("foundry_companion_prefs", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    private fun editPrefs(block: SharedPreferences.Editor.() -> Unit) {
        prefs.edit().apply(block).apply()
    }

    fun saveSession(session: PairedSession) {
        val serialized = json.encodeToString(PairedSession.serializer(), session)
        editPrefs { putString(KEY_SESSION, serialized) }
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
        editPrefs { remove(KEY_SESSION) }
    }

    fun isNotifyOnSettleEnabled(): Boolean {
        return prefs.getBoolean(KEY_NOTIFY_SETTLE, true)
    }

    fun setNotifyOnSettleEnabled(enabled: Boolean) {
        editPrefs { putBoolean(KEY_NOTIFY_SETTLE, enabled) }
    }

    fun getLastUsedPipeline(projectId: String): String? {
        if (projectId.isBlank()) return null
        return prefs.getString("${KEY_LAST_PIPELINE_PREFIX}_$projectId", null)
    }

    fun setLastUsedPipeline(projectId: String, pipelineId: String) {
        if (projectId.isBlank() || pipelineId.isBlank()) return
        editPrefs { putString("${KEY_LAST_PIPELINE_PREFIX}_$projectId", pipelineId) }
    }

    fun getNewRunDraft(): String {
        return prefs.getString(KEY_NEW_RUN_DRAFT, "").orEmpty()
    }

    fun setNewRunDraft(text: String) {
        editPrefs {
            if (text.isEmpty()) remove(KEY_NEW_RUN_DRAFT) else putString(KEY_NEW_RUN_DRAFT, text)
        }
    }

    fun clearNewRunDraft() {
        editPrefs { remove(KEY_NEW_RUN_DRAFT) }
    }

    fun getSelectedProjectId(): String? {
        return prefs.getString(KEY_SELECTED_PROJECT, null)?.takeIf { it.isNotBlank() }
    }

    fun setSelectedProjectId(projectId: String?) {
        editPrefs {
            if (projectId.isNullOrBlank()) remove(KEY_SELECTED_PROJECT) else putString(KEY_SELECTED_PROJECT, projectId)
        }
    }

    fun hasPromptedNotificationPermission(): Boolean {
        return prefs.getBoolean(KEY_NOTIFY_PROMPTED, false)
    }

    fun setPromptedNotificationPermission(prompted: Boolean) {
        editPrefs { putBoolean(KEY_NOTIFY_PROMPTED, prompted) }
    }

    fun getLastActiveRoute(): String? {
        return prefs.getString(KEY_LAST_ROUTE, null)
    }

    fun setLastActiveRoute(route: String?) {
        editPrefs {
            if (route == null) remove(KEY_LAST_ROUTE) else putString(KEY_LAST_ROUTE, route)
        }
    }

    fun getNotifiedSettledRunIds(): Set<String> {
        return prefs.getStringSet(KEY_NOTIFIED_RUNS, emptySet()) ?: emptySet()
    }

    fun addNotifiedSettledRunId(runId: String) {
        if (runId.isBlank()) return
        val current = getNotifiedSettledRunIds().toMutableSet()
        current.add(runId)
        editPrefs { putStringSet(KEY_NOTIFIED_RUNS, current) }
    }

    companion object {
        private const val KEY_SESSION = "paired_session"
        private const val KEY_NOTIFY_SETTLE = "notify_settle"
        private const val KEY_NOTIFY_PROMPTED = "notify_prompted"
        private const val KEY_LAST_ROUTE = "last_active_route"
        private const val KEY_NOTIFIED_RUNS = "notified_runs"
        private const val KEY_LAST_PIPELINE_PREFIX = "last_pipeline"
        private const val KEY_NEW_RUN_DRAFT = "new_run_draft"
        private const val KEY_SELECTED_PROJECT = "selected_project_id"
    }
}
