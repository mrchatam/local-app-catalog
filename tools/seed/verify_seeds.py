#!/usr/bin/env python3
"""Verify every seed candidate against its stores before it reaches data/.

Prints one line per (country, category, package) with the Play status, the
country-scoped store status where one exists, and whether the package id was
already harvested from a country-gated search (i.e. the label is real).
"""

from __future__ import annotations

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))  # tools/seed/ -> repo root
sys.path.insert(0, os.path.join(ROOT, "fetch"))
sys.path.insert(0, HERE)

from seed_spec import MINICHAT_CANDIDATES, SEEDS, UNVERIFIED_MAYBE  # noqa: E402
from store_adapters import ADAPTERS, for_country  # noqa: E402

LOCAL_STORES = {"IR": ["cafe_bazaar", "myket"], "RU": ["rustore"]}


def all_seeds():
    for cc, cats in SEEDS.items():
        for cat, apps in cats.items():
            for package, label in apps:
                yield cc, cat, package, label, True
    for cc, cats in UNVERIFIED_MAYBE.items():
        for cat, apps in cats.items():
            for package, label in apps:
                if package in {p for c in SEEDS.values() for a in c.values() for p, _ in a}:
                    continue
                yield cc, cat, package, label, False


def main() -> int:
    jobs = list(all_seeds())
    report = []

    def check(job):
        cc, cat, package, label, harvested = job
        row = {"country": cc, "category": cat, "package": package, "label": label, "harvested": harvested, "stores": {}}
        play = ADAPTERS["google_play"].check(package, cc)
        row["stores"]["google_play"] = play.status
        row["play_evidence"] = play.evidence
        for store_id in LOCAL_STORES.get(cc, []):
            res = ADAPTERS[store_id].check(package, cc)
            row["stores"][store_id] = res.status
            if res.status == "available":
                row["play_evidence"] = res.evidence
                row["local_store"] = store_id
        return row

    with ThreadPoolExecutor(max_workers=8) as pool:
        report = list(pool.map(check, jobs))

    def mini(package):
        return ADAPTERS["google_play"].check(package, "US").to_dict()

    with ThreadPoolExecutor(max_workers=5) as pool:
        minichat = list(pool.map(mini, MINICHAT_CANDIDATES))

    out = {"checked": len(report), "entries": report, "minichat": minichat}
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "verify.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)

    ok = 0
    for row in report:
        stores = " ".join(f"{k}={v}" for k, v in row["stores"].items())
        flag = "OK " if row["stores"]["google_play"] == "available" or row.get("local_store") else "MISS"
        if flag == "OK ":
            ok += 1
        print(f"{flag} {row['country']} {row['category']:11s} {row['package']:45s} {stores} {row['label']}")
    print(f"\n{ok}/{len(report)} resolve in at least one store")
    print("\nMiniChat candidates:")
    for res in minichat:
        print(f"  {res['status']:11s} {res['package']:35s} {res.get('evidence')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
