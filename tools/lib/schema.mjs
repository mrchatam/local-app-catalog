import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { SCHEMA_PATH } from "./paths.mjs";

/** Stable schema $ids, shared by the validator, the curate UI, and tests. */
export const SCHEMA_URI = {
  root: "https://localappcatalog.org/schema/v1/schema.json",
  packageId: "https://localappcatalog.org/schema/v1/package-id.json",
  category: "https://localappcatalog.org/schema/v1/category.json",
  confidence: "https://localappcatalog.org/schema/v1/confidence.json",
  appEntry: "https://localappcatalog.org/schema/v1/app-entry.json",
  catalogFile: "https://localappcatalog.org/schema/v1/catalog-file.json",
  index: "https://localappcatalog.org/schema/v1/index.json",
  globalFile: "https://localappcatalog.org/schema/v1/global-file.json",
};

export function readSchemaBundle() {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
}

/**
 * Compile the schema bundle once, exposing a validator per embedded $id.
 * Ajv resolves the cross-references (appEntry -> packageId/category/confidence)
 * because every def carries an absolute $id inside the same document.
 */
export function createValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(readSchemaBundle());

  const pick = (uri) => {
    const fn = ajv.getSchema(uri);
    if (!fn) throw new Error(`schema not registered: ${uri}`);
    fn.uri = uri;
    return fn;
  };

  return {
    ajv,
    appEntry: pick(SCHEMA_URI.appEntry),
    catalogFile: pick(SCHEMA_URI.catalogFile),
    index: pick(SCHEMA_URI.index),
    globalFile: pick(SCHEMA_URI.globalFile),
    packageId: pick(SCHEMA_URI.packageId),
  };
}

/** Render Ajv errors as compact "instancePath: message" strings. */
export function formatAjvErrors(errors) {
  return (errors ?? []).map((e) => {
    const where = e.instancePath === "" ? "/" : e.instancePath;
    return `${where} ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ""}`;
  });
}
