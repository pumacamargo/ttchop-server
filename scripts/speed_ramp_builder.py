#!/usr/bin/env python3
"""
Speed Ramp Builder — exponential slow→fast curve, frame-by-frame via OpenCV.
Each segment ramps from SLOW_SPEED to FAST_SPEED exponentially.
The cut happens at the fast peak (end of segment).
"""

import sys
import os
import json
import subprocess
import logging
import urllib.request
import numpy as np
import cv2

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger(__name__)

TEMP_DIR = '/tmp/sr_clips'

# Speed curve parameters
SLOW_SPEED = 0.15   # start of ramp (very slow)
FAST_SPEED = 8.0    # end of ramp (fast, at cut point)
CURVE_POW  = 1.0    # 1.0 = exponential, >1 = stays slow longer (cubic etc.)


def run(cmd, **kwargs):
    kwargs.setdefault('check', True)
    kwargs.setdefault('capture_output', True)
    return subprocess.run(cmd, **kwargs)


def download_clip(url, dest):
    if os.path.exists(dest):
        return
    log.info(f'Downloading {url[:80]}...')
    urllib.request.urlretrieve(url, dest)
    log.info(f'Downloaded: {dest}')


def get_duration(path):
    r = run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', path])
    return float(r.stdout.decode().strip())


def apply_speed_ramp_opencv(src_path, out_path, trim_start, trim_end,
                             out_fps, out_w, out_h,
                             slow=SLOW_SPEED, fast=FAST_SPEED, curve_pow=CURVE_POW):
    """
    Read frames from src_path between trim_start and trim_end.
    Apply exponential ramp from slow→fast.
    Write to out_path at out_fps.
    Returns: actual output duration in seconds.
    """
    cap = cv2.VideoCapture(src_path)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_src_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    src_duration = total_src_frames / src_fps

    # Clamp trim to actual duration
    trim_start = max(0.0, min(trim_start, src_duration - 0.1))
    trim_end   = max(trim_start + 0.1, min(trim_end, src_duration))
    clip_duration = trim_end - trim_start

    ratio = fast / slow
    ln_ratio = np.log(ratio)

    # Compute N (output frames) such that total input consumed ≈ clip_duration
    # total_input(N) = integral_0^N [slow * ratio^((i/N)^p) / out_fps] di
    # Solved numerically via binary search
    def total_input(N):
        N = max(1, int(N))
        s = 0.0
        for i in range(N):
            s += slow * ratio ** ((i / N) ** curve_pow) / out_fps
        return s

    N = 10
    while total_input(N) < clip_duration and N < 100000:
        N = int(N * 1.5)
    lo, hi = max(1, N // 3), N
    for _ in range(30):
        mid = (lo + hi) // 2
        if total_input(mid) < clip_duration:
            lo = mid
        else:
            hi = mid
    N = lo

    log.info(f'  Ramp: {clip_duration:.2f}s input → {N/out_fps:.2f}s output @ {out_fps}fps')

    # Determine output size from source if not specified
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    writer = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*'mp4v'), out_fps, (out_w, out_h))

    input_t = 0.0
    for i in range(N):
        abs_t = trim_start + input_t
        frame_idx = min(int(abs_t * src_fps), total_src_frames - 1)
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret:
            # duplicate last readable frame
            cap.set(cv2.CAP_PROP_POS_FRAMES, total_src_frames - 1)
            _, frame = cap.read()

        if frame is None:
            break

        # Resize/crop to output dimensions
        fh, fw = frame.shape[:2]
        if fw != out_w or fh != out_h:
            # Scale to fill then crop
            scale = max(out_w / fw, out_h / fh)
            nw, nh = int(fw * scale), int(fh * scale)
            frame = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)
            x = (nw - out_w) // 2
            y = (nh - out_h) // 2
            frame = frame[y:y+out_h, x:x+out_w]

        writer.write(frame)

        speed_now = slow * ratio ** ((i / N) ** curve_pow)
        input_t += speed_now / out_fps

    cap.release()
    writer.release()

    # Re-encode raw mp4v to h264 for clean timestamps
    h264_path = out_path.replace('.mp4', '_h264.mp4')
    run(['ffmpeg', '-y', '-i', out_path,
         '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
         '-r', str(out_fps), '-vsync', 'cfr', h264_path])
    os.replace(h264_path, out_path)

    return N / out_fps


def build_speed_ramp(recipe_path):
    with open(recipe_path) as f:
        recipe = json.load(f)

    output_path = recipe['outputPath']
    audio_path  = recipe['audioPath']
    fps    = recipe.get('fps', 30)
    width  = recipe.get('width', 1080)
    height = recipe.get('height', 1920)
    segments = recipe['segments']

    os.makedirs(TEMP_DIR, exist_ok=True)

    processed_parts = []

    for i, seg in enumerate(segments):
        url        = seg.get('firebaseUrl', '')
        src        = seg.get('src', '')
        trim_start = float(seg.get('trimStart', 0))
        trim_end   = float(seg.get('trimEnd', 5))

        # Download clip if needed
        clip_filename = f'sr_clip_{i}_{seg.get("clipId", str(i))}.mp4'
        clip_path = os.path.join(TEMP_DIR, clip_filename)
        if url:
            download_clip(url, clip_path)
        elif src:
            clip_path = src

        log.info(f'Segment {i}: {trim_start:.2f}s–{trim_end:.2f}s → exponential ramp')

        part_path = os.path.join(TEMP_DIR, f'sr_part_{i}.mp4')
        actual_duration = apply_speed_ramp_opencv(
            clip_path, part_path,
            trim_start, trim_end,
            fps, width, height
        )
        processed_parts.append(part_path)
        log.info(f'  Segment {i} done: {actual_duration:.2f}s output')

    if not processed_parts:
        print(json.dumps({'error': 'No segments processed'}))
        sys.exit(1)

    log.info(f'Concatenating {len(processed_parts)} parts...')

    list_file = os.path.join(TEMP_DIR, 'sr_concat_list.txt')
    with open(list_file, 'w') as f:
        for p in processed_parts:
            f.write(f"file '{p}'\n")

    concat_video = output_path.replace('.mp4', '_noaudio.mp4')
    run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', list_file,
         '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
         '-r', str(fps), '-vsync', 'cfr', concat_video])

    run(['ffmpeg', '-y',
         '-i', concat_video,
         '-i', audio_path,
         '-c:v', 'copy', '-c:a', 'aac', '-shortest',
         output_path])

    final_dur = get_duration(output_path)
    log.info(f'Done: {output_path} ({final_dur:.2f}s)')

    for p in processed_parts:
        if os.path.exists(p):
            os.unlink(p)
    if os.path.exists(list_file):
        os.unlink(list_file)
    if os.path.exists(concat_video):
        os.unlink(concat_video)

    print(json.dumps({
        'output': output_path,
        'duration': round(final_dur, 2),
        'segments': len(processed_parts)
    }))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: speed_ramp_builder.py <recipe.json>'}))
        sys.exit(1)
    build_speed_ramp(sys.argv[1])
