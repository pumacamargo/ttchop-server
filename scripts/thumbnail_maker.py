#!/usr/bin/env python3
"""
Genera una portada/thumbnail para TikTok desde un video.
Estilo hook: texto blanco, contorno negro grueso (8 dir), glow amarillo aditivo (#FFD700).

Uso:
  python3 thumbnail_maker.py <video_url_o_path> <texto> <output_path>

Ejemplo:
  python3 thumbnail_maker.py https://firebasestorage.../video.mp4 "Squishy Toy" /tmp/thumb.jpg
"""
import subprocess
import sys
import os
import urllib.request
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import numpy as np

FONT_PATH = "/tmp/cacho_inmotion/public/fonts/keinan/けいなん丸ポップ体JP/けいなん丸ポップ体JP.ttf"
W, H = 1080, 1920
SEEK_SEC = 2.0


def get_video(src, tmp_path):
    if src.startswith('http'):
        if not os.path.exists(tmp_path):
            urllib.request.urlretrieve(src, tmp_path)
    else:
        tmp_path = src
    return tmp_path


def extract_frame(video_path, frame_path, seek_sec=SEEK_SEC):
    subprocess.run([
        'ffmpeg', '-y', '-ss', str(seek_sec), '-i', video_path,
        '-frames:v', '1', '-q:v', '2', frame_path
    ], check=True, capture_output=True)


FONT_SIZE = 160
MAX_W = int(W * 0.82)
LINE_SPACING = 1.1


def wrap_text(text, font, max_width):
    """Word-wrap text into lines that fit within max_width."""
    words = text.split()
    lines = []
    current = ''
    tmp = ImageDraw.Draw(Image.new('RGBA', (W, H)))
    for word in words:
        test = (current + ' ' + word).strip()
        bb = tmp.textbbox((0, 0), test, font=font, anchor='lt')
        if (bb[2] - bb[0]) <= max_width:
            current = test
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def line_height(font):
    tmp = ImageDraw.Draw(Image.new('RGBA', (W, H)))
    bb = tmp.textbbox((0, 0), 'Ag', font=font, anchor='lt')
    return bb[3] - bb[1]


def add_glow(base_img, text, font, x, y):
    """Yellow glow via additive blending — works on any background color."""
    base_arr = np.array(base_img, dtype=np.float32)
    for radius, strength in [(80, 2.5), (45, 3.0), (20, 3.5)]:
        glow = Image.new('RGB', base_img.size, (0, 0, 0))
        d = ImageDraw.Draw(glow)
        d.text((x, y), text, font=font, fill=(255, 215, 0), anchor='mm')
        glow = glow.filter(ImageFilter.GaussianBlur(radius))
        glow_arr = np.array(glow, dtype=np.float32) * strength
        base_arr[:, :, 0] = np.clip(base_arr[:, :, 0] + glow_arr[:, :, 0], 0, 255)
        base_arr[:, :, 1] = np.clip(base_arr[:, :, 1] + glow_arr[:, :, 1], 0, 255)
        base_arr[:, :, 2] = np.clip(base_arr[:, :, 2] + glow_arr[:, :, 2], 0, 255)
    return Image.fromarray(base_arr.astype(np.uint8), 'RGBA')


def draw_outlined_text(draw, text, font, x, y):
    """White text, thick black outline in 16 directions."""
    OW = 18
    BLACK = (0, 0, 0, 255)
    WHITE = (255, 255, 255, 255)
    for dx, dy in [
        (-OW, -OW), (OW, -OW), (-OW, OW), (OW, OW),
        (-OW, 0), (OW, 0), (0, -OW), (0, OW),
        (-OW//2, -OW), (OW//2, -OW), (-OW//2, OW), (OW//2, OW),
        (-OW, -OW//2), (OW, -OW//2), (-OW, OW//2), (OW, OW//2),
    ]:
        draw.text((x + dx, y + dy), text, font=font, fill=BLACK, anchor='mm')
    draw.text((x, y), text, font=font, fill=WHITE, anchor='mm')


def make_thumbnail(video_src, text, out_path, seek_sec=SEEK_SEC):
    tmp_video = f'/tmp/thumb_video_{abs(hash(video_src))}.mp4'
    tmp_frame = f'/tmp/thumb_frame_{abs(hash(video_src))}.png'

    video_path = get_video(video_src, tmp_video)
    extract_frame(video_path, tmp_frame, seek_sec)

    img = Image.open(tmp_frame).convert('RGBA')
    img = img.resize((W, H), Image.LANCZOS)

    font = ImageFont.truetype(FONT_PATH, FONT_SIZE)
    lines = wrap_text(text, font, MAX_W)

    lh = int(line_height(font) * LINE_SPACING)
    total_h = lh * len(lines)
    cx = W // 2
    start_y = H // 2 - total_h // 2 + lh // 2

    for i, line in enumerate(lines):
        cy = start_y + i * lh
        img = add_glow(img, line, font, cx, cy)

    draw = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        cy = start_y + i * lh
        draw_outlined_text(draw, line, font, cx, cy)

    img.convert('RGB').save(out_path, 'JPEG', quality=95)
    print(f'Thumbnail: {out_path}')

    if os.path.exists(tmp_frame):
        os.unlink(tmp_frame)

    return out_path


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print('Uso: thumbnail_maker.py <video_url_o_path> <texto> <output_path>')
        sys.exit(1)
    make_thumbnail(sys.argv[1], sys.argv[2], sys.argv[3])
