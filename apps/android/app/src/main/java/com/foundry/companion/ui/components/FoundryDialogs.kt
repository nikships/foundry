package com.foundry.companion.ui.components

import android.view.WindowManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider

const val FoundryScrimAlpha = 0.62f

/** Material's default 32% dim is invisible on Foundry's near-black canvas. */
@Composable
fun ApplyFoundryDialogScrim(alpha: Float = FoundryScrimAlpha) {
    val view = LocalView.current
    SideEffect {
        val window = (view.parent as? DialogWindowProvider)?.window ?: return@SideEffect
        window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        window.setDimAmount(alpha)
    }
}
