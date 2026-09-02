package com.foundry.companion.ui.screens.pair

import android.Manifest
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.foundry.companion.data.model.COMPANION_PROTOCOL_VERSION
import com.foundry.companion.data.model.CompanionPairingPayload
import com.foundry.companion.ui.components.FoundryPrimaryButton
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.ui.theme.foundryLiveClockEnabled
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import kotlinx.serialization.json.Json
import java.util.concurrent.Executors

enum class CameraPermissionPrompt { Granted, Request, Settings }

internal fun cameraPermissionPrompt(
    granted: Boolean,
    asked: Boolean,
    shouldShowRationale: Boolean
): CameraPermissionPrompt = when {
    granted -> CameraPermissionPrompt.Granted
    !asked || shouldShowRationale -> CameraPermissionPrompt.Request
    else -> CameraPermissionPrompt.Settings
}

@Composable
fun PairScreen(
    onPairSuccess: () -> Unit,
    onPairScanned: (CompanionPairingPayload) -> Unit,
    errorMessage: String? = null,
    isPairing: Boolean = false,
    initialPasteMode: Boolean = false,
    modifier: Modifier = Modifier,
    cameraPromptOverride: CameraPermissionPrompt? = null
) {
    val context = LocalContext.current
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes

    var hasCameraPermission by remember {
        mutableStateOf(
            if (initialPasteMode) false else ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.CAMERA
            ) == PackageManager.PERMISSION_GRANTED
        )
    }

    var isPasteMode by remember { mutableStateOf(initialPasteMode) }
    var pastedJson by remember { mutableStateOf("") }
    var localValidationIssue by remember { mutableStateOf<String?>(null) }
    var hasAskedCamera by rememberSaveable {
        mutableStateOf(cameraPromptOverride == CameraPermissionPrompt.Settings)
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasAskedCamera = true
        hasCameraPermission = granted
        if (granted) {
            isPasteMode = false
        }
    }

    val activity = context as? Activity
    val shouldShowRationale = activity != null &&
        ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.CAMERA)
    val cameraPrompt = cameraPromptOverride ?: cameraPermissionPrompt(
        granted = hasCameraPermission,
        asked = hasAskedCamera,
        shouldShowRationale = shouldShowRationale
    )

    BackHandler(enabled = isPasteMode) {
        isPasteMode = false
    }

    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, initialPasteMode) {
        if (initialPasteMode) {
            return@DisposableEffect onDispose { }
        }
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                hasCameraPermission = ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.CAMERA
                ) == PackageManager.PERMISSION_GRANTED
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    LaunchedEffect(initialPasteMode, cameraPromptOverride) {
        if (cameraPromptOverride != null) return@LaunchedEffect
        if (!hasCameraPermission && !initialPasteMode && !hasAskedCamera) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    val jsonParser = remember { Json { ignoreUnknownKeys = true; isLenient = true } }

    fun processPayloadString(raw: String) {
        val trimmed = raw.trim()
        if (trimmed.isBlank()) {
            localValidationIssue = "Please paste the pairing code from Foundry."
            return
        }
        try {
            val payload = parseCompanionPairingPayload(trimmed, jsonParser)
            if (payload.origin.isBlank() || payload.secret.isBlank()) {
                localValidationIssue = "Invalid pairing payload: missing origin or secret."
                return
            }
            if (payload.protocolVersion != COMPANION_PROTOCOL_VERSION) {
                localValidationIssue =
                    "Protocol mismatch: Desktop is v${payload.protocolVersion}, Phone is v$COMPANION_PROTOCOL_VERSION. Please update the older app."
                return
            }
            localValidationIssue = null
            onPairScanned(payload)
        } catch (_: Exception) {
            localValidationIssue =
                "Could not parse pairing code. Ensure you copied or scanned the payload from Foundry Settings → Companion."
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bgBase)
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp)
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            // Top Header
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.padding(top = 12.dp)
            ) {
                Text(
                    text = "FOUNDRY",
                    style = typography.labelMono,
                    color = colors.accent
                )
                Text(
                    text = "Pair Companion",
                    style = typography.screenTitle,
                    color = colors.textPrimary
                )
                Text(
                    text = if (isPasteMode) {
                        "Paste the pairing code from Foundry → Settings → Companion on your Mac"
                    } else {
                        "Scan the QR code in Foundry → Settings → Companion on your Mac"
                    },
                    style = typography.body,
                    color = colors.textDim,
                    textAlign = TextAlign.Center
                )
            }

            Spacer(modifier = Modifier.height(20.dp))

            // Scanner, camera-denied card, or paste escape hatch
            if (cameraPrompt == CameraPermissionPrompt.Granted && !isPasteMode) {
                Box(
                    modifier = Modifier
                        .size(280.dp)
                        .background(colors.bgInput, shapes.card)
                        .border(1.dp, colors.lineStrong, shapes.card)
                        .semantics { contentDescription = "Scan the pairing QR code" },
                    contentAlignment = Alignment.Center
                ) {
                    CameraQrScannerView(
                        onQrScanned = { rawPayload ->
                            processPayloadString(rawPayload)
                        },
                        isPairing = isPairing,
                    )
                    ReticleOverlay(isPairing = isPairing)
                }
            } else if (cameraPrompt != CameraPermissionPrompt.Granted && !isPasteMode) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.bgPanel, shapes.card)
                        .border(1.dp, colors.line, shapes.card)
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text(
                        text = "CAMERA",
                        style = typography.eyebrowMono,
                        color = colors.accent
                    )
                    Text(
                        text = "Foundry is waiting on your Mac. Allow camera access to scan its pairing code.",
                        style = typography.body,
                        color = colors.textDim
                    )
                    if (cameraPrompt == CameraPermissionPrompt.Settings) {
                        FoundryPrimaryButton(
                            text = "Open app settings",
                            onClick = { openAppSettings(context) },
                            contentDescription = "Open app settings"
                        )
                    } else {
                        FoundryPrimaryButton(
                            text = "Allow camera",
                            onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) },
                            contentDescription = "Allow camera"
                        )
                    }
                }
            } else {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.bgPanel, shapes.card)
                        .border(1.dp, colors.line, shapes.card)
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text(
                        text = "PAIRING CODE",
                        style = typography.eyebrowMono,
                        color = colors.accent
                    )
                    Text(
                        text = "Paste the pairing JSON copied from Foundry Settings → Companion:",
                        style = typography.body,
                        color = colors.textDim
                    )

                    OutlinedTextField(
                        value = pastedJson,
                        onValueChange = {
                            pastedJson = it
                            localValidationIssue = null
                        },
                        placeholder = {
                            Text(
                                text = "{\"protocolVersion\":1,\"origin\":\"http://192.168...\",\"secret\":\"...\"}",
                                style = typography.metaMono,
                                color = colors.textFaint
                            )
                        },
                        textStyle = typography.metaMono.copy(color = colors.textPrimary),
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(110.dp),
                        shape = shapes.card,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedContainerColor = colors.bgInput,
                            unfocusedContainerColor = colors.bgInput,
                            focusedBorderColor = colors.accent,
                            unfocusedBorderColor = colors.line
                        )
                    )

                    TextButton(
                        onClick = {
                            val clipboard =
                                context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                            val clipText = clipboard?.primaryClip?.getItemAt(0)?.text?.toString()
                            if (!clipText.isNullOrBlank()) {
                                pastedJson = clipText
                                localValidationIssue = null
                            }
                        }
                    ) {
                        Text(
                            text = "PASTE CLIPBOARD",
                            style = typography.labelMono,
                            color = colors.accent
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Error display (from server rejection or local validation)
            val activeError = errorMessage ?: localValidationIssue
            if (!activeError.isNullOrBlank()) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.statusFailed.copy(alpha = 0.14f), shapes.card)
                        .border(1.dp, colors.statusFailed.copy(alpha = 0.3f), shapes.card)
                        .padding(14.dp)
                ) {
                    Text(
                        text = activeError,
                        style = typography.body,
                        color = colors.statusFailed,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
                Spacer(modifier = Modifier.height(12.dp))
            }

            // Bottom Actions
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                if (!isPasteMode) {
                    TextButton(
                        onClick = { isPasteMode = true },
                        modifier = Modifier
                            .heightIn(min = 48.dp)
                            .semantics { contentDescription = "Paste pairing code instead" }
                    ) {
                        Text(
                            text = "PASTE PAIRING CODE INSTEAD",
                            style = typography.labelMono,
                            color = colors.textPrimary
                        )
                    }
                } else {
                    FoundryPrimaryButton(
                        text = "Pair with Desktop",
                        onClick = {
                            processPayloadString(pastedJson)
                        },
                        isLoading = isPairing,
                        enabled = pastedJson.isNotBlank() && !isPairing,
                        contentDescription = "Pair with desktop"
                    )

                    TextButton(
                        onClick = { isPasteMode = false },
                        modifier = Modifier
                            .heightIn(min = 48.dp)
                            .semantics { contentDescription = "Scan QR code instead" }
                    ) {
                        Text(
                            text = "SCAN QR CODE INSTEAD",
                            style = typography.labelMono,
                            color = colors.textPrimary
                        )
                    }
                }

                Text(
                    text = "LAN ONLY · NO ACCOUNT REQUIRED",
                    style = typography.eyebrowMono,
                    color = colors.textDim
                )
            }
        }
    }
}

@Composable
private fun ReticleOverlay(isPairing: Boolean) {
    val colors = FoundryTheme.colors
    val laserY = if (!foundryLiveClockEnabled()) {
        0.5f
    } else {
        val infiniteTransition = rememberInfiniteTransition(label = "reticleScan")
        val animatedY by infiniteTransition.animateFloat(
            initialValue = 0.1f,
            targetValue = 0.9f,
            animationSpec = infiniteRepeatable(
                animation = tween(1800, easing = LinearEasing),
                repeatMode = RepeatMode.Reverse
            ),
            label = "laser"
        )
        animatedY
    }

    Canvas(modifier = Modifier.fillMaxSize().padding(20.dp)) {
        val strokeWidth = 3.dp.toPx()
        val cornerLength = 26.dp.toPx()
        val color = colors.accent

        // Top-Left corner
        drawLine(color, Offset(0f, 0f), Offset(cornerLength, 0f), strokeWidth)
        drawLine(color, Offset(0f, 0f), Offset(0f, cornerLength), strokeWidth)

        // Top-Right corner
        drawLine(color, Offset(size.width, 0f), Offset(size.width - cornerLength, 0f), strokeWidth)
        drawLine(color, Offset(size.width, 0f), Offset(size.width, cornerLength), strokeWidth)

        // Bottom-Left corner
        drawLine(color, Offset(0f, size.height), Offset(cornerLength, size.height), strokeWidth)
        drawLine(color, Offset(0f, size.height), Offset(0f, size.height - cornerLength), strokeWidth)

        // Bottom-Right corner
        drawLine(color, Offset(size.width, size.height), Offset(size.width - cornerLength, size.height), strokeWidth)
        drawLine(color, Offset(size.width, size.height), Offset(size.width, size.height - cornerLength), strokeWidth)

        // Laser scan line
        if (!isPairing) {
            val y = size.height * laserY
            drawLine(
                color = color.copy(alpha = 0.7f),
                start = Offset(10.dp.toPx(), y),
                end = Offset(size.width - 10.dp.toPx(), y),
                strokeWidth = 2.dp.toPx()
            )
        }
    }

    if (isPairing) {
        Box(
            modifier = Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.6f)),
            contentAlignment = Alignment.Center
        ) {
            CircularProgressIndicator(
                color = colors.accent,
                strokeWidth = 3.dp
            )
        }
    }
}

@androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
@Composable
private fun CameraQrScannerView(
    onQrScanned: (String) -> Unit,
    isPairing: Boolean,
) {
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    val analyzerExecutor = remember { Executors.newSingleThreadExecutor() }
    val barcodeScanner = remember {
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build(),
        )
    }
    val currentOnQrScanned by rememberUpdatedState(onQrScanned)
    val deduper = remember { QrDeduper() }

    LaunchedEffect(isPairing) {
        if (!isPairing) deduper.reset()
    }

    DisposableEffect(Unit) {
        onDispose {
            analyzerExecutor.shutdown()
            barcodeScanner.close()
        }
    }

    AndroidView(
        factory = { ctx ->
            val previewView = PreviewView(ctx).apply {
                scaleType = PreviewView.ScaleType.FILL_CENTER
            }
            val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)

            cameraProviderFuture.addListener({
                try {
                    val cameraProvider = cameraProviderFuture.get()
                    val preview = Preview.Builder().build().also {
                        it.setSurfaceProvider(previewView.surfaceProvider)
                    }

                    val imageAnalysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                    imageAnalysis.setAnalyzer(analyzerExecutor) { proxy ->
                        val image = proxy.image
                        if (image == null) {
                            proxy.close()
                            return@setAnalyzer
                        }
                        val input = InputImage.fromMediaImage(image, proxy.imageInfo.rotationDegrees)
                        barcodeScanner.process(input)
                            .addOnSuccessListener { barcodes ->
                                val raw = barcodes.firstNotNullOfOrNull { it.rawValue }
                                if (raw != null && deduper.take(raw)) {
                                    currentOnQrScanned(raw)
                                }
                            }
                            .addOnCompleteListener {
                                proxy.close()
                            }
                    }

                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        imageAnalysis,
                    )
                } catch (_: Exception) {
                    // Camera binding failure (e.g. running in Robolectric/emulator without camera)
                }
            }, ContextCompat.getMainExecutor(ctx))

            previewView
        },
        modifier = Modifier.fillMaxSize(),
    )
}

internal fun parseCompanionPairingPayload(raw: String, jsonParser: Json): CompanionPairingPayload {
    val trimmed = raw.trim()
    if (trimmed.startsWith("foundry://") || trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        val uri = Uri.parse(trimmed)
        val origin = uri.getQueryParameter("origin")
            ?: (if (trimmed.startsWith("http")) "${uri.scheme}://${uri.authority}" else "")
        val secret = uri.getQueryParameter("secret")
            ?: uri.fragment?.removePrefix("secret=")
            ?: ""
        return CompanionPairingPayload(
            protocolVersion = uri.getQueryParameter("v")?.toIntOrNull() ?: COMPANION_PROTOCOL_VERSION,
            origin = origin,
            desktopId = uri.getQueryParameter("desktopId").orEmpty(),
            desktopName = uri.getQueryParameter("desktopName").orEmpty(),
            secret = secret,
            expiresAt = uri.getQueryParameter("expiresAt").orEmpty()
        )
    }
    return jsonParser.decodeFromString(trimmed)
}

private fun openAppSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
        data = Uri.fromParts("package", context.packageName, null)
    }
    context.startActivity(intent)
}

private class QrDeduper {
    @Volatile
    private var last: String? = null

    fun take(raw: String): Boolean {
        if (raw == last) return false
        last = raw
        return true
    }

    fun reset() {
        last = null
    }
}
