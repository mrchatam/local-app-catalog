"""OneStore (KR) adapter.

OneStore detail pages are addressed by a store-native product id, and its
search API requires a client key, so a package id cannot be resolved without
credentials. Rather than guess a URL and risk a false verdict, the adapter is
declared `resolve_by="app_id"` and always answers `unknown` with an explanation.

The validator never promotes on `unknown`, so a KR entry confirmed only by
OneStore stays `community` until a maintainer either supplies a product id or
confirms it through another store.
"""

from __future__ import annotations

from .base import SCOPE_COUNTRY, STATUS_UNKNOWN, StoreAdapter


class OneStoreAdapter(StoreAdapter):
    id = "onestore"
    display_name = "OneStore"
    countries = ["KR"]
    scope = SCOPE_COUNTRY
    authoritative = False
    resolve_by = "app_id"

    def check(self, package: str, country: str):
        return self._result(
            package,
            country,
            STATUS_UNKNOWN,
            detail=(
                "OneStore cannot be queried by package id (store-native product id "
                "required); confirm manually and record the product id in evidence"
            ),
        )
