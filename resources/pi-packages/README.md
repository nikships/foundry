# Shipped pi packages

Each subdirectory here is a pi package this build ships, in pi's own layout
(`extensions/*.js`, `skills/<name>/SKILL.md`, or a `pi` manifest in
`package.json`). They are copied into the app bundle by `electron-builder.yml`
as `extraResources`, not bundled into `app.asar`, because pi loads an extension
through jiti and that reads the file from disk.

Adding one is a source change, not a user action:

1. Vendor the package directory here as `resources/pi-packages/<name>/`.
2. Add a matching entry to `BUNDLED_PACKAGES` in
   `apps/desktop/src/main/pi/packages.ts`.

A package's extensions are withheld from read-only agents unless its entry sets
`extensionsForReadOnly`. A reviewer phase is expected to have written nothing,
and the engine verifies that by diffing git after the call, so a write-capable
tool reaching one of those phases breaks the check.
