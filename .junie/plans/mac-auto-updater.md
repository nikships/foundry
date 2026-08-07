---
sessionId: session-260807-000431-vsu5
---

# Requirements

### Overview & Goals
Implement in-app automatic updates for Foundry on macOS using `electron-updater` and GitHub Releases. The app will automatically check for available releases in packaged builds, notify the user, show download progress, and allow restarting to install the update seamlessly.

### Scope

#### In Scope
- Adding `electron-updater` dependency to `apps/desktop`.
- Configuring `electron-builder.yml` with GitHub publish settings and macOS `zip` target alongside `dmg`.
- Updating `.github/workflows/mac-package.yml` to generate, notarize, staple, and publish `latest-mac.yml` and `.zip` update artifacts to GitHub Releases.
- Creating a main process `UpdaterService` (`src/main/updater.ts`) with `app.isPackaged` guards and lifecycle event handlers.
- Extending IPC contracts (`src/shared/ipc-contract.ts`, `src/preload/bridge.ts`, `src/main/ipc.ts`) with updater calls and status broadcast events.
- Adding "Check for Updates..." menu item to the macOS App menu.
- Building update status and trigger controls into `SettingsScreen.tsx`.
- Adding unit tests for updater state management and IPC contract compliance.

#### Out of Scope
- Windows or Linux auto-update backends.
- Custom update server microservices (Hazel / Nuts).
- Silent background restart/install without user confirmation.

### User Stories
- **As a Foundry user on macOS**, I want the app to notify me when a new update is available so I can stay up to date with new features and bug fixes.
- **As a Foundry user**, I want to trigger an update check manually from the App menu or Settings page.
- **As a Foundry user**, I want to see download progress and click "Restart to Update" when ready so the update installs smoothly without manual DMG mounting.

### Functional Requirements
- **Packaged Execution Guard**: Updater checks only execute in packaged builds (`app.isPackaged === true`). Development builds ignore update checks cleanly.
- **Status Lifecycle**: Track update stages (`idle`, `checking`, `available`, `downloading`, `ready`, `error`) with version metadata and download percentage.
- **IPC Event Streaming**: Main process broadcasts update status changes to renderer via `event:updater-status`.
- **User Installation Control**: Provide a clear "Restart to Update" action that calls `autoUpdater.quitAndInstall()`.
- **CI Release Assets**: GitHub Release workflow uploads `latest-mac.yml`, the notarized `.zip` bundle, and `.dmg`.

# Technical Design

### Current Implementation
- `apps/desktop` uses `electron-builder` to package `Foundry.app` into `Foundry-*-arm64.dmg`.
- `.github/workflows/mac-package.yml` signs with Developer ID `NW6B3R27LQ`, notarizes with Apple `notarytool`, staples, and uploads DMG files to GitHub Releases.
- Main process (`src/main/main.ts`) handles app lifecycle and registers IPC handlers in `src/main/ipc.ts`.
- Preload bridge (`src/preload/bridge.ts`) exposes named invoke methods from `src/shared/ipc-contract.ts`.

### Key Decisions
- **`electron-updater` with GitHub Releases**: Industry standard for `electron-builder` apps on macOS. No separate update server infrastructure required.
- **macOS ZIP Target**: macOS auto-updaters require `.zip` bundles containing `Foundry.app`. `electron-builder.yml` will be configured to output both `dmg` and `zip`.
- **Notarization & Stapling Pipeline**: The CI workflow notarizes the app archive, staples `Foundry.app`, packages the stapled app into the release `.zip`, updates `latest-mac.yml` checksums, and uploads both `.zip` and `latest-mac.yml` to the GitHub release.
- **Isolated Service Architecture**: Main process encapsulates `autoUpdater` in `UpdaterService` (`src/main/updater.ts`), avoiding direct `electron-updater` imports in UI or general IPC files.

### Proposed Changes

#### Configuration & Build
- `apps/desktop/package.json`:
  - Add `"electron-updater": "^6.3.9"` under `dependencies`.
- `apps/desktop/electron-builder.yml`:
  - Add `publish: { provider: 'github', owner: 'nikships', repo: 'software-factory' }`.
  - Add `zip` under `mac.target`.

#### CI Pipeline
- `.github/workflows/mac-package.yml`:
  - Ensure stapled `Foundry.app` is archived into `Foundry-${TAG}-arm64-mac.zip`.
  - Include `latest-mac.yml` and `.zip` assets in versioned and rolling release upload steps.

#### Main Process & IPC Bridge
- `apps/desktop/src/shared/types.ts`:
  - Define `UpdateStage` (`'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'`) and `UpdateStatus` interface.
- `apps/desktop/src/shared/ipc-contract.ts`:
  - Add IPC channels: `updaterCheck`, `updaterDownload`, `updaterQuitAndInstall`, `updaterGetStatus`, `eventUpdaterStatus`.
  - Add `updater` surface to `FoundryApi` interface.
- `apps/desktop/src/main/updater.ts` (new):
  - Encapsulate `autoUpdater` configuration (`autoDownload = true`, `autoInstallOnAppQuit = true`).
  - Wire listeners for `checking-for-update`, `update-available`, `update-not-available`, `download-progress`, `update-downloaded`, and `error`.
  - Broadcast status updates via `AppContext.broadcast()`.
- `apps/desktop/src/main/ipc.ts`:
  - Register handlers for updater channels.
- `apps/desktop/src/main/main.ts`:
  - Initialize `UpdaterService` when app is ready.
  - Add "Check for Updates..." to App menu template.
- `apps/desktop/src/preload/bridge.ts`:
  - Expose `updater` methods and push event subscription.

#### Renderer UI
- `apps/desktop/src/renderer/screens/SettingsScreen.tsx`:
  - Add Software Updates card showing current version (`window.foundry.app.version()`), update status badge, "Check for Updates" button, download progress indicator, and "Restart to Update" button.

### File Structure
- **Modified**:
  - `apps/desktop/package.json`
  - `apps/desktop/electron-builder.yml`
  - `.github/workflows/mac-package.yml`
  - `apps/desktop/src/shared/types.ts`
  - `apps/desktop/src/shared/ipc-contract.ts`
  - `apps/desktop/src/preload/bridge.ts`
  - `apps/desktop/src/main/ipc.ts`
  - `apps/desktop/src/main/main.ts`
  - `apps/desktop/src/renderer/screens/SettingsScreen.tsx`
- **Added**:
  - `apps/desktop/src/main/updater.ts`
  - `apps/desktop/tests/updater.test.ts`

# Testing

### Validation Approach
Verification relies on automated unit tests, TypeScript typechecking, and electron-vite build validation.

### Key Scenarios
- **Packaged Mode Guard**: Verify `UpdaterService` short-circuits gracefully when `app.isPackaged` is false.
- **State Machine Transitions**: Verify update status progression (`idle` -> `checking` -> `available` -> `downloading` -> `ready` / `error`).
- **IPC Payload Cloneability**: Verify `UpdateStatus` objects pass `plain()` structured-clone checks without throwing or dropping fields.
- **Settings UI Binding**: Verify Settings screen correctly subscribes to `event:updater-status` and renders version and action buttons according to stage.

### Edge Cases
- **Network Error / Offline**: Handle `autoUpdater` error events gracefully without crashing main process, surfacing user-friendly message in UI.
- **No Update Available**: Return to `idle` or `not-available` stage without leaving UI stuck in `checking` state.
- **Dev Mode Calls**: IPC invokes in dev mode return clear status indicating updates are disabled in unpackaged builds.

# Delivery Steps

### ✓ Step 1: Configure build targets and release workflow for macOS auto-updates
Configure `apps/desktop` build settings and GitHub Actions release workflow for macOS zip and update metadata packaging.

- Add `electron-updater` dependency to `apps/desktop/package.json`.
- Update `apps/desktop/electron-builder.yml` to specify `publish` settings (`provider: github`, `owner: nikships`, `repo: software-factory`) and add `zip` alongside `dmg` under `mac.target`.
- Update `.github/workflows/mac-package.yml` to package the notarized and stapled `Foundry.app` into `.zip`, update `latest-mac.yml`, and upload `latest-mac.yml` and the update `.zip` alongside `.dmg` in GitHub Release publishing steps.

### ✓ Step 2: Implement main process UpdaterService, IPC contract, and App menu entry
Implement main process `UpdaterService`, IPC contract extensions, and App menu triggers.

- Add `UpdateStatus` types in `src/shared/types.ts` and updater IPC channels / `FoundryApi` interface in `src/shared/ipc-contract.ts`.
- Create `src/main/updater.ts` encapsulating `autoUpdater` event handling, state tracking, status broadcasting, and `app.isPackaged` guard.
- Register updater IPC handlers in `src/main/ipc.ts` and initialize `UpdaterService` in `src/main/main.ts`.
- Expose `updater` API surface and status push listener in `src/preload/bridge.ts`.
- Add "Check for Updates..." item to the App menu in `src/main/main.ts`.

### ✓ Step 3: Add Settings screen update UI and unit tests
Add update management section to Settings UI and unit tests for updater logic.

- Update `SettingsScreen.tsx` to display current app version, update status badge, "Check for Updates" trigger, download progress bar, and "Restart to Update" button.
- Create `tests/updater.test.ts` to unit test updater state transitions, IPC payload cloneability, and packaged-mode safety.
- Verify `npm run typecheck`, `npm test`, and `npm run build` pass cleanly in `apps/desktop`.