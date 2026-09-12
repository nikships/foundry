package com.foundry.companion.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.*
import android.media.audiofx.AcousticEchoCanceler
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlin.math.abs

/** Owns only foreground audio. Small nonblocking writes bound interrupt latency. */
internal class SmithVoiceAudio(
    private val context: Context,
    private val scope: CoroutineScope,
    private val onInput: (ByteArray) -> Unit,
    private val onError: () -> Unit
) {
    private val lock = Any()
    private val manager = context.getSystemService(AudioManager::class.java)
    private var recorder: AudioRecord? = null
    private var player: AudioTrack? = null
    private var echo: AcousticEchoCanceler? = null
    private var capture: Job? = null
    private var playback: Job? = null
    private var meter: Job? = null
    @Volatile private var epoch = 0
    @Volatile private var closed = false
    private var writtenFrames = 0L
    private data class Slice(val endFrame: Long, val amplitude: Float)
    private val slices = ArrayDeque<Slice>()
    private val queue = Channel<Pair<Int, ByteArray>>(Channel.UNLIMITED)
    // Trailing byte held when a chunk ends mid-sample so only complete 2-byte
    // 16-bit samples are queued. Guarded by lock.
    private var pendingByte: Byte? = null
    @Volatile var level = 0f
        private set
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(attributes())
        .setOnAudioFocusChangeListener { if (it < 0) onError() }
        .build()

    fun start() {
        check(manager.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
        synchronized(lock) {
            player = AudioTrack.Builder().setAudioAttributes(attributes())
                .setAudioFormat(format(24000, AudioFormat.CHANNEL_OUT_MONO))
                .setBufferSizeInBytes(maxOf(4800, AudioTrack.getMinBufferSize(24000,
                    AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)))
                .setTransferMode(AudioTrack.MODE_STREAM).build()
            check(player!!.state == AudioTrack.STATE_INITIALIZED)
            player!!.play()
        }
        playback = scope.launch(Dispatchers.IO) {
            try {
                for ((generation, bytes) in queue) {
                    var offset = 0
                    while (offset < bytes.size && isActive) {
                        synchronized(lock) {
                            if (generation != epoch || closed) return@synchronized
                            val track = player ?: return@synchronized
                            val written = track.write(bytes, offset, bytes.size - offset, AudioTrack.WRITE_NON_BLOCKING)
                            check(written >= 0)
                            offset += written
                            if (written > 0) {
                                writtenFrames += written / 2
                                slices.addLast(Slice(writtenFrames, pcmLevel(bytes)))
                            }
                        }
                        if (generation != epoch || closed) break
                        if (offset < bytes.size) delay(5)
                    }
                }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { onError() }
        }
        meter = scope.launch(Dispatchers.IO) {
            while (isActive) {
                synchronized(lock) {
                    val head = player?.playbackHeadPosition?.toLong()?.and(0xffffffffL) ?: 0L
                    while (slices.firstOrNull()?.let { it.endFrame <= head } == true) slices.removeFirst()
                    level = slices.firstOrNull()?.amplitude ?: 0f
                }
                delay(10)
            }
        }
        mute(false)
    }

    fun mute(muted: Boolean) {
        capture?.cancel()
        capture = null
        synchronized(lock) {
            echo?.release()
            echo = null
            recorder?.let { runCatching { it.stop() }; it.release() }
            recorder = null
            if (muted || closed) return
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                throw SecurityException("Microphone permission required")
            }
            recorder = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                .setAudioFormat(format(16000, AudioFormat.CHANNEL_IN_MONO))
                .setBufferSizeInBytes(maxOf(3200, AudioRecord.getMinBufferSize(16000,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)))
                .build()
            val record = recorder!!
            check(record.state == AudioRecord.STATE_INITIALIZED)
            if (AcousticEchoCanceler.isAvailable()) {
                echo = AcousticEchoCanceler.create(record.audioSessionId)?.apply { enabled = true }
            }
            record.startRecording()
        }
        capture = scope.launch(Dispatchers.IO) {
            val bytes = ByteArray(640)
            try {
                while (isActive) {
                    synchronized(lock) {
                        if (!isActive) return@synchronized
                        val count = recorder?.read(bytes, 0, bytes.size, AudioRecord.READ_NON_BLOCKING) ?: 0
                        check(count >= 0)
                        if (count > 0) onInput(bytes.copyOf(count))
                    }
                    delay(10)
                }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { onError() }
        }
    }

    fun enqueue(bytes: ByteArray): Boolean = synchronized(lock) {
        if (closed) return@synchronized false
        // Prepend a byte held from an odd-length chunk so only complete 2-byte
        // 16-bit samples are queued; hold a new trailing byte when still odd.
        val held = pendingByte
        pendingByte = null
        val combined = if (held != null) {
            val merged = ByteArray(bytes.size + 1)
            merged[0] = held
            bytes.copyInto(merged, 1)
            merged
        } else {
            bytes
        }
        val evenSize = combined.size - (combined.size % 2)
        if (evenSize < combined.size) {
            pendingByte = combined[combined.size - 1]
        }
        if (evenSize == 0) return@synchronized true
        val aligned = if (evenSize == combined.size) combined else combined.copyOf(evenSize)
        // 20 ms packets buffered without a real-time cap so synthesis bursts
        // and network jitter play through instead of aborting the session.
        for (offset in 0 until evenSize step 960) {
            val end = minOf(offset + 960, evenSize)
            if (!queue.trySend(epoch to aligned.copyOfRange(offset, end)).isSuccess) {
                return@synchronized false
            }
        }
        true
    }

    fun interrupt() = synchronized(lock) {
        epoch++
        while (queue.tryReceive().isSuccess) Unit
        pendingByte = null
        player?.let { it.pause(); it.flush(); it.play() }
        writtenFrames = 0L
        slices.clear()
        level = 0f
    }

    fun close() {
        synchronized(lock) { closed = true }
        capture?.cancel()
        playback?.cancel()
        meter?.cancel()
        queue.close()
        synchronized(lock) {
            epoch++
            pendingByte = null
            level = 0f
            slices.clear()
            echo?.release()
            echo = null
            recorder?.let { runCatching { it.stop() }; it.release() }
            recorder = null
            player?.let { runCatching { it.pause(); it.flush() }; it.release() }
            player = null
        }
        manager.abandonAudioFocusRequest(focus)
    }

    companion object {
        private fun attributes() = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
        private fun format(rate: Int, channels: Int) = AudioFormat.Builder()
            .setSampleRate(rate).setChannelMask(channels).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()

        internal fun pcmLevel(bytes: ByteArray): Float {
            var peak = 0
            for (i in 0 until bytes.size - 1 step 2) {
                val sample = ((bytes[i].toInt() and 255) or (bytes[i + 1].toInt() shl 8)).toShort().toInt()
                peak = maxOf(peak, abs(sample))
            }
            return (peak / 32768f).coerceIn(0f, 1f)
        }
    }
}
