# Packaged Nerd Fonts (bounded)

Foundry does **not** ship the full Nerd Fonts collection. The signed app
carries one SymbolsOnly face plus the licenses required to redistribute it.

- Face: `Symbols Nerd Font Mono` (`SymbolsNerdFontMono-Regular.woff2`)
- Source of the binary: `apps/desktop/src/renderer/design/fonts/`
- electron-builder copies that folder’s Nerd artifacts (woff2, `LICENSE`,
  `OFL.txt`, `APACHE`, and the full README) to `Contents/Resources/fonts/` so
  they are readable outside the asar.
- This README is a developer pointer only. It is **not** in the
  `resources/fonts` extraResources filter — a later `to: fonts` overwrite
  would replace the full CC BY 4.0 attribution table and SHA pins from
  `apps/desktop/src/renderer/design/fonts/README.md`.
- Provenance, SHA-256 pins, and glyph-set attribution:
  `apps/desktop/src/renderer/design/fonts/README.md`
- Refresh / verify: `scripts/fetch-nerd-fonts.sh --check`

`LICENSE` in this folder is the Nerd Fonts MIT wrapper. `OFL.txt` covers Geist
and the OFL-licensed glyph sets (Weather Icons, Pomicons). `APACHE` is the
Apache-2.0 text for the Material Design Icons glyph set. Do not drop
additional patched families (Hack, JetBrains Mono, Fira Code, …) in this
directory — that is the bloat this bound exists to prevent.
