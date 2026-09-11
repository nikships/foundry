package com.foundry.companion.notification

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.foundry.companion.MainActivity
import com.foundry.companion.R
import com.foundry.companion.data.model.RunRow

interface CompanionNotificationManager {
    fun hasNotificationPermission(): Boolean
    fun postRunSettledNotification(run: RunRow)
    /**
     * High-priority engineer-waiting alert (spec §3.7): "⟨pipeline⟩ is waiting
     * on you". Fires even with the settle toggle off — it blocks a run.
     */
    fun postEngineerWaitingNotification(run: RunRow, question: String)
}

class FoundryNotificationManager(
    private val context: Context
) : CompanionNotificationManager {

    private val notificationManager: NotificationManagerCompat = NotificationManagerCompat.from(context)

    init {
        createNotificationChannels()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val systemNotificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                ?: return

            val settledChannel = NotificationChannel(
                CHANNEL_SETTLED_RUNS,
                "Settled Runs",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Notifications when a Foundry run finishes on your Mac."
                enableLights(true)
                enableVibration(true)
            }

            val waitingChannel = NotificationChannel(
                CHANNEL_ENGINEER_WAITING,
                "Engineer Waiting",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "High-priority alerts when a run is waiting on your answer."
                enableLights(true)
                enableVibration(true)
            }

            systemNotificationManager.createNotificationChannel(settledChannel)
            systemNotificationManager.createNotificationChannel(waitingChannel)
        }
    }

    override fun hasNotificationPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            notificationManager.areNotificationsEnabled()
        }
    }

    override fun postRunSettledNotification(run: RunRow) {
        if (!hasNotificationPermission()) return

        val headline = when (run.status.lowercase()) {
            "accepted" -> "Accepted"
            "rejected" -> "Not accepted"
            "failed" -> "Failed"
            "killed" -> "Killed"
            else -> run.status.replaceFirstChar { it.uppercase() }
        }

        val pipelineName = run.pipelineName.ifBlank { "Foundry" }
        val title = "$pipelineName · $headline"
        val excerpt = run.request.trim()
        val contentText = if (excerpt.isNotBlank()) excerpt else run.outcomeDetail.orEmpty()
        val bigText = if (!run.outcomeDetail.isNullOrBlank() && run.outcomeDetail != excerpt) {
            "$headline: ${run.outcomeDetail}\n\n$excerpt"
        } else {
            excerpt
        }

        val intent = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("foundry://run/${run.runId}"),
            context,
            MainActivity::class.java
        ).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("runId", run.runId)
            if (run.projectId.isNotBlank()) putExtra("projectId", run.projectId)
        }

        val pendingIntent = PendingIntent.getActivity(
            context,
            run.runId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val accentColor = when (run.status.lowercase()) {
            "accepted" -> 0xFF34D399.toInt()
            "rejected" -> 0xFFF5A623.toInt()
            "failed" -> 0xFFEF4444.toInt()
            "killed" -> 0x52FFFFFF.toInt()
            else -> 0xFFEE6018.toInt()
        }

        val notification = NotificationCompat.Builder(context, CHANNEL_SETTLED_RUNS)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setColor(accentColor)
            .setContentTitle(title)
            .setContentText(contentText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        try {
            notificationManager.notify(run.runId.hashCode(), notification)
        } catch (_: SecurityException) {
            // Permission not granted or revoked
        }
    }

    override fun postEngineerWaitingNotification(run: RunRow, question: String) {
        if (!hasNotificationPermission()) return

        val pipelineName = run.pipelineName.ifBlank { "Foundry" }
        val title = "$pipelineName is waiting on you"
        val detail = question.trim().ifBlank { run.request.trim() }
        val contentText = "An engineer phase is waiting for your answer."

        val intent = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("foundry://run/${run.runId}"),
            context,
            MainActivity::class.java
        ).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("runId", run.runId)
            if (run.projectId.isNotBlank()) putExtra("projectId", run.projectId)
        }

        val pendingIntent = PendingIntent.getActivity(
            context,
            waitingNotificationId(run.runId),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ENGINEER_WAITING)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setColor(0xFFF5A623.toInt())
            .setContentTitle(title)
            .setContentText(contentText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(listOf(contentText, detail).filter { it.isNotBlank() }.joinToString("\n\n")))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        try {
            notificationManager.notify(waitingNotificationId(run.runId), notification)
        } catch (_: SecurityException) {
            // Permission not granted or revoked
        }
    }

    companion object {
        const val CHANNEL_SETTLED_RUNS = "foundry_settled_runs"
        const val CHANNEL_ENGINEER_WAITING = "foundry_engineer_waiting"

        /** A distinct id space from settle alerts so waiting never overwrites one. */
        fun waitingNotificationId(runId: String): Int = (runId + "#waiting").hashCode()
    }
}
