#!/usr/bin/env bash
# Regenerates apps/website/public/media from the source art in ../../assets.
#
# The site is committed with its media already built, so you only need this
# when the source art changes. Requires ffmpeg (libx264) and cwebp.
#
# Targets: stills become WebP at web widths, the 8s 1080p loops become
# muted, faststart H.264 at 1280x720. Nothing here is wired into the repo gate
# or CI on purpose — see apps/website/README.md.
#
# `media-src/film/*.mp4` are narrated campaign films rather than loops: they
# keep their audio, so they are encoded by `film()` and played on demand behind
# a poster instead of autoplaying like the art.
#
# `media-src/ui/*.png` are retina captures of the running app (2880x1880),
# taken through the repo's foundry-ui skill; `media-src/phone/*.png` are the
# Android captures from ../../screenshots cropped to 1080x1000. Recapture
# either when a screen changes rather than hand-editing the WebP.
#
# Written for bash 3.2 (macOS system bash): no mapfile, no process
# substitution, no bare mktemp.

set -eo pipefail

here=$(cd "$(dirname "$0")" && pwd)
site=$(cd "$here/.." && pwd)
src=$(cd "$site/../../assets" && pwd)
# Site-only captures live under the site rather than in the app's assets/,
# which electron-builder ships wholesale as extraResources — marketing
# screenshots have no business inside the signed DMG.
mine=$(cd "$site/media-src" && pwd)
out="$site/public/media"

mkdir -p "$out/art" "$out/loop" "$out/ui" "$out/agents" "$out/sigil" "$out/phone" "$out/film"

echo "source : $src"
echo "output : $out"

# WebP comes from cwebp rather than ffmpeg: Homebrew's ffmpeg is not always
# built with libwebp, and cwebp is a hard dependency of libwebp itself, so this
# is the encoder that is actually present. ffmpeg still owns H.264 and frame
# extraction.

# still <in> <out> <width> <quality>   — PNG in, WebP out
still() {
  cwebp -quiet -resize "$3" 0 -q "$4" -m 6 "$1" -o "$2"
  printf '  %-46s %s\n' "$(basename "$2")" "$(du -h "$2" | cut -f1)"
}

# loop <in> <basename> — writes a 1280x720 mp4 plus a first-frame poster
loop() {
  ffmpeg -v error -y -i "$1" -an \
    -vf "scale=1280:-2:flags=lanczos" \
    -c:v libx264 -profile:v high -pix_fmt yuv420p \
    -crf 31 -preset slower -g 48 -movflags +faststart \
    "$out/loop/$2.mp4"
  frame="$out/loop/$2.frame.png"
  ffmpeg -v error -y -i "$1" -vframes 1 -vf "scale=1280:-2:flags=lanczos" "$frame"
  cwebp -quiet -q 72 -m 6 "$frame" -o "$out/loop/$2.webp"
  rm -f "$frame"
  printf '  %-46s %s\n' "$2.mp4" "$(du -h "$out/loop/$2.mp4" | cut -f1)"
}

# film <in> <basename> — a narrated 1080p film to 1280x720 with its audio kept,
# plus a poster taken at 5s (frame 0 of these films is a black fade-in)
film() {
  ffmpeg -v error -y -i "$1" \
    -vf "scale=1280:-2:flags=lanczos" \
    -c:v libx264 -profile:v high -pix_fmt yuv420p \
    -crf 30 -preset slow -g 60 \
    -c:a aac -b:a 96k -ac 2 -movflags +faststart \
    "$out/film/$2.mp4"
  frame="$out/film/$2.frame.png"
  ffmpeg -v error -y -ss 5 -i "$1" -vframes 1 -vf "scale=1280:-2:flags=lanczos" "$frame"
  cwebp -quiet -q 78 -m 6 "$frame" -o "$out/film/$2.webp"
  rm -f "$frame"
  printf '  %-46s %s\n' "$2.mp4" "$(du -h "$out/film/$2.mp4" | cut -f1)"
}

echo "── concept art (2560x1440 → 1600w)"
for f in "$src"/concept-art/*.png; do
  still "$f" "$out/art/$(basename "$f" .png).webp" 1600 74
done

echo "── generated hero (2560x1440 → 1600w)"
still "$src/generated/foundry-forge-workcell-hero.png" "$out/art/foundry-forge-workcell-hero.webp" 1600 74

echo "── sigils (1920² → 560w)"
for n in foundry-pipeline-sigil foundry-evidence-gate foundry-orchestrator-agent foundry-run-cleared; do
  still "$src/generated/$n.png" "$out/sigil/$n.webp" 560 78
done
for n in pipeline gate envelope; do
  still "$src/concepts/$n.png" "$out/sigil/concept-$n.webp" 560 78
done

echo "── agent portraits (1024² → 320w)"
for f in "$src"/agents/*.png; do
  still "$f" "$out/agents/$(basename "$f" .png).webp" 320 80
done

echo "── desktop screenshots (2880x1880 retina → 1440w)"
for f in "$mine"/ui/*.png; do
  still "$f" "$out/ui/$(basename "$f" .png).webp" 1440 82
done

# Cropped to 1080x1000: the raw captures are 1080x2400 and several screens fill
# only the top third, so the full canvas would render as a phone frame that is
# mostly empty background.
echo "── phone screenshots (1080x1000 → 540w)"
for f in "$mine"/phone/*.png; do
  still "$f" "$out/phone/$(basename "$f" .png).webp" 540 84
done

echo "── loops (1920x1080x8s → 1280x720)"
for f in "$src"/concept-art/*-loop.mp4; do
  b=$(basename "$f" -loop.mp4)
  loop "$f" "$b"
done

echo "── films (1920x1080 with audio → 1280x720)"
for f in "$mine"/film/*.mp4; do
  [ -e "$f" ] || continue
  film "$f" "$(basename "$f" .mp4)"
done

echo "── app icon"
still "$src/icon/app-icon-1024.png" "$out/app-icon.webp" 512 88

echo
echo "total: $(du -sh "$out" | cut -f1)"
