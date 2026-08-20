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
- **Not bundled into the app.** `electron-builder.yml` ships `out/**`,
  `package.json` and `skills/**`, with `assets/**` as extra resources. This
  folder is in none of those globs.

`.gitattributes` marks the folder `linguist-vendored` so it stays out of the
repo's language statistics and collapses by default in diffs.

## Layout

```
index.html               Vite entry
tailwind.config.js       colour/type scales → the app's CSS custom properties
src/index.css            Foundry's real tokens, copied from src/renderer/design/
src/data/foundry.ts      real agents, pipelines, gates, and the replayed run
src/data/site.ts         page copy
src/components/ui/       Eyebrow, Button, Badge, Section, Reveal, WindowFrame, ArtPanel
src/components/demos/    the four interactive demos
src/components/sections/ nav, hero, roster, galleries, footer
public/media/            optimised art (5 MB) — built from ../assets
public/fonts/            the same vendored Geist faces the app ships
tools/build-media.sh     regenerates public/media from ../assets
```

## The demos are the point

Four things on the page are real, interactive components rather than
screenshots:

- **`RunWaterfallDemo`** — the Inspector. Phase lanes fill on a shared
  timeline, each bar segmented per tool call and coloured by call kind; the
  transcript streams alongside and follows the running phase until you click a
  lane to pin it.
- **`PipelineCanvasDemo`** — the freeform canvas. Drag cards, pan the grid, add
  phases; the bezier wires re-route live, including the dashed feedback edge.
- **`GateEvidenceDemo`** — gates running against the envelope's claim. Every
  second pass fails `diff_matches_claims` on purpose.
- **`SmithApprovalDemo`** — a Smith session that blocks on a proposal until you
  approve or reject it.

## Keeping it honest

`src/data/foundry.ts` mirrors real source:

| Site | Source of truth |
| --- | --- |
| `AGENTS` | `apps/desktop/src/main/store/builtin-agents.ts` |
| `PIPELINES` | `apps/desktop/src/main/store/builtin-pipelines.ts` |
| `GATE_DESCRIPTIONS` | `apps/desktop/src/main/engine/gates.ts` |
| `ENVELOPE_BLURBS` | `apps/desktop/src/main/store/envelopes.ts` |
| design tokens | `apps/desktop/src/renderer/design/tokens-base.css`, `tokens-factory.css` |

Nothing enforces that mirror — this folder is outside the gate on purpose. If
you rename an agent or add a pipeline, update `src/data/foundry.ts` by hand.

## Design provenance

Layout, section copy and the Smith approval demo were generated with **Magic
Patterns** against this repository (design `ihtfy7myi65njlwx6wgjug`, using the
`Factory` design system), then adapted: `framer-motion` was dropped for local
hooks, invented data was replaced with the real records above, and the media
was repointed at the local asset build.

`tailwind.config.js` is the Factory design system's scale verbatim — every
utility resolves to a CSS custom property, so the site cannot drift from the
app's palette without the app changing first.

## Media

`public/media` is committed already built. Regenerate it only when the source
art in `../assets` changes:

```bash
npm run media      # needs ffmpeg with libwebp + libx264
```

That turns the 2560×1440 PNGs into 1600px WebP, the 1920×1080 loops into muted
720p H.264 with poster frames, and the agent portraits into 320px WebP —
about 90 MB of source down to 5 MB.
