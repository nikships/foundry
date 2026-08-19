package com.foundry.companion.ui.screens.pair

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.foundry.companion.data.model.COMPANION_PROTOCOL_VERSION
import com.foundry.companion.data.model.CompanionPairingPayload
import com.foundry.companion.ui.components.FoundryPrimaryButton
import com.foundry.companion.ui.theme.FoundryTheme
import com.google.zxing.*
import com.google.zxing.common.HybridBinarizer
import kotlinx.serialization.json.Json
import java.util.concurrent.Executors

@Composable
fun PairScreen(
    onPairSuccess: () -> Unit,
    onPairScanned: (CompanionPairingPayload) -> Unit,
    errorMessage: String? = null,
    isPairing: Boolean = false,
    initialPasteMode: Boolean = false,
    modifier: Modifier = Modifier
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

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasCameraPermission = granted
        if (!granted) {
            isPasteMode = true
        }
    }

    LaunchedEffect(initialPasteMode) {
        if (!hasCameraPermission && !initialPasteMode) {
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
            val payload = jsonParser.decodeFromString<CompanionPairingPayload>(trimmed)
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
        } catch (e: Exception) {
            localValidationIssue =
                "Could not parse pairing JSON. Ensure you copied the full payload from Foundry Settings → Phone."
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
                    text = "Scan the QR code in Foundry → Settings → Phone on your Mac",
                    style = typography.body,
                    color = colors.textDim,
                    textAlign = TextAlign.Center
                )
            }

            Spacer(modifier = Modifier.height(20.dp))

            // Main scanning view or Paste fallback card
            if (hasCameraPermission && !isPasteMode) {
                // Live Camera QR Viewfinder
                Box(
                    modifier = Modifier
                        .size(280.dp)
                        .background(colors.bgInput, shapes.card)
                        .border(1.dp, colors.lineStrong, shapes.card),
                    contentAlignment = Alignment.Center
                ) {
                    CameraQrScannerView(
                        onQrScanned = { rawPayload ->
                            processPayloadString(rawPayload)
                        }
                    )

                    // Scanning reticle and laser sweep overlay
                    ReticleOverlay(isPairing = isPairing)
                }
            } else {
                // Camera denied or manual Paste fallback card
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
                        text = if (!hasCameraPermission) {
                            "Foundry is waiting on your Mac. Paste its pairing code below to connect without a camera."
                        } else {
                            "Paste the pairing JSON copied from Foundry Settings → Phone:"
                        },
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

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
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

                        if (!hasCameraPermission) {
                            TextButton(
                                onClick = {
                                    permissionLauncher.launch(Manifest.permission.CAMERA)
                                }
                            ) {
                                Text(
                                    text = "TRY CAMERA",
                                    style = typography.labelMono,
                                    color = colors.textDim
                                )
                            }
                        }
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
                if (hasCameraPermission && !isPasteMode) {
                    TextButton(
                        onClick = { isPasteMode = true }
                    ) {
                        Text(
                            text = "PASTE PAIRING CODE INSTEAD",
                            style = typography.labelMono,
                            color = colors.textDim
                        )
                    }
                } else {
                    FoundryPrimaryButton(
                        text = "Pair with Desktop",
                        onClick = {
                            processPayloadString(pastedJson)
                        },
                        isLoading = isPairing,
                        enabled = pastedJson.isNotBlank() && !isPairing
                    )

                    if (hasCameraPermission) {
                        TextButton(
                            onClick = { isPasteMode = false }
                        ) {
                            Text(
                                text = "USE CAMERA SCANNER",
                                style = typography.labelMono,
                                color = colors.textDim
                            )
                        }
                    }
                }

                Text(
                    text = "LAN ONLY · NO ACCOUNT REQUIRED",
                    style = typography.eyebrowMono,
                    color = colors.textFaint
                )
            }
        }
    }
}

@Composable
private fun ReticleOverlay(isPairing: Boolean) {
    val colors = FoundryTheme.colors
    val isInspection = androidx.compose.ui.platform.LocalInspectionMode.current

    val laserY = if (isInspection) {
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

@Composable
private fun CameraQrScannerView(
    onQrScanned: (String) -> Unit
) {
    val context = LocalContext.current
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    val cameraExecutor = remember { Executors.newSingleThreadExecutor() }

    AndroidView(
        factory = { ctx ->
            val previewView = PreviewView(ctx)
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

                    val analyzer = QrCodeAnalyzer { qrText ->
                        onQrScanned(qrText)
                    }
                    imageAnalysis.setAnalyzer(cameraExecutor, analyzer)

                    val cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA

                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(
                        lifecycleOwner,
                        cameraSelector,
                        preview,
                        imageAnalysis
                    )
                } catch (_: Exception) {
                    // Camera binding failure (e.g. running in Robolectric/emulator without camera)
                }
            }, ContextCompat.getMainExecutor(ctx))

            previewView
        },
        modifier = Modifier.fillMaxSize()
    )
}

private class QrCodeAnalyzer(
    private val onQrCodeScanned: (String) -> Unit
) : ImageAnalysis.Analyzer {
    private val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE)))
    }
    private var isScanning = true

    @androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
    override fun analyze(imageProxy: ImageProxy) {
        val mediaImage = imageProxy.image
        if (mediaImage != null && isScanning) {
            val buffer = mediaImage.planes[0].buffer
            val data = ByteArray(buffer.remaining())
            buffer.get(data)
            val width = imageProxy.width
            val height = imageProxy.height

            val source = PlanarYUVLuminanceSource(
                data, width, height, 0, 0, width, height, false
            )
            val bitmap = BinaryBitmap(HybridBinarizer(source))

            try {
                val result = reader.decodeWithState(bitmap)
                isScanning = false
                onQrCodeScanned(result.text)
            } catch (_: Exception) {
                // No QR in this frame
            } finally {
                reader.reset()
            }
        }
        imageProxy.close()
    }
}
