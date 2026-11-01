#!/usr/bin/env python3
"""nas/list_dir.py — list the contents of a NAS share directory (SMB).

CLI:  list_dir.py <remote_relpath>

Prints ``DIR``/``FILE`` entries with sizes, sorted by name.

Runs on vps-tools (where the pumassh credentials live). Requires ``smbclient``.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import connect, remote_path  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("remote_relpath", help="directory path, relative to the share")
    args = ap.parse_args()

    import smbclient  # lazy: lets --help work without the smbclient lib installed

    connect()
    try:
        target = remote_path(args.remote_relpath)
        print("LISTING:", target)
        for entry in sorted(smbclient.scandir(target), key=lambda e: e.name.lower()):
            try:
                info = entry.stat()
                kind = "DIR " if entry.is_dir() else "FILE"
                print(f"{kind} {info.st_size:>12} {entry.name}")
            except Exception as exc:  # noqa: BLE001 - report and keep listing
                print("ERR", entry.name, type(exc).__name__, exc)
    finally:
        smbclient.reset_connection_cache()


if __name__ == "__main__":
    main()
