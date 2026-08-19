package com.foundry.companion.ui.navigation

/**
 * Where a launch intent should land. Interrupt notifications carry the
 * interrupt they were posted for, so a tap opens that sheet rather than only
 * dropping the operator on the run and leaving them to find the strip.
 *
 * [projectId] is the run's project when the notification knew it. A cold start
 * has no selected project yet, so without it the run detail would be fetched
 * against whichever project happens to sort first.
 */
data class DeepLinkTarget(
    val runId: String,
    val interruptId: String?,
    val projectId: String? = null
) {
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
    extraInterruptId: String?,
    uriProjectId: String? = null,
    extraProjectId: String? = null
): DeepLinkTarget? {
    val interruptId = extraInterruptId?.takeIf { it.isNotBlank() }
        ?: uriInterruptId?.takeIf { it.isNotBlank() }

    val runId = extraRunId?.takeIf { it.isNotBlank() }
        ?: uriRunId?.takeIf { it.isNotBlank() }
        ?: return null

    val projectId = extraProjectId?.takeIf { it.isNotBlank() }
        ?: uriProjectId?.takeIf { it.isNotBlank() }

    return DeepLinkTarget(runId, interruptId, projectId)
}
