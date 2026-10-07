"""Cafe Bazaar adapter - the primary Iranian Android store.

Measured behaviour (2026-10): GET https://cafebazaar.ir/app/<pkg>
    200 -> listing exists   (a nonexistent control package returns 404)
    404 -> not published

The public JSON API (api.cafebazaar.ir/rest-v1/process/AppDetailsRequest) answers
400 to anonymous callers, so the storefront HTML is the reliable signal.
Bazaar only serves Iran, so a positive result is country-proof.
"""

from __future__ import annotations

from .base import SCOPE_COUNTRY, StoreAdapter
from .http import fetch
from .listings import parse_listings

# Measured 2026-10 from this runner (datacenter IP, unblocked):
#   /lists/<slug>  -> 200, server-rendered app anchors with labels
#                     (al-ebanking alone carried 24 banking apps)
#   /app/<pkg>     -> the availability check's URL scheme
#   /pages/list~app-category~app-categories -> a JS shell: 200 but no app
#                     links in the HTML, so category *enumeration* needs a
#                     different surface; editorial lists are the measured one.


class CafeBazaarAdapter(StoreAdapter):
    id = "cafe_bazaar"
    display_name = "Cafe Bazaar"
    countries = ["IR"]
    scope = SCOPE_COUNTRY
    authoritative = True
    resolve_by = "package"
    CATEGORY_SOURCES = {"banking": "al-ebanking"}

    def check(self, package: str, country: str):
        res = fetch(f"https://cafebazaar.ir/app/{package}")
        return self._classify_html(res, package, country, require_package_in_body=True)

    def listings(self, source: str, country: str):
        """Nominate apps from a Bazaar editorial list page (source = slug).

        Bazaar serves Iran only, so every hit is a near-certain local app -
        the reverse of the Play-search crawl, which nominates one local app
        among global confusables.
        """
        res = fetch(f"https://cafebazaar.ir/lists/{source}")
        if res.status != 200:
            raise RuntimeError(f"cafebazaar list {source!r} failed (HTTP {res.status or res.error})")
        return parse_listings(
            res.body, evidence_base="https://cafebazaar.ir/app", source=source, country=country
        )
