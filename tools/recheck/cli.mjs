#!/usr/bin/env node
/**
 * Nightly recheck: re-ask the country-scoped store adapters about every
 * `verified` entry and demote the ones that are gone.
 *
 *   node tools/recheck/cli.mjs                 # report only (dry run)
 *   node tools/recheck/cli.mjs --apply         # write the demotions
 *   node tools/recheck/cli.mjs --country RU --apply
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
import { REPO_ROOT } from "../lib/paths.mjs";
import { loadRepo } from "../lib/load.mjs";
import { validateRepo } from "../lib/rules.mjs";
import { checkAvailability } from "../lib/availability.mjs";
import { unifiedDiff } from "../lib/diff.mjs";
import { orderEntry } from "../curate/lib.mjs";

const USAGE = `usage: node tools/recheck/cli.mjs [--apply] [--country CC] [--json] [--quiet]
       [--max-demotions N] [--force] [--python <exe>]`;

/**
 * Only these codes justify a demotion: both mean a country-scoped storefront
 * gave a definite answer. STORE_UNVERIFIABLE deliberately is not here - it is
 * exactly the "we could not reach the store" case that must not delete data.
 */
export const DEMOTING_CODES = new Set(["VERIFIED_NOT_LOCAL", "STORE_UNAVAILABLE"]);

/** Default guard: more than this many demotions in one night smells like an adapter bug. */
const DEFAULT_MAX_DEMOTIONS = 25;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {
    apply: false,
    country: null,
    json: false,
    quiet: false,
    force: false,
    maxDemotions: DEFAULT_MAX_DEMOTIONS,
    python: "python3",
  };
  const value = (arg, next) => {
    if (next === undefined || next.startsWith("--")) throw new UsageError(`${arg} needs a value`);
    return next;
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
        opts.country = value(arg, argv[++i]).toUpperCase();
        break;
      case "--python":
        opts.python = value(arg, argv[++i]);
        break;
      case "--max-demotions":
        opts.maxDemotions = Number.parseInt(value(arg, argv[++i]), 10);
        if (!Number.isInteger(opts.maxDemotions) || opts.maxDemotions < 0) {
          throw new UsageError("--max-demotions needs a non-negative integer");
        }
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

export function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
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

/** Turn demoting findings into the file rewrites they imply (no writes here). */
export function planDemotions({ findings, date, root = REPO_ROOT, readFile = readFileSync }) {
  const files = new Map(); // relPath -> { abs, relPath, before, after, doc, packages }
  for (const finding of findings) {
    const [relPath, pkg] = String(finding.where).split("#");
    if (!relPath || !pkg) continue;
    if (!files.has(relPath)) {
      const abs = path.join(root, relPath);
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
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${USAGE}\n${err.message}`);
      process.exit(3);
    }
    throw err;
  }

  const repo = loadRepo();
  const availability = await checkAvailability(repo, {
    confidence: "verified",
    country: opts.country,
    python: opts.python,
    onProgress: (code, count) =>
      opts.quiet || opts.json ? undefined : console.error(`rechecking ${code} (${count} verified) ...`),
  });

  const demoting = availability.findings.filter(
    (f) => f.level === "error" && DEMOTING_CODES.has(f.code),
  );
  const inconclusive = availability.findings.filter((f) => f.code === "STORE_UNVERIFIABLE");

  const date = new Date().toISOString().slice(0, 10);
  const files = planDemotions({ findings: demoting, date });
  const total = [...files.values()].reduce((n, f) => n + f.packages.length, 0);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: total === 0,
          applied: opts.apply && total > 0,
          demotions: [...files.values()].flatMap((f) =>
            f.packages.map((pkg) => ({ file: f.relPath, package: pkg })),
          ),
          demoting_findings: demoting,
          inconclusive_count: inconclusive.length,
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
    for (const finding of inconclusive) {
      console.log(`warn  ${finding.code.padEnd(22)} ${finding.where}\n      ${finding.message}`);
    }
    for (const file of files.values()) {
      console.log(`\n${opts.apply ? "demoting" : "would demote"} ${file.packages.length} entr(y|ies) in ${file.relPath}`);
      console.log(unifiedDiff({ before: file.before, after: file.after, from: `a/${file.relPath}`, to: `b/${file.relPath}` }).trimEnd());
    }
    if (total === 0) console.log("no verified entry lost its listing; nothing to demote.");
  }

  if (total === 0) {
    process.exit(inconclusive.length > 0 ? 2 : 0);
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

  for (const file of files.values()) writeFileSync(file.abs, file.after);
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
