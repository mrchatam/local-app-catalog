#!/usr/bin/env node
/**
 * Build the release artifacts published on GitHub Releases.
 *
 *   node tools/build/cli.mjs                 # tag = v<today>
 *   node tools/build/cli.mjs --tag v2026.10.07 --out dist
 *   node tools/build/cli.mjs --validate      # refuse to build a failing catalog
 *
 * Produces, in --out:
 *   catalog-all.json        every country, plus the global (negative) catalog
 *   catalog-<cc>.json       one self-contained bundle per country
 *   SHA256SUMS              sha256 of every artifact, in sha256sum -c format
 *   manifest.json           release tag, counts, artifact sizes and hashes
 *
 * The build is deterministic: the same commit and tag produce byte-identical
 * bundles, so a consumer that pins a release URL can verify the checksum.
 *
 * Exit codes
 *   0  built
 *   1  build failure (validation refused, unusable SOURCE_DATE_EPOCH)
 *   3  usage error (bad flag, missing value, malformed tag)
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DIST_DIR } from "../lib/paths.mjs";
import { UsageError, need, usageGuard } from "../lib/args.mjs";
import { loadRepo } from "../lib/load.mjs";
import { validateRepo } from "../lib/rules.mjs";
import { buildAllBundle, buildCountryBundle, buildManifest, renderChecksums } from "../lib/bundle.mjs";

const USAGE = `usage: node tools/build/cli.mjs [--tag vYYYY.MM.DD] [--out dist] [--validate] [--quiet]
       --release is an alias for --tag.

Exit codes: 0 built, 1 build failure, 3 usage error.

Deterministic by default: pass SOURCE_DATE_EPOCH (seconds since the Unix epoch,
as git log -1 --format=%ct gives) to stamp manifest.json's generated_at. Without
it the build omits the timestamp entirely, so the same commit always produces
the same bytes and the same checksums.`;

/**
 * The one place the build reads a clock. SOURCE_DATE_EPOCH is the standard,
 * reproducible-builds way to pin it; unset means "no timestamp at all" rather
 * than "right now", so builds are byte-identical by default.
 */
function buildDate(env = process.env) {
  const raw = env.SOURCE_DATE_EPOCH;
  if (raw === undefined || raw === "") return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) {
    console.error(`SOURCE_DATE_EPOCH must be seconds since the epoch, got "${raw}"`);
    process.exit(1);
  }
  return new Date(seconds * 1000);
}

function parseArgs(argv) {
  const date = buildDate();
  const stamp = (date ?? new Date()).toISOString().slice(0, 10).replaceAll("-", ".");
  const opts = { tag: `v${stamp}`, out: DIST_DIR, validate: false, quiet: false, date };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--tag":
      case "--release":
        // Both are aliases; `need` stops `--tag --out dist` from naming the
        // release "--out" and then treating "dist" as a stray argument.
        opts.tag = need(argv[i], argv[++i]);
        break;
      case "--out":
        // `--out --quiet` used to write a whole release into a directory
        // literally named `--quiet` in the working tree.
        opts.out = path.resolve(need(argv[i], argv[++i]));
        break;
      case "--validate":
        opts.validate = true;
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
        throw new UsageError(`unknown argument: ${argv[i]}`);
    }
  }
  if (!/^v\d{4}\.\d{2}\.\d{2}$/.test(opts.tag)) {
    throw new UsageError(`release tag must look like vYYYY.MM.DD, got "${opts.tag}"`);
  }
  return opts;
}

/** Serialize with a stable key order and no trailing whitespace drift. */
function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function write(outDir, name, contents) {
  const file = path.join(outDir, name);
  writeFileSync(file, contents);
  return {
    name,
    bytes: Buffer.byteLength(contents),
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function main() {
  const opts = usageGuard(USAGE, 3, () => parseArgs(process.argv.slice(2)));
  const repo = loadRepo();

  const result = validateRepo(repo);
  if (opts.validate && result.errors.length > 0) {
    console.error(`refusing to build: ${result.errors.length} validation error(s)`);
    for (const e of result.errors.slice(0, 20)) console.error(`  ${e.code} ${e.where}: ${e.message}`);
    process.exit(1);
  }
  if (!opts.validate && result.errors.length > 0) {
    console.error(`warning: building with ${result.errors.length} validation error(s)`);
  }

  rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(opts.out, { recursive: true });

  const artifacts = [];
  artifacts.push(write(opts.out, "catalog-all.json", serialize(buildAllBundle(repo, { release: opts.tag }))));

  for (const country of repo.countries.map((c) => c.code).sort()) {
    const bundle = buildCountryBundle(repo, country, { release: opts.tag });
    artifacts.push(
      write(opts.out, `catalog-${country.toLowerCase()}.json`, serialize(bundle)),
    );
  }

  const generatedAt = opts.date ? opts.date.toISOString().replace(/\.\d+Z$/, "Z") : undefined;
  artifacts.push(
    write(
      opts.out,
      "manifest.json",
      serialize(buildManifest({ release: opts.tag, generatedAt, artifacts })),
    ),
  );
  artifacts.push(write(opts.out, "SHA256SUMS", renderChecksums(artifacts)));

  if (!opts.quiet) {
    const { stats } = result;
    console.log(`built ${opts.tag} in ${path.relative(process.cwd(), opts.out) || "."}`);
    console.log(`  ${artifacts.length} artifacts, ${stats.totalEntries} entries, ${stats.countries} countries`);
    for (const a of artifacts.filter((a) => a.name.startsWith("catalog-"))) {
      console.log(`  ${a.name.padEnd(24)} ${String(a.bytes).padStart(8)} B  ${a.sha256.slice(0, 16)}...`);
    }
  }
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error(`build failed: ${err.stack ?? err.message}`);
  process.exit(1);
}
