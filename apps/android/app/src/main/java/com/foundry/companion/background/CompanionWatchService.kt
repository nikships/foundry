package com.foundry.companion.background

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.foundry.companion.FoundryApplication
import com.foundry.companion.MainActivity
import com.foundry.companion.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch

/**
 * Keeps the companion poll alive past the activity.
 *
 * A foreground service is the only thing Android reliably lets poll a LAN host
 * on a locked phone: `WorkManager` floors periodic work at 15 minutes and defers
 * it further under Doze, which would turn "your run finished" into news from a
 * quarter of an hour ago. The ongoing notification is the honest price of that.
 */
class CompanionWatchService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var watcher: CompanionWatcher? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as? FoundryApplication ?: run {
            stopSelf()
            return START_NOT_STICKY
        }

        val session = app.repository.activeSession.value
        if (session == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        startInForeground(session.desktopName)

        if (watcher == null) {
            val created = CompanionWatcher(app.repository, app.notifier, scope)
            watcher = created

            scope.launch {
                created.stopReason.filterNotNull().collect {
                    stopSelfSafely()
                }
            }
            scope.launch {
                app.repository.activeSession.collect { active ->
                    if (active == null) {
                        created.stop(CompanionWatcher.StopReason.UNPAIRED)
                    }
                }
            }
            created.start()
        }

        return START_STICKY
    }

    private fun startInForeground(desktopName: String) {
        createChannel()

        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_WATCH)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setColor(0xFFEE6018.toInt())
            .setContentTitle("Watching $desktopName")
            .setContentText("Foundry will notify you when a run settles or needs you.")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(contentIntent)
            .build()

        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            } else {
                0
            }
        )
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val channel = NotificationChannel(
            CHANNEL_WATCH,
            "Background Watch",
            NotificationManager.IMPORTANCE_MIN
        ).apply {
            description = "The quiet ongoing notice that keeps Foundry watching your Mac."
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun stopSelfSafely() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        watcher?.stop()
        watcher = null
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val CHANNEL_WATCH = "foundry_background_watch"
        private const val NOTIFICATION_ID = 4801

        /**
         * Starting a foreground service is only legal while the app itself is
         * allowed to; a process woken in the background throws instead of
         * starting, and that is not worth crashing over.
         */
        fun start(context: Context) {
            val intent = Intent(context, CompanionWatchService::class.java)
            try {
                context.startForegroundService(intent)
            } catch (_: Exception) {
                // Background start not allowed right now; the next foreground
                // launch starts it.
            }
        }

        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, CompanionWatchService::class.java))
            } catch (_: Exception) {
                // Already gone.
            }
        }
    }
}
