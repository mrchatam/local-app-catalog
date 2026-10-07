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


class CafeBazaarAdapter(StoreAdapter):
    id = "cafe_bazaar"
    display_name = "Cafe Bazaar"
    countries = ["IR"]
    scope = SCOPE_COUNTRY
    authoritative = True
    resolve_by = "package"

    def check(self, package: str, country: str):
        res = fetch(f"https://cafebazaar.ir/app/{package}")
        return self._classify_html(res, package, country, require_package_in_body=True)
