# Vendored fonts

This folder is the only place Foundry ships typefaces. Two families live here:

- **Geist / Geist Mono** (SIL OFL 1.1) — the shipped interface and monospace
  faces. See `OFL.txt`.
- **Symbols Nerd Font Mono** (Nerd Fonts SymbolsOnly) — bounded Nerd glyph
  coverage so icons render on a fresh install with nothing extra to install.

## Why one Nerd face, not “all the Nerd Fonts”

The full Nerd Fonts collection is 50+ patched families and hundreds of
megabytes. Shipping it would bloat the installer and hurt launch I/O. The
SymbolsOnly face carries the complete Nerd symbol/PUA range (Codicons,
Devicons, Octicons, Font Awesome, Material Design Icons, Powerline, Seti,
Weather, IEC power, …) with **no Latin glyphs**, so a single ~1.1 MB woff2
preserves every glyph the app can reference regardless of which patched family
a symbol originally came from. That is the upstream-supported subset for this
use case.

The proportional `Symbols Nerd Font` TTF from the same zip is **not** shipped.

## Symbols Nerd Font Mono — provenance

|                   |                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Upstream          | [ryanoasis/nerd-fonts](https://github.com/ryanoasis/nerd-fonts)                           |
| Release           | `v3.4.0`                                                                                  |
| Package           | `NerdFontsSymbolsOnly.zip`                                                                |
| File shipped      | `SymbolsNerdFontMono-Regular.woff2`                                                       |
| CSS `font-family` | `Symbols Nerd Font Mono` (must match `NERD_SYMBOLS_FAMILY`)                               |
| Archive SHA-256   | `8e617904b980fe3648a4b116808788fe50c99d2d495376cb7c0badbd8a564c47`                        |
| TTF SHA-256       | `f0f624d9b474bea1662cf7e862d44aebe1ae1f6c7f9cb7a0ca5d0e5ac9561c60`                        |
| WOFF2 SHA-256     | `6bf2900234c105b03835dbab8d2dd7f32f4f67308ac647df6912e85fd2c742c9`                        |
| Download          | https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/NerdFontsSymbolsOnly.zip |

The woff2 is a lossless format conversion of `SymbolsNerdFontMono-Regular.ttf`
from that zip (`fontTools.ttLib`, `flavor = "woff2"`). Glyphs, name table, and
cmap are unmodified.

Refresh / verify (offline `--check` never hits the network):

```
scripts/fetch-nerd-fonts.sh --check
scripts/fetch-nerd-fonts.sh          # re-download, verify, install
```

Pins live in the fetch script. A mismatched checksum leaves the destination
untouched.

## Licensing

- **Nerd Fonts project wrapper:** MIT. Full text in `LICENSE` (Ryan L
  McIntyre, 2014). Redistribution requires this notice.
- **Geist / Geist Mono, Weather Icons, Pomicons:** SIL OFL 1.1. Full text in
  `OFL.txt`.
- **Material Design Icons:** Apache 2.0. Full text in `APACHE`.
- **Glyph sets inside SymbolsOnly** (from the upstream Symbols Only README):

  | Set                    | License     | Attribution                                           |
  | ---------------------- | ----------- | ----------------------------------------------------- |
  | Codicons (Microsoft)   | CC BY 4.0   | https://github.com/microsoft/vscode-codicons          |
  | Devicons               | MIT         | https://github.com/devicons/devicon                   |
  | Font Awesome           | CC BY 4.0   | https://github.com/FortAwesome/Font-Awesome           |
  | Font Awesome Extension | MIT         | https://github.com/AndreLZGava/font-awesome-extension |
  | Font Logos             | unlicensed  | https://github.com/lukas-w/font-logos                 |
  | Material Design Icons  | Apache 2.0  | https://github.com/Templarian/MaterialDesign-Font     |
  | Octicons               | MIT         | https://github.com/primer/octicons                    |
  | Seti-UI + original     | MIT         | https://github.com/jesseweed/seti-ui                  |
  | Pomicons               | OFL 1.1 RFN | https://github.com/gabrielelana/pomicons              |
  | Powerline Extra        | MIT         | https://github.com/ryanoasis/powerline-extra-symbols  |
  | Powerline Symbols      | MIT         | https://github.com/powerline/powerline                |
  | IEC Power Symbols      | MIT         | https://github.com/jloughry/Unicode                   |
  | Weather Icons          | OFL 1.1     | https://github.com/erikflowers/weather-icons          |
  | extraglyphs (Hack)     | MIT         | https://github.com/source-foundry/Hack                |

CC BY 4.0 sets (Codicons, Font Awesome) require attribution; this file is
that attribution. Apache-2.0 Material Design Icons require a copy of the
license; see `APACHE`. No glyph set is re-licensed.

## How it loads

`design/nerd-fonts.css` declares `@font-face` with `font-display: swap` and a
`unicode-range` covering the Nerd PUA/symbol blocks (and excluding basic
Latin, so this face never shapes ordinary text). It also appends the family to
`--font` / `--font-mono`. Those stacks must stay identical to `fontStack()` in
`apps/desktop/src/shared/types.ts`. Missing or hostile user fonts fall through
the CSS stack to Geist, then to system faces — no JS detection, no blank UI.

The same woff2 + licenses (`LICENSE`, `OFL.txt`, `APACHE`) and this README are
copied to `Contents/Resources/fonts/` by electron-builder (`extraResources`)
so the signed package carries them outside the asar. The renderer still loads
the Vite-emitted copy. `resources/fonts/README.md` is a developer pointer and
is not extraResourced, so it cannot overwrite this attribution table.

## Representative coverage

The renderer currently draws UI icons with Lucide, not Nerd codepoints. The
bundled face is the forward-cover (and the acceptance vehicle that glyphs
render on a fresh Mac with no user fonts). Spot-check these if tofu appears:

| Codepoint      | Set                         |
| -------------- | --------------------------- |
| U+E0A0, U+E0B0 | Powerline                   |
| U+E5FA         | Seti-UI                     |
| U+E700         | Devicons                    |
| U+EA60         | Codicons                    |
| U+F07B         | Font Awesome                |
| U+F400         | Octicons                    |
| U+23FB, U+2B58 | IEC power                   |
| U+F0001        | Material Design Icons (SIP) |
