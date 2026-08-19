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

    companion object {
        private const val KEY_SESSION = "paired_session"
        private const val KEY_NOTIFY_SETTLE = "notify_settle"
    }
}
