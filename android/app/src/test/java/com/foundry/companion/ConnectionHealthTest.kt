package com.foundry.companion

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.foundry.companion.data.model.COMPANION_PROTOCOL_VERSION
import com.foundry.companion.data.model.ConnectionStatus
import com.foundry.companion.data.model.PairedSession
import com.foundry.companion.data.repository.FakeCompanionRepository
import com.foundry.companion.data.repository.HttpCompanionRepository
import com.foundry.companion.data.session.SessionManager
import com.foundry.companion.viewmodel.CompanionViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.TimeUnit

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ConnectionHealthTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var context: Context
    private lateinit var sessionManager: SessionManager
    private lateinit var repository: FakeCompanionRepository
    private lateinit var viewModel: CompanionViewModel
    private var mockWebServer: MockWebServer? = null

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        context = ApplicationProvider.getApplicationContext()
        sessionManager = SessionManager(context)
        sessionManager.clearSession()
        sessionManager.clearNewRunDraft()
        sessionManager.setSelectedProjectId(null)

        repository = FakeCompanionRepository(initialPaired = true)
        viewModel = CompanionViewModel(repository, sessionManager, enablePolling = false)
        testDispatcher.scheduler.advanceUntilIdle()
    }

    @After
    fun tearDown() {
        mockWebServer?.shutdown()
        Dispatchers.resetMain()
    }

    @Test
    fun testConnectionStatusTransitions() {
        assertEquals(
            "Nik’s Mac Studio",
            (viewModel.uiState.value.connectionStatus as? ConnectionStatus.Connected)?.desktopName
        )

        // Transition to Reconnecting
        repository.setConnectionStatus(
            ConnectionStatus.Reconnecting("Nik’s Mac Studio", "http://192.168.1.100:52810")
        )
        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(viewModel.uiState.value.connectionStatus is ConnectionStatus.Reconnecting)

        // Transition to Offline
        repository.setConnectionStatus(
            ConnectionStatus.Offline("Nik’s Mac Studio", "http://192.168.1.100:52810")
        )
        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(viewModel.uiState.value.connectionStatus is ConnectionStatus.Offline)

        // Retry returns to Connected
        viewModel.retryConnection()
        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(viewModel.uiState.value.connectionStatus is ConnectionStatus.Connected)
    }

    @Test
    fun testRevokedTokenDropsToPairWithClearSentence() {
        // Simulate desktop revoking bearer token
        repository.simulateRevokeToken()
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value
        assertTrue(state.connectionStatus is ConnectionStatus.Unpaired)
        assertNull(state.activeSession)
        assertNotNull(state.errorMessage)
        assertTrue(
            state.errorMessage?.contains("The desktop revoked this phone's pairing") == true
        )
        assertNull(sessionManager.getSession())
    }

    @Test
    fun testHttpRepositoryRevokedTokenReturnsExplicitError() {
        mockWebServer = MockWebServer()
        mockWebServer!!.start()
        val baseUrl = mockWebServer!!.url("").toString().removeSuffix("/")

        val client = OkHttpClient.Builder()
            .connectTimeout(1, TimeUnit.SECONDS)
            .readTimeout(1, TimeUnit.SECONDS)
            .build()
        val httpRepo = HttpCompanionRepository(client = client)

        val session = PairedSession(
            token = "revoked_token_xyz",
            desktopId = "desk_01",
            desktopName = "Nik’s Mac",
            hostOrigin = baseUrl,
            pairedAt = "2026-08-19T00:00:00Z",
            protocolVersion = COMPANION_PROTOCOL_VERSION
        )
        httpRepo.injectFakeSession(session)

        // Server responds 401 Unauthorized (token revoked by desktop)
        mockWebServer!!.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":\"revoked\"}"))

        // Calling getProjects directly should receive 401, drop pairing, and set clear error
        val res = kotlinx.coroutines.runBlocking { httpRepo.getProjects() }

        assertTrue(res.isFailure)
        val failureMsg = res.exceptionOrNull()?.message.orEmpty()
        assertTrue(failureMsg.contains("The desktop revoked this phone's pairing"))
        assertTrue(httpRepo.connectionStatus.value is ConnectionStatus.Unpaired)
        assertNull(httpRepo.activeSession.value)
    }

    @Test
    fun testHttpRepositoryNetworkFailureTransitionsToReconnectingThenOffline() {
        val client = OkHttpClient.Builder()
            .connectTimeout(100, TimeUnit.MILLISECONDS)
            .readTimeout(100, TimeUnit.MILLISECONDS)
            .build()
        val httpRepo = HttpCompanionRepository(client = client)

        val session = PairedSession(
            token = "valid_token",
            desktopId = "desk_01",
            desktopName = "Nik’s Mac",
            hostOrigin = "http://127.0.0.1:59999", // Unreachable host
            pairedAt = "2026-08-19T00:00:00Z",
            protocolVersion = COMPANION_PROTOCOL_VERSION
        )
        httpRepo.injectFakeSession(session)

        // Attempt 1: Reconnecting
        kotlinx.coroutines.runBlocking { httpRepo.getProjects() }
        assertTrue(httpRepo.connectionStatus.value is ConnectionStatus.Reconnecting)

        // Attempt 2: Reconnecting
        kotlinx.coroutines.runBlocking { httpRepo.getProjects() }
        assertTrue(httpRepo.connectionStatus.value is ConnectionStatus.Reconnecting)

        // Attempt 3: Transitions to Offline after 3 consecutive failures
        kotlinx.coroutines.runBlocking { httpRepo.getProjects() }
        assertTrue(httpRepo.connectionStatus.value is ConnectionStatus.Offline)
    }
}
