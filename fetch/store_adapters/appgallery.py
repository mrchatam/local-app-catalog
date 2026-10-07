"""AppGallery (Huawei) adapter.

AppGallery's own detail pages are addressed by a store-native id (C-numbers such
as /app/C10132067), not by package id, and the search endpoint is a JS app. The
adapter therefore queries the search route with the package id and treats the
package string appearing in the returned HTML as a positive signal.

That is a weak signal - the search page can echo the query back - so this
adapter is never authoritative: it can flag an entry for human review but can
never promote it to `verified`.
"""

from __future__ import annotations

from .base import SCOPE_REGION, STATUS_UNKNOWN, StoreAdapter
from .http import fetch


class AppGalleryAdapter(StoreAdapter):
    id = "appgallery"
    display_name = "AppGallery"
    countries = None  # serves many markets
    scope = SCOPE_REGION
    authoritative = False
    resolve_by = "package"

    def check(self, package: str, country: str):
        res = fetch(f"https://appgallery.huawei.com/search/{package}")
        result = self._classify_html(res, package, country, require_package_in_body=True)
        if result.status == "available":
            result.detail = (
                "package id echoed by AppGallery search results; weak signal, "
                "requires human confirmation on the store detail page"
            )
        elif res.status is None:
            result.status = STATUS_UNKNOWN
        return result
