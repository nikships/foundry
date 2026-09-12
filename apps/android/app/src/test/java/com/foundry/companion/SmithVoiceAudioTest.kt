package com.foundry.companion

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.foundry.companion.voice.SmithVoiceAudio
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SmithVoiceAudioTest {
    private fun createAudio(): Pair<SmithVoiceAudio, CoroutineScope> {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val audio = SmithVoiceAudio(context, scope, onInput = {}, onError = {})
        return audio to scope
    }

    @Suppress("UNCHECKED_CAST")
    private fun SmithVoiceAudio.drainQueuedBytes(): List<ByteArray> {
        val field = SmithVoiceAudio::class.java.getDeclaredField("queue").apply { isAccessible = true }
        val channel = field.get(this) as Channel<Pair<Int, ByteArray>>
        val out = mutableListOf<ByteArray>()
        while (true) {
            out.add(channel.tryReceive().getOrNull()?.second ?: break)
        }
        return out
    }

    private fun SmithVoiceAudio.heldByte(): Byte? {
        val field = SmithVoiceAudio::class.java.getDeclaredField("pendingByte").apply { isAccessible = true }
        return field.get(this) as Byte?
    }

    @Test fun `odd sized chunk buffers instead of failing playback`() {
        val (audio, scope) = createAudio()
        try {
            val first = ByteArray(961) { index -> (index % 251).toByte() }
            // Must stay true: the controller aborts the live session on false.
            assertTrue(audio.enqueue(first))
            val queued = audio.drainQueuedBytes()
            assertEquals(960, queued.sumOf { it.size })
            assertTrue(queued.all { it.size % 2 == 0 })
            assertEquals(first.last(), audio.heldByte())

            val second = ByteArray(961) { index -> ((index * 7) % 251).toByte() }
            assertTrue(audio.enqueue(second))
            val held = first.last()
            val queuedAfter = audio.drainQueuedBytes()
            val flattened = queuedAfter.flatMap { it.asList() }.toByteArray()
            val expected = byteArrayOf(held) + second
            assertArrayEquals(expected, flattened)
            assertTrue(queuedAfter.all { it.size % 2 == 0 })
            assertNull(audio.heldByte())
        } finally {
            audio.close()
            scope.cancel()
        }
    }

    @Test fun `split samples reassemble across chunk boundaries without loss`() {
        val (audio, scope) = createAudio()
        try {
            assertTrue(audio.enqueue(byteArrayOf(1, 2, 3)))
            assertTrue(audio.enqueue(byteArrayOf(4, 5, 6, 7)))
            val flattened = audio.drainQueuedBytes().flatMap { it.asList() }.toByteArray()
            assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6), flattened)
            assertEquals(7.toByte(), audio.heldByte())

            assertTrue(audio.enqueue(byteArrayOf(8)))
            val next = audio.drainQueuedBytes().flatMap { it.asList() }.toByteArray()
            assertArrayEquals(byteArrayOf(7, 8), next)
            assertNull(audio.heldByte())
        } finally {
            audio.close()
            scope.cancel()
        }
    }

    @Test fun `bursts longer than five seconds buffer instead of failing playback`() {
        val (audio, scope) = createAudio()
        try {
            // 400 x 20 ms packets is 8 seconds of 24 kHz 16-bit mono audio,
            // well past the old 250-packet (5 second) cap.
            repeat(400) { packet ->
                val bytes = ByteArray(960) { index -> ((packet + index) % 251).toByte() }
                assertTrue("packet $packet must buffer without aborting playback", audio.enqueue(bytes))
            }
            val queued = audio.drainQueuedBytes()
            assertEquals(400, queued.size)
            assertEquals(400 * 960, queued.sumOf { it.size })
            assertTrue(queued.all { it.size % 2 == 0 })
        } finally {
            audio.close()
            scope.cancel()
        }
    }

    @Test fun `interrupt clears held bytes so turns do not bleed into each other`() {
        val (audio, scope) = createAudio()
        try {
            assertTrue(audio.enqueue(byteArrayOf(10, 11, 12, 13, 14)))
            audio.interrupt()
            assertNull(audio.heldByte())
            assertTrue(audio.drainQueuedBytes().isEmpty())

            val nextTurn = byteArrayOf(21, 22, 33, 44)
            assertTrue(audio.enqueue(nextTurn))
            val flattened = audio.drainQueuedBytes().flatMap { it.asList() }.toByteArray()
            assertArrayEquals(nextTurn, flattened)
            assertNull(audio.heldByte())
        } finally {
            audio.close()
            scope.cancel()
        }
    }
}
