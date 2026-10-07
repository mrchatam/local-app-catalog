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
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DIST_DIR } from "../lib/paths.mjs";
import { loadRepo } from "../lib/load.mjs";
import { validateRepo } from "../lib/rules.mjs";
import { buildAllBundle, buildCountryBundle, buildManifest, renderChecksums } from "../lib/bundle.mjs";

const USAGE = `usage: node tools/build/cli.mjs [--tag vYYYY.MM.DD] [--out dist] [--validate] [--quiet]`;

function parseArgs(argv) {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", ".");
  const opts = { tag: `v${stamp}`, out: DIST_DIR, validate: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--tag":
      case "--release":
        opts.tag = argv[++i] ?? opts.tag;
        break;
      case "--out":
        opts.out = path.resolve(argv[++i] ?? opts.out);
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
        console.error(`${USAGE}\nunknown argument: ${argv[i]}`);
        process.exit(1);
    }
  }
  if (!/^v\d{4}\.\d{2}\.\d{2}$/.test(opts.tag)) {
    console.error(`release tag must look like vYYYY.MM.DD, got "${opts.tag}"`);
    process.exit(1);
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
  const opts = parseArgs(process.argv.slice(2));
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

  const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
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
