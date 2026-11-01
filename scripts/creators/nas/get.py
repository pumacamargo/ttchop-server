#!/usr/bin/env python3
"""nas/get.py — download a file from the NAS share (SMB).

CLI:  get.py <remote_relpath> <local_outpath>

Streams the remote file to ``local_outpath`` and prints the byte count and SHA-256
so the copy can be verified against the source.

Runs on vps-tools (where the pumassh credentials live). Requires ``smbclient``.
"""
import argparse
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import connect, remote_path  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("remote_relpath", help="source path, relative to the share")
    ap.add_argument("local_outpath", help="local destination path")
    args = ap.parse_args()

    import smbclient  # lazy: lets --help work without the smbclient lib installed

    connect()
    try:
        source = remote_path(args.remote_relpath)
        parent = os.path.dirname(os.path.abspath(args.local_outpath))
        os.makedirs(parent, exist_ok=True)
        digest = hashlib.sha256()
        total = 0
        with smbclient.open_file(source, mode="rb") as remote, \
                open(args.local_outpath, "wb") as local:
            for block in iter(lambda: remote.read(1024 * 1024), b""):
                local.write(block)
                digest.update(block)
                total += len(block)
        print(f"OK {args.remote_relpath} -> {args.local_outpath} {total} {digest.hexdigest()}")
    finally:
        smbclient.reset_connection_cache()


if __name__ == "__main__":
    main()
