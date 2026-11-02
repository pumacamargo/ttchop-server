"""Analiza los cortes de un video de referencia y saca un frame por intervalo.

Uso:
    python analyze_ref_shots.py <video> <dir_salida> [umbral=0.27]

Corre en la **PC (PumaDeskAsus)** con ffmpeg/ffprobe: es el paso que lee el video
original (deteccion de cambio de escena) y deja los fotogramas de referencia.

Salida en <dir_salida>:
    intervals.json   intervalos candidatos (i, inicio, fin, duracion) + metadatos del video
    fNN.jpg          un frame representativo de cada intervalo, sacado en el PUNTO MEDIO
    sheet.jpg        hoja de contacto para inspeccion visual

Notas (pitfalls aprendidos):
- Los frames van al PUNTO MEDIO del intervalo, no al inicio: el primer frame tras un
  corte suele ser transicion y no representa la toma (verificado en el caso 02_blanket:
  el centro coincide con lo que se ve en el shot, el inicio no).
- La hoja de contacto se arma con **PIL**. La version vieja usaba
  `ffmpeg -pattern_type glob -i 'f*.jpg' -vf tile=...` y en algunas builds de ffmpeg
  `glob` no esta compilado: ahi el comando fallaba y el sheet.jpg quedaba sin generar,
  en silencio. Aqui se intenta PIL primero y, si no hay PIL, se usa ffmpeg **avisando**
  cuando falla (nunca se calla).
- Binarios: se toman de $FFMPEG / $FFPROBE si estan definidos; si no, de
  D:\\staging\\creator-av-audit\\bin\\ (PC Windows); si no, de `ffmpeg` / `ffprobe` del PATH.
"""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

WIN_BIN = Path(r'D:\staging\creator-av-audit\bin')
DEFAULT_THRESHOLD = '0.27'
SHEET_COLS = 4
SHEET_TILE_W = 200


def pick(env_name, win_name, fallback):
    """Resuelve un binario: env -> ruta Windows conocida -> PATH."""
    if os.environ.get(env_name):
        return os.environ[env_name]
    win = WIN_BIN / win_name
    if win.exists():
        return str(win)
    found = shutil.which(fallback)
    return found or fallback


FFMPEG = pick('FFMPEG', 'ffmpeg.exe', 'ffmpeg')
FFPROBE = pick('FFPROBE', 'ffprobe.exe', 'ffprobe')


def run(args):
    return subprocess.run(args, capture_output=True, text=True, errors='replace')


def mid_frames(video, outdir, intervals):
    """Extrae un frame en el punto medio de cada intervalo. Devuelve los que faltan."""
    missing = []
    for it in intervals:
        mid = it['start'] + (it['end'] - it['start']) / 2
        out = outdir / f"f{it['i']:02d}.jpg"
        r = run([FFMPEG, '-y', '-hide_banner', '-loglevel', 'error',
                 '-ss', f'{mid:.3f}', '-i', video, '-frames:v', '1', '-q:v', '3', str(out)])
        if r.returncode != 0 or not out.exists():
            missing.append(it['i'])
    return missing


def sheet_pil(intervals, outdir, out):
    """Hoja de contacto con PIL (4 columnas, tile 200 px). True si la escribio."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return False
    tiles = []
    for it in intervals:
        p = outdir / f"f{it['i']:02d}.jpg"
        if not p.exists():
            continue
        im = Image.open(p).convert('RGB')
        h = max(1, int(im.height * SHEET_TILE_W / im.width))
        im = im.resize((SHEET_TILE_W, h), Image.LANCZOS)
        mid = it['start'] + (it['end'] - it['start']) / 2
        tiles.append((im, f"f{it['i']:02d}  {it['start']:.2f}-{it['end']:.2f}s  ({mid:.2f})"))
    if not tiles:
        return False
    rows = (len(tiles) + SHEET_COLS - 1) // SHEET_COLS
    tile_h = max(im.height for im, _ in tiles)
    cap, pad = 14, 6
    width = SHEET_COLS * SHEET_TILE_W + (SHEET_COLS + 1) * pad
    height = rows * (tile_h + cap) + (rows + 1) * pad
    sheet = Image.new('RGB', (width, height), (15, 17, 21))
    draw = ImageDraw.Draw(sheet)
    for k, (im, label) in enumerate(tiles):
        r, c = divmod(k, SHEET_COLS)
        x = pad + c * (SHEET_TILE_W + pad)
        y = pad + r * (tile_h + cap + pad)
        sheet.paste(im, (x, y))
        draw.text((x + 2, y + im.height + 1), label, fill=(232, 234, 240))
    sheet.save(out, 'JPEG', quality=82, optimize=True)
    return True


def sheet_ffmpeg(outdir, out, n):
    """Respaldo: ffmpeg con -pattern_type glob (puede no estar compilado). True si ok."""
    cols = SHEET_COLS
    rows = (n + cols - 1) // cols
    r = run([FFMPEG, '-y', '-hide_banner', '-loglevel', 'error', '-pattern_type', 'glob',
             '-i', str(outdir / 'f*.jpg'), '-vf', f'scale={SHEET_TILE_W}:-1,tile={cols}x{rows}',
             '-frames:v', '1', str(out)])
    return r.returncode == 0 and out.exists() and out.stat().st_size > 0


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    video = sys.argv[1]
    outdir = Path(sys.argv[2])
    thr = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_THRESHOLD
    outdir.mkdir(parents=True, exist_ok=True)

    probe = run([FFPROBE, '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                 'stream=width,height,r_frame_rate,nb_frames', '-show_entries',
                 'format=duration', '-of', 'json', video])
    meta = json.loads(probe.stdout or '{}')
    st = (meta.get('streams') or [{}])[0]
    dur = float((meta.get('format') or {}).get('duration', 0.0))

    p = run([FFMPEG, '-hide_banner', '-i', video, '-vf', f"select='gt(scene,{thr})',showinfo",
             '-f', 'null', '-'])
    cuts = sorted({round(float(m.group(1)), 3)
                   for m in re.finditer(r'pts_time:([0-9.]+)', p.stderr or '')})

    bounds = [0.0] + cuts + [round(dur, 3)]
    intervals = [{'i': i + 1, 'start': bounds[i], 'end': bounds[i + 1],
                  'dur': round(bounds[i + 1] - bounds[i], 3)} for i in range(len(bounds) - 1)]

    missing = mid_frames(video, outdir, intervals)

    sheet = outdir / 'sheet.jpg'
    sheet_ok = sheet_pil(intervals, outdir, sheet)
    sheet_how = 'PIL'
    if not sheet_ok:
        print('AVISO: sin PIL, se intenta la hoja de contacto con ffmpeg -pattern_type glob '
              '(no compilado en todas las builds)', file=sys.stderr)
        sheet_ok = sheet_ffmpeg(outdir, sheet, len(intervals))
        sheet_how = 'ffmpeg-glob'
    if not sheet_ok:
        print(f'AVISO: no se pudo generar la hoja de contacto {sheet} '
              f'(revisa PIL / ffmpeg -pattern_type glob); los fNN.jpg SI estan', file=sys.stderr)

    json.dump({'video': video, 'w': st.get('width'), 'h': st.get('height'),
               'fps': st.get('r_frame_rate'), 'duration': dur, 'threshold': float(thr),
               'n_intervals': len(intervals), 'intervals': intervals},
              open(outdir / 'intervals.json', 'w', encoding='utf-8'),
              ensure_ascii=False, indent=2)

    print(f'video={Path(video).name} {st.get("width")}x{st.get("height")} dur={dur:.3f} '
          f'cuts={len(cuts)} intervals={len(intervals)}')
    for it in intervals:
        print(f"  {it['i']:02d}  {it['start']:7.3f} -> {it['end']:7.3f}   {it['dur']:6.3f}s")
    print(f'intervals.json={outdir / "intervals.json"}')
    print(f'sheet={sheet} ({sheet_how})' if sheet_ok else f'sheet=NO GENERADA')
    if missing:
        print(f'FALLO: no se pudo extraer el frame de los intervalos {missing}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
