# Foundry companion (Android)

Kotlin + Jetpack Compose operator for a paired Foundry desktop. Lives in this repo under `apps/android/` so product tickets (FOU-85–FOU-91) land in a real shell. The JS gate (`npm run check`, knip, tsc, eslint, prettier) ignores this tree.

Decision (FOU-84): **in-repo**, not a sibling repository. The phone speaks the FOU-83 JSON contract in `apps/desktop/src/shared/companion.ts`.

## Screens

Navigation matches `specs/companion-android-ui.md`:

1. Pair
2. Home / Runs
3. New run
4. Run (operator)
5. Inspector
6. Smith
7. Connection sheet

There is no Settings graph.

## Requirements

- JDK 21 (matches `jvmTarget = "21"`)
- Android SDK with **compile / target SDK 35**, min SDK 26
- Android Studio Ladybug+ or command-line `sdkmanager`

Optional: set `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) so the Gradle wrapper can find the SDK. A local `android/local.properties` with `sdk.dir=...` is gitignored.

## Point at a desktop host

Builds default to `HttpCompanionRepository` (`FoundryApplication.USE_FAKE_REPOSITORY = false`) to talk to a real Foundry desktop (FOU-83 host).

To talk to a real Foundry desktop:

1. Pair on the Mac (Settings → Companion or Settings → Phone) and scan the QR, or
2. Inject a session via `adb` (see below) or provide the LAN origin + bearer token from pairing.

For offline demos or unit tests without a Mac, set `FoundryApplication.USE_FAKE_REPOSITORY = true` to use `FakeCompanionRepository`.

The HTTP client talks to the FOU-83 routes (`/pair`, `/v1/session`, `/v1/projects`, `/v1/runs`, etc.). Do not invent a second engine.

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

## Release APK

`.github/workflows/android-package.yml` runs after changes under `apps/android/` land on `main`. It tests the app, builds a versioned and signed release APK, and replaces `Foundry-Android.apk` on the repository's Latest GitHub release. The Mac packaging workflow carries those stable Android assets forward whenever it promotes a newer release, so the Latest page remains the download location for both platforms.

The workflow requires one long-lived Android signing key so users can install future APKs as upgrades:

- `ANDROID_KEYSTORE_BASE64` — base64-encoded JKS or PKCS12 keystore
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Keep a backup of the keystore and passwords outside GitHub. Losing this key means existing installations cannot upgrade to newly signed APKs.
