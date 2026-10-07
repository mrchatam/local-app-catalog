"""Store adapter registry: one interface, many stores.

Adding a store means adding one module here and registering it in ADAPTERS.
Nothing else in the repo needs to change: the validator reads `authoritative`,
`scope` and `resolve_by` off the adapter to decide what a result is worth.
"""

from __future__ import annotations

from .base import (  # noqa: F401 - re-exported for callers
    SCOPE_COUNTRY,
    SCOPE_GLOBAL,
    SCOPE_REGION,
    STATUS_AVAILABLE,
    STATUS_ERROR,
    STATUS_UNAVAILABLE,
    STATUS_UNKNOWN,
    CheckResult,
    StoreAdapter,
)
from .apkpure import ApkPureAdapter
from .appgallery import AppGalleryAdapter
from .cafe_bazaar import CafeBazaarAdapter
from .fdroid import FDroidAdapter
from .google_play import GooglePlayAdapter
from .myket import MyketAdapter
from .onestore import OneStoreAdapter
from .rustore import RuStoreAdapter

_ADAPTER_CLASSES = (
    GooglePlayAdapter,
    CafeBazaarAdapter,
    MyketAdapter,
    RuStoreAdapter,
    AppGalleryAdapter,
    ApkPureAdapter,
    OneStoreAdapter,
    FDroidAdapter,
)

ADAPTERS: dict[str, StoreAdapter] = {cls.id: cls() for cls in _ADAPTER_CLASSES}

# Stores that actually gate by country. Used to pick sensible defaults so a
# check for IR does not waste requests on stores that cannot serve Iran.
COUNTRY_STORES: dict[str, tuple[str, ...]] = {
    "IR": ("cafe_bazaar", "myket"),
    "RU": ("rustore",),
    "KR": ("onestore",),
}


def get(store_id: str) -> StoreAdapter:
    try:
        return ADAPTERS[store_id]
    except KeyError:
        raise KeyError(f"unknown store adapter: {store_id}") from None


def ids() -> list[str]:
    return sorted(ADAPTERS)


def for_country(country: str, *, include_global: bool = False) -> list[StoreAdapter]:
    """Adapters worth querying for a country.

    Country-scoped stores first (they are the ones that can prove locality),
    then worldwide stores when the caller opts in.
    """
    country = country.upper()
    scoped = [a for a in ADAPTERS.values() if a.scope != SCOPE_GLOBAL and a.supports_country(country)]
    ordered = sorted(
        scoped,
        key=lambda a: (a.countries is not None and country in (a.countries or []), a.id),
        reverse=True,
    )
    if include_global:
        ordered += [a for a in ADAPTERS.values() if a.scope == SCOPE_GLOBAL]
    return ordered


def authoritative_for(country: str) -> list[StoreAdapter]:
    """Adapters whose positive result may promote an entry to `verified`."""
    country = country.upper()
    return [
        a
        for a in ADAPTERS.values()
        if a.authoritative and a.resolve_by == "package" and a.supports_country(country)
    ]
