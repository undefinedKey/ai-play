#!/usr/bin/env python3
"""Restore only world SQLite files; retain failed data. --root uses an isolated installation layout."""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import re
import sqlite3
import tarfile
import tempfile

NAMES = ("world.sqlite", "world.sqlite-wal", "world.sqlite-shm")

def check_database(path):
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise RuntimeError("SQLite integrity check failed")
        json.loads(db.execute("SELECT payload FROM world_state WHERE id=1").fetchone()[0])

def contained(path, parent):
    if path.is_symlink() or not path.resolve().is_relative_to(parent.resolve()):
        raise ValueError("Release path escapes installation layout")

def restore(archive, stamp, root=Path("/")):
    root = root.resolve()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", stamp):
        raise ValueError("Invalid release stamp")
    data, backups = root / "var/lib/ai-plaza", root / "var/backups/ai-plaza"
    archive = Path(archive)
    for path in (data, backups):
        contained(path, root)
        if not path.is_dir(): raise ValueError("Missing installation directory")
    contained(archive, backups)
    if archive.parent.resolve() != backups.resolve() or not archive.is_file():
        raise ValueError("Backup must be in the installation backup directory")
    failed = backups / ("failed-data-" + stamp)
    if failed.exists() or failed.is_symlink(): raise ValueError("Failed-data destination already exists")
    for name in NAMES: contained(data / name, data)
    with tempfile.TemporaryDirectory(prefix="restore-world-", dir=backups) as directory:
        stage, metadata = Path(directory), {}
        with tarfile.open(archive, "r:gz") as source:
            for name in NAMES:
                members = [m for m in source.getmembers() if m.name == "var/lib/ai-plaza/" + name]
                if len(members) > 1: raise ValueError("Duplicate SQLite archive member")
                if not members:
                    if name == "world.sqlite": raise ValueError("World database missing from backup")
                    continue
                member = members[0]
                if not member.isfile(): raise ValueError("SQLite member is not a regular file")
                (stage / name).write_bytes(source.extractfile(member).read())
                metadata[name] = member
        check_database(stage / "world.sqlite")
        # Validate before moving anything. Unknown archive members are never extracted.
        failed.mkdir(mode=0o700)
        for name in NAMES:
            current = data / name
            if current.exists(): current.replace(failed / name)
        for name, member in metadata.items():
            target = data / name
            (stage / name).replace(target)
            target.chmod(member.mode & 0o777)
            if hasattr(os, "chown"): os.chown(target, member.uid, member.gid)
        check_database(data / "world.sqlite")
    return {"world_database_restored": True, "failed_data": str(failed), "sqlite_integrity": "ok"}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("stamp")
    parser.add_argument("--root", type=Path, default=Path("/"))
    args = parser.parse_args()
    print(json.dumps(restore(args.archive, args.stamp, args.root)))
