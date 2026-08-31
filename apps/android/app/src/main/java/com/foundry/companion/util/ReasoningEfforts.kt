package com.foundry.companion.util

import com.foundry.companion.data.model.SmithModelInfo

/** Every reasoning level understood by the paired desktop, in display order. */
val KNOWN_REASONING_EFFORTS = listOf(
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
)

/** The levels a model offers, falling back to off when its catalog row is empty. */
fun supportedReasoningEfforts(model: SmithModelInfo?): List<String> {
    if (model == null) return KNOWN_REASONING_EFFORTS
    val supported = KNOWN_REASONING_EFFORTS.filter(model.supportedReasoningEfforts::contains)
    return supported.ifEmpty { listOf("off") }
}

/**
 * Keeps a supported choice, otherwise uses the selected model's default and
 * then its first supported level. Unknown models stay untouched because the
 * phone has no capability row against which to normalize them.
 */
fun normalizeReasoningEffort(
    wanted: String,
    model: SmithModelInfo?
): String {
    if (model == null) return wanted
    val supported = supportedReasoningEfforts(model)
    if (wanted in supported) return wanted
    if (model.defaultReasoningEffort in supported) return model.defaultReasoningEffort
    return supported.first()
}

fun normalizeReasoningEffortForModelChoice(
    wanted: String,
    modelId: String,
    models: List<SmithModelInfo>
): String = normalizeReasoningEffort(wanted, models.firstOrNull { it.id == modelId })
