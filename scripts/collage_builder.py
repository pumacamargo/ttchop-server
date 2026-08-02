import os
import sys
import json
import logging
import subprocess
import urllib.request
import urllib.error

# --- Logging setup ---
LOG_DIR = "/home/node/.n8n-files/logs"
os.makedirs(LOG_DIR, exist_ok=True)
LOG_FILE = os.path.join(LOG_DIR, "collage_builder.log")

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stderr),
    ],
)
logger = logging.getLogger("collage_builder")


def run_cmd(cmd, description):
    logger.debug(f"Running {description}: {cmd}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        logger.error(f"{description} failed (exit code {result.returncode})")
        logger.error(f"stdout: {result.stdout.strip()}")
        logger.error(f"stderr: {result.stderr.strip()}")
        raise RuntimeError(f"{description} failed: {result.stderr.strip()[:500]}")
    return result


def get_media_duration(file_path):
    cmd = f'ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "{file_path}"'
    result = run_cmd(cmd, f"ffprobe on {file_path}")
    try:
        return float(result.stdout.strip())
    except ValueError:
        raise RuntimeError(f"Could not read duration for {file_path}")


def download_file(url, output_path):
    logger.debug(f"Downloading {url} -> {output_path}")
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as response, open(output_path, "wb") as out:
            out.write(response.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Failed to download {url}: HTTP {e.code} {e.reason}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Failed to download {url}: {e.reason}")
    logger.debug(f"Downloaded successfully ({os.path.getsize(output_path)} bytes)")


def main():
    temp_dir = "/media/collage_temp"
    os.makedirs(temp_dir, exist_ok=True)

    # --- Parse input ---
    try:
        filepath = sys.argv[1]
        with open(filepath, 'r') as f:
            raw = json.load(f)
        # Accept both the full validator array or a plain recipe object
        if isinstance(raw, list):
            recipe = raw[0]["ffmpegRecipe"]
        elif "ffmpegRecipe" in raw:
            recipe = raw["ffmpegRecipe"]
        else:
            recipe = raw  # already the recipe itself
    except Exception as e:
        logger.error(f"Invalid input: {e}")
        print(json.dumps({"error": f"Invalid input: {e}"}))
        sys.exit(1)

    meta = recipe["meta"]
    audio_info = recipe["audio"]
    clips = recipe["clips"]

    output_path = meta.get("outputPath", "/media/output/collage.mp4")
    width = meta.get("width", 1080)
    height = meta.get("height", 1920)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    logger.info(f"Starting collage: {len(clips)} clips -> {output_path}")

    # --- Audio: local path or URL ---
    audio_src = audio_info["src"]
    if audio_src.startswith("http"):
        audio_path = os.path.join(temp_dir, "audio.mp3")
        logger.info("Downloading audio...")
        download_file(audio_src, audio_path)
    else:
        audio_path = audio_src
        if not os.path.exists(audio_path):
            raise RuntimeError(f"Audio file not found: {audio_path}")

    logger.info(f"Audio: {audio_path}")

    # --- Download and trim each clip ---
    trimmed_clips = []

    for i, clip in enumerate(clips):
        clip_id = clip.get("clipId", f"clip_{i}")
        role = clip.get("role", "")
        firebase_url = clip.get("firebaseUrl", "")
        local_src = clip.get("src", "")
        trim_start = float(clip.get("trimStart", 0))
        trim_end = float(clip.get("trimEnd", 0))
        speed = float(clip.get("speed", 1))
        duration = trim_end - trim_start

        if duration <= 0:
            logger.warning(f"Clip {clip_id} ({role}): invalid duration {duration:.3f}s, skipping")
            continue

        # Resolve local path for this clip
        raw_path = os.path.join(temp_dir, f"raw_{clip_id}.mp4")

        if os.path.exists(local_src):
            raw_path = local_src
            logger.info(f"Clip {i} ({role}): using local file {local_src}")
        elif firebase_url:
            logger.info(f"Clip {i} ({role}): downloading from Firebase...")
            download_file(firebase_url, raw_path)
        else:
            raise RuntimeError(f"Clip {clip_id}: no local file and no firebaseUrl")

        # Trim (and optionally speed up)
        trimmed_path = os.path.join(temp_dir, f"trim_{i}_{clip_id}.mp4")

        scale_filter = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setpts=PTS-STARTPTS"

        if speed != 1:
            pts_factor = round(1 / speed, 6)
            vf = f"setpts={pts_factor}*PTS,{scale_filter}"
        else:
            vf = scale_filter

        cmd = (
            f'ffmpeg -y -ss {trim_start} -t {duration} -i "{raw_path}" '
            f'-vf "{vf}" -pix_fmt yuv420p -an "{trimmed_path}"'
        )
        run_cmd(cmd, f"trim clip {i} ({role})")

        actual_duration = get_media_duration(trimmed_path)
        logger.info(f"Clip {i} ({role}): trimmed {trim_start:.3f}s-{trim_end:.3f}s -> {actual_duration:.3f}s")
        trimmed_clips.append(trimmed_path)

    if not trimmed_clips:
        raise RuntimeError("No clips were trimmed — nothing to render")

    # --- Concatenate all trimmed clips ---
    logger.info(f"Concatenating {len(trimmed_clips)} clips...")

    ffmpeg_inputs = " ".join(f'-i "{p}"' for p in trimmed_clips)
    filter_concat = "".join(f"[{i}:v]" for i in range(len(trimmed_clips)))
    filter_concat += f"concat=n={len(trimmed_clips)}:v=1:a=0[v]"

    cmd_final = (
        f'ffmpeg -y {ffmpeg_inputs} -i "{audio_path}" '
        f'-filter_complex "{filter_concat}" '
        f'-map "[v]" -map {len(trimmed_clips)}:a '
        f'-c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "{output_path}"'
    )
    run_cmd(cmd_final, "ffmpeg final concat + audio")

    if not os.path.exists(output_path):
        raise RuntimeError("ffmpeg finished but output file is missing")

    final_duration = get_media_duration(output_path)
    logger.info(f"Done: {output_path} ({final_duration:.2f}s)")

    # --- Cleanup temp files ---
    for f in os.listdir(temp_dir):
        fp = os.path.join(temp_dir, f)
        if os.path.isfile(fp):
            os.remove(fp)
    os.rmdir(temp_dir)

    print(json.dumps({
        "status": "success",
        "output_path": output_path,
        "total_clips": len(trimmed_clips),
        "final_duration_seconds": round(final_duration, 2),
        "log_file": LOG_FILE,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        logger.exception("collage_builder failed")
        print(json.dumps({"error": str(e), "log_file": LOG_FILE}))
        sys.exit(1)
