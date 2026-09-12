package com.foundry.companion.voice

import com.foundry.companion.data.model.*
import com.foundry.companion.data.repository.CompanionRepository
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

/** One tool bridge per voice session; all operations stay in its captured project. */
internal class SmithVoiceTools(
    private val repository: CompanionRepository,
    private val projectId: String?,
    private val scope: CoroutineScope,
    private val onSettled: (String) -> Unit
) {
    private val mutex = Mutex()
    private var readProposal: SmithProposal? = null
    private var pending: Job? = null

    suspend fun call(name: String, args: JsonObject): JsonObject = mutex.withLock {
        try {
            currentCoroutineContext().ensureActive()
            when (name) {
                "smith_delegate" -> delegate(args)
                "smith_cancel" -> {
                    repository.cancelSmith(projectId).getOrThrow()
                    voiceObject("status" to voiceText("Cancellation requested"))
                }
                "smith_proposal_read" -> {
                    val proposal = currentProposal()
                    readProposal = proposal
                    if (proposal == null) voiceObject("status" to voiceText("No pending proposal"))
                    else voiceObject(
                        "id" to voiceText(proposal.id),
                        "title" to voiceText(proposal.headline),
                        "summary" to voiceText(proposal.body),
                        "risk" to voiceText(proposal.risk.orEmpty()),
                        "requiresTypedSecret" to JsonPrimitive(proposal.needsSecret)
                    )
                }
                "smith_proposal_answer" -> {
                    val approved = (args["approved"] as? JsonPrimitive)
                        ?.takeUnless { it.isString }?.booleanOrNull
                        ?: error("approved must be a boolean")
                    val proposal = currentProposal() ?: error("No pending proposal")
                    currentCoroutineContext().ensureActive()
                    check(proposal == readProposal) { "Proposal changed or has not been read. Read it again first." }
                    check(!approved || !proposal.needsSecret) { "Enter this secret in the approval card, never by voice." }
                    readProposal = null
                    val result = repository.answerSmithProposal(proposal.id, SmithProposalAnswer(approved)).getOrThrow()
                    check(result.ok) { "The host could not apply this answer. Check the approval card." }
                    voiceObject("ok" to JsonPrimitive(true))
                }
                else -> error("Unknown voice tool")
            }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) {
            // Transport errors can contain URLs/headers. Do not feed them to the model.
            voiceObject("error" to voiceText("Smith action could not complete. Read the current proposal or check Smith on screen; do not assume success."))
        }
    }

    private suspend fun currentProposal(): SmithProposal? = repository.getSmithProposals().getOrThrow()
        .firstOrNull { it.projectId == projectId }

    private suspend fun delegate(args: JsonObject): JsonObject {
        val text = (args["text"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim().orEmpty()
        require(text.isNotEmpty())
        check(pending?.isActive != true)
        val before = repository.getSmithState(projectId).getOrThrow()
        currentCoroutineContext().ensureActive()
        check(!before.running)
        val submitted = repository.sendSmith(projectId, text, SmithScreenContext("smith")).getOrThrow()
        currentCoroutineContext().ensureActive()
        val baseline = before.transcript.map { it.id }.toSet()
        val turnId = submitted.transcript.lastOrNull { it.isOperator && it.id !in baseline }?.id
        pending = scope.launch {
            // The tool response is sent before any completion notification.
            delay(100)
            try {
                val result = withTimeout(10 * 60 * 1000L) {
                    var state = submitted
                    while (state.running) {
                        delay(1000)
                        state = repository.getSmithState(projectId).getOrThrow()
                    }
                    if (turnId.isNullOrBlank() || state.projectId != projectId ||
                        state.transcript.lastOrNull { it.isOperator }?.id != turnId) {
                        "Smith conversation changed before completion could be confirmed. Check the chat; do not reuse earlier answers."
                    } else settledVoiceSummary(state, baseline)
                }
                onSettled(result)
            } catch (e: TimeoutCancellationException) {
                onSettled("Smith is taking longer than expected. Check the conversation; completion is not confirmed.")
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { onSettled("Could not confirm Smith completion. Check the conversation on screen.") }
        }
        return voiceObject("status" to voiceText("started"))
    }
}

internal fun settledVoiceSummary(state: SmithChatState, previousIds: Set<String>): String {
    val fresh = state.transcript.filter { it.id.isNotBlank() && it.id !in previousIds && !it.isOperator }
    val failure = state.error?.takeIf { it.isNotBlank() }
        ?: fresh.lastOrNull { it.failed == true || it.kind == "error" }?.text
    if (failure != null) return "Smith failed: ${failure.take(3000)}"
    return fresh.filter { it.kind == "text" }.joinToString("\n") { it.text }.takeLast(6000)
        .ifBlank { "Smith finished without a new text answer. Check the conversation for artifacts or approvals." }
}
