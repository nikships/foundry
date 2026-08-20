package com.foundry.companion

import com.foundry.companion.data.model.PhaseRunSummary
import com.foundry.companion.data.model.RunRow
import com.foundry.companion.util.RunFormatters
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class RunFormattersTest {

    @Test
    fun testParseIsoToEpochMs() {
        val iso = "2026-08-18T22:10:00Z"
        val epochMs = RunFormatters.parseIsoToEpochMs(iso)
        assertNotNull(epochMs)
        assertEquals(Instant.parse(iso).toEpochMilli(), epochMs)

        assertNull(RunFormatters.parseIsoToEpochMs(null))
        assertNull(RunFormatters.parseIsoToEpochMs(""))
    }

    @Test
    fun testFormatDuration() {
        assertEquals("—", RunFormatters.formatDuration(null))
        assertEquals("—", RunFormatters.formatDuration(0L))
        assertEquals("42s", RunFormatters.formatDuration(42_000L))
        assertEquals("5m 34s", RunFormatters.formatDuration(334_000L))
        assertEquals("1h 12m", RunFormatters.formatDuration(4_320_000L))
    }

    @Test
    fun testFormatElapsedTimer() {
        assertEquals("00:00", RunFormatters.formatElapsedTimer(0L))
        assertEquals("01:23", RunFormatters.formatElapsedTimer(83_000L))
        assertEquals("12:45", RunFormatters.formatElapsedTimer(765_000L))
        assertEquals("01:05:30", RunFormatters.formatElapsedTimer(3_930_000L))
    }

    @Test
    fun testFormatRelativeTime() {
        val now = 1_700_000_000_000L
        val justNow = Instant.ofEpochMilli(now - 10_000).toString()
        assertEquals("just now", RunFormatters.formatRelativeTime(justNow, now))

        val fiveMinAgo = Instant.ofEpochMilli(now - 5 * 60 * 1000).toString()
        assertEquals("5m ago", RunFormatters.formatRelativeTime(fiveMinAgo, now))

        val twoHoursAgo = Instant.ofEpochMilli(now - 2 * 3600 * 1000).toString()
        assertEquals("2h ago", RunFormatters.formatRelativeTime(twoHoursAgo, now))

        val yesterday = Instant.ofEpochMilli(now - 28 * 3600 * 1000).toString()
        assertEquals("yesterday", RunFormatters.formatRelativeTime(yesterday, now))

        val threeDaysAgo = Instant.ofEpochMilli(now - 3 * 24 * 3600 * 1000).toString()
        assertEquals("3d ago", RunFormatters.formatRelativeTime(threeDaysAgo, now))
    }

    @Test
    fun testFormatTokens() {
        assertNull(RunFormatters.formatTokens(null))
        assertNull(RunFormatters.formatTokens(0L))
        assertEquals("450 tokens", RunFormatters.formatTokens(450L))
        assertEquals("52k tokens", RunFormatters.formatTokens(52_000L))
        assertEquals("30.8k tokens", RunFormatters.formatTokens(30_770L))
        assertEquals("1.5M tokens", RunFormatters.formatTokens(1_500_000L))
    }

    @Test
    fun testBranchTail() {
        assertEquals("—", RunFormatters.branchTail(null))
        assertEquals("—", RunFormatters.branchTail(""))
        assertEquals("run_260818_live99", RunFormatters.branchTail("foundry/run_260818_live99"))
        assertEquals("feature-branch", RunFormatters.branchTail("feature-branch"))
    }

    @Test
    fun testComputeDurationMsForLiveAndSettled() {
        val settledRun = RunRow(
            runId = "run_settled",
            startedAt = "2026-08-18T22:00:00Z",
            endedAt = "2026-08-18T22:05:30Z",
            status = "accepted"
        )
        val settledDuration = RunFormatters.computeDurationMs(settledRun)
        assertEquals(330_000L, settledDuration)

        val liveRun = RunRow(
            runId = "run_live",
            startedAt = "2026-08-18T22:00:00Z",
            status = "running"
        )
        val now = Instant.parse("2026-08-18T22:01:23Z").toEpochMilli()
        val liveDuration = RunFormatters.computeDurationMs(liveRun, now)
        assertEquals(83_000L, liveDuration)
    }
}
