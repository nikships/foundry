package com.foundry.companion

import com.foundry.companion.util.isHiddenVendorText
import com.foundry.companion.util.isIncompleteFunctionCallJson
import com.foundry.companion.util.isVendorFunctionCallPayload
import com.foundry.companion.util.stripVendorToolEcho
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VendorTextTest {
    private val functionCall = """
        {
          "functionCall": {
            "name": "smith_readiness",
            "args": {
              "operation": "show"
            }
          }
        }
    """.trimIndent()

    @Test
    fun testRecognizesCompleteFunctionCallPayload() {
        assertTrue(isVendorFunctionCallPayload(functionCall))
        assertTrue(isVendorFunctionCallPayload("""{"functionResponse":{"name":"x"}}"""))
        assertFalse(isVendorFunctionCallPayload("Got it."))
        assertFalse(isVendorFunctionCallPayload("""{"ok":true}"""))
    }

    @Test
    fun testHoldsIncompleteFunctionCallJson() {
        assertTrue(isIncompleteFunctionCallJson("{\n  \"functionCall\": {\n    \"name\":"))
        assertFalse(isIncompleteFunctionCallJson(functionCall))
        assertFalse(isIncompleteFunctionCallJson("Got it."))
    }

    @Test
    fun testStripsFinishedEchoes() {
        assertEquals("", stripVendorToolEcho(functionCall))
        assertEquals("", stripVendorToolEcho("Ran `smith_readiness`."))
        assertEquals("Got it.", stripVendorToolEcho("Got it.\nRan `smith_readiness`."))
        assertEquals("Got it.", stripVendorToolEcho("Got it.\n$functionCall"))
    }

    @Test
    fun testHidesEmptyIncompleteAndFinishedEchoes() {
        assertTrue(isHiddenVendorText(""))
        assertTrue(isHiddenVendorText(functionCall))
        assertTrue(isHiddenVendorText("Ran `smith_readiness`."))
        assertTrue(isHiddenVendorText("{\n  \"functionCall\": {"))
        assertFalse(isHiddenVendorText("Got it."))
    }
}
