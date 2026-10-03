#!/usr/bin/env bash
# Fetch the NASA SVS CGI Moon Kit maps and convert them to the WebP textures
# under ui/public/moon/. See ui/public/moon/CREDITS.md for attribution and the
# map convention. Idempotent: re-running overwrites the outputs with identical
# results. Needs curl and ImageMagick 7 (`magick`) with WebP support.
#
# Usage: ui/scripts/fetch-moon-textures.sh
set -euo pipefail

BASE="https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720"
COLOR_SRC="lroc_color_poles_4k.tif" # 4096x2048 8-bit sRGB colour
RELIEF_SRC="ldem_16_uint.tif"       # 5760x2880 16-bit unsigned elevation

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out_dir="$script_dir/../public/moon"
mkdir -p "$out_dir"

command -v magick >/dev/null || {
  echo "fetch-moon-textures: ImageMagick 'magick' not found" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() {
  echo "downloading $1"
  curl --fail --location --silent --show-error --retry 3 \
    --output "$tmp/$1" "$BASE/$1"
}

fetch "$COLOR_SRC"
fetch "$RELIEF_SRC"

# Colour: full 4k plus a 1k copy for the static card disc.
magick "$tmp/$COLOR_SRC" -colorspace sRGB -strip \
  -resize '4096x2048!' -quality 82 -define webp:method=6 \
  "$out_dir/moon-color-4k.webp"
magick "$tmp/$COLOR_SRC" -colorspace sRGB -strip \
  -filter Lanczos -resize '1024x512!' -quality 82 -define webp:method=6 \
  "$out_dir/moon-color-1k.webp"

# Relief: 16-bit heights stretched to the full 8-bit greyscale range.
magick "$tmp/$RELIEF_SRC" -strip -filter Lanczos -resize '2048x1024!' \
  -auto-level -colorspace Gray -depth 8 \
  -quality 85 -define webp:method=6 \
  "$out_dir/moon-relief-2k.webp"

ls -l "$out_dir"/*.webp
