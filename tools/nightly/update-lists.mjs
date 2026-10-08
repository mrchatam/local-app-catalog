#!/usr/bin/env node
/**
 * Nightly list updater: turn store nominations into catalog entries.
 *
 * Pipeline position: `fetch/discover.py --all` (or the local-store enumerators)
 * writes a candidates JSON; this tool checks each candidate's availability via
 * `fetch/play_availability.py`, and inserts ONLY candidates with a definite
 * answer:
 *
 *   available + authoritative store said so  -> confidence "verified"
 *                                               (store = the confirming store)
 *   available, global store only (Play)      -> confidence "community"
 *   unavailable / unknown / error            -> not inserted (a nomination is
 *                                               not data; retried next night)
 *
 * Every insertion goes through tools/curate/lib.mjs - normalizeEntry,
 * validateEntry, insertSorted, the same stageEntry bytes CI validates on the
 * pull request - so the automated path cannot write something the human path
 * could not. Candidates already listed in the catalog are skipped BEFORE any
 * store is probed (a duplicate nomination must not cost a store hit), and
 * insertions are capped per run (--max-insertions) so one bad night cannot
 * flood the diff; the default (100) is sized for a healthy multi-country
 * sweep, and anything beyond it is reported as `deferred` and picked up the
 * next night (already-inserted packages are skipped then).
 *
 * Exit codes (same taxonomy as tools/recheck):
 *   0  entries inserted (or nothing qualified)
 *   1  hard failure (bad candidates file, availability subprocess failed)
 *   3  usage error
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { UsageError, need, needInt, usageGuard } from "../lib/args.mjs";
import { REPO_ROOT, authoritativeStoresFor } from "../lib/paths.mjs";
import { loadRepo } from "../lib/load.mjs";
import { loadCatalog, normalizeEntry, stageEntry, validateEntry } from "../curate/lib.mjs";

const USAGE = `usage: node tools/nightly/update-lists.mjs --candidates <file> [--report <file>]
       [--apply] [--country <CC>] [--max-insertions <N>] [--python <cmd>] [--quiet]

Read a fetch/discover.py candidates JSON, check each candidate's availability,
and insert entries that a store answered for. Without --apply nothing is
written (dry run, prints the plan).

Exit codes: 0 inserted or nothing qualified, 1 hard failure, 3 usage error.`;

const DEFAULT_MAX_INSERTIONS = 100;
const ADDED_BY = "@local-app-catalog"; // schema: a GitHub-username-shaped handle

function parseArgs(argv) {
  const opts = {
    candidates: null,
    report: null,
    apply: false,
    country: null,
    maxInsertions: DEFAULT_MAX_INSERTIONS,
    python: process.env.LAC_PYTHON || "python3",
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--candidates":
        opts.candidates = need(arg, argv[++i]);
        break;
      case "--report":
        opts.report = need(arg, argv[++i]);
        break;
      case "--apply":
        opts.apply = true;
        break;
      case "--country":
        opts.country = need(arg, argv[++i]);
        break;
      case "--max-insertions":
        opts.maxInsertions = needInt(arg, argv[++i], { min: 1, max: 500 });
        break;
      case "--python":
        opts.python = need(arg, argv[++i]);
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (!opts.candidates) throw new UsageError("--candidates is required");
  if (opts.report && opts.report === opts.candidates) {
    throw new UsageError("--report would overwrite --candidates; pick a different file");
  }
  return opts;
}

/** Read the discover.py output; fail closed on anything that is not one. */
export function readCandidates(file) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`--candidates ${file}: ${err.message}`);
  }
  const grouped = doc?.candidates;
  if (!grouped || typeof grouped !== "object" || Array.isArray(grouped)) {
    throw new Error(`--candidates ${file}: not a discover.py output (missing candidates object)`);
  }
  // A candidate object is shared between its categories, so dedupe on
  // (country, package) and keep the nomination order per country.
  const out = new Map();
  for (const [cc, categories] of Object.entries(grouped)) {
    const perCountry = out.get(cc) ?? new Map();
    for (const [category, entries] of Object.entries(categories)) {
      for (const entry of entries) {
        if (!entry?.package || !entry?.label) continue;
        const existing = perCountry.get(entry.package);
        if (existing) {
          if (!existing.categories.includes(category)) existing.categories.push(category);
        } else {
          perCountry.set(entry.package, {
            package: entry.package,
            label: entry.label,
            country: entry.country ?? cc,
            categories: [category],
            evidence: entry.evidence ?? null,
          });
        }
      }
    }
    out.set(cc, perCountry);
  }
  return out;
}

/**
 * Availability verdicts for one country's candidates, in one
 * play_availability.py subprocess (it parallelizes store checks itself).
 * Countries with a country-scoped store are checked against it alone - a Play
 * "yes" must not drown the locality question - countries without one fall back
 * to worldwide stores, where "available" tops out at community confidence.
 */
export function availabilityArgs({ country, packages, withGlobal }) {
  const args = ["fetch/play_availability.py", "--json", "--quiet", "--country", country];
  for (const pkg of packages) args.push("--package", pkg);
  if (withGlobal) args.push("--with-global");
  return args;
}

export function runAvailability({ python, country, packages, withGlobal }) {
  const args = availabilityArgs({ country, packages, withGlobal });
  const result = spawnSync(python, args, { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.error) throw new Error(`availability check could not start: ${result.error.message}`);
  // Exit 2 = "some checks were inconclusive" (throttled/blocked store) - the
  // documented daily-runner condition. The definite answers in the same payload
  // are still valid; the per-verdict statuses below skip the rest. Only a
  // contract failure (usage error, crash, non-JSON) aborts the run, the same
  // tolerance the other workflows pin.
  if (result.status !== 0 && result.status !== 2) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().slice(0, 400);
    throw new Error(`availability check for ${country} failed (exit ${result.status}): ${detail}`);
  }
  let doc;
  try {
    doc = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`availability check for ${country}: output is not JSON (${err.message})`);
  }
  const verdicts = new Map();
  for (const verdict of doc.verdicts ?? []) verdicts.set(verdict.package, verdict);
  return verdicts;
}

/** The entry a verdict justifies, or null when the answer was not definite. */
export function entryFor({ candidate, verdict, country, today, category }) {
  if (!verdict || verdict.status !== "available") return null;
  const authoritative = verdict.authoritative === true;
  const evidence = verdict.evidence || candidate.evidence;
  if (!evidence) return null;
  const entry = normalizeEntry({
    package: candidate.package,
    label: candidate.label,
    category,
    country,
    confidence: authoritative ? "verified" : "community",
    added_by: ADDED_BY,
    added_at: today,
    evidence,
    ...(authoritative ? { store: verdict.confirmed_by, verified_at: today } : {}),
  });
  return entry;
}

async function main() {
  const opts = usageGuard(USAGE, 3, () => parseArgs(process.argv.slice(2)));
  const candidates = readCandidates(opts.candidates);
  const today = new Date().toISOString().slice(0, 10);
  // The registry + tree this run acts on (LOCAL_APP_CATALOG_DATA-aware, like
  // every writer in tools/curate) - used for the already-listed pre-filter.
  const repo = loadRepo();

  const report = {
    ok: true,
    applied: opts.apply,
    candidates_file: opts.candidates,
    checked: 0,
    insertions: [],
    deferred: [],
    skipped: { already_listed: 0, unproven: 0, invalid: [] },
    by_country: {},
    inconclusive_count: 0,
  };

  // Deterministic order: countries sorted, packages sorted within a country,
  // so a re-run against an updated candidates file plans the same work.
  const countries = [...candidates.keys()]
    .filter((cc) => !opts.country || cc === opts.country)
    .sort();

  for (const country of countries) {
    const perCountry = candidates.get(country);
    const authoritative = authoritativeStoresFor(country);
    // Candidates already in the catalog (any category) are not re-checked:
    // the availability probe costs a store hit per package, every night.
    const fresh = [];
    // A package may live in only one category per country (the validator's
    // country-wide duplicate rule), so a listing anywhere in the country's
    // catalog files - not just under the nominated categories - means the
    // candidate is known and must not cost a store probe. This check has to
    // read the catalog directly: stageEntry().changed cannot detect a
    // duplicate, because insertSorted would happily insert a second copy and
    // the bytes would still differ.
    const listed = new Set();
    for (const file of repo.countries.find((c) => c.code === country)?.files ?? []) {
      for (const app of file.doc?.apps ?? []) listed.add(app.package);
    }
    for (const candidate of [...perCountry.values()].sort((a, b) =>
      a.package.localeCompare(b.package),
    )) {
      if (listed.has(candidate.package)) {
        report.skipped.already_listed += 1;
        continue;
      }
      fresh.push({ candidate, category: [...candidate.categories].sort()[0] });
    }
    if (!fresh.length) continue;

    report.checked += fresh.length;
    const verdicts = runAvailability({
      python: opts.python,
      country,
      packages: fresh.map((f) => f.candidate.package),
      withGlobal: authoritative.length === 0,
    });

    for (const { candidate, category } of fresh) {
      const verdict = verdicts.get(candidate.package);
      if (!verdict || verdict.status !== "available") {
        // unavailable is a definite "no" for a nomination; unknown/error (or a
        // missing verdict) are inconclusive. Neither becomes data, and neither
        // is retried tonight - but only the inconclusive ones count as such.
        report.skipped.unproven += 1;
        if (!verdict || verdict.status !== "unavailable") {
          report.inconclusive_count += 1;
        }
        continue;
      }
      const entry = entryFor({ candidate, verdict, country, today, category });
      if (!entry) {
        report.skipped.unproven += 1;
        continue;
      }
      const validation = validateEntry(entry);
      if (!validation.ok) {
        report.skipped.invalid.push({
          package: candidate.package,
          country,
          errors: validation.errors,
        });
        continue;
      }
      const pending = { country, category, entry, warnings: validation.warnings };
      const slot =
        report.insertions.length < opts.maxInsertions ? report.insertions : report.deferred;
      slot.push(pending);
    }
  }

  // Sort the plan before writing: stable diffs, and the cap cuts a
  // deterministic tail rather than a race-dependent one.
  const byKey = (i) => `${i.country} ${i.category} ${i.entry.package}`;
  report.insertions.sort((a, b) => byKey(a).localeCompare(byKey(b)));
  report.deferred.sort((a, b) => byKey(a).localeCompare(byKey(b)));

  if (opts.apply) {
    for (const { country, category, entry } of report.insertions) {
      stageEntry(entry, { apply: true });
      const bucket = (report.by_country[country] ??= { inserted: 0, files: new Set() });
      bucket.inserted += 1;
      bucket.files.add(`data/${country.toLowerCase()}/${category}.json`);
    }
    // Sets do not survive JSON.stringify.
    report.by_country = Object.fromEntries(
      Object.entries(report.by_country).map(([cc, v]) => [cc, { inserted: v.inserted, files: [...v.files].sort() }]),
    );
  } else {
    report.by_country = {};
  }

  if (opts.report) {
    writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (!opts.quiet) {
    const where = opts.apply ? "applied" : "planned";
    console.log(
      `${where} ${report.insertions.length} insertion(s)` +
        (report.deferred.length ? `, deferred ${report.deferred.length}` : "") +
        `, skipped ${report.skipped.already_listed} listed / ${report.skipped.unproven} unproven` +
        (report.skipped.invalid.length ? `, invalid ${report.skipped.invalid.length}` : ""),
    );
    for (const [cc, v] of Object.entries(report.by_country)) {
      console.log(`  ${cc}: ${v.inserted} -> ${v.files.join(", ")}`);
    }
    if (!opts.apply && report.insertions.length) {
      console.log("dry run: pass --apply to write");
    }
  }
  return 0;
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((err) => {
    console.error(`update-lists failed: ${err.message}`);
    process.exit(1);
  });
}
