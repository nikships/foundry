package com.foundry.companion

import com.foundry.companion.data.model.*
import com.foundry.companion.data.repository.CompanionRepository
import com.foundry.companion.voice.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SmithVoiceToolsTest {
    private class Host : CompanionRepository by OfflineCompanionRepository() {
        var proposals = emptyList<SmithProposal>()
        var state = SmithChatState()
        var sentScope: String? = "not sent"
        var answers = mutableListOf<Pair<String, SmithProposalAnswer>>()
        override suspend fun getSmithProposals() = Result.success(proposals)
        override suspend fun getSmithState(projectId: String?) = Result.success(state)
        override suspend fun sendSmith(projectId: String?, text: String, screen: SmithScreenContext): Result<SmithChatState> {
            sentScope = projectId
            state = state.copy(running = true, transcript = state.transcript +
                SmithTranscriptEntry(id = "operator-new", source = "operator", text = text))
            return Result.success(state)
        }
        override suspend fun answerSmithProposal(id: String, answer: SmithProposalAnswer): Result<SmithProposalAnswerResult> {
            answers.add(id to answer)
            return Result.success(SmithProposalAnswerResult(true))
        }
    }

    @Test fun `approval is scoped read first unchanged and strictly boolean`() = runTest {
        val host = Host()
        val proposal = SmithProposal("wanted", "action", projectId = "p", title = "Deploy")
        host.proposals = listOf(SmithProposal("global", "action"), proposal)
        val tools = SmithVoiceTools(host, "p", backgroundScope) {}
        val approve = voiceObject("approved" to JsonPrimitive(true))
        assertTrue("error" in tools.call("smith_proposal_answer", approve))
        assertEquals("wanted", tools.call("smith_proposal_read", voiceObject())["id"]?.jsonPrimitive?.content)
        assertTrue("error" in tools.call("smith_proposal_answer", voiceObject("approved" to voiceText("true"))))
        assertTrue("error" in tools.call("smith_proposal_answer", voiceObject()))
        host.proposals = listOf(proposal.copy(title = "Changed action"))
        assertTrue("error" in tools.call("smith_proposal_answer", approve))
        tools.call("smith_proposal_read", voiceObject())
        assertEquals(JsonPrimitive(true), tools.call("smith_proposal_answer", approve)["ok"])
        assertEquals(listOf("wanted" to SmithProposalAnswer(true)), host.answers)
    }

    @Test fun `secret proposals cannot be approved by voice but can be rejected after reading`() = runTest {
        val host = Host()
        host.proposals = listOf(SmithProposal("secret", "action", secretRequest = SmithSecretRequest()))
        val tools = SmithVoiceTools(host, null, backgroundScope) {}
        tools.call("smith_proposal_read", voiceObject())
        assertTrue("error" in tools.call("smith_proposal_answer", voiceObject("approved" to JsonPrimitive(true))))
        assertTrue(host.answers.isEmpty())
        tools.call("smith_proposal_answer", voiceObject("approved" to JsonPrimitive(false)))
        assertEquals(SmithProposalAnswer(false, secret = null), host.answers.single().second)
    }

    @Test fun `delegate returns started then reports only fresh scoped settlement including failure`() = runTest {
        val host = Host()
        val old = SmithTranscriptEntry(id = "old", text = "Old answer")
        host.state = SmithChatState(projectId = "p", transcript = listOf(old))
        val reports = mutableListOf<String>()
        val tools = SmithVoiceTools(host, "p", backgroundScope, reports::add)
        assertEquals("started", tools.call("smith_delegate", voiceObject("text" to voiceText("Fix it")))["status"]?.jsonPrimitive?.content)
        assertEquals("p", host.sentScope)
        assertTrue(reports.isEmpty())
        host.state = host.state.copy(running = false, transcript = host.state.transcript +
            SmithTranscriptEntry(id = "new", kind = "error", text = "Build failed", failed = true))
        advanceTimeBy(1200)
        runCurrent()
        assertEquals(listOf("Smith failed: Build failed"), reports)
        assertFalse(settledVoiceSummary(SmithChatState(transcript = listOf(old)), setOf("old")).contains("Old answer"))
    }

    @Test fun `another operator turn cannot be reported as this delegation result`() = runTest {
        val host = Host()
        val reports = mutableListOf<String>()
        val tools = SmithVoiceTools(host, null, backgroundScope, reports::add)
        tools.call("smith_delegate", voiceObject("text" to voiceText("First task")))
        host.state = host.state.copy(running = false, transcript = host.state.transcript + listOf(
            SmithTranscriptEntry(id = "other-operator", source = "operator", text = "Different task"),
            SmithTranscriptEntry(id = "other-answer", text = "Unrelated answer")
        ))
        advanceTimeBy(1200)
        runCurrent()
        assertTrue(reports.single().contains("conversation changed"))
        assertFalse(reports.single().contains("Unrelated answer"))
    }

    @Test fun `cancelled read cannot submit a late approval`() = runTest {
        val host = Host()
        host.proposals = listOf(SmithProposal("p1", "action"))
        val release = CompletableDeferred<Unit>()
        var delayRead = false
        val repository = object : CompanionRepository by host {
            override suspend fun getSmithProposals(): Result<List<SmithProposal>> {
                if (delayRead) withContext(NonCancellable) { release.await() }
                return Result.success(host.proposals)
            }
        }
        val tools = SmithVoiceTools(repository, null, backgroundScope) {}
        tools.call("smith_proposal_read", voiceObject())
        delayRead = true
        val job = launch { tools.call("smith_proposal_answer", voiceObject("approved" to JsonPrimitive(true))) }
        runCurrent()
        job.cancel()
        release.complete(Unit)
        runCurrent()
        assertTrue(host.answers.isEmpty())
    }

    @Test fun `protocol messages carry no credential and use the live session types`() {
        val audio = SmithVoiceProtocol.inputAudio("pcm-bytes")
        assertEquals("session.input_audio.append", audio.getValue("type").jsonPrimitive.content)
        assertEquals("pcm-bytes", audio.getValue("audio").jsonPrimitive.content)
        assertFalse(audio.toString().contains("sk-"))
        assertEquals("session.input_audio.mute", SmithVoiceProtocol.mute(true).getValue("type").jsonPrimitive.content)
        assertEquals("session.input_audio.unmute", SmithVoiceProtocol.mute(false).getValue("type").jsonPrimitive.content)
        val commentary = SmithVoiceProtocol.commentary("del_1", "Smith finished")
        assertEquals("session.commentary.append", commentary.getValue("type").jsonPrimitive.content)
        assertEquals("del_1", commentary.getValue("delegation_id").jsonPrimitive.content)
        assertEquals("Smith finished", commentary.getValue("content").jsonPrimitive.content)
    }

    @Test fun `captions accumulate fragments and bound history and entry length`() {
        var captions = appendVoiceCaption(emptyList(), "Smith", "Hello")
        captions = appendVoiceCaption(captions, "Smith", " there")
        assertEquals("Hello there", captions.single().text)
        repeat(30) { captions = appendVoiceCaption(captions, if (it % 2 == 0) "You" else "Smith", "x".repeat(3000)) }
        assertEquals(12, captions.size)
        assertTrue(captions.all { it.text.length == 2000 })
    }
}
