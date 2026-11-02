"""Recorta cada shot de un video de referencia y lo guarda como GIF animado (preview).

Uso:
    python make_shot_gifs.py <video_ref> <dir_shots> <dir_salida_gifs>
                             [ancho=180] [fps=6] [colores=64] [dither=bayer:bayer_scale=3]

Corre en **vps-tools** (necesita solo ffmpeg).

<dir_shots> es el mismo directorio que consume build_shotlist_html.py: necesita
intervals.json (lo escribe analyze_ref_shots.py).

Receta por defecto (medida, aprobada por Arturo): 180 px de ancho, 6 fps, 64 colores,
palettegen/paletteuse con `dither=bayer:bayer_scale=3`, `-loop 0` (bucle infinito).
Para 25 tomas de ~26 s de video vertical sale ~4 MB en total.

Los GIFs se numeran sNN.gif **igual que la lista HTML**: sobre los intervalos YA
fusionados (los cortes falsos <0.15 s se unen al anterior), de modo que sNN.gif es la
misma toma NN que muestra la pagina. Escribe ademas gifs.json con la metadata.

NO incrustar los GIFs en base64 dentro del HTML: 25 GIFs lo llevan a >10 MB. Se sirven
como archivos aparte junto al HTML y se referencian por ruta relativa con loading=lazy.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

FALSE_CUT = 0.15           # intervalos mas cortos que esto son cortes falsos: se fusionan
DEF_WIDTH = '180'
DEF_FPS = '6'
DEF_COLORS = '64'
DEF_DITHER = 'bayer:bayer_scale=3'


def ffmpeg_bin():
    return os.environ.get('FFMPEG') or shutil.which('ffmpeg') or 'ffmpeg'


def merge_false_cuts(intervals):
    """Fusiona los cortes falsos (<FALSE_CUT) con el intervalo anterior.

    Misma regla que build_shotlist_html.py: si divergen, la numeracion de los GIFs deja
    de coincidir con la de la pagina.
    """
    merged = []
    for it in intervals:
        if merged and it['dur'] < FALSE_CUT:
            merged[-1]['end'] = it['end']
            merged[-1]['dur'] = round(merged[-1]['end'] - merged[-1]['start'], 3)
        else:
            merged.append(dict(it))
    return merged


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    video = sys.argv[1]
    shots_dir = Path(sys.argv[2])
    outdir = Path(sys.argv[3])
    width = sys.argv[4] if len(sys.argv) > 4 else DEF_WIDTH
    fps = sys.argv[5] if len(sys.argv) > 5 else DEF_FPS
    colors = sys.argv[6] if len(sys.argv) > 6 else DEF_COLORS
    dither = sys.argv[7] if len(sys.argv) > 7 else DEF_DITHER
    outdir.mkdir(parents=True, exist_ok=True)
    ffmpeg = ffmpeg_bin()

    data = json.loads((shots_dir / 'intervals.json').read_text(encoding='utf-8'))
    merged = merge_false_cuts(data['intervals'])

    vf = (f'fps={fps},scale={width}:-1:flags=lanczos,split[a][b];'
          f'[a]palettegen=max_colors={colors}[p];'
          f'[b][p]paletteuse=dither={dither}')

    meta, failed = [], []
    for n, it in enumerate(merged, 1):
        name = f's{n:02d}.gif'
        out = outdir / name
        r = subprocess.run([ffmpeg, '-y', '-hide_banner', '-loglevel', 'error',
                            '-ss', f"{it['start']:.3f}", '-t', f"{it['dur']:.3f}",
                            '-i', video, '-vf', vf, '-loop', '0', str(out)],
                           capture_output=True, text=True)
        if r.returncode != 0 or not out.exists():
            failed.append(n)
            print(f'FALLO {name}: {(r.stderr or "").strip()[-300:]}', file=sys.stderr)
            continue
        meta.append({'n': n, 'fr': it['i'], 'start': round(it['start'], 3),
                     'end': round(it['end'], 3), 'dur': round(it['dur'], 3),
                     'file': name, 'bytes': out.stat().st_size})

    (outdir / 'gifs.json').write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')
    total = sum(m['bytes'] for m in meta)
    print(f'{len(meta)} gifs - {total / 1e6:.2f} MB - ancho {width}px - {fps} fps - '
          f'{colors} colores - dither={dither} - loop 0')
    for m in meta:
        print(f"  {m['n']:02d}  {m['start']:6.3f}-{m['end']:6.3f}  {m['dur']:5.2f}s  "
              f"{m['file']}  {m['bytes'] / 1024:6.1f} KB")
    print(f'gifs.json={outdir / "gifs.json"}')
    if failed:
        print(f'FALLO: {len(failed)} gifs sin generar: {failed}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
