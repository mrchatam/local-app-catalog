import assert from "node:assert/strict";
import test from "node:test";
import { readSchemaBundle, createValidators, SCHEMA_URI } from "../tools/lib/schema.mjs";
import { PACKAGE_ID_RE, validateRepo } from "../tools/lib/rules.mjs";
import { loadRepo } from "../tools/lib/load.mjs";
import { entry, makeRepo, readJson } from "./helpers.mjs";

test("the schema bundle compiles and exposes every documented $id", () => {
  const bundle = readSchemaBundle();
  // every published $id lives either on an embedded $defs entry or (for the
  // document itself) on the root, so collect both before checking for drift
  const declared = new Set(
    [bundle.$id, ...Object.values(bundle.$defs).map((def) => def.$id)].filter(Boolean),
  );
  for (const [name, uri] of Object.entries(SCHEMA_URI)) {
    assert.ok(declared.has(uri), `SCHEMA_URI.${name} (${uri}) is missing from data/schema.json`);
  }
  const validators = createValidators();
  for (const name of ["appEntry", "catalogFile", "index", "globalFile", "packageId"]) {
    assert.equal(typeof validators[name], "function", `${name} validator is not callable`);
  }
  assert.ok(
    validators.ajv.getSchema(SCHEMA_URI.root),
    `the root schema ${SCHEMA_URI.root} is not registered with Ajv`,
  );
});

test("the shipped catalog validates clean end to end", () => {
  const result = validateRepo(loadRepo());
  assert.deepEqual(
    result.errors.map((e) => `${e.code} ${e.where}: ${e.message}`),
    [],
  );
});

test("the appEntry schema rejects unknown fields and missing requirements", () => {
  const { appEntry } = createValidators();
  assert.ok(appEntry(entry()));
  assert.ok(!appEntry({ ...entry(), surprise: true }));
  const { evidence: _drop, ...noEvidence } = entry();
  assert.ok(!appEntry(noEvidence));
});

test("the package-id pattern accepts real store ids and rejects malformed ones", () => {
  // Real ids, straight off their store listings. Uppercase segments are legal.
  const accepted = [
    "com.whatsapp",
    "ir.divar",
    "mini.video.chat",
    "com.bKash.customerapp",
    "com.amazon.mShop.android.shopping",
    "com.sbi.SBIFreedomPlus",
    "in.gov.ecourts.eCourtsServices",
    "br.com.buscape.MainPack",
    "ua.android.kredobank.prod",
  ];
  for (const id of accepted) {
    assert.ok(PACKAGE_ID_RE.test(id), `expected ${id} to be a valid package id`);
  }

  const rejected = [
    "com",
    "com.",
    ".com.app",
    "com..app",
    "com.example.app-",
    "Com.example.app",
    "com/example/app",
    "com.example app",
    "",
  ];
  for (const id of rejected) {
    assert.ok(!PACKAGE_ID_RE.test(id), `expected ${id} to be rejected`);
  }
});

test("the pattern in schema.json and the one in rules.mjs cannot drift apart", () => {
  const [pattern] = [readJson("data/schema.json").$defs.packageId.pattern];
  assert.equal(pattern, PACKAGE_ID_RE.source);
});

test("a catalog entry whose package id is malformed fails as PACKAGE_ID_FORMAT", () => {
  const repo = makeRepo({
    "ir/banking.json": {
      country: "IR",
      category: "banking",
      apps: [entry({ package: "Com.Example.Bad", country: "IR" })],
    },
  });
  try {
    const result = validateRepo(loadRepo({ dataDir: repo.dir }));
    assert.ok(result.errors.some((e) => e.code === "PACKAGE_ID_FORMAT"));
  } finally {
    repo.cleanup();
  }
});
