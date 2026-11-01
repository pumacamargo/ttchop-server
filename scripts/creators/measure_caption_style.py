#!/usr/bin/env python3
"""measure_caption_style.py — measure the creator's caption band (position & size).

Generalized version of the one-off `measure_caption.py`. Given either a folder of
frames or a video, it locates the near-white caption text and reports, per frame:

  * the vertical band it occupies (y range, and that range as % of frame height);
  * its vertical center;
  * the text height in pixels;
  * the horizontal centering (x range and center vs frame width).

This is the measurement used to place the recreated caption stickers so they match
the source creator's layout.

Where it runs: vps-projects (needs ffmpeg for the video path; PIL for the pixels).
"""
import argparse
import glob
import os
import subprocess
import sys
import tempfile

from PIL import Image

IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp")


def parse_region(text):
    """Parse "x0,y0,x1,y1". Values <= 1 are treated as fractions of the frame."""
    parts = [float(v) for v in text.split(",")]
    if len(parts) != 4:
        raise SystemExit("--region must be x0,y0,x1,y1 (fractions <=1 or pixels)")
    return parts


def region_pixels(region, W, H):
    x0, y0, x1, y1 = region
    px0 = int(round(x0 * W)) if x0 <= 1 else int(x0)
    py0 = int(round(y0 * H)) if y0 <= 1 else int(y0)
    px1 = int(round(x1 * W)) if x1 <= 1 else int(x1)
    py1 = int(round(y1 * H)) if y1 <= 1 else int(y1)
    return max(0, px0), max(0, py0), min(W, px1), min(H, py1)


def measure(im, label, region, threshold, min_pixels):
    im = im.convert("L")
    W, H = im.size
    px = im.load()
    x0, y0, x1, y1 = region_pixels(region, W, H)

    rows = []
    for y in range(y0, y1):
        count = 0
        for x in range(x0, x1, 2):
            if px[x, y] > threshold:
                count += 1
        rows.append((y, count))

    best = sorted(rows, key=lambda r: -r[1])[:40]
    if not best or best[0][1] < min_pixels:
        print(f"{label}: no clear caption text detected (max white px/row={best[0][1] if best else 0})")
        return
    cutoff = max(min_pixels, best[0][1] // 2)
    ys = sorted(y for y, c in rows if c >= cutoff)
    top, bot = ys[0], ys[-1]
    print(f"{label}: W={W} H={H} banda_y={top}..{bot} centro={(top + bot) / 2:.0f} "
          f"({top / H * 100:.1f}%..{bot / H * 100:.1f}% del alto) alto_texto={bot - top + 1}px")

    cols = []
    for x in range(x0, x1):
        count = 0
        for y in range(top, bot + 1):
            if px[x, y] > threshold:
                count += 1
        if count >= 2:
            cols.append(x)
    if cols:
        print(f"   ancho_texto={cols[0]}..{cols[-1]} ({cols[-1] - cols[0] + 1}px), "
              f"centrado_x={(cols[0] + cols[-1]) / 2:.0f} de {W}")


def video_duration(path):
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        raise SystemExit(f"ffprobe failed for {path}: {proc.stderr.strip()}")
    return float(proc.stdout.strip())


def grab_frame(video, t, out_path):
    proc = subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-ss", str(t), "-i", video, "-frames:v", "1", out_path],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(f"ffmpeg frame grab failed at t={t}: {proc.stderr.strip()}")
    return out_path


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, help="folder of frames or a video file")
    ap.add_argument("--times", default=None,
                    help="comma-separated seconds to sample (video input only); "
                         "default: 5 frames evenly spaced over the video")
    ap.add_argument("--region", default="0,0,1,0.65",
                    help="search region x0,y0,x1,y1 (fractions <=1 or pixels)")
    ap.add_argument("--threshold", type=int, default=235, help="white threshold (0-255)")
    ap.add_argument("--min-pixels", type=int, default=5,
                    help="min near-white pixels per row to count as caption")
    args = ap.parse_args()

    region = parse_region(args.region)

    if os.path.isdir(args.input):
        names = sorted(n for n in os.listdir(args.input) if n.lower().endswith(IMAGE_EXT))
        if not names:
            raise SystemExit(f"no image files in {args.input}")
        for name in names:
            measure(Image.open(os.path.join(args.input, name)), name, region,
                    args.threshold, args.min_pixels)
        return

    # video input: sample frames with ffmpeg
    if args.times:
        times = [float(t) for t in args.times.split(",") if t.strip() != ""]
    else:
        dur = video_duration(args.input)
        times = [dur * f for f in (0.1, 0.3, 0.5, 0.7, 0.9)]
    with tempfile.TemporaryDirectory() as tmp:
        for t in times:
            frame = grab_frame(args.input, t, os.path.join(tmp, f"f_{t}.png"))
            measure(Image.open(frame), f"t={t:.2f}s", region, args.threshold, args.min_pixels)


if __name__ == "__main__":
    sys.exit(main())
