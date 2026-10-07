/**
 * Bundle format. This is the consumption contract: VPN split-tunneling clients
 * read `packages` (category -> sorted package ids) and nothing else has to
 * change when the catalog grows.
 *
 *   format            bundle format version, independent of the data version
 *   release           release tag, vYYYY.MM.DD
 *   data_version      data/index.json#version
 *   categories        every category present in this bundle, sorted
 *   packages          { "<category>": ["com.example.app", ...] } - the payload
 *   entries           full provenance (label, confidence, evidence, store)
 *   globals           package ids that must NOT bypass the tunnel
 *   counts            entries, non-legacy entries, globals
 *
 * The output is deterministic for a given (data, release tag): entries are
 * sorted by category then package, and no wall-clock timestamp is embedded, so
 * a release can be rebuilt byte-for-byte from the same commit.
 */

export const BUNDLE_FORMAT = 1;

/** Confidence levels kept out of `packages` (dead listings, kept only for history). */
const EXCLUDED_CONFIDENCE = new Set(["legacy"]);

const byCategoryThenPackage = (a, b) =>
  String(a.category).localeCompare(String(b.category)) || String(a.package).localeCompare(String(b.package));

function payloadFor(entries) {
  const packages = {};
  for (const entry of entries) {
    if (EXCLUDED_CONFIDENCE.has(entry.confidence)) continue;
    const bucket = (packages[entry.category] ??= new Set());
    bucket.add(entry.package);
  }
  const out = {};
  for (const category of Object.keys(packages).sort()) {
    out[category] = [...packages[category]].sort();
  }
  return out;
}

function globalsOf(repo) {
  return (repo.global.packages ?? []).map((p) => p.package).sort();
}

function base(repo, release) {
  return {
    format: BUNDLE_FORMAT,
    release,
    data_version: repo.index.version,
    generated_from: "data/",
    globals: globalsOf(repo),
    globals_note:
      "A client must not bypass the tunnel for these packages, in any country. Shipped inside every bundle so a single file is enough to build a bypass set.",
  };
}

export function buildCountryBundle(repo, countryCode, { release }) {
  const code = countryCode.toUpperCase();
  const country = repo.countries.find((c) => c.code === code);
  if (!country) throw new Error(`no catalog folder for ${code}`);

  const entries = [];
  for (const file of country.files) {
    for (const app of file.doc?.apps ?? []) entries.push(app);
  }
  entries.sort(byCategoryThenPackage);
  const packages = payloadFor(entries);

  return {
    ...base(repo, release),
    country: code,
    categories: Object.keys(packages),
    counts: {
      entries: entries.length,
      active_entries: entries.filter((e) => !EXCLUDED_CONFIDENCE.has(e.confidence)).length,
      legacy_entries: entries.filter((e) => EXCLUDED_CONFIDENCE.has(e.confidence)).length,
      categories: Object.keys(packages).length,
      globals: globalsOf(repo).length,
    },
    packages,
    entries,
  };
}

export function buildAllBundle(repo, { release }) {
  const countries = repo.countries.map((c) => c.code).sort();
  const perCountry = {};
  const entries = [];
  for (const code of countries) {
    const bundle = buildCountryBundle(repo, code, { release });
    perCountry[code] = {
      categories: bundle.categories,
      packages: bundle.packages,
      counts: bundle.counts,
    };
    for (const entry of bundle.entries) entries.push({ ...entry, country: code });
  }
  entries.sort(
    (a, b) => a.country.localeCompare(b.country) || byCategoryThenPackage(a, b),
  );

  const flat = [...new Set(entries.map((e) => e.package))].sort();
  return {
    ...base(repo, release),
    countries,
    counts: {
      countries: countries.length,
      entries: entries.length,
      active_entries: entries.filter((e) => !EXCLUDED_CONFIDENCE.has(e.confidence)).length,
      legacy_entries: entries.filter((e) => EXCLUDED_CONFIDENCE.has(e.confidence)).length,
      unique_packages: flat.length,
      globals: globalsOf(repo).length,
    },
    countries_detail: perCountry,
    packages: flat,
    entries,
  };
}

export function buildManifest({ release, generatedAt, artifacts }) {
  const manifest = {
    format: BUNDLE_FORMAT,
    release,
    artifact_count: artifacts.length,
    total_bytes: artifacts.reduce((n, a) => n + a.bytes, 0),
    checksums: "SHA256SUMS",
    artifacts: [...artifacts].sort((a, b) => a.name.localeCompare(b.name)),
  };
  // Only stamp a time when the caller pinned one (SOURCE_DATE_EPOCH). A wall
  // clock here would make two builds of the same commit differ, and the
  // manifest's own checksum is published in SHA256SUMS.
  if (generatedAt) manifest.generated_at = generatedAt;
  return manifest;
}

/** Lines in the format `sha256sum -c` expects: "<hex>  <filename>". */
export function renderChecksums(artifacts) {
  return `${[...artifacts]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `${a.sha256}  ${a.name}`)
    .join("\n")}\n`;
}
