# Foundry companion (Android)

Kotlin + Jetpack Compose operator for a paired Foundry desktop. Lives in this repo under `android/` so product tickets (FOU-85–FOU-91) land in a real shell. The JS gate (`npm run check`, knip, tsc, eslint, prettier) ignores this tree.

Decision (FOU-84): **in-repo**, not a sibling repository. The phone speaks the FOU-83 JSON contract in `src/shared/companion.ts`.

## Screens

Navigation matches `specs/companion-android-ui.md`:

1. Pair
2. Home / Runs
3. New run
4. Run (operator)
5. Inspector
6. Connection sheet

There is no Settings graph.

## Requirements

- JDK 21 (matches `jvmTarget = "21"`)
- Android SDK with **compile / target SDK 35**, min SDK 26
- Android Studio Ladybug+ or command-line `sdkmanager`

Optional: set `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) so the Gradle wrapper can find the SDK. A local `android/local.properties` with `sdk.dir=...` is gitignored.

## Point at a desktop host

Debug builds default to `FakeCompanionRepository` (`FoundryApplication.USE_FAKE_REPOSITORY = true`) so the six surfaces work without a Mac.

To talk to a real Foundry desktop (FOU-83 host):

1. Pair on the Mac (Settings → Phone) and scan the QR, or
2. Set `FoundryApplication.USE_FAKE_REPOSITORY = false` and call `HttpCompanionRepository` with the LAN origin + bearer token from pairing.

The HTTP client is stubbed against the FOU-83 routes (`/pair`, `/session`, `/runs`, `/events`, start/kill/interrupt/PR). Do not invent a second engine.

## Fake paired session (acceptance)

Unpaired debug launch opens **Pair**.

To inject a fake paired session and land on **Runs**:

```bash
adb shell am start \
  -n com.foundry.companion.debug/com.foundry.companion.MainActivity \
  --ez inject_fake_session true
```

## Build

From this directory:

```bash
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest
```

Install on a device or emulator:

```bash
./gradlew :app:installDebug
```

The debug application id is `com.foundry.companion.debug`.
