# Collapsed-rail emblems

Hand-authored SVG linework, not a raster export. The runtime source is
`src/renderer/components/SidebarEmblems.tsx`. Each mark paints with
`currentColor` and `fill="none"` so the 56px rail can tint it through the
existing `--text-dim` / `--text` / `--amber` tokens.

GitHub #78 asked for AI-generated transparent images. FOU-7 prefers clean
SVGs with `currentColor`; raster 1x/2x variants are only required if a mark
cannot be drawn as linework. These thirteen slots are all linework, so no PNG
matte is checked in.

Four marks sit on the rail (Runs, Inspector, Design, Pull Requests) and three
label Design's tab strip (Pipelines, Agents, Envelopes). Pipelines and Agents
kept the linework they had when they were rail entries; only where they render
changed. "Agents" is the user-facing name for the roster crew mark.

| Slot | Emblem | Replaces (lucide) |
| --- | --- | --- |
| Runs | Workcell ring + start chevron | `Play` |
| Design | Drafting square over its rail | — |
| Pipelines | Three stations on a routed rail | `Workflow` |
| Agents | Crew of three operators | `Users` |
| Envelopes | Sealed handoff with its typed slot | — |
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
