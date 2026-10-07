import { flattenEntries, loadRepo } from "./load.mjs";
import { createValidators, formatAjvErrors } from "./schema.mjs";
import { AUTHORITATIVE_STORES, KNOWN_STORES, authoritativeStoresFor } from "./paths.mjs";

/**
 * Android package id: a dotted Java identifier. Uppercase segments are legal and
 * do occur in real listings (com.amazon.mShop.android.shopping,
 * com.bKash.customerapp), so a lowercase-only pattern - as originally sketched in
 * the spec - would reject genuine apps. Kept identical to data/schema.json#packageId.
 */
export const PACKAGE_ID_RE = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

const today = () => new Date().toISOString().slice(0, 10);

class Findings {
  constructor() {
    this.items = [];
  }
  error(code, where, message) {
    this.items.push({ level: "error", code, where, message });
  }
  warn(code, where, message) {
    this.items.push({ level: "warn", code, where, message });
  }
  get errors() {
    return this.items.filter((i) => i.level === "error");
  }
  get warnings() {
    return this.items.filter((i) => i.level === "warn");
  }
}

/**
 * Validates schema + semantic rules. Pure and network-free: store availability
 * is a separate, opt-in pass (see tools/lib/availability.mjs).
 */
export function validateRepo(repo = loadRepo()) {
  const f = new Findings();
  const validators = createValidators();

  // --- index.json -----------------------------------------------------------
  if (!validators.index(repo.index)) {
    for (const e of formatAjvErrors(validators.index.errors)) {
      f.error("INDEX_SCHEMA", "data/index.json", e);
    }
  }
  const indexCountries = new Set(repo.index.countries ?? []);
  const indexCategories = new Set(repo.index.categories ?? []);

  // --- global.json (negative catalog) --------------------------------------
  if (!validators.globalFile(repo.global)) {
    for (const e of formatAjvErrors(validators.globalFile.errors)) {
      f.error("GLOBAL_SCHEMA", "data/global.json", e);
    }
  }
  const globalPackages = new Map();
  for (const p of repo.global.packages ?? []) {
    globalPackages.set(p.package, p);
  }
  const globalDupes = new Set();
  const seenGlobal = new Set();
  for (const p of repo.global.packages ?? []) {
    if (seenGlobal.has(p.package)) globalDupes.add(p.package);
    seenGlobal.add(p.package);
  }
  for (const d of globalDupes) {
    f.error("GLOBAL_DUPLICATE", "data/global.json", `global package listed twice: ${d}`);
  }

  // --- per-file schema ------------------------------------------------------
  for (const country of repo.countries) {
    if (!indexCountries.has(country.code)) {
      f.error(
        "COUNTRY_NOT_IN_INDEX",
        `data/${country.folder}`,
        `country folder "${country.folder}" is not listed in data/index.json#countries`,
      );
    }
    for (const file of country.files) {
      const where = file.relPath;
      if (!validators.catalogFile(file.doc)) {
        for (const e of formatAjvErrors(validators.catalogFile.errors)) {
          f.error("SCHEMA", where, e);
        }
        continue;
      }
      if (file.doc.country !== country.code) {
        f.error(
          "COUNTRY_FOLDER_MISMATCH",
          where,
          `country "${file.doc.country}" does not match folder "${country.folder}"`,
        );
      }
      if (file.expectedCategory !== file.doc.category) {
        f.error(
          "CATEGORY_FILENAME_MISMATCH",
          where,
          `category "${file.doc.category}" does not match filename "${file.fileName}"`,
        );
      }
      if (!indexCategories.has(file.doc.category)) {
        f.error(
          "CATEGORY_NOT_IN_INDEX",
          where,
          `category "${file.doc.category}" is not registered in data/index.json#categories`,
        );
      }
    }
  }

  // --- per-entry rules ------------------------------------------------------
  const byCountryPackage = new Map();
  const byPackageCountries = new Map();
  const perCountryDupes = new Map();
  let newestAddedAt = "";

  for (const { app, file, folderCode } of flattenEntries(repo)) {
    const where = `${file.relPath}#${app?.package ?? "(missing package)"}`;
    if (!app || typeof app !== "object") continue;

    if (typeof app.package === "string" && !PACKAGE_ID_RE.test(app.package)) {
      f.error(
        "PACKAGE_ID_FORMAT",
        where,
        `"${app.package}" is not a dotted package id (expected e.g. com.example.app)`,
      );
    }

    // duplicates within a country (across all of that country's category files)
    const cpKey = `${folderCode}\u0000${app.package}`;
    if (byCountryPackage.has(cpKey)) {
      perCountryDupes.set(cpKey, (perCountryDupes.get(cpKey) ?? 0) + 1);
      f.error(
        "DUPLICATE_PACKAGE",
        where,
        `"${app.package}" already listed for ${folderCode} in ${byCountryPackage.get(
          cpKey,
        )}`,
      );
    } else {
      byCountryPackage.set(cpKey, file.relPath);
    }

    if (!byPackageCountries.has(app.package)) byPackageCountries.set(app.package, new Set());
    byPackageCountries.get(app.package).add(folderCode);

    // global confusables must never be claimed as local
    if (globalPackages.has(app.package)) {
      f.error(
        "GLOBAL_CONFLICT",
        where,
        `"${app.package}" (${globalPackages.get(app.package).label}) is a global app and must not be listed as local to ${folderCode}`,
      );
    }

    if (app.evidence && !String(app.evidence).startsWith("https://")) {
      f.error("EVIDENCE_NOT_HTTPS", where, `evidence must be an https URL, got "${app.evidence}"`);
    }

    if (app.confidence === "verified" && !app.verified_at) {
      f.error(
        "VERIFIED_WITHOUT_DATE",
        where,
        "confidence=verified requires verified_at (set by the availability checker or a maintainer)",
      );
    }
    if (app.confidence !== "verified" && app.verified_at) {
      f.warn(
        "STALE_VERIFIED_AT",
        where,
        `verified_at is set but confidence is "${app.confidence}"; drop verified_at or promote the entry`,
      );
    }

    if (app.store && !KNOWN_STORES.includes(app.store)) {
      f.error("UNKNOWN_STORE", where, `unknown store adapter "${app.store}"`);
    }

    // `verified` is a claim about *locality*, so it has to be backed by a
    // country-scoped storefront for that very country. A worldwide store (Play,
    // APKPure) proves only that the package exists somewhere.
    if (app.confidence === "verified" && (!app.store || KNOWN_STORES.includes(app.store))) {
      const covering = authoritativeStoresFor(folderCode);
      if (covering.length === 0) {
        f.error(
          "VERIFY_IMPOSSIBLE",
          where,
          `no country-scoped store adapter covers ${folderCode}, so "${app.package}" cannot be verified by CI; keep it community until an adapter exists`,
        );
      } else if (!app.store) {
        f.error(
          "VERIFIED_WITHOUT_STORE",
          where,
          `confidence=verified requires the store listing that proves it: cite one of ${covering.join(", ")}`,
        );
      } else if (!covering.includes(app.store)) {
        f.error(
          "VERIFIED_STORE_NOT_LOCAL",
          where,
          `store "${app.store}" (authoritative for ${(AUTHORITATIVE_STORES[app.store] ?? []).join(", ") || "nothing"}) cannot confirm locality for ${folderCode}`,
        );
      }
    }

    if (typeof app.added_at === "string") {
      if (app.added_at > newestAddedAt) newestAddedAt = app.added_at;
      if (app.added_at > today()) {
        f.error("ADDED_AT_IN_FUTURE", where, `added_at "${app.added_at}" is in the future`);
      }
    }
  }

  // same package in two countries is allowed (regional apps) but worth surfacing
  for (const [pkg, codes] of byPackageCountries) {
    if (codes.size > 1) {
      f.warn(
        "MULTI_COUNTRY_PACKAGE",
        `data/*/${pkg}`,
        `"${pkg}" is listed for ${[...codes].sort().join(", ")}; keep evidence per country`,
      );
    }
  }

  if (newestAddedAt && repo.index.updated && repo.index.updated < newestAddedAt) {
    f.warn(
      "INDEX_UPDATED_STALE",
      "data/index.json",
      `updated "${repo.index.updated}" is older than the newest added_at "${newestAddedAt}"`,
    );
  }

  return {
    findings: f.items,
    errors: f.errors,
    warnings: f.warnings,
    stats: summarize(repo),
  };
}

export function summarize(repo) {
  const perCountry = {};
  const perCategory = {};
  let total = 0;
  let legacy = 0;
  for (const { app, folderCode } of flattenEntries(repo)) {
    total += 1;
    if (app?.confidence === "legacy") legacy += 1;
    perCountry[folderCode] = (perCountry[folderCode] ?? 0) + 1;
    perCategory[app?.category] = (perCategory[app?.category] ?? 0) + 1;
  }
  return {
    countries: repo.countries.length,
    totalEntries: total,
    legacyEntries: legacy,
    perCountry,
    perCategory,
  };
}
