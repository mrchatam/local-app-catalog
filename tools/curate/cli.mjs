#!/usr/bin/env node
/**
 * Headless curation: propose an entry, see exactly what a pull request would
 * contain, and only write when you ask for it.
 *
 *   node tools/curate/cli.mjs \
 *     --country IR --category rideshare --package com.snapp.passenger \
 *     --label Snapp --evidence https://cafebazaar.ir/app/com.snapp.passenger \
 *     --added-by @me
 *
 *   node tools/curate/cli.mjs --file proposal.json --apply
 *   cat proposal.json | node tools/curate/cli.mjs --stdin --json
 *   node tools/curate/cli.mjs --country RU --category banking \
 *     --package ru.sberbankmobile --label Sberbank \
 *     --evidence https://www.rustore.ru/catalog/app/ru.sberbankmobile \
 *     --confidence verified --store rustore --verified-at 2026-10-07
 *
 * The proposal is judged by exactly the rules CI will apply on the pull
 * request (tools/lib/rules.mjs + the shipped JSON Schema), so a rejection here
 * is a rejection there. Nothing is written without `--apply`.
 *
 * Exit codes
 *   0  proposal is valid (staged or applied)
 *   1  proposal is invalid, or a staged entry introduced a repo-level error
 *   2  usage error / unreadable proposal
 */

import { readFileSync } from "node:fs";
import {
  normalizeEntry,
  orderEntry,
  relCatalogPath,
  renderPrBody,
  renderPrCommands,
  stageEntry,
  unifiedDiff,
  validateEntry,
} from "./lib.mjs";
import { loadRepo } from "../lib/load.mjs";
import { validateRepo } from "../lib/rules.mjs";
import { checkAvailability } from "../lib/availability.mjs";

const USAGE = `usage: node tools/curate/cli.mjs [options]

proposal (choose one):
  --file <path>          read a JSON proposal ({package,label,category,country,...})
  --stdin                read the JSON proposal from stdin
  --country CC --category <cat> --package <id> --label <name> --evidence <url>
                         build the proposal from flags
entry fields:
  --confidence <c>       community (default) | verified | legacy
  --store <id>           store adapter that proves locality (required for verified)
  --verified-at <date>   required alongside --store, YYYY-MM-DD
  --added-by <handle>    defaults to @<git user> or @anonymous
  --added-at <date>      defaults to today
output:
  --apply                write the entry into data/<cc>/<category>.json
  --check-stores         also ask the store adapters (network, best effort)
  --json                 print a machine-readable report
  --quiet                suppress the diff, keep the verdict
  -h, --help`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { apply: false, checkStores: false, json: false, quiet: false, stdin: false, file: null, fields: {} };
  const takeValue = (arg, next) => {
    if (next === undefined || next.startsWith("--")) throw new UsageError(`${arg} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--file":
        opts.file = takeValue(arg, argv[++i]);
        break;
      case "--stdin":
        opts.stdin = true;
        break;
      case "--apply":
        opts.apply = true;
        break;
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
        opts.fields.country = takeValue(arg, argv[++i]);
        break;
      case "--category":
        opts.fields.category = takeValue(arg, argv[++i]);
        break;
      case "--package":
        opts.fields.package = takeValue(arg, argv[++i]);
        break;
      case "--label":
        opts.fields.label = takeValue(arg, argv[++i]);
        break;
      case "--evidence":
        opts.fields.evidence = takeValue(arg, argv[++i]);
        break;
      case "--confidence":
        opts.fields.confidence = takeValue(arg, argv[++i]);
        break;
      case "--store":
        opts.fields.store = takeValue(arg, argv[++i]);
        break;
      case "--verified-at":
        opts.fields.verified_at = takeValue(arg, argv[++i]);
        break;
      case "--added-by":
        opts.fields.added_by = takeValue(arg, argv[++i]);
        break;
      case "--added-at":
        opts.fields.added_at = takeValue(arg, argv[++i]);
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) throw new UsageError(`unknown argument: ${arg}`);
        throw new UsageError(`unexpected positional argument: ${arg}`);
    }
  }
  return opts;
}

function readProposal(opts) {
  if (opts.file && opts.stdin) throw new UsageError("use --file or --stdin, not both");
  if (opts.file) {
    let text;
    try {
      text = readFileSync(opts.file, "utf8");
    } catch (err) {
      throw new UsageError(`cannot read ${opts.file}: ${err.message}`);
    }
    return parseProposal(text, opts.file);
  }
  if (opts.stdin) return parseProposal(readFileSync(0, "utf8"), "<stdin>");
  return opts.fields;
}

function parseProposal(text, where) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${where}: invalid JSON (${err.message})`);
  }
  if (Array.isArray(value)) throw new UsageError(`${where}: expected one entry object, got an array`);
  if (!value || typeof value !== "object") throw new UsageError(`${where}: expected a JSON object`);
  return value;
}

/** Fill the fields a contributor should not have to type by hand. */
function withDefaults(entry) {
  const today = new Date().toISOString().slice(0, 10);
  const out = { ...entry };
  if (!out.confidence) out.confidence = "community";
  if (!out.added_at) out.added_at = today;
  if (!out.added_by) {
    const handle =
      process.env.GITHUB_ACTOR ||
      process.env.USER ||
      process.env.USERNAME ||
      "anonymous";
    out.added_by = handle.startsWith("@") ? handle : `@${handle}`;
  }
  return orderEntry(out);
}

function printVerdict(entry, verdict) {
  for (const message of verdict.errors) console.log(`error ${message}`);
  for (const message of verdict.warnings) console.log(`warn  ${message}`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${USAGE}\n${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  let entry;
  try {
    entry = withDefaults(normalizeEntry(readProposal(opts)));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${USAGE}\n${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  if (!entry.country || !entry.category || !entry.package) {
    console.error(`${USAGE}\nmissing required field(s): ${["country", "category", "package"].filter((k) => !entry[k]).join(", ")}`);
    process.exit(2);
  }

  const repo = loadRepo();
  const verdict = validateEntry(entry, { repo });

  if (opts.json) {
    console.log(
      JSON.stringify(
        { ok: verdict.ok, stageable: verdict.ok, entries: [entry], errors: verdict.errors, warnings: verdict.warnings },
        null,
        2,
      ),
    );
    process.exit(verdict.ok ? 0 : 1);
  }

  if (!verdict.ok) {
    console.error(`rejected ${entry.package} for ${entry.country}/${entry.category}`);
    printVerdict(entry, verdict);
    console.error("\nnothing was written.");
    process.exit(1);
  }

  const staged = stageEntry(entry, { apply: opts.apply });
  const diff = unifiedDiff({ before: staged.before, after: staged.after, from: `a/${staged.file}`, to: `b/${staged.file}` });

  // Re-run the full repo validation: a locally valid entry can still collide
  // with something else in the tree, and CI will notice.
  const result = validateRepo(loadRepo());
  const newErrors = result.errors.filter((f) => f.where === staged.file && f.level === "error");

  if (!opts.quiet) {
    printVerdict(entry, verdict);
    if (diff) {
      console.log(`\n${opts.apply ? "wrote" : "would write"} ${staged.file}\n`);
      console.log(diff.trimEnd());
    } else {
      console.log(`\n${staged.file} already contains this entry unchanged.`);
    }
    if (newErrors.length) {
      console.log("\nrepo validation now reports:");
      for (const e of newErrors) console.log(`  error ${e.code} ${e.where}: ${e.message}`);
    }
  }

  let availability = null;
  if (opts.checkStores) {
    availability = await checkAvailability(loadRepo(), {
      country: entry.country,
      onProgress: (code, count) => (opts.quiet ? undefined : console.error(`checking ${code} (${count} packages) ...`)),
    });
    for (const finding of availability.findings) {
      console.log(`${finding.level === "error" ? "error" : "warn "} ${finding.code.padEnd(22)} ${finding.where}\n      ${finding.message}`);
    }
  }

  const prBody = renderPrBody({
    entries: [entry],
    validation: verdict.warnings,
    diff,
    result,
  });
  if (!opts.quiet) {
    console.log("\n--- pull request body -------------------------------------------");
    console.log(prBody);
    console.log("\n--- pull request commands ---------------------------------------");
    console.log(renderPrCommands([entry]).join("\n"));
  }

  if (newErrors.length > 0) {
    console.error(`\n${newErrors.length} repo-level error(s) after staging; fix before opening the PR.`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`curate failed: ${err.stack ?? err.message}`);
  process.exit(1);
});
