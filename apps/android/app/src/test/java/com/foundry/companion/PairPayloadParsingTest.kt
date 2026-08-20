package com.foundry.companion

import android.net.Uri
import com.foundry.companion.data.model.COMPANION_PROTOCOL_VERSION
import com.foundry.companion.data.model.CompanionPairingPayload
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PairPayloadParsingTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private fun parsePayload(raw: String): CompanionPairingPayload {
        val trimmed = raw.trim()
        return if (trimmed.startsWith("{")) {
            json.decodeFromString<CompanionPairingPayload>(trimmed)
        } else if (trimmed.startsWith("foundry://") || trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            val uri = Uri.parse(trimmed)
            val origin = uri.getQueryParameter("origin")
                ?: (if (trimmed.startsWith("http")) "${uri.scheme}://${uri.authority}" else "")
            val secret = uri.getQueryParameter("secret")
                ?: uri.fragment?.removePrefix("secret=")
                ?: ""
            val version = uri.getQueryParameter("v")?.toIntOrNull() ?: COMPANION_PROTOCOL_VERSION
            val desktopId = uri.getQueryParameter("desktopId").orEmpty()
            val desktopName = uri.getQueryParameter("desktopName").orEmpty()
            val expiresAt = uri.getQueryParameter("expiresAt").orEmpty()
            CompanionPairingPayload(
                protocolVersion = version,
                origin = origin,
                desktopId = desktopId,
                desktopName = desktopName,
                secret = secret,
                expiresAt = expiresAt
            )
        } else {
            json.decodeFromString<CompanionPairingPayload>(trimmed)
        }
    }

    @Test
    fun parseFullJsonPayload() {
        val jsonStr = """
            {
                "protocolVersion": 1,
                "origin": "http://192.168.1.150:52810",
                "desktopId": "desk_123",
                "desktopName": "Nik's Mac",
                "secret": "secret_abc_123",
                "expiresAt": "2026-08-19T12:00:00.000Z"
            }
        """.trimIndent()
        val payload = parsePayload(jsonStr)
        assertEquals("http://192.168.1.150:52810", payload.origin)
        assertEquals("secret_abc_123", payload.secret)
        assertEquals(1, payload.protocolVersion)
        assertEquals("desk_123", payload.desktopId)
        assertEquals("Nik's Mac", payload.desktopName)
    }

    @Test
    fun parseCompactUriPayload() {
        val uriStr = "foundry://pair?origin=http%3A%2F%2F192.168.0.148%3A54325&secret=secret_xyz_789"
        val payload = parsePayload(uriStr)
        assertEquals("http://192.168.0.148:54325", payload.origin)
        assertEquals("secret_xyz_789", payload.secret)
        assertEquals(COMPANION_PROTOCOL_VERSION, payload.protocolVersion)
    }

    @Test
    fun parseHttpUriPayload() {
        val uriStr = "http://192.168.0.148:54325/pair#secret=secret_http_456"
        val payload = parsePayload(uriStr)
        assertEquals("http://192.168.0.148:54325", payload.origin)
        assertEquals("secret_http_456", payload.secret)
        assertEquals(COMPANION_PROTOCOL_VERSION, payload.protocolVersion)
    }
}
