package com.foundry.companion.ui.navigation

/**
 * Where a launch intent should land. Run notifications carry the run they
 * were posted for, so a tap opens that run rather than dropping the operator
 * on whichever project happens to sort first.
 *
 * [projectId] is the run's project when the notification knew it. A cold start
 * has no selected project yet, so without it the run detail would be fetched
 * against whichever project happens to sort first.
 */
data class DeepLinkTarget(
    val runId: String,
    val projectId: String? = null
) {
    val route: String get() = NavRoute.RunDetail.createRoute(runId)
}

/**
 * Resolves a launch intent's run from either shape the app posts: a
 * `foundry://run/<runId>` URI, or the `runId` extra. Extras win, because a
 * notification always sets them and a URI query is the fallback for an
 * externally built link.
 */
fun resolveDeepLink(
    uriRunId: String?,
    extraRunId: String?,
    uriProjectId: String? = null,
    extraProjectId: String? = null
): DeepLinkTarget? {
    val runId = extraRunId?.takeIf { it.isNotBlank() }
        ?: uriRunId?.takeIf { it.isNotBlank() }
        ?: return null

    val projectId = extraProjectId?.takeIf { it.isNotBlank() }
        ?: uriProjectId?.takeIf { it.isNotBlank() }

    return DeepLinkTarget(runId, projectId)
}
