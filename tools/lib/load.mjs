import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, GLOBAL_PATH, INDEX_PATH } from "./paths.mjs";

function readJson(file) {
  const text = readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path.relative(DATA_DIR, file)}: invalid JSON (${err.message})`);
  }
}

/**
 * A country folder name is the lowercase ISO code; files inside are <category>.json.
 * Loads every country folder that exists and every .json inside it.
 */
export function loadRepo({ dataDir = DATA_DIR } = {}) {
  const index = readJson(path.join(dataDir, "index.json"));
  const global = readJson(GLOBAL_PATH);

  const countries = [];
  for (const name of readdirSync(dataDir).sort()) {
    if (!/^[a-z]{2}$/.test(name)) continue;
    const dir = path.join(dataDir, name);
    if (!statSync(dir).isDirectory()) continue;

    const files = [];
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(dir, entry);
      files.push({
        file,
        relPath: path.posix.join("data", name, entry),
        fileName: entry,
        expectedCategory: entry.slice(0, -".json".length),
        folder: name,
        doc: readJson(file),
      });
    }
    countries.push({ code: name.toUpperCase(), folder: name, dir, files });
  }

  return { index, global, countries, dataDir };
}

/** Flat list of every entry with its origin, for rule checks and bundling. */
export function flattenEntries(repo) {
  const out = [];
  for (const country of repo.countries) {
    for (const file of country.files) {
      const apps = Array.isArray(file.doc?.apps) ? file.doc.apps : [];
      for (const app of apps) {
        out.push({ app, file, folderCode: country.code });
      }
    }
  }
  return out;
}

export function loadFile(relPath) {
  return readJson(path.join(DATA_DIR, relPath));
}
