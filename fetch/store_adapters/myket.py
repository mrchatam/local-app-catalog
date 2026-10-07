"""Myket adapter - secondary Iranian Android store.

Myket's storefront has used a few URL shapes over time and its API moved, so the
adapter tries the known paths in order and stops at the first 200. Every path
that answers 404 leaves the status open; only when all paths answer 404 is the
package reported unavailable.
"""

from __future__ import annotations

from .base import SCOPE_COUNTRY, STATUS_UNAVAILABLE, StoreAdapter
from .http import fetch

PATHS = (
    "https://myket.ir/app/{pkg}",
    "https://myket.ir/app/{pkg}/",
    "https://myket.ir/Apps/Details?packageName={pkg}",
)


class MyketAdapter(StoreAdapter):
    id = "myket"
    display_name = "Myket"
    countries = ["IR"]
    scope = SCOPE_COUNTRY
    authoritative = True
    resolve_by = "package"

    def check(self, package: str, country: str):
        last = None
        for template in PATHS:
            res = fetch(template.format(pkg=package))
            result = self._classify_html(res, package, country, require_package_in_body=True)
            if result.status not in (STATUS_UNAVAILABLE,):
                return result
            last = result
        return last
