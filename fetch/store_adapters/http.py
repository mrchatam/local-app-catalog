"""Shared HTTP helper for store adapters.

Stdlib only on purpose: CI must be able to run the availability checks without
installing anything, and the adapters must degrade to `unknown` rather than
raise when a store blocks the runner (Cloudflare 403, geo-block, timeout).
"""

from __future__ import annotations

import gzip
import io
import time
import urllib.error
import urllib.request

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 LocalAppCatalog/0.1 (+https://github.com/local-app-catalog)"
)

DEFAULT_TIMEOUT = 15.0
DEFAULT_RETRIES = 2


class HttpResult:
    __slots__ = ("status", "body", "url", "error")

    def __init__(self, status: int | None, body: str, url: str, error: str | None = None):
        self.status = status
        self.body = body
        self.url = url
        self.error = error

    @property
    def ok(self) -> bool:
        return self.status == 200

    @property
    def missing(self) -> bool:
        return self.status == 404


def fetch(
    url: str,
    *,
    timeout: float = DEFAULT_TIMEOUT,
    retries: int = DEFAULT_RETRIES,
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    method: str | None = None,
) -> HttpResult:
    """GET (or POST) a URL, following redirects, retrying transient failures.

    Never raises for HTTP status codes; transport failures come back as
    HttpResult(status=None, error=...) so callers can report `unknown`.
    """
    hdrs = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/json,*/*;q=0.8",
        "Accept-Encoding": "gzip",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if headers:
        hdrs.update(headers)

    last_error: str | None = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    try:
                        raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
                    except OSError:
                        pass
                return HttpResult(resp.status, raw.decode("utf-8", "replace"), url)
        except urllib.error.HTTPError as exc:  # includes 404 / 403
            try:
                raw = exc.read()
            except Exception:  # noqa: BLE001 - body is optional
                raw = b""
            return HttpResult(exc.code, raw.decode("utf-8", "replace"), url)
        except Exception as exc:  # noqa: BLE001 - transport layer
            last_error = f"{type(exc).__name__}: {exc}"
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))

    return HttpResult(None, "", url, last_error)
