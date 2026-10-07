import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import test from "node:test";
import {
  ENTRY_FIELD_ORDER,
  catalogPath,
  insertSorted,
  normalizeEntry,
  orderEntry,
  relCatalogPath,
  renderPrBody,
  renderPrCommands,
  stageEntry,
  unifiedDiff,
  validateEntry,
} from "../tools/curate/lib.mjs";
import { DEMOTING_CODES, demote, planDemotions } from "../tools/recheck/cli.mjs";
import { loadRepo } from "../tools/lib/load.mjs";
import { validateRepo } from "../tools/lib/rules.mjs";
import { entry, makeRepo } from "./helpers.mjs";

/** Never touch data/zz/: a country code the validator rejects, so it cannot exist. */
const SCRATCH = { country: "zz", category: "banking" };

test("validateEntry accepts a plain community entry and reports the promotion path", () => {
  const repo = loadRepo();
  const verdict = validateEntry(
    entry({ country: "TR", category: "banking", package: "tr.gov.ziraat" }),
    { repo },
  );
  assert.deepEqual(verdict.errors, []);
  assert.ok(verdict.warnings.some((w) => /community entries are the ceiling/.test(w)));
});

test("validateEntry refuses a global confusable before anything is written", () => {
  const repo = loadRepo();
  const verdict = validateEntry(
    entry({ country: "IR", category: "messaging", package: "org.telegram.messenger" }),
    { repo },
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => /data\/global\.json/.test(e)));
});

test("validateEntry refuses verified without a storefront that covers the country", () => {
  const repo = loadRepo();
  const wrongStore = validateEntry(
    entry({ country: "IR", category: "banking", confidence: "verified", store: "rustore", verified_at: "2026-10-07" }),
    { repo },
  );
  assert.ok(wrongStore.errors.some((e) => /cannot confirm locality/.test(e)));

  const impossible = validateEntry(
    entry({ country: "TR", category: "banking", confidence: "verified", store: "myket", verified_at: "2026-10-07" }),
    { repo },
  );
  assert.ok(impossible.errors.some((e) => /no store adapter can confirm locality/.test(e)));
});

test("validateEntry catches duplicates inside the country and unregistered categories", () => {
  const repo = loadRepo();
  const dup = validateEntry(
    entry({ country: "IR", category: "banking", package: "ir.tgbs.peccharge" }),
    { repo },
  );
  assert.ok(dup.errors.some((e) => /already listed/.test(e)));

  const badCategory = validateEntry(entry({ country: "IR", category: "nonsense" }), { repo });
  assert.ok(badCategory.errors.some((e) => /categories/.test(e)));
});

test("normalizeEntry trims, uppercases the country, and orders fields canonically", () => {
  const normalized = normalizeEntry({
    evidence: "  https://example.com/app  ",
    package: " com.example.app ",
    country: " ir ",
    label: "Example",
    category: "banking",
    blank: "   ",
  });
  assert.equal(normalized.country, "IR");
  assert.equal(normalized.evidence, "https://example.com/app");
  assert.equal("blank" in normalized, false);
  const keys = Object.keys(normalized);
  assert.deepEqual(keys, ENTRY_FIELD_ORDER.filter((k) => k in normalized));
});

test("orderEntry puts known fields first without dropping anything unknown", () => {
  const ordered = orderEntry({ notes: "hi", package: "com.example.app", label: "L" });
  assert.deepEqual(Object.keys(ordered), ["package", "label", "notes"]);
});

test("insertSorted keeps a catalog file sorted by package id", () => {
  const apps = [{ package: "a.b" }, { package: "a.d" }];
  assert.deepEqual(
    insertSorted(apps, { package: "a.c" }).map((a) => a.package),
    ["a.b", "a.c", "a.d"],
  );
  assert.deepEqual(
    insertSorted(apps, { package: "z.z" }).map((a) => a.package),
    ["a.b", "a.d", "z.z"],
  );
});

test("stageEntry does not write unless apply is set, and diffs against a missing file", () => {
  const file = catalogPath(SCRATCH.country, SCRATCH.category);
  if (existsSync(file)) rmSync(file);
  try {
    const staged = stageEntry(
      entry({ country: SCRATCH.country, category: SCRATCH.category, package: "zz.example.app" }),
      { apply: false },
    );
    assert.equal(staged.file, relCatalogPath(SCRATCH.country, SCRATCH.category));
    assert.equal(staged.changed, true);
    assert.equal(existsSync(file), false, "dry run must not create the file");
    assert.match(staged.after, /"zz\.example\.app"/);
    assert.match(staged.before, /"apps": \[\]/);
    assert.ok(unifiedDiff({ before: staged.before, after: staged.after }).includes("+"));
  } finally {
    if (existsSync(file)) rmSync(file);
  }
});

test("renderPrBody and renderPrCommands describe the change without running git", () => {
  const proposed = entry({ country: "IR", category: "rideshare", package: "ir.example.ride" });
  const staged = stageEntry(proposed, { apply: false });
  const diff = unifiedDiff({ before: staged.before, after: staged.after });
  const result = validateRepo(loadRepo());
  const body = renderPrBody({ entries: [proposed], validation: [], diff, result });
  assert.match(body, /ir\.example\.ride/);
  assert.match(body, /## Add 1 entry to `data\/ir\/`/);
  assert.match(body, /```diff\n/);

  const commands = renderPrCommands([proposed]);
  assert.ok(commands.some((c) => c.startsWith("git checkout -b add/ir-rideshare-")));
  assert.ok(commands.every((c) => typeof c === "string"));
});

test("demote keeps provenance, drops the live claim, and records why", () => {
  const before = entry({
    package: "ru.sberbankmobile",
    country: "RU",
    confidence: "verified",
    store: "rustore",
    verified_at: "2026-10-07",
    notes: "seed",
  });
  const after = demote(before, { date: "2026-11-01", reason: "rustore says 404" });
  assert.equal(after.confidence, "legacy");
  assert.equal("verified_at" in after, false);
  assert.equal(after.store, "rustore");
  assert.equal(after.package, "ru.sberbankmobile");
  assert.equal(after.evidence, before.evidence);
  assert.match(after.notes, /^seed \| demoted 2026-11-01: rustore says 404$/);
  assert.equal(validateRepo(loadRepo()).errors.length, 0, "the fixture repo must stay clean");
});

test("planDemotions rewrites only the affected files and is idempotent", () => {
  const repo = makeRepo({
    "ir/banking.json": {
      country: "IR",
      category: "banking",
      apps: [
        entry({ package: "ir.tgbs.peccharge", confidence: "verified", store: "myket", verified_at: "2026-10-07" }),
        entry({ package: "ir.divar", confidence: "community" }),
      ],
    },
  });
  try {
    const findings = [
      {
        level: "error",
        code: "VERIFIED_NOT_LOCAL",
        where: "ir/banking.json#ir.tgbs.peccharge",
        message: "myket does not list it for IR (404)",
      },
      // a package the file does not contain must be ignored, not crash
      { level: "error", code: "STORE_UNAVAILABLE", where: "ir/banking.json#ir.gone", message: "404" },
    ];
    const plan = planDemotions({ findings, date: "2026-11-01", dataDir: repo.dir });
    assert.equal(plan.size, 1);
    const file = plan.get("ir/banking.json");
    assert.deepEqual(file.packages, ["ir.tgbs.peccharge"]);

    const doc = JSON.parse(file.after);
    assert.equal(doc.apps[0].confidence, "legacy");
    assert.equal("verified_at" in doc.apps[0], false);
    assert.equal(doc.apps[1].confidence, "community");
    assert.ok(unifiedDiff({ before: file.before, after: file.after }).includes("-      \"confidence\": \"verified\""));

    // running the planner again on the already-demoted content plans nothing
    const again = planDemotions({
      findings: findings.slice(0, 1),
      date: "2026-11-02",
      dataDir: repo.dir,
      readFile: () => file.after,
    });
    assert.deepEqual(again.get("ir/banking.json").packages, []);
  } finally {
    repo.cleanup();
  }
});

test("STORE_UNVERIFIABLE alone never demotes an entry", () => {
  assert.equal(DEMOTING_CODES.has("STORE_UNVERIFIABLE"), false);
  assert.equal(DEMOTING_CODES.has("VERIFIED_NOT_LOCAL"), true);
  assert.equal(DEMOTING_CODES.has("STORE_UNAVAILABLE"), true);
});
