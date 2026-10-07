"""RuStore adapter - the Russian national Android store.

Measured behaviour (2026-10): GET https://www.rustore.ru/catalog/app/<pkg>
    200 with the package id in the body -> listing exists
    404                                 -> not published
    200 with an "Ошибка 429" page       -> rate limited; NOT evidence

RuStore's JSON API (backapi.rustore.ru/applicationData/overallInfo/<pkg>)
answers 400 to anonymous callers, so the catalogue HTML is used instead.
RuStore serves Russia, so a positive result proves locality.

The 429 page is the trap: RuStore serves its rate-limit notice with HTTP 200,
so a naive status check reads "the store answered 200" as "the app is there"
and would let a throttled runner promote or condemn entries. It is reported as
`error` (inconclusive) instead, and the CI validator only treats a definite
answer as evidence.
"""

from __future__ import annotations

import re

from .base import SCOPE_COUNTRY, STATUS_ERROR, StoreAdapter
from .http import fetch

# "<title>Ошибка 429</title>" / "<title>Error 429</title>" on an HTTP 200 response
ERROR_PAGE_RE = re.compile(r"<title[^>]*>\s*(?:Ошибка|Error)\s*(\d{3})\b", re.IGNORECASE)


class RuStoreAdapter(StoreAdapter):
    id = "rustore"
    display_name = "RuStore"
    countries = ["RU"]
    scope = SCOPE_COUNTRY
    authoritative = True
    resolve_by = "package"

    def check(self, package: str, country: str):
        res = fetch(f"https://www.rustore.ru/catalog/app/{package}")
        if res.status == 200:
            match = ERROR_PAGE_RE.search(res.body or "")
            if match:
                code = match.group(1)
                detail = (
                    f"rate limited (HTTP 200 body is an error page: Ошибка {code})"
                    if code == "429"
                    else f"store served an error page with HTTP 200 (Ошибка {code})"
                )
                return self._result(
                    package, country, STATUS_ERROR, http_status=200, evidence=res.url, detail=detail
                )
        return self._classify_html(res, package, country, require_package_in_body=True)
