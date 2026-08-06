# Tooling

Build and package stack for Foundry.

## electron-vite

`electron.vite.config.ts` builds three targets:

| Target | Entry | Notes |
|---|---|---|
| main | `src/main/main.ts` | ESM, deps externalized |
| preload | `src/preload/bridge.ts` | **CJS** output `bridge.cjs` (sandboxed preloads cannot be ESM) |
| renderer | `src/renderer/index.html` | React plugin, Vite |

Path aliases: `@shared`, `@main`, `@renderer`.

`package.json` `main` field is `out/main/main.js` (named after the entry file, not `index.js`).

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Dev server + Electron |
| `npm run build` | Production bundles to `out/` |
| `npm start` | Preview built app |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | vitest |
| `npm run engine:demo` | `tsx scripts/engine-demo.ts` |
| `npm run icons` | `scripts/make-icns.sh` |
| `npm run package` | build + icons + electron-builder mac arm64 |

## electron-builder

`electron-builder.yml`:

- `appId: com.foundry.app`, product name Foundry
- macOS minimum system version **26.0**, arm64 DMG
- `asar: true` with `better-sqlite3` unpacked (native binding)
- Assets via `extraResources` so `process.resourcesPath/assets` resolves at runtime

## npm allow-scripts

`.npmrc`:

```
allow-scripts = electron,esbuild,better-sqlite3
```

Only those packages run install scripts. If Electron's binary is missing, re-run its install script manually.

## TypeScript

Single `tsconfig.json` for the app; renderer is plain TSX so `tsc` covers it. No separate frontend typecheck step.

## CI

No project-local GitHub Actions workflow is required for the core loop; verification is the three local commands (typecheck, test, build). Packaging is manual via `npm run package`.
