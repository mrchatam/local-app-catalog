"""Parse a storefront listing page (category page, editorial list) into hits.

Measured shapes (2026-10, from this runner):
  Cafe Bazaar  <a href="/app/<pkg>" ...> ... <picture alt="<label>"> ... </a>
               (the /lists/<slug> pages are server-rendered; the category
               index is a JS shell with no app links)
  Myket        <a href="/app/<pkg>" ... title="<label>" ...> ... </a>

Both are just "app anchors carrying a label attribute nearby", so one parser
serves both: walk every anchor whose href points at an app page, take the first
label-ish attribute (title, then alt) inside the anchor, and emit one hit per
distinct package. Label order matters: on Myket the anchor title is the clean
app name while the icon alt duplicates it with a "download " prefix; on Bazaar
the label lives in alt/title deeper inside the anchor.

A listing page is a nomination source, never evidence of localness on its own
- but the store that serves it is country-scoped, so every hit inherits that
strong signal, and the availability check still decides what ships.
"""

from __future__ import annotations

import html as html_mod
import re

# href="/app/<pkg>" or href="/catalog/app/<pkg>" - the app-detail URL of the
# store doing the listing, whatever its depth. The full anchor element is
# matched (open tag + body up to </a>) so a label can never be borrowed from
# the NEXT anchor: label attributes sit either on the open tag (Myket's
# title="...") or just inside the body (Bazaar's <picture alt="...").
ANCHOR = re.compile(
    r'<a\b([^>]*href="[^"]*/app/([a-zA-Z0-9_.]{3,})"[^>]*)>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
LABEL = re.compile(r'\b(?:title|alt)="([^"]{1,140})"')


def parse_listings(body: str, *, evidence_base: str, source: str, country: str) -> list[dict]:
    """Return [{package,label,evidence,query,country}] hits, deduped by package.

    evidence_base is the store's app-URL prefix (e.g. https://cafebazaar.ir/app);
    source is the slug/identifier of the listing page, recorded as the hit's
    query so the discovery planner can show where each candidate came from.
    """
    hits: list[dict] = []
    seen: set[str] = set()
    for match in ANCHOR.finditer(body):
        open_attrs, package, inner = match.group(1), match.group(2), match.group(3)
        if package in seen:
            continue
        label = ""
        for candidate in LABEL.findall(open_attrs + inner):
            text = html_mod.unescape(candidate).strip()
            # Icon attributes leak download boilerplate; keep the cleanest one.
            if text and not label:
                label = text
        if label.startswith("دانلود "):
            label = label[len("دانلود ") :]
        label = label.strip() or package
        seen.add(package)
        hits.append(
            {
                "package": package,
                "label": label,
                "evidence": f"{evidence_base}/{package}",
                "query": source,
                "country": country.upper(),
            }
        )
    return hits
