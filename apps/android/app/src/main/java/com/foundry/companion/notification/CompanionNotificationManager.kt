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
import com.foundry.companion.data.model.PendingInterrupt
import com.foundry.companion.data.model.RunRow

interface CompanionNotificationManager {
    fun hasNotificationPermission(): Boolean
    fun postRunSettledNotification(run: RunRow)

    /**
     * [projectId] is the run's project when the caller knows it. The host serves
     * interrupts without one, so it is joined in from the runs list and may be
     * blank; a blank value simply leaves the tap on whatever project is selected.
     */
    fun postInterruptNotification(interrupt: PendingInterrupt, projectId: String = "")
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

            val interruptChannel = NotificationChannel(
                CHANNEL_INTERRUPTS,
                "Engineer Interrupts",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "High-priority notifications when an engineer phase is waiting on your decision."
                enableLights(true)
                enableVibration(true)
            }

            systemNotificationManager.createNotificationChannel(settledChannel)
            systemNotificationManager.createNotificationChannel(interruptChannel)
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

    override fun postInterruptNotification(interrupt: PendingInterrupt, projectId: String) {
        if (!hasNotificationPermission()) return

        val pipelineName = interrupt.displayPipeline
        val title = "$pipelineName is waiting on you"
        val question = interrupt.displayQuestion
        val contentText = if (question.isNotBlank()) question else "An engineer phase is waiting for your answer."

        val intent = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("foundry://run/${interrupt.runId}?interrupt=${interrupt.interruptId}"),
            context,
            MainActivity::class.java
        ).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("runId", interrupt.runId)
            putExtra("interruptId", interrupt.interruptId)
            if (projectId.isNotBlank()) putExtra("projectId", projectId)
        }

        val pendingIntent = PendingIntent.getActivity(
            context,
            interrupt.interruptId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_INTERRUPTS)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setColor(0xFFEE6018.toInt())
            .setContentTitle(title)
            .setContentText(contentText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(contentText))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        try {
            notificationManager.notify(interrupt.interruptId.hashCode(), notification)
        } catch (_: SecurityException) {
            // Permission not granted or revoked
        }
    }

    companion object {
        const val CHANNEL_SETTLED_RUNS = "foundry_settled_runs"
        const val CHANNEL_INTERRUPTS = "foundry_interrupts"
    }
}
