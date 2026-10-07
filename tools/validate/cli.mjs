#!/usr/bin/env node
/**
 * LocalAppCatalog CI validator.
 *
 *   node tools/validate/cli.mjs                  # schema + semantic rules (no network)
 *   node tools/validate/cli.mjs --check-stores   # also ask the store adapters
 *   node tools/validate/cli.mjs --json           # machine-readable report
 *   node tools/validate/cli.mjs --country IR     # limit findings to one country
 *
 * Exit codes
 *   0  clean
 *   1  validation errors (schema, duplicate package, global conflict, dead listing)
 *   2  no errors, but at least one store check was inconclusive (blocked or
 *      rate-limited runner). Advisory: the network-free pass is the merge gate.
 *   3  usage error (bad flag, missing value, unregistered country)
 */

import { UsageError, need, needInt, needCountry, usageGuard } from "../lib/args.mjs";
import { loadRepo } from "../lib/load.mjs";
import { validateRepo } from "../lib/rules.mjs";
import { checkAvailability } from "../lib/availability.mjs";

const USAGE = `usage: node tools/validate/cli.mjs [--check-stores] [--country CC] [--json] [--quiet]
       [--max-messages N]

Exit codes: 0 clean, 1 validation errors, 2 store check inconclusive, 3 usage error.`;

function parseArgs(argv) {
  const opts = {
    checkStores: false,
    country: null,
    json: false,
    quiet: false,
    maxMessages: 200,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--check-stores":
        opts.checkStores = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "--country":
        // Shape-checked here, registration-checked against data/index.json once
        // the repo is loaded: `--country XX` must not look like a clean run.
        opts.country = need(arg, argv[++i]).toUpperCase();
        break;
      case "--max-messages":
        opts.maxMessages = needInt(arg, argv[++i], { min: 0 });
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
  return opts;
}

function inScope(finding, country) {
  if (!country) return true;
  if (finding.code === "INDEX_SCHEMA" || finding.code === "GLOBAL_SCHEMA") return true;
  return finding.where.startsWith(`data/${country.toLowerCase()}/`);
}

function report(findings, opts) {
  const order = { error: 0, warn: 1 };
  const sorted = [...findings].sort(
    (a, b) => order[a.level] - order[b.level] || a.code.localeCompare(b.code) || a.where.localeCompare(b.where),
  );
  const seen = new Map();
  for (const f of sorted) {
    seen.set(f.code, (seen.get(f.code) ?? 0) + 1);
    if (seen.get(f.code) > opts.maxMessages) continue;
    const tag = f.level === "error" ? "error" : "warn ";
    console.log(`${tag} ${f.code.padEnd(22)} ${f.where}\n      ${f.message}`);
  }
  const truncated = sorted.filter((f) => seen.get(f.code) > opts.maxMessages).length;
  if (truncated > 0) console.log(`... ${truncated} further finding(s) suppressed by --max-messages`);
  return seen;
}

async function main() {
  const opts = usageGuard(USAGE, 3, () => parseArgs(process.argv.slice(2)));
  const repo = loadRepo();
  if (opts.country) {
    opts.country = usageGuard(USAGE, 3, () =>
      needCountry("--country", opts.country, repo.index.countries),
    );
  }
  const result = validateRepo(repo);
  let findings = result.findings.filter((f) => inScope(f, opts.country));

  let availability = null;
  if (opts.checkStores) {
    availability = await checkAvailability(repo, {
      country: opts.country,
      onProgress: (code, count) =>
        opts.quiet || opts.json ? undefined : console.error(`checking ${code} (${count} packages) ...`),
    });
    findings = findings.concat(availability.findings);
  }

  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warn");
  const storeInconclusive =
    availability?.findings.some((f) => f.code === "STORE_UNVERIFIABLE") ?? false;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: errors.length === 0,
          errors: errors.length,
          warnings: warnings.length,
          store_inconclusive: storeInconclusive,
          stats: result.stats,
          findings,
          availability: availability
            ? { countries: availability.countriesChecked, verdicts: [...availability.verdicts.values()] }
            : null,
        },
        null,
        2,
      ),
    );
  } else if (!opts.quiet) {
    report(findings, opts);
    const { stats } = result;
    console.log("");
    console.log(
      `catalog: ${stats.totalEntries} entries across ${stats.countries} country folder(s)` +
        (stats.legacyEntries ? `, ${stats.legacyEntries} legacy` : ""),
    );
    const perCategory = Object.entries(stats.perCategory).sort((a, b) => b[1] - a[1]);
    console.log(`         ${perCategory.map(([c, n]) => `${c}:${n}`).join("  ")}`);
    console.log(`         ${Object.entries(stats.perCountry).map(([c, n]) => `${c}:${n}`).join("  ")}`);
    if (availability) {
      for (const row of availability.countriesChecked) {
        const s = row.summary;
        console.log(
          `stores:  ${row.country} checked ${row.packages} - available:${s.available} unavailable:${s.unavailable} unknown:${s.unknown} error:${s.error}`,
        );
      }
    }
    console.log("");
    console.log(`${errors.length} error(s), ${warnings.length} warning(s)`);
  }

  if (errors.length > 0) process.exit(1);
  if (storeInconclusive) process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  console.error(`validator crashed: ${err.stack ?? err.message}`);
  process.exit(1);
});
