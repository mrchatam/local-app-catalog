"""Adapter interface. One method to implement: check(package, country)."""

from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timezone

# status values, in order of usefulness
STATUS_AVAILABLE = "available"
STATUS_UNAVAILABLE = "unavailable"
STATUS_UNKNOWN = "unknown"
STATUS_ERROR = "error"

# how much a positive result tells us about the *declared country*
SCOPE_COUNTRY = "country"  # store only serves one country -> positive result proves locality
SCOPE_REGION = "region"    # store serves a region -> positive result is suggestive
SCOPE_GLOBAL = "global"    # worldwide store -> positive result only proves the package exists


@dataclass
class CheckResult:
    package: str
    store: str
    country: str
    status: str
    scope: str = SCOPE_GLOBAL
    http_status: int | None = None
    evidence: str | None = None
    detail: str | None = None
    checked_at: str = ""

    def __post_init__(self) -> None:
        if not self.checked_at:
            self.checked_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def to_dict(self) -> dict:
        return asdict(self)


class StoreAdapter:
    """Base class for per-store fetchers.

    id                  stable adapter id, referenced by a catalog entry's `store` field
    display_name        human name
    countries           ISO-3166-1 alpha-2 codes the store is authoritative for,
                        or None when the store is worldwide
    scope               SCOPE_* constant describing what a positive result proves
    authoritative       True when a positive result may promote an entry to `verified`
    resolve_by          "package" when the store can be queried by package id,
                        "app_id" when it needs a store-native id (never authoritative)
    """

    id: str = "base"
    display_name: str = "base"
    countries: list[str] | None = None
    scope: str = SCOPE_GLOBAL
    authoritative: bool = False
    resolve_by: str = "package"

    def supports_country(self, country: str) -> bool:
        if self.countries is None:
            return True
        return country.upper() in self.countries

    def check(self, package: str, country: str) -> CheckResult:  # pragma: no cover - interface
        raise NotImplementedError

    def _result(self, package: str, country: str, status: str, **kw) -> CheckResult:
        return CheckResult(
            package=package,
            store=self.id,
            country=country.upper(),
            status=status,
            scope=self.scope,
            **kw,
        )

    def _classify_html(self, res, package: str, country: str, *, require_package_in_body: bool) -> CheckResult:
        """Turn an HTTP result into a CheckResult, guarding against soft-404s.

        Several storefronts answer 200 for an unknown package and render a
        "not found" page. Requiring the package id to appear in the body turns
        those into `unknown` instead of a false `available`.
        """
        if res.status == 200:
            if require_package_in_body and package.lower() not in res.body.lower():
                return self._result(
                    package,
                    country,
                    STATUS_UNKNOWN,
                    http_status=200,
                    evidence=res.url,
                    detail="200 but package id absent from body (soft-404 suspected)",
                )
            return self._result(
                package, country, STATUS_AVAILABLE, http_status=200, evidence=res.url
            )
        if res.missing:
            return self._result(
                package,
                country,
                STATUS_UNAVAILABLE,
                http_status=404,
                evidence=res.url,
                detail="store returned 404",
            )
        return self._result(
            package,
            country,
            STATUS_ERROR,
            http_status=res.status,
            evidence=res.url,
            detail=res.error or (f"unexpected HTTP {res.status}" if res.status else "transport failure"),
        )
