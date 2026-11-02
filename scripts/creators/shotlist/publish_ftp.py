"""Cliente FTPS minimo para publicar en Lemon Sushi (lemonsushi.com/uploads/vps2).

Uso:
    python publish_ftp.py list    [dir_remoto]
    python publish_ftp.py put     <archivo_local> <dir_remoto>
    python publish_ftp.py putmany <dir_remoto> <archivo_local>...

Corre en **vps-tools** (ahi vive la credencial).

Credenciales: /root/.config/ftp/ftpAccess.txt (linea 1 usuario, linea 2 password),
leidas con O_NOFOLLOW y validando propietario/permisos. **Nunca se imprimen.**
Config: /root/.config/ftp/config.json (host, puerto, public_base_url).

Todo se restringe a ROOT (/public_html/uploads/vps2): cualquier ruta que se salga se
rechaza. Cada subida se verifica releyendo el archivo remoto y comparando SHA-256.
"""
import ftplib
import hashlib
import json
import os
import ssl
import stat
import sys
from pathlib import Path

CFG = '/root/.config/ftp/config.json'
CRED = '/root/.config/ftp/ftpAccess.txt'
ROOT = '/public_html/uploads/vps2'
DEF_BASE = 'https://lemonsushi.com/uploads/vps2'


def safe_lines(path):
    """Lee lineas de un archivo de credenciales sin seguir symlinks y validando permisos."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as h:
        i = os.fstat(h.fileno())
        if not (stat.S_ISREG(i.st_mode) and i.st_uid == os.getuid()
                and not (stat.S_IMODE(i.st_mode) & 0o077)):
            raise RuntimeError(f'permisos inseguros: {path}')
        return [ln.strip() for ln in h.read().splitlines() if ln.strip()]


def connect():
    """FTPS explicito (AUTH TLS + PROT P). Devuelve (ftp, cfg)."""
    cfg = json.loads(Path(CFG).read_text(encoding='utf-8'))
    host = cfg.get('host') or cfg.get('ftps_host') or 'server310.web-hosting.com'
    port = int(cfg.get('port') or 21)
    user, pwd = safe_lines(CRED)[:2]
    ftp = ftplib.FTP_TLS(context=ssl.create_default_context())
    ftp.connect(host, port, timeout=40)
    ftp.auth()
    ftp.login(user, pwd)
    ftp.prot_p()
    ftp.set_pasv(True)
    return ftp, cfg


def norm(remote_dir):
    """Normaliza y valida que la ruta remota quede dentro de ROOT."""
    p = os.path.normpath(remote_dir if remote_dir.startswith('/') else ROOT + '/' + remote_dir)
    if '..' in p.split('/'):
        raise SystemExit(f'ruta con ..: {p}')
    if not (p == ROOT or p.startswith(ROOT + '/')):
        raise SystemExit(f'fuera de la raiz autorizada: {p}')
    return p


def sha(data):
    return hashlib.sha256(data).hexdigest()


def base_url(cfg):
    return (cfg.get('public_base_url') or DEF_BASE).rstrip('/')


def ensure_dir(ftp, remote_dir):
    """Crea la jerarquia de carpetas dentro de ROOT si hace falta y se posiciona en ella."""
    ftp.cwd(ROOT)
    for part in remote_dir[len(ROOT):].strip('/').split('/'):
        if not part:
            continue
        try:
            ftp.cwd(part)
        except ftplib.error_perm:
            ftp.mkd(part)
            ftp.cwd(part)


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ('list', 'put', 'putmany'):
        sys.exit(__doc__)
    action = sys.argv[1]
    ftp, cfg = connect()
    try:
        if action == 'list':
            d = norm(sys.argv[2]) if len(sys.argv) > 2 else ROOT
            print('PWD', ftp.pwd())
            print(f'LIST {d}')
            try:
                ftp.cwd(d)
            except ftplib.error_perm as e:
                print('NO EXISTE:', e)
                return
            print(ftp.retrlines('LIST'))
            return

        if action == 'put':
            local, remote_dir = sys.argv[2], norm(sys.argv[3])
            data = Path(local).read_bytes()
            lh = sha(data)
            ensure_dir(ftp, remote_dir)
            name = os.path.basename(local)
            with open(local, 'rb') as f:
                ftp.storbinary('STOR ' + name, f)
            buf = bytearray()                       # lectura de vuelta
            ftp.retrbinary('RETR ' + name, buf.extend)
            ok = sha(bytes(buf)) == lh
            print(f'PUT {remote_dir}/{name} bytes={len(data)} sha256={lh} '
                  f'readback={"OK" if ok else "MISMATCH"}')
            print('URL', base_url(cfg) + remote_dir[len(ROOT):] + '/' + name)
            return

        if action == 'putmany':
            remote_dir = norm(sys.argv[2])
            locals_ = sys.argv[3:]
            if not locals_:
                sys.exit('putmany necesita al menos un archivo local')
            ensure_dir(ftp, remote_dir)
            ok_all = True
            for local in locals_:
                data = Path(local).read_bytes()
                lh = sha(data)
                name = os.path.basename(local)
                with open(local, 'rb') as f:
                    ftp.storbinary('STOR ' + name, f)
                buf = bytearray()
                ftp.retrbinary('RETR ' + name, buf.extend)
                ok = sha(bytes(buf)) == lh
                ok_all = ok_all and ok
                print(f'  {name} bytes={len(data)} readback={"OK" if ok else "MISMATCH"}')
            print(f'PUT {len(locals_)} archivos en {remote_dir} -> '
                  f'{"TODO OK" if ok_all else "HAY FALLOS"}')
            print('URL', base_url(cfg) + remote_dir[len(ROOT):] + '/')
            return
    finally:
        try:
            ftp.quit()
        except Exception:
            ftp.close()


if __name__ == '__main__':
    main()
