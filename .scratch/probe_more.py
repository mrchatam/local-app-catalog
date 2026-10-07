#!/usr/bin/env python3
"""Probe a second batch of candidate package ids and print the real listing title.

Nothing is added to data/ from this file: it exists to confirm that a guessed
package id really is the app we think it is, by reading the store page title.
"""

from __future__ import annotations

import html
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fetch"))

from store_adapters import ADAPTERS  # noqa: E402
from store_adapters.http import fetch  # noqa: E402

TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)

CANDIDATES = [
    # (country, guessed package, what we expect it to be)
    ("KR", "com.kakao.talk", "KakaoTalk"),
    ("KR", "com.kakao.taxi", "Kakao T"),
    ("KR", "com.nhn.android.navermap", "Naver Map"),
    ("ID", "com.gojek.app", "Gojek"),
    ("ID", "com.tokopedia.tkpd", "Tokopedia"),
    ("JP", "com.linecorp.LINE", "LINE"),
    ("JP", "jp.naver.line.android", "LINE (alt id)"),
    ("RU", "com.vk.messenger", "VK Messenger"),
    ("RU", "ru.vk.store", "VK Store"),
    ("RU", "com.yandex.taxi", "Yandex Go"),
    ("UA", "com.uklon.app", "Uklon"),
    ("TR", "com.bitaksi.android", "BiTaksi"),
    ("TR", "com.btk.bip", "BiP"),
    ("PH", "com.globe.gcash.android", "GCash"),
    ("PH", "com.angkas.passenger", "Angkas"),
    ("BD", "com.pathao.user", "Pathao"),
    ("VN", "com.vingroup.vinfast", "VinFast"),
    ("VN", "com.be.vn.mobile", "Be (Vietnam)"),
    ("IR", "ir.snapp.passenger", "Snapp"),
    ("IR", "com.eitaa.messenger", "Eitaa"),
    ("IR", "ir.eitaa.messenger", "Eitaa (alt id)"),
    ("IR", "ir.bale.messenger", "Bale"),
    ("ZA", "com.whatsapp", "WhatsApp (control)"),
]


def probe(job):
    country, package, expected = job
    adapter = ADAPTERS["google_play"]
    res = adapter.check(package, country)
    title = ""
    if res.status == "available" and res.evidence:
        raw = fetch(res.evidence)
        if raw.ok:
            m = TITLE_RE.search(raw.body)
            if m:
                title = html.unescape(m.group(1)).strip()
    return {"country": country, "package": package, "expected": expected,
            "status": res.status, "title": title}


def main() -> int:
    with ThreadPoolExecutor(max_workers=6) as pool:
        rows = list(pool.map(probe, CANDIDATES))
    for r in rows:
        print(f"{r['status']:11s} {r['country']} {r['package']:32s} expect={r['expected']:20s} title={r['title'][:70]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
