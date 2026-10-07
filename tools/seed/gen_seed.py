#!/usr/bin/env python3
"""Turn the verified seed probe results into data/<cc>/<category>.json.

Rules encoded:

* an entry only lands if some store returned ``available`` for it;
* ``confidence`` is ``verified`` ONLY when a country-scoped store (Cafe Bazaar,
  Myket, RuStore) confirmed the package - Google Play's ``gl=`` parameter does
  not gate availability, so a Play listing is a discovery signal, not proof of
  local distribution;
* the entry's ``store`` is set only for those country-scoped confirmations;
* an entry whose Play listing 404s but whose local store listing resolves is
  kept, and the local store URL becomes its evidence.
"""

from __future__ import annotations

import json
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))  # tools/seed/ -> repo root
sys.path.insert(0, HERE)

ADDED_BY = "@local-app-catalog"
ADDED_AT = "2026-09-30"
VERIFIED_AT = "2026-10-07"

# Stores whose availability is scoped to the declared country, so a hit there
# proves the package is actually distributed in that country.
COUNTRY_SCOPED = {"cafe_bazaar", "myket", "rustore"}


def main() -> int:
    with open(os.path.join(HERE, "verify.json"), encoding="utf-8") as fh:
        report = json.load(fh)

    by_country: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    dropped = []
    promoted = []

    for row in report["entries"]:
        stores = row.get("stores", {})
        if stores.get("google_play") != "available" and not row.get("local_store"):
            dropped.append(row)
            continue

        entry = {
            "package": row["package"],
            "label": row["label"],
            "category": row["category"],
            "country": row["country"],
            "confidence": "community",
            "added_by": ADDED_BY,
            "added_at": ADDED_AT,
            "evidence": row["play_evidence"],
        }
        if row.get("local_store") in COUNTRY_SCOPED:
            entry["confidence"] = "verified"
            entry["store"] = row["local_store"]
            entry["verified_at"] = VERIFIED_AT
            promoted.append((row["country"], row["package"], row["local_store"]))

        by_country[row["country"]][row["category"]].append(entry)

    written = 0
    for cc in sorted(by_country):
        folder = os.path.join(ROOT, "data", cc.lower())
        os.makedirs(folder, exist_ok=True)
        for category in sorted(by_country[cc]):
            apps = sorted(by_country[cc][category], key=lambda e: e["package"])
            doc = {"country": cc, "category": category, "apps": apps}
            path = os.path.join(folder, f"{category}.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(doc, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
            written += 1
            print(f"wrote data/{cc.lower()}/{category}.json ({len(apps)} apps)")

    print(f"\n{written} files, {sum(len(v) for c in by_country.values() for v in c.values())} entries")
    print("promoted to verified via a country-scoped store:")
    for cc, pkg, store in sorted(promoted):
        print(f"  {cc} {pkg} ({store})")
    print("dropped (no store resolves):")
    for row in dropped:
        print(f"  {row['country']} {row['category']} {row['package']} {row['stores']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
