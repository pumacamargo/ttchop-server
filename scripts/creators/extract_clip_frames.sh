#!/usr/bin/env bash
# extract_clip_frames.sh — grab one representative frame per clip (skips existing).
#
# Generalized version of the one-off extract_frames.sh used for the 01_squishy01
# recreation case. Naming stays fNN.jpg (sorted order) so the frames line up with
# the `fNN` ids used by the plan/recipe of that case.
#
# Usage:
#   extract_clip_frames.sh <clips_dir> <out_dir> [percent=0.35] [scale_width=200] [glob=*.mp4]
#
# Where it runs: vps-projects (needs ffmpeg/ffprobe and the clip files).
#
# Examples:
#   extract_clip_frames.sh /mnt/polaris/.../assets/video ./frames
#   extract_clip_frames.sh ./clips ./frames 0.5 320
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <clips_dir> <out_dir> [percent=0.35] [scale_width=200] [glob=*.mp4]" >&2
  exit 2
fi

CLIPS="$1"
OUT="$2"
PERCENT="${3:-0.35}"
SCALE_W="${4:-200}"
# shellcheck disable=SC2016
PATTERN="${5:-*.mp4}"

mkdir -p "$OUT"

i=0
for f in "$CLIPS"/$PATTERN; do
  [ -e "$f" ] || continue
  i=$((i + 1))
  n=$(printf '%02d' "$i")
  base=$(basename "$f")
  if [ -s "$OUT/f$n.jpg" ]; then
    echo "SKIP $n $base"
    continue
  fi
  d=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f" 2>/dev/null || true)
  [ -z "$d" ] && d=5
  t=$(python3 -c "print(max(0.5, float('$d') * float('$PERCENT')))")
  ffmpeg -y -hide_banner -loglevel error -ss "$t" -i "$f" -frames:v 1 -vf "scale=$SCALE_W:-1" "$OUT/f$n.jpg"
  echo "OK $n $base t=$t"
done

echo "TOTAL $(ls -1 "$OUT" 2>/dev/null | wc -l)"
