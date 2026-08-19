package com.foundry.companion.util

import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent

/**
 * Opens GitHub (and any other http(s) URL) in a Custom Tab rather than a raw
 * `ACTION_VIEW`. Spec §3.4.1: Open PR / Open Issue stay in-app chrome.
 */
object CustomTabs {
    fun intent(): CustomTabsIntent =
        CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setUrlBarHidingEnabled(true)
            .build()

    fun open(context: Context, url: String) {
        if (url.isBlank()) return
        intent().launchUrl(context, Uri.parse(url))
    }
}
