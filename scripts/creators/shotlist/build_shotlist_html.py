"""Genera la lista HTML de shots a grabar (con GIF animado de referencia) para un caso.

Uso:
    python build_shotlist_html.py <dir_shots> <salida.html> [caso] [shotlist.json] [prefijo_gifs=shots/]

Corre en **vps-tools** (necesita PIL para incrustar las miniaturas).

<dir_shots> necesita:
    intervals.json   cortes + duraciones (lo escribe analyze_ref_shots.py)
    fNN.jpg          un frame por intervalo, sacado en el PUNTO MEDIO del shot
    sNN.gif          preview animado (opcional; lo escribe make_shot_gifs.py)
    shotlist.json    descripciones + grupos (por defecto se busca AQUI; ver abajo)

`shotlist.json` (el 4o argumento lo puede apuntar a otro sitio, p. ej. el
`shotlist.example.json` del repo):

{
  "case": "02_blanket",
  "by_frame": {
    "1": {"enc": "Primer plano", "ang": "Cenital", "act": "El peluche en el sillon"},
    "11": {"enc": "Detalle", "act": "Otra cobija: pelo largo gris (comparar)"}
  },
  "groups": [
    {"id": "A", "name": "La cobija", "hint": "presentacion, sin manos", "frames": [1, 2, 15]}
  ]
}

- `by_frame` va **SIEMPRE por indice de frame del original (fNN)**, nunca por el numero
  posterior a fusionar cortes falsos: fusionar renumera y corre las descripciones de
  lugar (nos paso en 02_blanket: el corte falso de 0.03 s hizo que un shot se describiera
  con la toma siguiente, "celular" donde habia un libro).
- `groups[].frames` tambien usa indices de frame del original. Un frame que no este en
  ningun grupo queda en el grupo "?" (se lista igual, al final).
- `ang` (angulo) es opcional y NO se pinta: las tarjetas llevan poco texto
  (`duracion · encuadre` + una linea de accion). Se conserva en el JSON como dato.

Salida: HTML con las miniaturas incrustadas en base64 (asi el archivo suelto se lee sin
conexion) y, si hay GIFs sNN.gif, el preview animado se carga por ruta relativa
(`prefijo_gifs`, por defecto `shots/`) con la miniatura incrustada como respaldo via
`onerror`. NO incrustar los GIFs: 25 de ellos llevan la pagina a >10 MB.
"""
import base64
import io
import json
import sys
from pathlib import Path

from PIL import Image

FALSE_CUT = 0.15          # intervalos mas cortos que esto son cortes falsos: se fusionan
THUMB_W = 200             # imagenes pequenas (lo pidio asi Arturo)
THUMB_Q = 66
DEF_GIF_PREFIX = 'shots/'

TEMPLATE = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shots a grabar — %%CASE%%</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:18px 12px 48px; background:#0f1115; color:#e8eaf0;
         font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:880px; margin:0 auto; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:#98a2b3; font-size:12.5px; margin-bottom:14px; }
  .sub b { color:#e8eaf0; }
  .switch { display:inline-flex; background:#171a21; border:1px solid #242936;
            border-radius:999px; padding:3px; margin-bottom:16px; }
  .switch button { border:0; background:transparent; color:#98a2b3; font:600 13px inherit;
                   padding:7px 16px; border-radius:999px; cursor:pointer; }
  .switch button.on { background:#e2001a; color:#fff; }
  h2 { font-size:14px; margin:20px 0 1px; }
  h2 .cnt { font-size:11.5px; color:#98a2b3; font-weight:400; margin-left:6px; }
  .hint { font-size:11.5px; color:#8b93a7; margin-bottom:8px; }
  .grid { display:grid; gap:9px; grid-template-columns:repeat(auto-fill,minmax(138px,1fr)); }
  .shot { background:#171a21; border:1px solid #242936; border-radius:10px; overflow:hidden; }
  .pic { position:relative; background:#000; }
  .pic img { display:block; width:100%; height:auto; }
  .badge { position:absolute; top:5px; left:5px; background:#e2001a; color:#fff;
           font:700 11px/1 inherit; padding:3px 6px; border-radius:999px; }
  .body { padding:7px 8px 9px; }
  .meta { font-size:11px; color:#ffd166; font-weight:700; }
  .enc { color:#8b93a7; font-weight:400; }
  .act { font-size:12px; margin-top:3px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Shots a grabar — %%CASE%%</h1>
  <div class="sub"><b>%%N%% tomas</b> · %%TOTAL%%s · vertical 1080×1920 — el
    <b>número rojo</b> es su lugar en la edición</div>
  <div class="switch">
    <button id="b-grp" class="on" onclick="render('grp')">Agrupado</button>
    <button id="b-ord" onclick="render('ord')">Por orden</button>
  </div>
  <div id="out"></div>
</div>
<script>
const SHOTS = %%SHOTS%%;
const THUMBS = %%THUMBS%%;
const GIFPREFIX = %%GIFPREFIX%%;
const GMETA = %%GMETA%%;
const GORDER = %%GORDER%%;

function card(s) {
  const fallback = s.gif ? ` onerror="this.onerror=null;this.src=THUMBS[${s.n}]"` : '';
  const src = s.gif ? GIFPREFIX + s.gif : THUMBS[s.n];
  return `<article class="shot">
    <div class="pic"><img loading="lazy" src="${src}"${fallback} alt="shot ${s.n}"><span class="badge">${s.n}</span></div>
    <div class="body">
      <div class="meta">${s.dur.toFixed(2)}s <span class="enc">· ${s.enc}</span></div>
      <div class="act">${s.act}</div>
    </div>
  </article>`;
}

function render(mode) {
  document.getElementById('b-grp').className = mode === 'grp' ? 'on' : '';
  document.getElementById('b-ord').className = mode === 'ord' ? 'on' : '';
  const out = document.getElementById('out');
  if (mode === 'ord') {
    out.innerHTML = `<div class="grid">${SHOTS.map(card).join('')}</div>`;
    return;
  }
  out.innerHTML = GORDER.map(g => {
    const items = SHOTS.filter(s => s.grp === g);
    if (!items.length) return '';
    const secs = items.reduce((a, s) => a + s.dur, 0).toFixed(1);
    return `<section><h2>${g} · ${GMETA[g].name}
      <span class="cnt">${items.length} tomas · ${secs}s</span></h2>
      <div class="hint">${GMETA[g].hint}</div>
      <div class="grid">${items.map(card).join('')}</div></section>`;
  }).join('');
}

render('grp');
</script>
</body>
</html>
"""


def thumb(path, width=THUMB_W, quality=THUMB_Q):
    """Miniatura JPEG en base64: respaldo embebido para cuando el GIF no carga."""
    im = Image.open(path).convert('RGB')
    height = int(im.height * width / im.width)
    im = im.resize((width, height), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=quality, optimize=True)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()


def merge_false_cuts(intervals):
    """Fusiona los cortes falsos (<FALSE_CUT) con el anterior (igual que make_shot_gifs.py)."""
    merged = []
    for it in intervals:
        if merged and it['dur'] < FALSE_CUT:
            merged[-1]['end'] = it['end']
            merged[-1]['dur'] = round(merged[-1]['end'] - merged[-1]['start'], 3)
        else:
            merged.append(dict(it))
    return merged


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    shots_dir = Path(sys.argv[1])
    out = Path(sys.argv[2])
    plan_path = Path(sys.argv[4]) if len(sys.argv) > 4 else (shots_dir / 'shotlist.json')
    gif_prefix = sys.argv[5] if len(sys.argv) > 5 else DEF_GIF_PREFIX

    plan = {}
    if plan_path.exists():
        plan = json.loads(plan_path.read_text(encoding='utf-8'))
    else:
        print(f'AVISO: no existe {plan_path}: la pagina sale con descripciones genericas',
              file=sys.stderr)
    case = sys.argv[3] if len(sys.argv) > 3 else (plan.get('case') or shots_dir.parent.name)
    by_frame = {int(k): v for k, v in (plan.get('by_frame') or {}).items()}

    data = json.loads((shots_dir / 'intervals.json').read_text(encoding='utf-8'))
    merged = merge_false_cuts(data['intervals'])

    shots = []
    for n, it in enumerate(merged, 1):
        frame = int(it['i'])            # indice del frame del ORIGINAL: clave de las descripciones
        info = by_frame.get(frame) or {}
        pic = shots_dir / f'f{frame:02d}.jpg'
        gif = f's{n:02d}.gif'
        shots.append({
            'n': n,
            'fr': frame,
            'dur': round(it['dur'], 2),
            'enc': info.get('enc', 'Toma'),
            'act': info.get('act', f'Intervalo {frame} del original'),
            'img': thumb(pic) if pic.exists() else '',
            'gif': gif if (shots_dir / gif).exists() else '',
        })
        if info.get('ang'):                 # dato del caso; no se pinta (tarjetas pequenas)
            shots[-1]['ang'] = info['ang']

    groups = plan.get('groups') or [{'id': '?', 'name': 'Todas las tomas', 'hint': 'sin agrupar',
                                     'frames': [s['fr'] for s in shots]}]
    grp_of = {}
    for g in groups:
        for fr in g.get('frames', []):
            grp_of[int(fr)] = g['id']
    for s in shots:
        s['grp'] = grp_of.get(s['fr'], '?')

    gmeta = {g['id']: {'name': g.get('name', ''), 'hint': g.get('hint', '')} for g in groups}
    gorder = [g['id'] for g in groups]
    if any(s['grp'] == '?' for s in shots) and '?' not in gmeta:
        gmeta['?'] = {'name': 'Sin grupo', 'hint': 'frames que no estan en shotlist.json'}
        gorder.append('?')

    total = round(sum(s['dur'] for s in shots), 1)
    missing_img = [s['fr'] for s in shots if not s['img']]
    gifs = sum(1 for s in shots if s['gif'])

    html = (TEMPLATE.replace('%%CASE%%', case)
                    .replace('%%N%%', str(len(shots)))
                    .replace('%%TOTAL%%', f'{total:.1f}')
                    .replace('%%SHOTS%%', json.dumps(shots))
                    .replace('%%THUMBS%%', json.dumps({str(s['n']): s['img'] for s in shots}))
                    .replace('%%GIFPREFIX%%', json.dumps(gif_prefix))
                    .replace('%%GMETA%%', json.dumps(gmeta))
                    .replace('%%GORDER%%', json.dumps(gorder)))
    out.write_text(html, encoding='utf-8')

    print(f'OK {out} tomas={len(shots)} grupos={len(gorder)} total={total}s '
          f'gifs={gifs} bytes={out.stat().st_size}')
    for g in gorder:
        items = [s for s in shots if s['grp'] == g]
        secs = sum(s['dur'] for s in items)
        print(f'  {g} {gmeta[g]["name"]}: {len(items)} tomas, {secs:.1f}s')
    if missing_img:
        print(f'AVISO: sin fNN.jpg para los frames {missing_img} (revisa {shots_dir})',
              file=sys.stderr)
    if gifs:
        print(f'GIFs: {gifs}/{len(shots)} detectados; se sirven como {gif_prefix}sNN.gif '
              f'(subirlos junto al HTML, no se incrustan)')
    else:
        print('GIFs: ninguno detectado; la pagina usa solo las miniaturas embebidas')


if __name__ == '__main__':
    main()
