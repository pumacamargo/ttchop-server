#!/usr/bin/env python3
"""nas/put.py — upload local files to a directory on the NAS share (SMB).

CLI:  put.py <remote_dir> <local_file> [<local_file> ...] [--force]

By default the upload FAILS if a remote file with the same name already exists
with different content. Pass ``--force`` to overwrite it (removes the remote file
first). Identical files are skipped. Every upload is verified by re-reading the
remote file and comparing SHA-256.

Runs on vps-tools (where the pumassh credentials live). Requires ``smbclient``.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import connect, die, remote_path, sha256_bytes  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("remote_dir", help="destination directory, relative to the share")
    ap.add_argument("files", nargs="+", help="local files to upload")
    ap.add_argument("--force", action="store_true",
                    help="overwrite a remote file that already exists with different content")
    args = ap.parse_args()

    import smbclient  # lazy: lets --help work without the smbclient lib installed

    for path in args.files:
        if not os.path.isfile(path):
            die(f"not a local file: {path}")

    connect()
    try:
        remote_dir = remote_path(args.remote_dir)
        if not smbclient.path.exists(remote_dir):
            smbclient.makedirs(remote_dir, exist_ok=True)
        for local in args.files:
            name = os.path.basename(local)
            target = remote_dir + "\\" + name
            with open(local, "rb") as handle:
                data = handle.read()
            local_hash = sha256_bytes(data)
            if smbclient.path.exists(target):
                with smbclient.open_file(target, "rb") as handle:
                    current = handle.read()
                if sha256_bytes(current) == local_hash:
                    print(f"SKIP identical {name}")
                    continue
                if not args.force:
                    die(f"Refusing to overwrite existing different file: {name} "
                        f"(use --force to replace it)")
                smbclient.remove(target)
                print(f"REMOVED previous {name}")
            with smbclient.open_file(target, "xb") as handle:
                handle.write(data)
            with smbclient.open_file(target, "rb") as handle:
                back = handle.read()
            assert sha256_bytes(back) == local_hash, f"readback mismatch {name}"
            print(f"PUT {name} {len(data)} {local_hash} readback=OK")
    finally:
        smbclient.reset_connection_cache()


if __name__ == "__main__":
    main()
