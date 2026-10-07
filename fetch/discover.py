#!/usr/bin/env python3
"""Nominate candidate local apps for each country/category via store search.

Discovery is a *nomination* step, never a publish step. Play search is
country-scoped, so native-language queries return locally relevant apps that
English queries miss - but the same page also returns global apps that merely
match the words, so everything this tool emits has to be confirmed by a curator
(and, ideally, by an authoritative country store) before it reaches data/.

Packages listed in data/global.json are dropped here so the known confusables
never even reach a reviewer's queue.

Examples
--------
    python3 fetch/discover.py --country TR --category banking
    python3 fetch/discover.py --all --out .scratch/candidates.json
    python3 fetch/discover.py --countries IR,RU --categories banking,rideshare

Exit codes
----------
    0  candidates were produced (possibly zero; failures are per-query warnings)
    2  usage error (bad flag, unknown store, unusable --workers)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from store_adapters import ADAPTERS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUERIES = os.path.join(ROOT, "fetch", "queries.json")
GLOBAL = os.path.join(ROOT, "data", "global.json")
INDEX = os.path.join(ROOT, "data", "index.json")
DEFAULT_CATEGORIES = ["banking", "government", "rideshare", "messaging"]


def load_global_packages() -> set[str]:
    try:
        with open(GLOBAL, encoding="utf-8") as fh:
            return {p["package"] for p in json.load(fh).get("packages", [])}
    except FileNotFoundError:
        return set()


def load_registry() -> dict:
    """The catalog registry (data/index.json): the set of countries and
    categories the catalog is contracted to carry.

    Fail closed with a readable message: a missing or broken index is a broken
    checkout, and a traceback from deep inside json is not a diagnosis.
    """
    try:
        with open(INDEX, encoding="utf-8") as fh:
            doc = json.load(fh)
        return {"countries": set(doc["countries"]), "categories": set(doc["categories"])}
    except FileNotFoundError:
        raise SystemExit(f"{INDEX}: not found; run from a full checkout of the repo") from None
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise SystemExit(f"{INDEX}: not a usable catalog registry ({exc})") from None


def selected_countries(args) -> list[str]:
    """Merge --country and --countries.

    They used to override each other silently: ``--countries IR --country TR``
    ran only IR and nobody could tell from the output. Both flags now add up;
    duplicates are dropped, first spelling wins.
    """
    out: list[str] = []
    tokens = [args.country]
    if args.countries:
        tokens.extend(args.countries.split(","))
    for token in tokens:
        if not token or not token.strip():
            continue
        code = token.strip().upper()
        if code not in out:
            out.append(code)
    return out


def selected_categories(args) -> list[str]:
    """Merge --category (repeatable) and --categories, defaulting to DEFAULT_CATEGORIES."""
    out: list[str] = []
    tokens = list(args.category)
    if args.categories:
        tokens.extend(args.categories.split(","))
    for token in tokens:
        name = token.strip()
        if name and name not in out:
            out.append(name)
    return out or list(DEFAULT_CATEGORIES)


def plan_all(matrix: dict, registry: dict) -> tuple[list[str], list[str]]:
    """Scope of --all: every query-matrix key the registry actually knows.

    The matrix is a discovery input, the registry is the catalog contract; a
    query key outside the registry would produce candidates no consumer reads,
    so --all is the intersection, not the union.
    """
    countries = sorted(set(matrix) & registry["countries"])
    categories = sorted({c for v in matrix.values() for c in v} & registry["categories"])
    return countries, categories


def build_jobs(matrix: dict, countries: list[str], categories: list[str]) -> list[tuple]:
    jobs = []
    for cc in countries:
        per_category = matrix.get(cc)
        if not per_category:
            print(f"warn: no discovery queries for {cc}", file=sys.stderr)
            continue
        for category in categories:
            for query in per_category.get(category, []):
                jobs.append((cc, category, query))
    return jobs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--country", help="one ISO country code (merged with --countries)")
    ap.add_argument("--category", action="append", default=[], help="category (repeatable; merged with --categories)")
    ap.add_argument("--countries", help="comma-separated country codes (merged with --country)")
    ap.add_argument("--categories", help="comma-separated categories (merged with --category)")
    ap.add_argument(
        "--all",
        action="store_true",
        help="every query-matrix country/category that is also in data/index.json",
    )
    ap.add_argument("--out", help="write candidates JSON here (default: stdout)")
    ap.add_argument("--store", default="google_play", help="search-capable adapter id")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args(argv)

    with open(QUERIES, encoding="utf-8") as fh:
        matrix = json.load(fh)["queries"]
    registry = load_registry()

    # The registry, not the query matrix, is the contract: a country or
    # category that data/index.json does not carry has no catalog to feed, so
    # accepting it here would be the G20 bug again on the Python side.
    if args.all:
        countries, categories = plan_all(matrix, registry)
        unknown = sorted(set(matrix) - set(countries))
        if unknown:
            print(f"warn: query-matrix countries not in data/index.json, skipped: {', '.join(unknown)}", file=sys.stderr)
    else:
        countries = selected_countries(args)
        categories = selected_categories(args)
        for code in countries:
            if code not in registry["countries"]:
                ap.error(f"unknown country: {code} (registered: {', '.join(sorted(registry['countries']))})")
        for name in categories:
            if name not in registry["categories"]:
                ap.error(f"unknown category: {name} (registered: {', '.join(sorted(registry['categories']))})")
    if not countries:
        ap.error("nothing to do: pass --country, --countries, or --all")

    # Reject bad flags here rather than letting a raw KeyError/ValueError escape
    # from deep inside the run: a usage mistake should print usage, not a
    # traceback a contributor has to read.
    if args.workers < 1:
        ap.error(f"--workers must be at least 1 (got {args.workers})")
    if args.store not in ADAPTERS:
        ap.error(f"unknown store adapter: {args.store} (known: {', '.join(sorted(ADAPTERS))})")
    adapter = ADAPTERS[args.store]
    if not hasattr(adapter, "search"):
        ap.error(f"store adapter {args.store!r} does not support search discovery")

    jobs = build_jobs(matrix, countries, categories)
    globals_ = load_global_packages()

    def run(job):
        cc, category, query = job
        try:
            return [dict(hit, category=category) for hit in adapter.search(query, cc)]
        except Exception as exc:  # noqa: BLE001 - a failed query must not kill the run
            print(f"warn: {cc}/{category} query {query!r} failed: {exc}", file=sys.stderr)
            return []

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        batches = list(pool.map(run, jobs))

    by_key: dict[tuple[str, str], dict] = {}
    dropped = 0
    for hits in batches:
        for hit in hits:
            if hit["package"] in globals_:
                dropped += 1
                continue
            key = (hit["country"], hit["package"])
            entry = by_key.setdefault(
                key,
                {
                    "package": hit["package"],
                    "label": hit["label"],
                    "country": hit["country"],
                    "categories": [],
                    "queries": [],
                    "evidence": hit["evidence"],
                },
            )
            if hit["category"] not in entry["categories"]:
                entry["categories"].append(hit["category"])
            if hit["query"] not in entry["queries"]:
                entry["queries"].append(hit["query"])

    grouped: dict[str, dict[str, list[dict]]] = {}
    for entry in by_key.values():
        cc = entry["country"]
        grouped.setdefault(cc, {})
        for category in entry["categories"]:
            grouped[cc].setdefault(category, []).append(entry)

    payload = {
        "source": args.store,
        "queries_run": len(jobs),
        "global_dropped": dropped,
        "candidate_count": len(by_key),
        "candidates": grouped,
    }

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, sort_keys=True)
        print(
            f"{len(by_key)} candidates across {len(grouped)} countries "
            f"({len(jobs)} queries, {dropped} global packages dropped) -> {args.out}"
        )
    else:
        json.dump(payload, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
