#!/usr/bin/env node
/**
 * Nightly recheck: re-ask the country-scoped store adapters about every
 * `verified` entry and demote the ones that are gone.
 *
 *   node tools/recheck/cli.mjs                 # report only (dry run)
 *   node tools/recheck/cli.mjs --apply         # write the demotions
 *   node tools/recheck/cli.mjs --country RU --apply
 *   node tools/recheck/cli.mjs --json > r.json && node tools/recheck/cli.mjs --apply --plan r.json
 *
 * Demotion means `confidence` becomes `legacy`: the entry stays in the file
 * (history and package ids are worth keeping) but leaves every bundle, so a
 * consumer's bypass list stops carrying a dead package.
 *
 * Only a *definite* answer demotes. Store adapters are constantly blocked,
 * rate-limited or geo-fenced from CI runners, and a throttled run must never
 * erase good data - anything inconclusive is reported as a warning instead.
 *
 * Exit codes
 *   0  nothing to demote (or demotions applied)
 *   1  demotions are needed but --apply was not given, or the safety cap tripped
 *   2  nothing demoted, but some verified entries could not be rechecked
 *   3  usage error
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_DIR } from "../lib/paths.mjs";
import { UsageError, need, needInt, needCountry, usageGuard } from "../lib/args.mjs";
import { loadRepo } from "../lib/load.mjs";
import { validateRepo } from "../lib/rules.mjs";
import { checkAvailability } from "../lib/availability.mjs";
import { unifiedDiff } from "../lib/diff.mjs";
import { orderEntry } from "../curate/lib.mjs";

const USAGE = `usage: node tools/recheck/cli.mjs [--apply] [--country CC] [--json] [--quiet]
       [--max-demotions N] [--force] [--python <exe>] [--plan <file>]

Re-ask the country-scoped stores about every \`verified\` entry and demote any
whose listing is gone. Only a definite answer demotes; a blocked or throttled
runner is reported as inconclusive and never erases data.

--plan <file> applies a report this tool wrote earlier with --json instead of
asking the stores again. That is how the nightly workflow demotes: it reports
once and then applies exactly those findings, so a second, flaky probe can
neither invent a demotion nor silently drop one the report announced.
--plan cannot be combined with --country (the report already names its scope).

Exit codes
  0  nothing to demote, or demotions applied and the catalog still validates
  1  demotions are pending without --apply, or the --max-demotions cap tripped
  2  nothing demoted, but some verified entries could not be rechecked
  3  usage error`;

/**
 * Only these codes justify a demotion: both mean a country-scoped storefront
 * gave a definite answer. STORE_UNVERIFIABLE deliberately is not here - it is
 * exactly the "we could not reach the store" case that must not delete data.
 */
export const DEMOTING_CODES = new Set(["VERIFIED_NOT_LOCAL", "STORE_UNAVAILABLE"]);

/** Default guard: more than this many demotions in one night smells like an adapter bug. */
const DEFAULT_MAX_DEMOTIONS = 25;

function parseArgs(argv) {
  const opts = {
    apply: false,
    country: null,
    json: false,
    quiet: false,
    force: false,
    plan: null,
    maxDemotions: DEFAULT_MAX_DEMOTIONS,
    python: "python3",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--apply":
        opts.apply = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "--country":
        opts.country = need(arg, argv[++i]).toUpperCase();
        break;
      case "--python":
        opts.python = need(arg, argv[++i]);
        break;
      case "--max-demotions":
        opts.maxDemotions = needInt(arg, argv[++i], { min: 0 });
        break;
      case "--plan":
        opts.plan = need(arg, argv[++i]);
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
  if (opts.plan && opts.country) {
    throw new UsageError(
      "--plan re-applies a recorded report, which already carries its own scope; drop --country",
    );
  }
  return opts;
}

export function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Read a `--json` report back in. Fails closed: a plan that does not carry a
 * usable findings array is a bad argument, not "no demotions", because the
 * quieter reading would let the nightly workflow report a takedown and then
 * apply nothing.
 */
export function readPlan(text, { file = "plan" } = {}) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${file} is not the JSON report this tool writes: ${err.message}`);
  }
  if (!Array.isArray(doc?.demoting_findings)) {
    throw new UsageError(`${file} has no demoting_findings array; write it with --json`);
  }
  const findings = doc.demoting_findings.map((finding, i) => {
    if (typeof finding?.where !== "string" || !finding.where.includes("#")) {
      throw new UsageError(`${file}: demoting_findings[${i}].where must be "<file>#<package>"`);
    }
    if (typeof finding.message !== "string" || !finding.message) {
      throw new UsageError(`${file}: demoting_findings[${i}] needs a message to record as the reason`);
    }
    if (!DEMOTING_CODES.has(finding.code)) {
      throw new UsageError(
        `${file}: demoting_findings[${i}].code ${JSON.stringify(finding.code)} is not a demoting ` +
          `code (${[...DEMOTING_CODES].join(", ")}); this report is not a demotion plan`,
      );
    }
    // Normalize to the finding shape the rest of this file filters on, so an
    // omitted `level` can never quietly drop a demotion the report announced.
    return { level: "error", code: finding.code, where: finding.where, message: finding.message };
  });
  return {
    findings,
    inconclusiveCount: Number.isInteger(doc.inconclusive_count) ? doc.inconclusive_count : 0,
    countriesChecked: Array.isArray(doc.checked) ? doc.checked : [],
  };
}

/** Read and parse `--plan <file>`. Separate from readPlan so the I/O error is a usage error too. */
function readPlanFile(file) {
  let text;
  try {
    text = readFileSync(path.resolve(file), "utf8");
  } catch (err) {
    throw new UsageError(
      `--plan ${file}: ${err.code === "ENOENT" ? "no such file" : err.message}`,
    );
  }
  return readPlan(text, { file });
}

/** Write the planned rewrites. Exported so tests can drive it against a fixture. */
export function applyDemotions(files, { writeFile = writeFileSync } = {}) {
  let written = 0;
  for (const file of files.values()) {
    writeFile(file.abs, file.after);
    written += file.packages.length;
  }
  return written;
}

/** Demote one entry, keeping its provenance and recording why. */
export function demote(app, { date, reason }) {
  const note = `demoted ${date}: ${reason}`;
  const previous = typeof app.notes === "string" && app.notes.trim() ? `${app.notes.trim()} | ` : "";
  const next = { ...app };
  next.confidence = "legacy";
  delete next.verified_at; // verified_at is a live claim; a legacy entry must not carry one
  next.notes = (previous + note).slice(0, 500);
  return orderEntry(next);
}

/**
 * Turn demoting findings into the file rewrites they imply (no writes here).
 *
 * Findings carry repo-relative paths (`data/ir/shopping.json`), so they are
 * resolved against the *loaded* data directory rather than the repo root: the
 * same `LOCAL_APP_CATALOG_DATA` override that decided what was checked must
 * also decide what a demotion writes, or a test (or an operator pointing at a
 * checkout) would edit the shipped catalog instead of the tree it just read.
 */
export function planDemotions({ findings, date, dataDir = DATA_DIR, readFile = readFileSync }) {
  const files = new Map(); // relPath -> { abs, relPath, before, after, doc, packages }
  for (const finding of findings) {
    const [relPath, pkg] = String(finding.where).split("#");
    if (!relPath || !pkg) continue;
    if (!files.has(relPath)) {
      const abs = path.join(dataDir, relPath.replace(/^data[/\\]/, ""));
      const text = readFile(abs, "utf8");
      files.set(relPath, { abs, relPath, before: text, doc: JSON.parse(text), packages: [] });
    }
    const file = files.get(relPath);
    const apps = file.doc.apps ?? [];
    const index = apps.findIndex((a) => a.package === pkg);
    if (index === -1) continue; // already demoted, renamed or moved by hand
    if (apps[index].confidence === "legacy") continue;
    apps[index] = demote(apps[index], { date, reason: finding.message });
    file.packages.push(pkg);
  }
  for (const file of files.values()) file.after = serialize(file.doc);
  return files;
}

async function main() {
  const opts = usageGuard(USAGE, 3, () => parseArgs(process.argv.slice(2)));

  const repo = loadRepo();
  let availability;
  let inconclusive;
  if (opts.plan) {
    // No store is contacted: the findings were recorded by an earlier --json
    // run, and re-asking would make the applied diff differ from the report.
    const plan = usageGuard(USAGE, 3, () => readPlanFile(opts.plan));
    availability = { findings: plan.findings, countriesChecked: plan.countriesChecked };
    inconclusive = plan.inconclusiveCount;
  } else {
    if (opts.country) {
      // `--country XX` used to check nothing and exit 0, which reads as "the
      // catalog is clean". A country nobody registered is a typo, not a result.
      opts.country = usageGuard(USAGE, 3, () =>
        needCountry("--country", opts.country, repo.index.countries),
      );
    }
    const probed = await checkAvailability(repo, {
      confidence: "verified",
      country: opts.country,
      python: opts.python,
      onProgress: (code, count) =>
        opts.quiet || opts.json ? undefined : console.error(`rechecking ${code} (${count} verified) ...`),
    });
    availability = probed;
    // STORE_UNVERIFIABLE is the only inconclusive code, so counting it is the
    // same number the JSON reports as inconclusive_count.
    inconclusive = probed.findings.filter((f) => f.code === "STORE_UNVERIFIABLE");
  }

  // A plan only carries the count of inconclusive entries (it is a demotion
  // plan, not a re-run), so report the number either way and keep the finding
  // objects when there are any.
  const inconclusiveTotal = typeof inconclusive === "number" ? inconclusive : inconclusive.length;

  const demoting = availability.findings.filter(
    (f) => f.level === "error" && DEMOTING_CODES.has(f.code),
  );

  const date = new Date().toISOString().slice(0, 10);
  const files = planDemotions({ findings: demoting, date, dataDir: repo.dataDir });
  const total = [...files.values()].reduce((n, f) => n + f.packages.length, 0);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: total === 0,
          applied: opts.apply && total > 0,
          plan: opts.plan ?? null,
          demotions: [...files.values()].flatMap((f) =>
            f.packages.map((pkg) => ({ file: f.relPath, package: pkg })),
          ),
          demoting_findings: demoting,
          inconclusive_count: inconclusiveTotal,
          checked: availability.countriesChecked,
        },
        null,
        2,
      ),
    );
  } else if (!opts.quiet) {
    for (const code of availability.countriesChecked) {
      const s = code.summary;
      console.log(
        `checked ${code.country}: ${code.packages} verified - available:${s.available} unavailable:${s.unavailable} unknown:${s.unknown} error:${s.error}`,
      );
    }
    if (opts.plan) {
      console.log(
        `${demoting.length} demoting finding(s) read from ${opts.plan}` +
          (inconclusiveTotal ? `, ${inconclusiveTotal} inconclusive` : ""),
      );
    }
    for (const finding of Array.isArray(inconclusive) ? inconclusive : []) {
      console.log(`warn  ${finding.code.padEnd(22)} ${finding.where}\n      ${finding.message}`);
    }
    for (const file of files.values()) {
      console.log(`\n${opts.apply ? "demoting" : "would demote"} ${file.packages.length} entr(y|ies) in ${file.relPath}`);
      console.log(unifiedDiff({ before: file.before, after: file.after, from: `a/${file.relPath}`, to: `b/${file.relPath}` }).trimEnd());
    }
    if (total === 0) console.log("no verified entry lost its listing; nothing to demote.");
  }

  if (total === 0) {
    process.exit(inconclusiveTotal > 0 ? 2 : 0);
  }

  if (total > opts.maxDemotions && !opts.force) {
    console.error(
      `\nrefusing: ${total} demotion(s) exceed --max-demotions ${opts.maxDemotions}. ` +
        `That many at once usually means an adapter broke, not that ${total} apps vanished. ` +
        `Re-run with --force if the data really is gone.`,
    );
    process.exit(1);
  }

  if (!opts.apply) {
    console.error(`\n${total} demotion(s) pending. Re-run with --apply to write them.`);
    process.exit(1);
  }

  applyDemotions(files);
  const result = validateRepo(loadRepo());
  if (!opts.quiet && !opts.json) {
    console.log(`\nwrote ${total} demotion(s) across ${files.size} file(s)`);
    console.log(`catalog: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
  }
  process.exit(result.errors.length > 0 ? 1 : 0);
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((err) => {
    console.error(`recheck failed: ${err.stack ?? err.message}`);
    process.exit(1);
  });
}
