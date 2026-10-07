#!/usr/bin/env python3
"""Check whether a package is published/available in the declared country.

This is the single implementation of "store availability" in the project. The
Node CI validator shells out to this script with --json instead of duplicating
the logic, so there is exactly one source of truth for what a store told us.

Examples
--------
    # one package, country-scoped stores for IR
    python3 fetch/play_availability.py --package com.snapp.passenger --country IR --json

    # a specific store, and include worldwide stores
    python3 fetch/play_availability.py -p ir.divar -c IR --store cafe_bazaar --with-global

    # every entry in a catalog file
    python3 fetch/play_availability.py --from-catalog data/ir/banking.json --json

    # nightly: recheck only entries currently marked verified
    python3 fetch/play_availability.py --from-catalog data/ir/banking.json --only-verified --json

Exit codes
----------
    0  every requested check resolved to a definite answer -- available OR
       unavailable. A confirmed 404 is a result, not an inconclusive one.
    1  usage error
    2  at least one check came back unknown or errored: the store was blocked,
       rate-limited, or failed at the transport layer, so nothing was proven.

A definite "unavailable" therefore exits 0 by design. The Node validator
(tools/lib/availability.mjs) treats exit 2 as "inconclusive" and downgrades it
to a warning, so folding a confirmed 404 into exit 2 would silently turn real
falsification evidence into an advisory note.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from store_adapters import (  # noqa: E402
    ADAPTERS,
    STATUS_AVAILABLE,
    STATUS_ERROR,
    STATUS_UNAVAILABLE,
    STATUS_UNKNOWN,
    authoritative_for,
    for_country,
    get,
)


def load_catalog_entries(path: str) -> tuple[dict, list[dict]]:
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    if not isinstance(doc, dict) or "apps" not in doc:
        raise SystemExit(f"{path}: not a catalog file (missing 'apps')")
    return doc, doc["apps"]


def run_checks(jobs: list[tuple[str, str, str]]) -> list[dict]:
    """jobs: (package, country, store_id) -> result dicts, order preserved."""

    def one(job):
        package, country, store_id = job
        return get(store_id).check(package, country).to_dict()

    with ThreadPoolExecutor(max_workers=8) as pool:
        return list(pool.map(one, jobs))


def main(argv: list[str] | None = None) -> int:
    class Parser(argparse.ArgumentParser):
        """argparse exits 2 for usage errors, which collides with the documented
        "a check was inconclusive" exit code. Usage errors exit 1 instead."""

        def error(self, message):
            self.print_usage(sys.stderr)
            sys.stderr.write(f"{self.prog}: error: {message}\n")
            raise SystemExit(1)

    ap = Parser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-p", "--package", action="append", default=[], help="package id (repeatable)")
    ap.add_argument("-c", "--country", help="ISO 3166-1 alpha-2 country code")
    ap.add_argument("-s", "--store", action="append", default=[], help="store adapter id (repeatable)")
    ap.add_argument("--from-catalog", help="check every app in this catalog file")
    ap.add_argument("--only-verified", action="store_true", help="with --from-catalog, only confidence=verified")
    ap.add_argument("--with-global", action="store_true", help="also query worldwide stores (Play, APKPure, F-Droid)")
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    if args.store:
        for store_id in args.store:
            if store_id not in ADAPTERS:
                ap.error(f"unknown store adapter: {store_id} (known: {', '.join(sorted(ADAPTERS))})")

    jobs: list[tuple[str, str, str]] = []
    country = args.country.upper() if args.country else None
    entries: list[dict] = []

    if args.from_catalog:
        doc, entries = load_catalog_entries(args.from_catalog)
        country = country or doc.get("country")
        if args.only_verified:
            entries = [e for e in entries if e.get("confidence") == "verified"]
        packages = [e["package"] for e in entries]
    else:
        packages = args.package

    if not packages:
        ap.error("nothing to check: pass --package or --from-catalog")
    if not country:
        ap.error("--country is required (or use a catalog file that declares one)")

    stores = args.store or [a.id for a in for_country(country, include_global=args.with_global)]
    if not stores:
        ap.error(f"no store adapters available for {country}")

    for package in packages:
        for store_id in stores:
            adapter = get(store_id)
            if not adapter.supports_country(country) and not args.store:
                continue
            jobs.append((package, country, store_id))

    results = run_checks(jobs)

    # a package is available if ANY queried store that can be checked says so;
    # authoritative stores are preferred when reporting the deciding store.
    by_package: dict[str, list[dict]] = {}
    for r in results:
        by_package.setdefault(r["package"], []).append(r)

    verdicts = []
    for package, rs in by_package.items():
        available = [r for r in rs if r["status"] == STATUS_AVAILABLE]
        authoritative = [r for r in available if ADAPTERS[r["store"]].authoritative]
        if authoritative:
            status, deciding = STATUS_AVAILABLE, authoritative[0]
        elif available:
            status, deciding = STATUS_AVAILABLE, available[0]
        elif any(r["status"] == STATUS_UNAVAILABLE for r in rs):
            status, deciding = STATUS_UNAVAILABLE, next(r for r in rs if r["status"] == STATUS_UNAVAILABLE)
        elif any(r["status"] == STATUS_ERROR for r in rs):
            status, deciding = STATUS_ERROR, next(r for r in rs if r["status"] == STATUS_ERROR)
        else:
            status, deciding = STATUS_UNKNOWN, rs[0]
        verdicts.append(
            {
                "package": package,
                "country": country,
                "status": status,
                "authoritative": any(ADAPTERS[r["store"]].authoritative for r in available),
                "confirmed_by": deciding["store"],
                "evidence": deciding.get("evidence"),
                "detail": deciding.get("detail"),
                "checks": rs,
            }
        )

    summary = {
        s: sum(1 for v in verdicts if v["status"] == s)
        for s in (STATUS_AVAILABLE, STATUS_UNAVAILABLE, STATUS_UNKNOWN, STATUS_ERROR)
    }
    payload = {
        "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "country": country,
        "stores": stores,
        "authoritative_stores": [a.id for a in authoritative_for(country)],
        "summary": summary,
        "verdicts": verdicts,
    }

    if args.json:
        json.dump(payload, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    elif not args.quiet:
        print(f"{country}: {summary}")
        for v in verdicts:
            mark = {
                STATUS_AVAILABLE: "OK  ",
                STATUS_UNAVAILABLE: "MISS",
                STATUS_UNKNOWN: "??? ",
                STATUS_ERROR: "ERR ",
            }[v["status"]]
            print(f"  {mark} {v['package']:<44} via {v['confirmed_by']:<12} {v['detail'] or ''}")

    return 0 if summary[STATUS_ERROR] == 0 and summary[STATUS_UNKNOWN] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
