/**
 * Curation core: validate a proposed entry, place it in the right catalog file,
 * and render the PR a maintainer would review.
 *
 * The web UI (tools/curate/server.mjs) and the headless flow
 * (tools/curate/cli.mjs) both go through here, so a proposal made in a browser
 * and a proposal made in a terminal are judged by exactly the same rules -
 * and by the same rules CI will apply on the pull request.
 *
 * Nothing here writes anything until `stageEntry(..., {apply: true})`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, KNOWN_STORES, authoritativeStoresFor } from "../lib/paths.mjs";
import { PACKAGE_ID_RE } from "../lib/rules.mjs";
import { createValidators, formatAjvErrors } from "../lib/schema.mjs";
import { loadRepo } from "../lib/load.mjs";

/**
 * data/<cc>/<category>.json - the only place an entry may live.
 *
 * Fail closed on anything that escapes data/: country and category both arrive
 * from contributors, and `path.join` happily follows `..` out of the tree
 * (the curator server proved it by reading package.json through this function).
 */
export function catalogPath(country, category) {
  const root = path.resolve(DATA_DIR) + path.sep;
  const file = path.resolve(DATA_DIR, String(country).toLowerCase(), `${category}.json`);
  if (!file.startsWith(root)) {
    throw new Error(`refusing to touch ${file}: catalog files must live under ${DATA_DIR}`);
  }
  return file;
}

export function relCatalogPath(country, category) {
  return path.posix.join("data", String(country).toLowerCase(), `${category}.json`);
}

/** Load one catalog file, or an empty shell when the file does not exist yet. */
export function loadCatalog(country, category) {
  const file = catalogPath(country, category);
  if (!existsSync(file)) {
    return { country: String(country).toUpperCase(), category, apps: [] };
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Canonical field order shared with the existing catalogs, so a curated entry
 * lands next to its neighbours rather than appending keys in form order.
 */
export const ENTRY_FIELD_ORDER = [
  "package",
  "label",
  "category",
  "country",
  "confidence",
  "added_by",
  "added_at",
  "evidence",
  "store",
  "verified_at",
];

/** Reorder an entry's keys canonically; unknown keys keep their relative order. */
export function orderEntry(entry) {
  const out = {};
  for (const key of ENTRY_FIELD_ORDER) {
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  for (const [key, value] of Object.entries(entry)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/** Trim strings, uppercase the country, drop blank form fields, sort the keys. */
export function normalizeEntry(input) {
  const out = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value === undefined || value === null) continue;
    const trimmed = typeof value === "string" ? value.trim() : value;
    if (trimmed === "") continue;
    out[key] = trimmed;
  }
  if (out.country) out.country = String(out.country).toUpperCase();
  return orderEntry(out);
}

/**
 * Judge a proposal: schema, package format, global conflicts, duplicates, and
 * what `verified` would require. Returns errors (blocking) and warnings (mind
 * the gap, but a maintainer may still merge).
 */
export function validateEntry(entry, { repo = loadRepo() } = {}) {
  const errors = [];
  const warnings = [];
  const validators = createValidators();
  const country = entry.country;
  const category = entry.category;
  const covering = country ? authoritativeStoresFor(country) : [];

  if (!validators.appEntry(entry)) {
    for (const message of formatAjvErrors(validators.appEntry.errors)) {
      errors.push(`schema: ${message}`);
    }
  }

  if (country && !(repo.index.countries ?? []).includes(country)) {
    errors.push(`${country} is not registered in data/index.json#countries`);
  }
  if (category && !(repo.index.categories ?? []).includes(category)) {
    errors.push(`${category} is not registered in data/index.json#categories`);
  }

  if (entry.package && !PACKAGE_ID_RE.test(entry.package)) {
    errors.push(
      `"${entry.package}" is not a dotted package id (expected e.g. com.example.app)`,
    );
  }

  const global = new Map((repo.global.packages ?? []).map((p) => [p.package, p]));
  if (global.has(entry.package)) {
    errors.push(
      `"${entry.package}" (${global.get(entry.package).label}) is in data/global.json: ` +
        `it is a worldwide app and can never be local to ${country}`,
    );
  }

  if (entry.category) {
    const existing = loadCatalog(country, category).apps ?? [];
    if (existing.some((a) => a.package === entry.package)) {
      errors.push(`"${entry.package}" is already listed in ${relCatalogPath(country, category)}`);
    }
    for (const doc of repo.countries) {
      if (doc.code !== country) continue;
      for (const file of doc.files) {
        if (file.doc.category === category) continue;
        if ((file.doc.apps ?? []).some((a) => a.package === entry.package)) {
          errors.push(`"${entry.package}" is already listed for ${country} in ${file.relPath}`);
        }
      }
    }
  }

  // `verified` is a locality claim, so it needs a country-scoped storefront
  if (entry.confidence === "verified") {
    if (!covering.length) {
      errors.push(
        `no store adapter can confirm locality for ${country}, so this entry must stay ` +
          `"community" (adapters with a country scope: see fetch/store_adapters/)`,
      );
    } else if (!entry.store) {
      errors.push(
        `confidence "verified" requires the store listing that proves it: ` +
          `store must be one of ${covering.join(", ")}`,
      );
    } else if (!covering.includes(entry.store)) {
      errors.push(
        `store "${entry.store}" cannot confirm locality for ${country}; use one of ${covering.join(", ")}`,
      );
    }
    if (!entry.verified_at) {
      errors.push(`confidence "verified" requires verified_at (YYYY-MM-DD)`);
    }
  } else if (entry.store && !KNOWN_STORES.includes(entry.store)) {
    errors.push(`"${entry.store}" is not a store adapter (known: ${KNOWN_STORES.join(", ")})`);
  }

  if (!covering.length) {
    warnings.push(
      `${country} has no country-scoped store adapter yet, so CI cannot verify anything ` +
        `here: community entries are the ceiling until one exists`,
    );
  } else if (entry.confidence !== "verified") {
    warnings.push(
      `a maintainer can promote this to "verified" once ${covering.join(" or ")} confirms it`,
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Keep the file sorted by package id: stable ordering keeps PR diffs tiny. */
export function insertSorted(apps, entry) {
  const next = [...apps];
  const at = next.findIndex((a) => a.package > entry.package);
  next.splice(at === -1 ? next.length : at, 0, entry);
  return next;
}

/** The exact bytes a staged entry would write. */
export function stageEntry(entry, { apply = false } = {}) {
  const relPath = relCatalogPath(entry.country, entry.category);
  const doc = loadCatalog(entry.country, entry.category);
  const before = serialize(doc);
  const after = serialize({ ...doc, apps: insertSorted(doc.apps ?? [], entry) });
  if (apply) {
    const file = catalogPath(entry.country, entry.category);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, after);
  }
  return { file: relPath, before, after, changed: before !== after };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Re-exported so curator callers only need one import path. */
export { unifiedDiff } from "../lib/diff.mjs";

/** The pull request body a contributor would paste, in the repo's house style. */
export function renderPrBody({ entries, validation, diff, result }) {
  const rows = entries
    .map(
      (e) =>
        `| \`${e.package}\` | ${e.label} | ${e.category} | ${e.country} | ${e.confidence} | ${e.evidence} |`,
    )
    .join("\n");
  return [
    `## Add ${entries.length} entr${entries.length === 1 ? "y" : "ies"} to \`data/${entries[0].country.toLowerCase()}/\``,
    "",
    "| package | label | category | country | confidence | evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    rows,
    "",
    "### Checklist",
    "",
    "- [x] entry added with `npm run curate` (schema-checked before writing)",
    `- [x] \`npm run validate\` passes (${result.errors.length} errors, ${result.warnings.length} warnings locally)`,
    "- [ ] store listing reachable from the declared country",
    "- [ ] promoted to `verified` by a maintainer with a second review",
    "",
    ...(validation.length
      ? ["### Warnings raised while curating", "", ...validation.map((w) => `- ${w}`), ""]
      : []),
    "### Diff",
    "",
    "```diff",
    diff.trimEnd(),
    "```",
    "",
    "_Generated by `tools/curate`._",
  ].join("\n");
}

/** Commands that turn a staged change into a pull request. Never run for you. */
export function renderPrCommands(entries) {
  const first = entries[0];
  const branch = `add/${first.country.toLowerCase()}-${first.category}-${first.package}`.replace(
    /[^A-Za-z0-9/_.-]/g,
    "-",
  );
  return [
    `git checkout -b ${branch}`,
    `git add ${[...new Set(entries.map((e) => relCatalogPath(e.country, e.category)))].join(" ")}`,
    `git commit -m "Add ${entries.map((e) => e.package).join(", ")} to data/${first.country.toLowerCase()}/"`,
    `git push -u origin ${branch}`,
    "# then open the pull request against main",
  ];
}
