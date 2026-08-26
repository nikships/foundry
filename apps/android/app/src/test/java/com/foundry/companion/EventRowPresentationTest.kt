package com.foundry.companion

import com.foundry.companion.data.model.DiffType
import com.foundry.companion.data.model.EventRow
import com.foundry.companion.data.model.parseUnifiedDiff
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EventRowPresentationTest {

    @Test
    fun durationUsesPayloadThenTimestampsAndOmitsDash() {
        val withPayload = EventRow(
            type = "tool_call",
            name = "edit: spec.md",
            payload = buildJsonObject { put("durationMs", 1420) },
            startedAt = "2026-08-18T23:30:00Z",
            endedAt = "2026-08-18T23:30:02Z"
        )
        assertEquals(1420L, withPayload.durationMs)
        assertEquals("1s", withPayload.durationLabel)

        val fromTimestamps = EventRow(
            type = "tool_call",
            name = "edit: spec.md",
            startedAt = "2026-08-18T23:30:00Z",
            endedAt = "2026-08-18T23:30:03Z"
        )
        assertEquals(3000L, fromTimestamps.durationMs)
        assertEquals("3s", fromTimestamps.durationLabel)

        val open = EventRow(
            type = "tool_call",
            name = "edit: spec.md",
            startedAt = "2026-08-18T23:30:00Z"
        )
        assertEquals("…", open.durationLabel)

        val unknown = EventRow(
            type = "tool_call",
            name = "edit: spec.md",
            startedAt = "23:30:00Z",
            endedAt = "23:30:01Z"
        )
        assertEquals("", unknown.durationLabel)
        assertFalse(unknown.durationLabel.contains("—") || unknown.durationLabel.contains("–"))

        val offset = EventRow(
            type = "tool_call",
            name = "edit: spec.md",
            startedAt = "2026-08-18T10:00:00-04:00",
            endedAt = "2026-08-18T10:00:03-04:00"
        )
        assertEquals(3000L, offset.durationMs)
        assertEquals("3s", offset.durationLabel)
    }

    @Test
    fun argsPrettyPrintJsonInsteadOfCompactBlob() {
        val event = EventRow(
            type = "tool_call",
            name = "edit: spec.md",
            payload = buildJsonObject {
                putJsonObject("args") {
                    put("path", "spec.md")
                    put("old", "alpha")
                    put("new", "beta")
                }
            },
            startedAt = "2026-08-18T23:30:00Z",
            endedAt = "2026-08-18T23:30:01Z"
        )
        assertTrue(event.argsText.contains("\n"))
        assertTrue(event.argsText.contains("\"path\": "))
        assertFalse(event.argsText.startsWith("{path"))
    }

    @Test
    fun parseUnifiedDiffColorsAddsAndDeletes() {
        val diff = parseUnifiedDiff(
            """
            @@ -1,2 +1,2 @@
             context
            -old line
            +new line
            """.trimIndent()
        )
        requireNotNull(diff)
        assertEquals(1, diff.addCount)
        assertEquals(1, diff.delCount)
        assertEquals(DiffType.HUNK, diff.lines.first().type)
        assertTrue(diff.lines.any { it.type == DiffType.ADD && it.text == "+new line" })
        assertTrue(diff.lines.any { it.type == DiffType.DEL && it.text == "-old line" })
        assertNull(parseUnifiedDiff("just a sentence with no marks"))
        assertNull(parseUnifiedDiff("+not a diff\n-still not"))
    }

    @Test
    fun unescapeDoesNotRewriteWindowsPaths() {
        val event = EventRow(
            type = "tool_call",
            name = "read: file",
            payload = buildJsonObject {
                put("result", """C:\new\test.txt and C:\tools\run.exe""")
            },
            startedAt = "2026-08-18T23:30:00Z",
            endedAt = "2026-08-18T23:30:01Z"
        )
        assertEquals("""C:\new\test.txt and C:\tools\run.exe""", event.resultText)
    }
}
