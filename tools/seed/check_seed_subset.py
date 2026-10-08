#!/usr/bin/env python3
"""Prove that every seeded entry is still present, unchanged, in data/.

The nightly pipeline and human curators legitimately GROW data/ beyond the
original seed, so "gen_seed.py reproduces data/ byte-for-byte" can no longer
hold. What must hold is the provenance guarantee behind that check:

    every entry gen_seed.py produces is present, deep-equal, in the tracked
    data/ tree.

A seeded entry that is missing, moved to another file, or has any field
changed (label, confidence, evidence, ...) fails. Extra entries in data/
that the seed never produced are expected and ignored.

Usage:  check_seed_subset.py SEED_DIR DATA_DIR

SEED_DIR is a freshly regenerated data/ tree (gen_seed.py run against the
committed verify.json); DATA_DIR is the tracked tree under review.
"""

from __future__ import annotations

import json
import os
import sys


def load_apps(path: str) -> dict[str, dict]:
    """Return {package: app} for one data file, refusing duplicate packages."""
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    apps: dict[str, dict] = {}
    for app in doc.get("apps", []):
        pkg = app["package"]
        if pkg in apps:
            raise SystemExit(f"ERROR: duplicate package {pkg} in {path}")
        apps[pkg] = app
    return apps


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 64
    seed_dir, data_dir = argv[1], argv[2]

    problems: list[str] = []
    checked = 0

    for root, _dirs, files in os.walk(seed_dir):
        for name in sorted(files):
            if not name.endswith(".json"):
                continue
            seed_path = os.path.join(root, name)
            rel = os.path.relpath(seed_path, seed_dir)
            tracked_path = os.path.join(data_dir, rel)
            if not os.path.exists(tracked_path):
                problems.append(f"{rel}: seeded file is missing from data/")
                continue
            tracked = load_apps(tracked_path)
            for pkg, seed_app in load_apps(seed_path).items():
                checked += 1
                if pkg not in tracked:
                    problems.append(f"{rel}: seeded entry {pkg} is missing from data/")
                elif tracked[pkg] != seed_app:
                    problems.append(f"{rel}: seeded entry {pkg} drifted from its provenance")

    print(f"seed proof: {checked} seeded entries checked against {data_dir}")
    if problems:
        print(f"\n{len(problems)} problem(s):")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("seed proof OK: every seeded entry is present and unchanged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
