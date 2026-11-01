#!/usr/bin/env python3
"""build_recipe_from_plan.py — build a ttchop collage ffmpegRecipe from a duration->clip plan.

Generalized, path-agnostic version of the one-off `make_recipe2.py` written for the
`01_squishy01` recreation case. It turns a *plan* (how many seconds each clip must
contribute) into the `ffmpegRecipe` object consumed by `scripts/collage_builder.py`.

Key behaviours (kept from the original):
  * clip durations are probed with `ffprobe` (no manual duration table required);
  * the audio duration is probed with `ffprobe`;
  * `trimStart = clamp(trim_start_ratio*dur - 0.3, 0, dur - need - 0.1)`;
  * the gap between the audio duration and the sum of the plan is absorbed by the
    LAST clip (disable with --no-absorb).

Plan format (--plan): a JSON list of `[seconds, clip_name]` pairs, e.g.

    [[2.2, "20261031_234928.mp4"], [1.0, "20261031_234619.mp4"], ...]

or an object `{"plan": [...], "durations": {"<clip_name>": <seconds>, ...}}`
(the `durations` map is optional and only used to skip a couple of ffprobe calls;
see also `--durations`). `plan.example.json` is a real, working example.

Where it runs: vps-projects (it needs the /mnt/polaris mount and ffprobe).
"""
import argparse
import json
import os
import subprocess
import sys


def probe_duration(path):
    """Return the media duration (seconds) of `path` using ffprobe."""
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        raise RuntimeError(f"ffprobe failed for {path}: {proc.stderr.strip()}")
    return float(proc.stdout.strip())


def load_plan(path):
    """Load the plan (and any embedded durations map) from a JSON file.

    Accepts either a bare list of [seconds, clip_name] pairs, a list of dicts
    with {"seconds"/"dur", "clip"/"name"} keys, or an object with a "plan" key
    plus an optional "durations" map.
    """
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)

    durations = {}
    if isinstance(data, dict):
        durations = data.get("durations") or {}
        plan = data.get("plan") or data.get("PLAN")
        if plan is None:
            raise SystemExit(f'{path}: object must contain a "plan" list')
    else:
        plan = data

    pairs = []
    for item in plan:
        if isinstance(item, dict):
            seconds = item.get("seconds", item.get("dur"))
            name = item.get("clip", item.get("name"))
            if seconds is None or name is None:
                raise SystemExit(f"{path}: bad plan entry {item!r}")
        else:
            seconds, name = item[0], item[1]
        pairs.append((float(seconds), str(name)))
    if not pairs:
        raise SystemExit(f"{path}: empty plan")
    return pairs, {k: float(v) for k, v in durations.items()}


def clamp(value, low, high):
    return min(max(value, low), high)


def build_recipe(pairs, durations, video_dir, audio, args):
    extra = args.audio_duration - sum(sec for sec, _ in pairs)
    last = len(pairs) - 1
    clips = []
    for i, (need, name) in enumerate(pairs):
        src = name if os.path.isabs(name) else os.path.join(video_dir, name)
        key = name if name in durations else os.path.basename(name)
        if key in durations:
            clip_dur = durations[key]
        else:
            clip_dur = probe_duration(src)
        if i == last and not args.no_absorb and extra > 0:
            need += extra
        start = clamp(args.trim_start_ratio * clip_dur - 0.3,
                      0.0, max(0.0, clip_dur - need - 0.1))
        clips.append({
            "clipId": f"s{i + 1:02d}",
            "role": "body",
            "src": src,
            "trimStart": round(start, 3),
            "trimEnd": round(start + need, 6),
            "speed": 1.0,
        })
        print(f"s{i + 1:02d} {name} need={need:.3f} start={start:.3f} clip={clip_dur:.3f}")

    meta = {"width": args.width, "height": args.height}
    if args.output_video:
        meta["outputPath"] = args.output_video
    recipe = {"ffmpegRecipe": {"meta": meta, "audio": {"src": audio}, "clips": clips}}
    total = sum(c["trimEnd"] - c["trimStart"] for c in clips)
    absorb = 0.0 if args.no_absorb else max(extra, 0.0)
    print("video_target=%.3f audio=%.3f extra_al_ultimo=%.3f receta_total=%.3f"
          % (sum(sec for sec, _ in pairs), args.audio_duration, absorb, total))
    return recipe


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plan", required=True, help="plan JSON (list of [seconds, clip_name])")
    ap.add_argument("--video-dir", required=True, help="directory holding the source clips")
    ap.add_argument("--audio", required=True, help="audio file (voice track) for the collage")
    ap.add_argument("--out", required=True, help="path to write the recipe JSON")
    ap.add_argument("--output-video", default=None, help="meta.outputPath for the rendered video")
    ap.add_argument("--width", type=int, default=1080)
    ap.add_argument("--height", type=int, default=1920)
    ap.add_argument("--trim-start-ratio", type=float, default=0.35,
                    help="trimStart = ratio*clip_dur - 0.3 (default 0.35)")
    ap.add_argument("--no-absorb", action="store_true",
                    help="do NOT grow the last clip to match the audio duration")
    ap.add_argument("--durations", default=None,
                    help="optional JSON {clip_name: seconds} to reuse already-measured durations")
    ap.add_argument("--audio-duration", type=float, default=None,
                    help="override the probed audio duration (seconds)")
    args = ap.parse_args()

    pairs, durations = load_plan(args.plan)
    if args.durations:
        with open(args.durations, encoding="utf-8") as handle:
            extra_dur = json.load(handle)
        if isinstance(extra_dur, dict) and "durations" in extra_dur:
            extra_dur = extra_dur["durations"]
        durations.update({k: float(v) for k, v in extra_dur.items()})

    if args.audio_duration is None:
        if args.audio.startswith("http"):
            raise SystemExit("--audio-duration is required when --audio is a URL")
        args.audio_duration = probe_duration(args.audio)

    recipe = build_recipe(pairs, durations, args.video_dir, args.audio, args)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(recipe, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(f"wrote {args.out} ({len(recipe['ffmpegRecipe']['clips'])} clips)")


if __name__ == "__main__":
    sys.exit(main())
