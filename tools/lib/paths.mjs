import { fileURLToPath } from "node:url";
import path from "node:path";

/** Repository root, derived from this file's location (tools/lib/ -> repo root). */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const DATA_DIR = path.join(REPO_ROOT, "data");
export const SCHEMA_PATH = path.join(DATA_DIR, "schema.json");
export const INDEX_PATH = path.join(DATA_DIR, "index.json");
export const GLOBAL_PATH = path.join(DATA_DIR, "global.json");
export const DIST_DIR = path.join(REPO_ROOT, "dist");

/**
 * Adapter ids that a catalog entry's optional `store` field may name.
 * Kept in sync with fetch/store_adapters/ (one module per id) and asserted by tests.
 */
export const KNOWN_STORES = [
  "google_play",
  "cafe_bazaar",
  "myket",
  "rustore",
  "appgallery",
  "apkpure",
  "onestore",
  "fdroid",
];

/**
 * Country-scoped, package-resolvable storefronts: the only adapters whose
 * positive result may promote an entry from `community` to `verified`, and the
 * only ones that can falsify a `verified` claim with a definite 404.
 *
 * A worldwide store can never appear here: Google Play carrying a bank from
 * Tehran says nothing about whether the bank serves Iran. Mirrored from
 * fetch/store_adapters/__init__.py, and tests/store-adapters.test.mjs asserts
 * that this table and the Python registry agree - one of them changing alone
 * must fail CI.
 */
export const AUTHORITATIVE_STORES = Object.freeze({
  cafe_bazaar: Object.freeze(["IR"]),
  myket: Object.freeze(["IR"]),
  rustore: Object.freeze(["RU"]),
});

/** Storefronts that can confirm or falsify a claim about `countryCode` (e.g. "IR"). */
export function authoritativeStoresFor(countryCode) {
  const cc = String(countryCode).toUpperCase();
  return Object.entries(AUTHORITATIVE_STORES)
    .filter(([, countries]) => countries.includes(cc))
    .map(([id]) => id);
}

/** True when at least one adapter can speak about locality for `countryCode`. */
export function canVerify(countryCode) {
  return authoritativeStoresFor(countryCode).length > 0;
}

/** Entries demoted by the nightly recheck; kept in the catalog, out of presets. */
export const LEGACY_CONFIDENCE = "legacy";
