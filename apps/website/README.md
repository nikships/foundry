# Foundry — marketing site

The public product site. A standalone Vite + React 19 + TypeScript app that
builds to static files. It is **not** part of the desktop app, its build, or
its test suite.

```bash
cd apps/website
npm install
npm run dev        # http://localhost:5173
npm run build      # → apps/website/dist
npm run preview
```

Deployed to Firebase Hosting (`firebase deploy --only hosting`, project
`foundry-site-2026` — see `.firebaserc`). `firebase.json` serves `dist` and
rewrites everything to `index.html`.

## It is deliberately invisible to the repo's tooling

Nothing here runs in CI and nothing here can fail `npm run check`. That is
enforced in six places, all of them pointing at `apps/website/`:

| Where | What it does |
| --- | --- |
| `tsconfig.json` (root) | `include` is `apps/desktop/src`, `scripts`, `apps/desktop/tests` only — root `tsc` never sees this folder |
| `eslint.config.js` | `apps/website/**` in `ignores` |
| `.prettierignore` | `apps/website` — so `prettier --check .` skips it |
| `knip.json` | `apps/website/**` in `ignore` |
| `.github/workflows/ci.yml` | the push-to-`main` `paths` allowlist does not include `apps/website/**`, so the `verify` job does not run for site-only pushes |
| `.github/codeql/codeql-config.yml` | `apps/website` in `paths-ignore` — the required check still reports, it just does not scan this folder |

Two more consequences worth knowing:

- **No root dependency changes.** This app has its own `package.json` and its
  own lockfile. The root manifest is untouched, so `dependency-review` and
  `npm run audit:deps` see nothing new.
- **Not bundled into the app.** `electron-builder.yml` ships `out/**` and
  `package.json`, with `assets/**` as extra resources. This folder is in
  neither glob — which is also why the site's own screenshot sources live in
  `media-src/` here rather than in the repo's `assets/`: everything under
  `assets/` is copied into the signed DMG.

`.gitattributes` marks the folder `linguist-vendored` so it stays out of the
repo's language statistics and collapses by default in diffs.

## Layout

```
index.html               Vite entry + OG/Twitter meta
tailwind.config.js       colour/type scales → the app's CSS custom properties
src/index.css            Foundry's real tokens, copied from the app's design/
src/data/foundry.ts      real agents, pipelines, checks, reports, the replayed run
src/data/site.ts         page copy
src/components/ui/       Eyebrow, Button, Badge, Section, Reveal, WindowFrame, ArtPanel
src/components/demos/    the five interactive demos
src/components/sections/ nav, hero, roster, galleries, footer
public/media/            optimised art + the campaign film — built, committed
media-src/               site-only screenshot and film sources (kept out of the DMG)
public/fonts/            the same vendored Geist faces the app ships
tools/build-media.sh     regenerates public/media
```

## The demos are the point

Five things on the page are real, interactive components rather than
screenshots:

- **`RunWaterfallDemo`** — the Inspector. Phase lanes fill on a shared
  timeline, each bar segmented per tool call and coloured by call kind; the
  transcript streams alongside and follows the running phase until you click a
  lane to pin it. The phase header carries the model that answered, the tokens
  spent, and how much of that model's context the phase occupied.
- **`PipelineCanvasDemo`** — the freeform canvas. Drag cards, pan the grid, add
  phases; the bezier wires re-route live, including the dashed feedback edge.
- **`ModelCastingDemo`** — one run across five providers, seat by seat. The
  `build` seat exhausts its retries on purpose so the failover path is visible:
  the turn continues on the next reachable model rather than failing the run.
- **`CheckEvidenceDemo`** — checks running against a `review` report. Every
  second pass the agent lists a blocker and still claims success, so
  `verdict_consistent` and `disapproval_halts` halt the phase.
- **`SmithChatDemo`** — the native operator chat, blocking on one inline
  approval card until you approve or reject it. Approving mints a receipt.

## Keeping it honest

`src/data/foundry.ts` mirrors real source:

| Site | Source of truth |
| --- | --- |
| `AGENTS` | `apps/desktop/src/shared/builtin-agents.ts` |
| `PIPELINES` | `apps/desktop/src/shared/builtin-pipelines.ts` |
| `CHECK_DESCRIPTIONS` | `apps/desktop/src/main/engine/gates.ts` (`GATE_DESCRIPTIONS`) |
| `REPORT_BLURBS` | `apps/desktop/src/shared/types.ts` (`BUILTIN_ENVELOPE_BLURBS`) |
| `ACCEPTANCE_KINDS` | `apps/desktop/src/shared/types.ts` (`Acceptance`) |
| `SUBSCRIPTIONS` | `apps/desktop/src/main/bridge/providers.ts` |
| `SMITH_TOOLS` | `apps/desktop/src/main/smith/AGENTS.md` |
| `COMPANION_POINTS` | `apps/desktop/src/main/companion/host.ts` |
| `READINESS_POINTS` | `apps/desktop/src/main/readiness/AGENTS.md` |
| design tokens | `apps/desktop/src/renderer/design/tokens-base.css`, `tokens-factory.css` |

Nothing enforces that mirror — this folder is outside the gate on purpose. If
you rename an agent or add a pipeline, update `src/data/foundry.ts` by hand.

**Vocabulary.** The engine's internal names are `gate` and `envelope`; the
app's UI says **check** and **report**. The site follows the UI in its copy and
keeps the engine names on identifiers that a reader might want to grep, so
`CHECK_DESCRIPTIONS` maps to `GATE_DESCRIPTIONS` on purpose.

## Media

`public/media` is committed already built. Regenerate it when the source art or
a screenshot changes:

```bash
npm run media      # needs ffmpeg (libx264) and cwebp
```

WebP comes from `cwebp` rather than ffmpeg, because Homebrew's ffmpeg is not
always built with `libwebp`; ffmpeg still owns H.264 and frame extraction.

Sources, all outside this folder:

| Source | Becomes |
| --- | --- |
| `../../assets/concept-art/*.png` | `media/art/*.webp` |
| `../../assets/concept-art/*-loop.mp4` | `media/loop/*.mp4` + poster |
| `../../assets/agents/*.png` | `media/agents/*.webp` (portraits) |
| `media-src/ui/*.png` | `media/ui/*.webp` (desktop screens) |
| `media-src/phone/*.png` | `media/phone/*.webp` |
| `media-src/film/*.mp4` | `media/film/*.mp4` + poster (keeps its audio) |

`media-src/film/` is **gitignored**: those masters are 1080p originals in the
tens of MB, past the repo's 10 MiB per-file ceiling (`npm run check:files`).
Only the encoded 720p result under `public/media/film/` is committed. Drop the
master back in and run `npm run media` to re-encode.

`media-src/ui/*.png` are retina captures (2880×1880) of the running app, taken
through the repo's `foundry-ui` skill against an isolated `--user-data-dir`
seeded from real state. Recapture them when a screen changes rather than
hand-editing the WebP, and **check the frame for anything account-specific
before committing** — the providers pane shows the signed-in account, so that
capture was taken with the address replaced in the DOM first.

`media-src/phone/*.png` are the Android captures from `../../screenshots`
cropped to 1080×1000; the raw 1080×2400 frames leave several screens as mostly
empty background inside a phone bezel.

`pr_writer` and `issue_writer` ship no portrait; the roster falls back to a
tinted monogram for those two, which is deliberate rather than a missing file.

## Design provenance

Layout and section structure were originally generated with **Magic Patterns**
against this repository (design `ihtfy7myi65njlwx6wgjug`, using the `Factory`
design system), then adapted: `framer-motion` was dropped for local hooks, and
invented data was replaced with the real records above.

`tailwind.config.js` is the Factory design system's scale verbatim — every
utility resolves to a CSS custom property, so the site cannot drift from the
app's palette without the app changing first.
