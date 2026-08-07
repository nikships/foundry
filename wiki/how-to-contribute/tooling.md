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
| `npm run lint` | ESLint, zero warnings allowed |
| `npm run format` / `format:check` | Prettier write / check |
| `npm run knip` | Dead code and unused dependency scan |
| `npm run audit:deps` | `npm audit` at high severity |
| `npm test` | vitest |
| `npm run check` | typecheck + lint + format + knip + test + build + audit |
| `npm run engine:demo` | `tsx scripts/engine-demo.ts` |
| `npm run icons` | `scripts/make-icns.sh` |
| `npm run package` | build + icons + electron-builder mac arm64 |

## Quality tooling

| Tool | Config | Role |
|---|---|---|
| TypeScript | `tsconfig.json` | Types; `noUnusedLocals` / `noUnusedParameters` |
| ESLint 9 (flat) | `eslint.config.js` | JS/TS/React correctness; Prettier disables style fights |
| Prettier | `.prettierrc.json` | Deterministic formatting for agents |
| Knip | `knip.json` | Unused files and dependencies (exports off by design) |

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

GitHub Actions under `.github/workflows/`:

| Workflow | Gates |
|---|---|
| `ci.yml` | typecheck, lint, format, knip, test, build, audit, actionlint |
| `dependency-review.yml` | vulnerable / denied-license dependency diffs on PRs |
| `codeql.yml` | CodeQL security-and-quality on `apps/desktop` |
| `mac-package.yml` | signed/notarized DMG (not on pull requests) |

Local parity: `npm run check`. Packaging remains `npm run package` or the Mac package workflow.
