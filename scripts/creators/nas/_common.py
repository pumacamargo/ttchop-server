"""Shared helpers for the NAS (SMB) scripts.

These scripts run on vps-tools, which is where the pumassh credential file lives
(``/root/.config/pumassh/polaris.json`` by default; override with ``PUMA_CRED_FILE``).
The NAS endpoint defaults to the ``Projects`` share and can be overridden with
``NAS_SERVER`` / ``NAS_SHARE``.

Security invariants (kept from the original ``nas_*.py`` one-offs):
  * the credential file is opened with ``O_NOFOLLOW`` and validated to be a regular
    file owned by the current uid with no group/other permission bits;
  * credentials are never printed;
  * uploads are verified by re-reading the remote file and comparing SHA-256.
"""
import hashlib
import json
import os
import stat
import sys

DEFAULT_CRED_FILE = "/root/.config/pumassh/polaris.json"
DEFAULT_SERVER = "100.91.254.118"
DEFAULT_SHARE = "Projects"


def load_credentials():
    """Read and validate the SMB credential file. Returns the parsed dict."""
    path = os.environ.get("PUMA_CRED_FILE", DEFAULT_CRED_FILE)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "r", encoding="utf-8") as handle:
        info = os.fstat(handle.fileno())
        if (not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) & 0o077):
            raise RuntimeError(f"Unsafe credential permissions on {path}")
        return json.load(handle)


def server_name():
    return os.environ.get("NAS_SERVER", DEFAULT_SERVER)


def share_root():
    return "\\\\%s\\%s" % (server_name(), os.environ.get("NAS_SHARE", DEFAULT_SHARE))


def remote_path(rel):
    """Join a share-relative path onto the UNC root (always with a leading '\\')."""
    return share_root() + "\\" + rel.lstrip("\\/")


def connect():
    """Register an encrypted SMB session. Returns the cleared credentials dict."""
    import smbclient  # imported lazily so --help works without the lib
    creds = load_credentials()
    smbclient.register_session(
        server_name(), username=creds["username"], password=creds["password"],
        encrypt=True, connection_timeout=25,
    )
    creds.clear()
    return creds


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path, block=1024 * 1024):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(block), b""):
            digest.update(chunk)
    return digest.hexdigest()


def die(message, code=1):
    print(message, file=sys.stderr)
    sys.exit(code)
