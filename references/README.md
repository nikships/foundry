# Pinned Pi vendor docs — `@earendil-works/pi-coding-agent@0.84.4`

These files are copies of the official docs from the exact-pinned package in
`node_modules/@earendil-works/pi-coding-agent`. They are the repository
contract for anyone changing `src/main/pi/**` or anything that names
`@earendil-works/pi-*`.

Do not fetch live https://pi.dev or GitHub docs. They may be ahead of the pin.

**When you bump the package pin, recopy these docs from the new package.**

## Read before changing Pi integration

1. `src/main/pi/AGENTS.md` — Foundry's invariants (this directory, not upstream).
2. `sdk.md` — `createAgentSession`, `ModelRuntime`, `SessionManager`,
   `SettingsManager`, tools, events.
3. `extensions.md` — `tool_call` policy, `registerTool`, `bindExtensions`.
4. Then only the file that matches the change:

| File | When |
| --- | --- |
| `session-format.md`, `sessions.md` | session files, `branch`, rewind, entries |
| `compaction.md` | in-place `session.compact()` |
| `models.md`, `custom-provider.md`, `providers.md` | catalog, `models.json`, auth, Bridge custom models |
| `settings.md` | `SettingsManager.inMemory` overrides |
| `packages.md` | operator-installed packages, `PackageManager`, resolution scopes |
| `environment-variables.md` | `PI_OFFLINE` |
| `security.md` | `project_trust` |
| `sdk-examples.md` | worked `createAgentSession` examples |

## What Foundry actually uses

Foundry embeds pi **in-process** via `createAgentSession` (see
`src/main/pi/pi-transport.ts` and `pi-oneshot.ts`). It does **not** use RPC
mode, the CLI binary, the TUI, or skills / prompt / theme discovery.

Discovery is explicitly off (`noExtensions`, `noSkills`, `noPromptTemplates`,
`noThemes`). Paths pin to under Foundry's Application Support; `~/.pi` must
not be touched.

Packages are used, but only the ones Foundry ships: `BUNDLED_PACKAGES` in
`src/main/pi/packages.ts` is the entire list, vendored under
`resources/pi-packages/`. There is no `pi install`, no settings entry, and no
runtime install path. `PackageManager` is used solely to resolve those local
directories. Their paths reach a session through `additionalExtensionPaths` /
`additionalSkillPaths`, which pi honours while every `no*` discovery flag
stays on. Project scope (`.pi/`) is never enabled.

Transitive packages (`pi-agent-core`, `pi-ai`, `pi-client`, `pi-protocol`,
`pi-tui`) are **not** Foundry dependencies. Do not import them. Derive types
from `pi-coding-agent`'s own surface.

## Deliberately omitted

Upstream also has `rpc.md`, `json.md`, `tui.md`, `usage.md`, `quickstart.md`,
`skills.md`, `prompt-templates.md`, `themes.md`, `keybindings.md`, and
platform setup guides. Those are for the interactive CLI and for non-Node
hosts. Copying them here would point agents at the wrong integration.

## Source directory

`node_modules/@earendil-works/pi-coding-agent/docs/` and
`examples/sdk/README.md` (saved here as `sdk-examples.md`).
