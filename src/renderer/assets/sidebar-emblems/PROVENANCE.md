# Collapsed-rail emblems

Hand-authored SVG linework, not a raster export. The runtime source is
`src/renderer/components/SidebarEmblems.tsx`. Each mark paints with
`currentColor` and `fill="none"` so the 56px rail can tint it through the
existing `--text-dim` / `--text` / `--amber` tokens.

GitHub #78 asked for AI-generated transparent images. FOU-7 prefers clean
SVGs with `currentColor`; raster 1x/2x variants are only required if a mark
cannot be drawn as linework. These eleven slots are all linework, so no PNG
matte is checked in.

| Slot | Emblem | Replaces (lucide) |
| --- | --- | --- |
| Runs | Workcell ring + start chevron | `Play` |
| Pipelines | Three stations on a routed rail | `Workflow` |
| Roster | Crew of three operators | `Users` |
| Inspector | Aperture with reticle ticks | `Eye` |
| Pull Requests | Two heads merging onto one rail | `GitPullRequest` |
| Smith | Anvil and a single forge spark | `TerminalSquare` |
| Project picker | Tabbed work bin | `Folder` |
| Settings | Hex nut | `Settings` |
| Pending / needs you | Shop-floor call bell | `Bell` |
| Expand | Rail spine + opening chevron | `PanelLeftOpen` |
| Collapse | Rail spine + closing chevron | `PanelLeftClose` |

Constraints held by the component and `tests/sidebar-emblems.test.ts`:

- No baked background, drop shadow, or filter.
- No hardcoded fill other than `none` (stroke carries the color).
- Default optical size 18px in a 24×24 viewBox, centered in the 36×36 hit target.
- `aria-hidden` on the glyph; accessible names stay on the buttons in `Sidebar.tsx`.
