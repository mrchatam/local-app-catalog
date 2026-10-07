"""APKPure adapter.

APKPure fronts its site with bot protection: from a datacenter runner both
/apkpure.com/search?q=<pkg> and detail pages answer 403. The adapter reports
that honestly as `error` with the HTTP status, so the nightly job can tell
"blocked" apart from "not found" and CI never treats a block as evidence.

When a permitted runner gets a 200, APKPure detail pages are addressed by a
human-readable slug (/zalo/com.zing.zalo), so the slug is derived from the last
segment of the package id, which is what APKPure does in practice.
"""

from __future__ import annotations

import re

from .base import SCOPE_GLOBAL, STATUS_ERROR, STATUS_UNKNOWN, StoreAdapter
from .http import fetch

SLUG_SAFE = re.compile(r"[^a-z0-9]+")


class ApkPureAdapter(StoreAdapter):
    id = "apkpure"
    display_name = "APKPure"
    countries = None
    scope = SCOPE_GLOBAL
    authoritative = False
    resolve_by = "package"

    def _slug(self, package: str) -> str:
        tail = package.rsplit(".", 1)[-1]
        return SLUG_SAFE.sub("-", tail.lower()).strip("-") or "app"

    def check(self, package: str, country: str):
        res = fetch(f"https://apkpure.com/{self._slug(package)}/{package}")
        if res.status in (401, 403, 429):
            return self._result(
                package,
                country,
                STATUS_ERROR,
                http_status=res.status,
                evidence=res.url,
                detail=(
                    f"APKPure blocked this runner with HTTP {res.status}; "
                    "retry from a permitted network before treating as absent"
                ),
            )
        if res.status is None:
            return self._result(
                package,
                country,
                STATUS_UNKNOWN,
                evidence=res.url,
                detail=res.error or "transport failure",
            )
        return self._classify_html(res, package, country, require_package_in_body=True)
