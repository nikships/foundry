#!/usr/bin/env bash
# Downloads the pinned Nerd Fonts SymbolsOnly release, verifies checksums, and
# installs the single Mono woff2 Foundry ships. Fail-closed: a mismatched
# checksum leaves the destination untouched and exits non-zero.
#
# The full Nerd Fonts collection is 50+ patched families / hundreds of MB.
# SymbolsOnly carries the complete Nerd PUA/symbol range with no Latin glyphs,
# which is the bounded set that preserves coverage without bloating the app.
#
# This script is a maintainer tool, not a `pnpm run check` step — the gate
# must stay offline. `--check` never hits the network.
#
# Usage:
#   scripts/fetch-nerd-fonts.sh           # download, verify, install
#   scripts/fetch-nerd-fonts.sh --check   # offline: verify committed files
#   scripts/fetch-nerd-fonts.sh --force   # re-download even if present

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$ROOT/apps/desktop/src/renderer/design/fonts"
PACK_DIR="$ROOT/resources/fonts"
WOFF2_NAME="SymbolsNerdFontMono-Regular.woff2"
TTF_NAME="SymbolsNerdFontMono-Regular.ttf"
LICENSE_NAME="LICENSE"

# Pin. Bump by editing these four values together after a verified conversion.
NERD_FONTS_VERSION="v3.4.0"
ARCHIVE_NAME="NerdFontsSymbolsOnly.zip"
ARCHIVE_SHA256="8e617904b980fe3648a4b116808788fe50c99d2d495376cb7c0badbd8a564c47"
TTF_SHA256="f0f624d9b474bea1662cf7e862d44aebe1ae1f6c7f9cb7a0ca5d0e5ac9561c60"
WOFF2_SHA256="6bf2900234c105b03835dbab8d2dd7f32f4f67308ac647df6912e85fd2c742c9"
FAMILY_NAME="Symbols Nerd Font Mono"
RELEASE_URL="https://github.com/ryanoasis/nerd-fonts/releases/download/${NERD_FONTS_VERSION}/${ARCHIVE_NAME}"

WOFF2_PATH="$DEST_DIR/$WOFF2_NAME"
MAX_BYTES=$((5 * 1024 * 1024))

sha256_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

fail() {
  echo "fetch-nerd-fonts: $1" >&2
  exit 1
}

CHECK=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --force) FORCE=1 ;;
    -h | --help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *) fail "unknown argument: $arg" ;;
  esac
done

verify_committed() {
  [[ -f "$WOFF2_PATH" ]] || fail "missing $WOFF2_PATH"
  local actual size
  actual="$(sha256_of "$WOFF2_PATH")"
  [[ "$actual" == "$WOFF2_SHA256" ]] || fail "woff2 sha256 mismatch (got $actual, want $WOFF2_SHA256)"
  size="$(wc -c < "$WOFF2_PATH" | tr -d ' ')"
  [[ "$size" -gt 0 ]] || fail "woff2 is empty"
  [[ "$size" -le "$MAX_BYTES" ]] || fail "woff2 is ${size} bytes (budget ${MAX_BYTES})"
  # wOF2 magic
  local magic
  magic="$(dd if="$WOFF2_PATH" bs=4 count=1 2>/dev/null)"
  [[ "$magic" == "wOF2" ]] || fail "woff2 magic is not wOF2"

  [[ -f "$DEST_DIR/$LICENSE_NAME" ]] || fail "missing $DEST_DIR/$LICENSE_NAME"
  grep -q "MIT License" "$DEST_DIR/$LICENSE_NAME" || fail "font LICENSE is not MIT"
  [[ -f "$DEST_DIR/OFL.txt" ]] || fail "missing $DEST_DIR/OFL.txt"
  grep -q "SIL OPEN FONT LICENSE" "$DEST_DIR/OFL.txt" || fail "OFL.txt is not SIL OFL"
  [[ -f "$DEST_DIR/README.md" ]] || fail "missing $DEST_DIR/README.md"
  grep -q "$NERD_FONTS_VERSION" "$DEST_DIR/README.md" || fail "fonts README does not pin $NERD_FONTS_VERSION"
  grep -q "$WOFF2_SHA256" "$DEST_DIR/README.md" || fail "fonts README does not pin the woff2 sha256"
  grep -q "$FAMILY_NAME" "$DEST_DIR/README.md" || fail "fonts README does not name $FAMILY_NAME"

  [[ -f "$PACK_DIR/$LICENSE_NAME" ]] || fail "missing $PACK_DIR/$LICENSE_NAME"
  [[ -f "$PACK_DIR/OFL.txt" ]] || fail "missing $PACK_DIR/OFL.txt"
  [[ -f "$PACK_DIR/README.md" ]] || fail "missing $PACK_DIR/README.md"

  echo "fetch-nerd-fonts: ok $NERD_FONTS_VERSION $WOFF2_NAME (${size} bytes)"
}

if [[ "$CHECK" -eq 1 ]]; then
  verify_committed
  exit 0
fi

if [[ "$FORCE" -eq 0 && -f "$WOFF2_PATH" ]]; then
  actual="$(sha256_of "$WOFF2_PATH")"
  if [[ "$actual" == "$WOFF2_SHA256" ]]; then
    verify_committed
    echo "fetch-nerd-fonts: already present and verified"
    exit 0
  fi
fi

command -v curl >/dev/null || fail "curl is required to download $ARCHIVE_NAME"
command -v unzip >/dev/null || fail "unzip is required to extract $ARCHIVE_NAME"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/foundry-nerd-fonts.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "fetch-nerd-fonts: downloading $RELEASE_URL"
curl -fsSL --retry 3 -o "$WORK/$ARCHIVE_NAME" "$RELEASE_URL"
archive_actual="$(sha256_of "$WORK/$ARCHIVE_NAME")"
[[ "$archive_actual" == "$ARCHIVE_SHA256" ]] || fail "archive sha256 mismatch (got $archive_actual)"

unzip -q -o "$WORK/$ARCHIVE_NAME" "$TTF_NAME" "$LICENSE_NAME" -d "$WORK"
[[ -f "$WORK/$TTF_NAME" ]] || fail "zip did not contain $TTF_NAME"
ttf_actual="$(sha256_of "$WORK/$TTF_NAME")"
[[ "$ttf_actual" == "$TTF_SHA256" ]] || fail "ttf sha256 mismatch (got $ttf_actual)"

converted="$WORK/$WOFF2_NAME"
if python3 -c 'import fontTools, brotli' >/dev/null 2>&1; then
  python3 - "$WORK/$TTF_NAME" "$converted" <<'PY'
import sys
from fontTools.ttLib import TTFont

src, dest = sys.argv[1], sys.argv[2]
font = TTFont(src)
font.flavor = "woff2"
font.save(dest)
PY
  conv_actual="$(sha256_of "$converted")"
  [[ "$conv_actual" == "$WOFF2_SHA256" ]] || fail "converted woff2 sha256 mismatch (got $conv_actual)"
elif [[ -f "$WOFF2_PATH" && "$(sha256_of "$WOFF2_PATH")" == "$WOFF2_SHA256" ]]; then
  echo "fetch-nerd-fonts: fonttools/brotli not installed; keeping committed woff2"
  converted="$WOFF2_PATH"
else
  fail "fonttools+brotli required to convert TTF → woff2 (pip install fonttools brotli)"
fi

mkdir -p "$DEST_DIR" "$PACK_DIR"
if [[ "$converted" != "$WOFF2_PATH" ]]; then
  tmp_woff="$DEST_DIR/$WOFF2_NAME.tmp"
  cp "$converted" "$tmp_woff"
  [[ "$(sha256_of "$tmp_woff")" == "$WOFF2_SHA256" ]] || {
    rm -f "$tmp_woff"
    fail "refusing to install woff2 with unexpected sha256"
  }
  mv "$tmp_woff" "$WOFF2_PATH"
fi
cp "$WORK/$LICENSE_NAME" "$DEST_DIR/$LICENSE_NAME"
cp "$WORK/$LICENSE_NAME" "$PACK_DIR/$LICENSE_NAME"

verify_committed
echo "fetch-nerd-fonts: installed $FAMILY_NAME from $NERD_FONTS_VERSION"
