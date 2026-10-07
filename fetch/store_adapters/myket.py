"""Myket adapter - secondary Iranian Android store.

Myket's storefront has used a few URL shapes over time and its API moved, so the
adapter tries the known paths in order and stops at the first 200. Every path
that answers 404 leaves the status open; only when all paths answer 404 is the
package reported unavailable.
"""

from __future__ import annotations

from .base import SCOPE_COUNTRY, STATUS_UNAVAILABLE, StoreAdapter
from .http import fetch
from .listings import parse_listings

PATHS = (
    "https://myket.ir/app/{pkg}",
    "https://myket.ir/app/{pkg}/",
    "https://myket.ir/Apps/Details?packageName={pkg}",
)

# Measured 2026-10 from this runner: https://myket.ir/apps/<slug> is
# server-rendered with app anchors carrying title="..." labels (productivity
# alone carried 77 packages, including cab.snapp.passenger). Slugs follow
# Play-style names; the class-level map covers the catalog categories we
# could verify, and running an unmapped category fails with the measured
# list.


class MyketAdapter(StoreAdapter):
    id = "myket"
    display_name = "Myket"
    countries = ["IR"]
    scope = SCOPE_COUNTRY
    authoritative = True
    resolve_by = "package"
    CATEGORY_SOURCES = {
        "banking": "finance",
        "shopping": "shopping",
        "streaming": "video-players-and-editors",
        "messaging": "communication",
        "rideshare": "maps-and-navigation",
        "delivery": "maps-and-navigation",
    }

    def check(self, package: str, country: str):
        last = None
        for template in PATHS:
            res = fetch(template.format(pkg=package))
            result = self._classify_html(res, package, country, require_package_in_body=True)
            if result.status not in (STATUS_UNAVAILABLE,):
                return result
            last = result
        return last

    def listings(self, source: str, country: str):
        """Nominate apps from a Myket category page (source = slug)."""
        res = fetch(f"https://myket.ir/apps/{source}")
        if res.status != 200:
            raise RuntimeError(f"myket category {source!r} failed (HTTP {res.status or res.error})")
        return parse_listings(
            res.body, evidence_base="https://myket.ir/app", source=source, country=country
        )
