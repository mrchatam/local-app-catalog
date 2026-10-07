"""F-Droid adapter.

F-Droid exposes a stable JSON API: GET /api/v1/packages/<pkg> -> 200 with the
package metadata, 404 when it is not in any repository.

F-Droid mirrors are global rather than country-scoped, so a hit proves an app is
free-software and published, never that it is local to a given country: this
adapter is not authoritative. It is still useful as a cheap existence check and
as a discovery source for the Iran seed (F-Droid is widely used there).
"""

from __future__ import annotations

from .base import SCOPE_GLOBAL, StoreAdapter
from .http import fetch


class FDroidAdapter(StoreAdapter):
    id = "fdroid"
    display_name = "F-Droid"
    countries = None
    scope = SCOPE_GLOBAL
    authoritative = False
    resolve_by = "package"

    def check(self, package: str, country: str):
        res = fetch(f"https://f-droid.org/api/v1/packages/{package}")
        result = self._classify_html(res, package, country, require_package_in_body=True)
        if result.status == "available":
            result.detail = "present in an F-Droid repository (global mirror, not country-scoped)"
        return result
