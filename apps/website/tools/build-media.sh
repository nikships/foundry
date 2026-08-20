#!/usr/bin/env bash
# Regenerates website/media/ from the source art in ../../assets.
#
# The site is committed with its media already built, so you only need this
# when the source art changes. Requires ffmpeg with libwebp and libx264.
#
# Targets: stills become WebP at web widths, the 8s 1080p loops become
# muted, faststart H.264 at 1280x720. Nothing here is wired into npm scripts
# or CI on purpose — see website/README.md.
#
# Written for bash 3.2 (macOS system bash): no mapfile, no process
# substitution, no bare mktemp.

set -eo pipefail

here=$(cd "$(dirname "$0")" && pwd)
site=$(cd "$here/.." && pwd)
src=$(cd "$site/../../assets" && pwd)
out="$site/public/media"

mkdir -p "$out/art" "$out/loop" "$out/ui" "$out/agents" "$out/sigil"

echo "source : $src"
echo "output : $out"

# still <in> <out> <width> <quality>
still() {
  ffmpeg -v error -y -i "$1" -vf "scale=$3:-2:flags=lanczos" -c:v libwebp -quality "$4" -compression_level 6 "$2"
  printf '  %-46s %s\n' "$(basename "$2")" "$(du -h "$2" | cut -f1)"
}

# loop <in> <basename> — writes a 1280x720 mp4 plus a first-frame poster
loop() {
  ffmpeg -v error -y -i "$1" -an \
    -vf "scale=1280:-2:flags=lanczos" \
    -c:v libx264 -profile:v high -pix_fmt yuv420p \
    -crf 31 -preset slower -g 48 -movflags +faststart \
    "$out/loop/$2.mp4"
  ffmpeg -v error -y -i "$1" -vframes 1 -vf "scale=1280:-2:flags=lanczos" \
    -c:v libwebp -quality 72 "$out/loop/$2.webp"
  printf '  %-46s %s\n' "$2.mp4" "$(du -h "$out/loop/$2.mp4" | cut -f1)"
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

echo "── app screenshots (1400w → 1400w)"
for f in "$src"/readme/*.png; do
  still "$f" "$out/ui/$(basename "$f" .png).webp" 1400 82
done

echo "── loops (1920x1080x8s → 1280x720)"
for f in "$src"/concept-art/*-loop.mp4; do
  b=$(basename "$f" -loop.mp4)
  loop "$f" "$b"
done

echo "── app icon"
still "$src/icon/app-icon-1024.png" "$out/app-icon.webp" 512 88

echo
echo "total: $(du -sh "$out" | cut -f1)"
