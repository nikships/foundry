# Factory redesign — asset replacement report

The 2026-08 redesign moved the UI from the Prism theme (OLED black + spectral
neon, glass-and-rainbow 3D art) to the Factory design language (flat industrial
`#020202` surfaces, 1pt hairlines, uppercase Geist Mono chrome, one Factory
orange `#EE6018` accent). **All raster assets below are still the old Prism
renders** — they were left untouched on purpose. This report describes each
replacement to generate.

Global art direction for every replacement:

- Matte flat black background (`#020202`), no environment, no floor
  reflections, no fog.
- Subject built from thin WHITE hairline linework / wireframe (`#EEEEEE` at
  60–100%), exactly ONE Factory-orange element (`#EE6018`) as the accent.
- No rainbow / spectral refraction anywhere. No lens flare. No glow, bloom,
  or soft shadows — light comes from flat fills, not effects.
- Isometric or orthographic technical-drawing feel (engineering blueprint),
  generous negative space, subject centered.
- Consistent stroke weight across the whole set (reads as one family).
- Export PNG @2x of the display size, transparent or `#020202` background.

---

## Missing assets (referenced in code, no file exists — broken image today)

These are **net-new**, discovered during the redesign (`OutcomeBanner.tsx`):

### `scenes/run-accepted.png` — MISSING
Used in the run-detail outcome banner when a run is accepted. Currently renders
as a broken-image icon (visible in web preview; packaged app shows nothing).

> **Generate:** Orthographic technical illustration of the Factory pinwheel
> droid glyph drawn in white hairline strokes, with a single solid
> Factory-orange check/tick mark integrated as the final stroke. Flat matte
> `#020202` background, no glow, no glass. Square-ish, reads at 48px (banner
> shows it at 48px) and at 220px.

### `scenes/run-rejected.png` — MISSING
Same banner, rejected outcome.

> **Generate:** Same pinwheel-in-hairlines treatment, but the accent element
> is a single muted-amber (`#F5A623`) broken/interrupted stroke (a dashed
> segment or an open bracket), signalling "sent back". No red — red is
> reserved for failed. Same flat blueprint style, same sizes.

## Scenes (`assets/scenes/`, shown by EmptyState / onboarding / banners)

### `onboarding-hero.png` — replace
Current: giant glass prism splitting a white beam into a rainbow over a
mirror floor with lens-flare sun. Maximum Prism, zero Factory.
Used by: onboarding welcome step.

> **Generate:** Wide matte-black scene. A large Factory pinwheel droid glyph
> rendered as white hairline wireframe (engineering-drawing style, visible
> construction lines), with ONE incoming white hairline beam from the left
> edge refracting into a single Factory-orange beam that continues right.
> Optional faint hairline grid (`rgba(255,255,255,0.05)`) on the ground
> plane. No rainbow, no flare, no glass shading. ~1600×1200.

### `pipeline-designer.png` — replace
Current: orange/red translucent 3D pipeline with glow and reflections.
Used by: onboarding "factory" step.

> **Generate:** Isometric blueprint of an assembly line: 4–5 white hairline
> wireframe stations (cube, octahedron, cylinder) connected by hairline
> conveyor lines on matte black; the middle station's element is solid
> Factory orange. Top-down-45° isometric, uniform stroke, no glow.
> ~1600×1200.

### `empty-state.png` — replace
Current: glass pyramid prism with orange beam + glow + reflections (closest
of the old set, but still glass and bloom).
Used by: Inspector empty state, Pipelines empty state, onboarding doctor step.

> **Generate:** A small empty parts tray / open wireframe cube drawn in white
> hairlines, viewed isometrically, one faint dashed hairline outline inside
> showing where a part will go; tiny Factory-orange square marker at one
> corner. Flat, quiet, optimistic. Must stay legible at 220×220 (displayed at
> 220px, opacity 0.75).

### `run-success.png` — replace
Current: rainbow beams converging through a glass lens into a white flare.
Used by: onboarding roster step (and fallback success art).

> **Generate:** Three to five parallel white hairline beams entering a
> hairline-wireframe gate/frame and exiting as ONE clean Factory-orange
> beam, on matte black. Orthographic side view, drafting style, no lens, no
> flare, no rainbow. ~1600×900.

### `run-failed.png` — replace
Current: glass pyramid shattering into rainbow shards with a red beam.
Used by: outcome banner (failure), onboarding fallback.

> **Generate:** The same hairline beam diagram as run-success, but the
> orange beam stops abruptly at the gate with a small cluster of short
> hairline fracture ticks; a single muted-red (`#EF4444`) marker dot at the
> break point. Flat, no shattered glass, no particles. ~1600×900.

## Concepts (`assets/concepts/`, onboarding concept cards)

### `pipeline.png` — replace
Current: orange/red glowing 3D pipeline (same family as pipeline-designer).

> **Generate:** Compact isometric icon of a 3-station assembly line in white
> hairlines, middle node solid Factory orange, on matte black. Square 1024,
> legible at 220px. (Small sibling of the pipeline-designer scene.)

### `envelope.png` — refine
Current: white wireframe isometric cube with glowing orange core. Already
close to the target style; the glow around the core is the only off-brand
element.

> **Regenerate or touch up:** identical composition — white hairline
> isometric cube — but the inner element is a FLAT solid Factory-orange
> rounded-corner square (an "envelope card"), no bloom/halo. Keep stroke
> weight identical to the rest of the new set.

### `gate.png` — refine
Current: white hairline aperture/iris with orange hairline beams passing
through, on matte black. Already very close to the target language — the
only off-brand element is the soft glow around the beam.

> **Regenerate or touch up:** identical composition — hairline iris, hairline
> beams — but beams are crisp solid Factory-orange strokes with zero
> bloom/glow, and the stroke weight matches the rest of the new set. Keep
> square 1024.

## Agent portraits (`assets/agents/`, roster + phase chips, circular crop)

Current set (`planner`, `builder`, `scout`, `reviewer`, `documenter`,
`refiner`, `finisher`): dark 3D glass-prism busts with orange internal glow —
moody, ray-traced, glassy. They read "sci-fi hologram", not Factory.

> **Generate a 7-portrait set, one per agent:** flat matte-black squares,
> each showing an abstract head-and-shoulders avatar constructed from white
> hairline technical linework (like a patent drawing of a robot head),
> differentiated by silhouette/detail:
>
> - **planner** — head with hairline compass/dividers motif
> - **builder** — blocky head with a hairline I-beam across it
> - **scout** — narrow head with a hairline radar/telescope ring
> - **reviewer** — head with a hairline magnifier lens (lens NOT glowing)
> - **documenter** — head with hairline page-lines beside it
> - **refiner** — head with concentric hairline iteration arcs
> - **finisher** — head with a single Factory-orange flag/tick above it
>
> Each portrait gets exactly ONE small Factory-orange detail (listed above);
> everything else white hairline on `#020202`. No glow, no glass, no
> gradients, no rainbow. Square 1024, subject centered with margin — the UI
> crops these to a circle and zooms to 118%.

## App icon (`assets/icon/`)

### `app-icon-1024.png` + `app-icon.icns` — replace
Current: rainbow crystal prism on black — pure Prism brand.

> **Generate:** macOS app icon per Apple's grid: flat matte-black
> (`#020202`) rounded-rectangle field, the Factory pinwheel droid glyph in
> solid light gray (`#EEEEEE`) centered at ~55% of the icon height, with the
> pinwheel's center hub (or one blade tip) in Factory orange `#EE6018`.
> Absolutely flat — no glass, no inner glow, no drop shadow beyond the
> standard macOS icon shadow. Deliver 1024×1024 PNG, then regenerate
> `app-icon.icns` via `npm run icons`.

## Notes for regeneration

- Keep the exact file names; every reference in code resolves by path.
- The pinwheel path data is already in the codebase
  (`src/renderer/components/BrandIcon.tsx` → `FactoryDroid`) if a generator
  supports SVG trace/compose.
- After replacing, delete this report's checkboxes below (or track in a PR).

### Checklist

- [ ] scenes/run-accepted.png (NEW)
- [ ] scenes/run-rejected.png (NEW)
- [ ] scenes/onboarding-hero.png
- [ ] scenes/pipeline-designer.png
- [ ] scenes/empty-state.png
- [ ] scenes/run-success.png
- [ ] scenes/run-failed.png
- [ ] concepts/pipeline.png
- [ ] concepts/envelope.png
- [ ] concepts/gate.png
- [ ] agents/planner.png
- [ ] agents/builder.png
- [ ] agents/scout.png
- [ ] agents/reviewer.png
- [ ] agents/documenter.png
- [ ] agents/refiner.png
- [ ] agents/finisher.png
- [ ] icon/app-icon-1024.png + icon/app-icon.icns
