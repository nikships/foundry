#!/usr/bin/env bash
# Builds assets/icon/app-icon.icns from the 1024px master.
# iconutil needs every size present in a .iconset directory; sips does the
# resampling, so there is no dependency beyond the base system.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="assets/icon/app-icon-1024.png"
OUT="assets/icon/app-icon.icns"
SET="$(mktemp -d)/app-icon.iconset"

[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }
mkdir -p "$SET"

for size in 16 32 128 256 512; do
  sips -z $size $size          "$SRC" --out "$SET/icon_${size}x${size}.png"      >/dev/null
  sips -z $((size*2)) $((size*2)) "$SRC" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$SET" -o "$OUT"
echo "wrote $OUT"
