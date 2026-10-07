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
 *   3  usage error / unreadable proposal
 */

import { readFileSync } from "node:fs";
import { UsageError, need, usageGuard } from "../lib/args.mjs";
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

/** `--file` and the entry fields all take a value; `need` refuses to eat the next flag. */
const VALUE_FLAGS = {
  "--file": (opts, value) => (opts.file = value),
  "--country": (opts, value) => (opts.fields.country = value),
  "--category": (opts, value) => (opts.fields.category = value),
  "--package": (opts, value) => (opts.fields.package = value),
  "--label": (opts, value) => (opts.fields.label = value),
  "--evidence": (opts, value) => (opts.fields.evidence = value),
  "--confidence": (opts, value) => (opts.fields.confidence = value),
  "--store": (opts, value) => (opts.fields.store = value),
  "--verified-at": (opts, value) => (opts.fields.verified_at = value),
  "--added-by": (opts, value) => (opts.fields.added_by = value),
  "--added-at": (opts, value) => (opts.fields.added_at = value),
};

function parseArgs(argv) {
  const opts = { apply: false, checkStores: false, json: false, quiet: false, stdin: false, file: null, fields: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (Object.hasOwn(VALUE_FLAGS, arg)) {
      VALUE_FLAGS[arg](opts, need(arg, argv[++i]));
      continue;
    }
    switch (arg) {
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
  const opts = usageGuard(USAGE, 3, () => parseArgs(process.argv.slice(2)));

  const entry = usageGuard(USAGE, 3, () => withDefaults(normalizeEntry(readProposal(opts))));

  if (!entry.country || !entry.category || !entry.package) {
    usageGuard(USAGE, 3, () => {
      throw new UsageError(
        `missing required field(s): ${["country", "category", "package"].filter((k) => !entry[k]).join(", ")}`,
      );
    });
  }

  const repo = loadRepo();
  const verdict = validateEntry(entry, { repo });

  // A proposal that fails the entry rules is rejected before anything is
  // staged or any store is contacted. The JSON and human paths must agree on
  // that verdict, so both are printed from here.
  if (!verdict.ok) {
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            changed: false,
            applied: false,
            entries: [entry],
            errors: verdict.errors,
            warnings: verdict.warnings,
            repo_errors: [],
            availability: null,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`rejected ${entry.package} for ${entry.country}/${entry.category}`);
      printVerdict(entry, verdict);
      console.error("\nnothing was written.");
    }
    process.exit(1);
  }

  const staged = stageEntry(entry, { apply: opts.apply });
  const diff = unifiedDiff({ before: staged.before, after: staged.after, from: `a/${staged.file}`, to: `b/${staged.file}` });

  // Re-run the full repo validation: a locally valid entry can still collide
  // with something else in the tree, and CI will notice. The `--json` report has
  // to see this too - reporting `ok: true` on a proposal that breaks the repo
  // would let an automation merge through a check a human would have failed.
  const result = validateRepo(loadRepo());
  const newErrors = result.errors.filter((f) => f.where === staged.file && f.level === "error");
  const ok = newErrors.length === 0;

  // Availability is asked for explicitly and reported by both paths; it used to
  // be silently skipped whenever --json was passed.
  let availability = null;
  if (opts.checkStores) {
    availability = await checkAvailability(loadRepo(), {
      country: entry.country,
      onProgress: (code, count) =>
        opts.quiet || opts.json ? undefined : console.error(`checking ${code} (${count} packages) ...`),
    });
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok,
          changed: diff !== "",
          applied: Boolean(opts.apply) && diff !== "",
          file: staged.file,
          entries: [entry],
          errors: verdict.errors,
          warnings: verdict.warnings,
          repo_errors: newErrors,
          availability: availability
            ? {
                verdicts: [...availability.verdicts.values()],
                findings: availability.findings,
              }
            : null,
        },
        null,
        2,
      ),
    );
    process.exit(ok ? 0 : 1);
  }

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

  if (availability) {
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
