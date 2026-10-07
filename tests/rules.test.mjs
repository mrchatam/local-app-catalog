import assert from "node:assert/strict";
import test from "node:test";
import { validateRepo } from "../tools/lib/rules.mjs";
import { loadRepo } from "../tools/lib/load.mjs";
import { entry, makeRepo } from "./helpers.mjs";

/** Validate a fixture and return { codes, result }; always cleans up. */
function check(files, options) {
  const repo = makeRepo(files, options);
  try {
    return validateRepo(loadRepo({ dataDir: repo.dir }));
  } finally {
    repo.cleanup();
  }
}

const base = (name) => ({
  country: "IR",
  category: name,
  apps: [entry({ category: name })],
});

test("a well-formed country file produces no findings", () => {
  const result = check({ "ir/banking.json": base("banking") });
  assert.deepEqual(result.findings, []);
  assert.equal(result.stats.totalEntries, 1);
});

test("GLOBAL_CONFLICT: a global confusable cannot be claimed as local", () => {
  const result = check({
    "ir/wallet.json": {
      country: "IR",
      category: "wallet",
      apps: [entry({ category: "wallet", package: "com.google.android.apps.walletnfcrel" })],
    },
  });
  assert.ok(result.errors.some((e) => e.code === "GLOBAL_CONFLICT"));
});

test("DUPLICATE_PACKAGE: the same package twice in one country, even across categories", () => {
  const result = check({
    "ir/banking.json": base("banking"),
    "ir/wallet.json": {
      country: "IR",
      category: "wallet",
      apps: [entry({ category: "wallet" })],
    },
  });
  assert.ok(result.errors.some((e) => e.code === "DUPLICATE_PACKAGE"));
});

test("COUNTRY_FOLDER_MISMATCH / CATEGORY_FILENAME_MISMATCH flag misplaced files", () => {
  const result = check({
    "ir/banking.json": {
      country: "TR",
      category: "wallet",
      apps: [entry({ country: "TR", category: "wallet" })],
    },
  });
  const codes = result.errors.map((e) => e.code);
  assert.ok(codes.includes("COUNTRY_FOLDER_MISMATCH"));
  assert.ok(codes.includes("CATEGORY_FILENAME_MISMATCH"));
});

test("COUNTRY_NOT_IN_INDEX / CATEGORY_NOT_IN_INDEX keep the registry authoritative", () => {
  const result = check({
    "zz/banking.json": {
      country: "ZZ",
      category: "banking",
      apps: [entry({ country: "ZZ" })],
    },
  });
  const codes = result.errors.map((e) => e.code);
  assert.ok(codes.includes("COUNTRY_NOT_IN_INDEX"));
});

test("CATEGORY_NOT_IN_INDEX rejects an unregistered category", () => {
  const result = check({
    "ir/shopping.json": {
      country: "IR",
      category: "shopping",
      apps: [entry({ category: "shopping" })],
    },
  }, {
    index: {
      countries: ["IR"],
      categories: ["banking"],
      updated: "2026-10-07",
      version: 1,
    },
  });
  assert.ok(result.errors.some((e) => e.code === "CATEGORY_NOT_IN_INDEX"));
});

test("evidence must be an https URL", () => {
  const result = check({
    "ir/banking.json": {
      country: "IR",
      category: "banking",
      apps: [entry({ evidence: "http://cafebazaar.ir/app/ir.divar" })],
    },
  });
  assert.ok(result.errors.some((e) => e.code === "EVIDENCE_NOT_HTTPS"));
});

test("verified requires verified_at, and verified_at is meaningless on community", () => {
  const missing = check({
    "ir/banking.json": {
      country: "IR",
      category: "banking",
      apps: [entry({ confidence: "verified" })],
    },
  });
  assert.ok(missing.errors.some((e) => e.code === "VERIFIED_WITHOUT_DATE"));

  const stray = check({
    "ir/banking.json": {
      country: "IR",
      category: "banking",
      apps: [entry({ confidence: "community", verified_at: "2026-03-01" })],
    },
  });
  assert.ok(stray.warnings.some((w) => w.code === "STALE_VERIFIED_AT"));
});

test("verified must be backed by a storefront that covers its own country", () => {
  const withStore = (overrides) => ({
    country: "IR",
    category: "banking",
    apps: [entry({ confidence: "verified", verified_at: "2026-03-01", ...overrides })],
  });

  const noStore = check({ "ir/banking.json": withStore({}) });
  assert.ok(noStore.errors.some((e) => e.code === "VERIFIED_WITHOUT_STORE"));

  const wrongCountry = check({ "ir/banking.json": withStore({ store: "rustore" }) });
  assert.ok(wrongCountry.errors.some((e) => e.code === "VERIFIED_STORE_NOT_LOCAL"));

  const good = check({ "ir/banking.json": withStore({ store: "myket" }) });
  assert.equal(good.errors.length, 0);
});

test("VERIFY_IMPOSSIBLE blocks verified where no country-scoped adapter exists", () => {
  const result = check({
    "tr/banking.json": {
      country: "TR",
      category: "banking",
      apps: [
        entry({
          country: "TR",
          confidence: "verified",
          verified_at: "2026-03-01",
          store: "myket",
        }),
      ],
    },
  });
  assert.ok(result.errors.some((e) => e.code === "VERIFY_IMPOSSIBLE"));
});

test("UNKNOWN_STORE rejects a store id no adapter implements", () => {
  const result = check({
    "ir/banking.json": {
      country: "IR",
      category: "banking",
      apps: [entry({ store: "samsung_galaxy_store" })],
    },
  });
  assert.ok(result.errors.some((e) => e.code === "UNKNOWN_STORE"));
});

test("ADDED_AT_IN_FUTURE rejects a date that has not happened yet", () => {
  const result = check({
    "ir/banking.json": {
      country: "IR",
      category: "banking",
      apps: [entry({ added_at: "2999-01-01" })],
    },
  });
  assert.ok(result.errors.some((e) => e.code === "ADDED_AT_IN_FUTURE"));
});

test("MULTI_COUNTRY_PACKAGE warns but does not block a regional app", () => {
  const result = check({
    "ir/banking.json": base("banking"),
    "tr/banking.json": {
      country: "TR",
      category: "banking",
      apps: [entry({ country: "TR" })],
    },
  });
  assert.ok(result.warnings.some((w) => w.code === "MULTI_COUNTRY_PACKAGE"));
  assert.equal(result.errors.length, 0);
});

test("INDEX_UPDATED_STALE warns when the registry date lags the newest entry", () => {
  const result = check(
    {
      "ir/banking.json": {
        country: "IR",
        category: "banking",
        apps: [entry({ added_at: "2026-06-01" })],
      },
    },
    { index: { countries: ["IR"], categories: ["banking"], updated: "2026-01-01", version: 1 } },
  );
  assert.ok(result.warnings.some((w) => w.code === "INDEX_UPDATED_STALE"));
});

test("a malformed JSON file fails loudly instead of being skipped", () => {
  const repo = makeRepo({ "ir/banking.json": "{ this is not json" });
  try {
    assert.throws(() => loadRepo({ dataDir: repo.dir }), /invalid JSON/);
  } finally {
    repo.cleanup();
  }
});
