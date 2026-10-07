import { execFile } from "node:child_process";
import path from "node:path";
import { REPO_ROOT } from "./paths.mjs";
import { flattenEntries } from "./load.mjs";

const PY_SCRIPT = path.join(REPO_ROOT, "fetch", "play_availability.py");

/** Per-country exit code 2 means "a check was inconclusive", not "the tool broke". */
const ACCEPTED_EXIT_CODES = new Set([0, 2]);

/**
 * Run the Python availability checker for one country and parse its JSON.
 * The Python module is the single source of truth for what a store said; this
 * wrapper only decides what the answer means for the catalog.
 */
function checkCountry({ country, packages, python, timeoutMs }) {
  const args = [PY_SCRIPT, "--country", country, "--with-global", "--json"];
  for (const pkg of packages) args.push("--package", pkg);

  return new Promise((resolve, reject) => {
    execFile(
      python,
      args,
      { cwd: REPO_ROOT, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !ACCEPTED_EXIT_CODES.has(err.code) && !stdout) {
          reject(
            new Error(
              `store check failed for ${country}: ${err.message}${stderr ? `\n${stderr.trim()}` : ""}`,
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(
            new Error(
              `store check for ${country} produced unparsable output (${parseErr.message})`,
            ),
          );
        }
      },
    );
  });
}

/**
 * Group entries by country, ask every store adapter about each package, and
 * turn the verdicts into findings.
 *
 * The rule this pass enforces is "availability is not locality": a worldwide
 * storefront proves a package exists, never that it is local to the declared
 * country. Only a country-scoped adapter (scope=country) can do that.
 *
 * Because a live probe can be blocked, rate-limited or geo-fenced, an error is
 * raised only when a country-scoped store gave a *definite* answer; anything
 * inconclusive is a warning. A throttled runner must never fail a PR, and a
 * green run must never rest on a store that never answered.
 *
 * Codes produced here (network-dependent, so kept out of the pure rules module):
 *   STORE_UNAVAILABLE      error  no store lists the package for this country
 *                                 and at least one country-scoped store said so
 *                                 with a definite 404
 *   VERIFIED_NOT_LOCAL     error  confidence=verified but the country-scoped
 *                                 storefront answered 404: the claim is false
 *   LOCAL_STORE_MISSING    warn   a worldwide store resolved it while the
 *                                 country-scoped storefront 404'd: the evidence
 *                                 probably points at the wrong country
 *   STORE_UNVERIFIABLE     warn   nothing was proven: every store that could
 *                                 have answered was blocked/rate-limited/soft-404
 *   PROMOTION_AVAILABLE    warn   a country-scoped store confirms it:
 *                                 eligible for community -> verified
 */
export async function checkAvailability(
  repo,
  { python = "python3", timeoutMs = 180_000, country = null, confidence = null, onProgress = null } = {},
) {
  const entries = flattenEntries(repo);
  const byCountry = new Map();
  for (const item of entries) {
    const code = item.folderCode;
    if (country && code !== country.toUpperCase()) continue;
    // The nightly recheck only cares about entries that carry a `verified`
    // claim: checking the rest costs store requests and proves nothing new.
    if (confidence && item.app?.confidence !== confidence) continue;
    if (!byCountry.has(code)) byCountry.set(code, new Map());
    byCountry.get(code).set(item.app.package, item);
  }

  const findings = [];
  const verdicts = new Map();
  const countriesChecked = [];

  for (const code of [...byCountry.keys()].sort()) {
    const packages = [...byCountry.get(code).keys()].sort();
    if (packages.length === 0) continue;
    onProgress?.(code, packages.length);

    const payload = await checkCountry({ country: code, packages, python, timeoutMs });
    countriesChecked.push({
      country: code,
      packages: packages.length,
      summary: payload.summary,
      authoritative_stores: payload.authoritative_stores ?? [],
    });

    for (const verdict of payload.verdicts ?? []) {
      const key = `${code}\u0000${verdict.package}`;
      verdicts.set(key, verdict);
      const item = byCountry.get(code).get(verdict.package);
      const where = `${item.file.relPath}#${verdict.package}`;
      const checks = verdict.checks ?? [];
      // Only a store that serves this one country can speak about locality.
      const local = checks.filter((c) => c.scope === "country");
      const localAvailable = local.filter((c) => c.status === "available");
      const localMissing = local.filter((c) => c.status === "unavailable");
      const localBlocked = local.filter((c) => c.status === "unknown" || c.status === "error");
      const blockedDetail =
        localBlocked.map((c) => `${c.store} (${c.detail ?? c.status})`).join(", ") ||
        "no country-scoped store answered";

      if (verdict.status === "available") {
        if (item.app.confidence === "verified" && !verdict.authoritative) {
          if (localMissing.length) {
            findings.push({
              level: "error",
              code: "VERIFIED_NOT_LOCAL",
              where,
              message:
                `confidence=verified but ${localMissing.map((c) => c.store).join(", ")} does not list ` +
                `"${verdict.package}" for ${code} (404) - it is only on ${verdict.confirmed_by} ` +
                `(scope=global); demote to community`,
            });
          } else {
            findings.push({
              level: "warn",
              code: "STORE_UNVERIFIABLE",
              where,
              message:
                `${code}: the stores that could confirm locality are unresolvable - ${blockedDetail}; ` +
                `only ${verdict.confirmed_by} (scope=global) resolved it, so verified is unproven this run`,
            });
          }
        } else if (item.app.confidence !== "verified" && verdict.authoritative) {
          findings.push({
            level: "warn",
            code: "PROMOTION_AVAILABLE",
            where,
            message: `confirmed by ${verdict.confirmed_by} for ${code}: eligible for community -> verified`,
          });
        } else if (item.app.confidence !== "verified" && localMissing.length && !localAvailable.length) {
          findings.push({
            level: "warn",
            code: "LOCAL_STORE_MISSING",
            where,
            message:
              `${localMissing.map((c) => c.store).join(", ")} does not list "${verdict.package}" for ` +
              `${code}, but ${verdict.confirmed_by} does: check the entry really is local to ${code}`,
          });
        }
      } else if (verdict.status === "unavailable") {
        // Definite only when a country-scoped store said so, or when every store
        // that was asked agreed. Otherwise a worldwide store's 404 ("not in
        // F-Droid") would fail a perfectly real local app.
        const everyCheckAgreed = checks.length > 0 && checks.every((c) => c.status === "unavailable");
        if (localMissing.length || everyCheckAgreed) {
          findings.push({
            level: "error",
            code: "STORE_UNAVAILABLE",
            where,
            message: `no store lists "${verdict.package}" for ${code} (last: ${verdict.confirmed_by}, ${verdict.detail ?? "404"})`,
          });
        } else {
          findings.push({
            level: "warn",
            code: "STORE_UNVERIFIABLE",
            where,
            message: `${code}: only ${verdict.confirmed_by} answered about "${verdict.package}" and it said unavailable; ${blockedDetail} - nothing conclusive`,
          });
        }
      } else {
        findings.push({
          level: "warn",
          code: "STORE_UNVERIFIABLE",
          where,
          message: `${code}: every store answered ${verdict.status} for "${verdict.package}" (${verdict.detail ?? "blocked or rate-limited"}); nothing was proven`,
        });
      }
    }
  }

  return {
    findings,
    errors: findings.filter((f) => f.level === "error"),
    warnings: findings.filter((f) => f.level === "warn"),
    verdicts,
    countriesChecked,
    unresolved: findings.filter(
      (f) => f.code === "STORE_UNVERIFIABLE" || f.code === "STORE_UNAVAILABLE",
    ).length,
  };
}
