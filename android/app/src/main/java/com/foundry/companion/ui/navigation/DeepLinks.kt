package com.foundry.companion.ui.navigation

/**
 * Where a launch intent should land. Interrupt notifications carry the
 * interrupt they were posted for, so a tap opens that sheet rather than only
 * dropping the operator on the run and leaving them to find the strip.
 */
data class DeepLinkTarget(val runId: String, val interruptId: String?) {
    val route: String get() = NavRoute.RunDetail.createRoute(runId, interruptId)
}

/**
 * Resolves a launch intent's run/interrupt pair from either shape the app
 * posts: a `foundry://run/<runId>?interrupt=<interruptId>` URI, or the
 * `runId` / `interruptId` extras. Extras win, because a notification always
 * sets them and a URI query is the fallback for an externally built link.
 */
fun resolveDeepLink(
    uriRunId: String?,
    uriInterruptId: String?,
    extraRunId: String?,
    extraInterruptId: String?
): DeepLinkTarget? {
    val interruptId = extraInterruptId?.takeIf { it.isNotBlank() }
        ?: uriInterruptId?.takeIf { it.isNotBlank() }

    val runId = extraRunId?.takeIf { it.isNotBlank() }
        ?: uriRunId?.takeIf { it.isNotBlank() }
        ?: return null

    return DeepLinkTarget(runId, interruptId)
}
