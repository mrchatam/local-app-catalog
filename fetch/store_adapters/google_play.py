"""Google Play adapter: availability check + country-scoped search discovery.

Availability (measured 2026-10, from a datacenter runner)
    GET /store/apps/details?id=<pkg>&gl=<CC>&hl=en
      200 -> the package exists on Play
      404 -> the package does not exist on Play at all

    `gl=` does NOT gate the detail page: Telegram, WhatsApp, Google Wallet and
    TikTok all answered 200 at gl=IR even though several are blocked in Iran,
    while Snapp (com.snapp.passenger) answered 404 at both gl=US and gl=IR
    because it is not published on Play at all. So a positive detail result
    proves only that the package exists -> scope=global, authoritative=False.
    A negative result is still a useful signal that an app is store-isolated.

Search (measured 2026-10)
    GET /store/search?q=<query>&c=apps&gl=<CC>&hl=en

    Search results ARE country-scoped, unlike the detail page: "telegram"
    at gl=IR returns Telegram alternatives but not org.telegram.messenger,
    and "mobil bankacılık" at gl=TR leads with the Turkish banks. That makes
    search the discovery source for this project: nominate candidates per
    country, then let curation and the availability check decide.

    Result rows are parsed by pairing each `details?id=<pkg>` occurrence with
    the nearest following play button (`aria-label="Play <title>"`), which is
    stable across the two row layouts Play serves.
"""

from __future__ import annotations

import html as html_mod
import re
import urllib.parse

from .base import SCOPE_GLOBAL, STATUS_AVAILABLE, STATUS_UNAVAILABLE, StoreAdapter
from .http import USER_AGENT, fetch

PKG_IN_URL = re.compile(r"details\?id=([a-zA-Z0-9_.]+)")
PLAY_BUTTON = re.compile(r'aria-label="Play ([^"]{1,120})"')
MAX_GAP = 1500


class GooglePlayAdapter(StoreAdapter):
    id = "google_play"
    display_name = "Google Play"
    countries = None  # worldwide
    scope = SCOPE_GLOBAL
    authoritative = False
    resolve_by = "package"

    DETAILS = "https://play.google.com/store/apps/details"
    SEARCH = "https://play.google.com/store/search"

    # ---- availability ----------------------------------------------------
    def check(self, package: str, country: str):
        url = f"{self.DETAILS}?id={package}&gl={country.upper()}&hl=en"
        res = fetch(url)
        result = self._classify_html(res, package, country, require_package_in_body=False)
        if result.status == STATUS_AVAILABLE:
            result.detail = (
                "package exists on Play; gl= does not gate availability, so this "
                "does not prove the app is usable in the declared country"
            )
        elif result.status == STATUS_UNAVAILABLE:
            result.detail = "not published on Google Play (store-isolated app)"
        return result

    # ---- discovery -------------------------------------------------------
    def search(self, query: str, country: str) -> list[dict]:
        """Return [{package,label,evidence}] nominations for a country query."""
        url = (
            f"{self.SEARCH}?q={urllib.parse.quote(query)}&c=apps"
            f"&gl={country.upper()}&hl=en"
        )
        res = fetch(url, headers={"User-Agent": USER_AGENT})
        if res.status != 200:
            raise RuntimeError(f"search failed (HTTP {res.status or res.error}) for {query!r}")

        ids = [(m.start(), m.group(1)) for m in PKG_IN_URL.finditer(res.body)]
        out: list[dict] = []
        seen: set[str] = set()
        for pos, raw_label in [(m.start(), m.group(1)) for m in PLAY_BUTTON.finditer(res.body)]:
            best = None
            for ipos, pkg in ids:
                if ipos < pos and pos - ipos < MAX_GAP:
                    best = pkg
            if best is None or best in seen:
                continue
            seen.add(best)
            out.append(
                {
                    "package": best,
                    "label": html_mod.unescape(raw_label).strip(),
                    "evidence": f"{self.DETAILS}?id={best}",
                    "query": query,
                    "country": country.upper(),
                }
            )
        return out
