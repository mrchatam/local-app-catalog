import assert from "node:assert/strict";
import test from "node:test";
import {
  BUNDLE_FORMAT,
  buildAllBundle,
  buildCountryBundle,
  buildManifest,
  renderChecksums,
} from "../tools/lib/bundle.mjs";
import { loadRepo } from "../tools/lib/load.mjs";
import { entry, makeRepo } from "./helpers.mjs";

const REPO = loadRepo();

test("every country folder yields a self-contained bundle", () => {
  assert.ok(REPO.countries.length >= 3, "expected the shipped catalog to cover several countries");
  for (const country of REPO.countries) {
    const bundle = buildCountryBundle(REPO, country.code, { release: "v2026.10.07" });
    assert.equal(bundle.format, BUNDLE_FORMAT);
    assert.equal(bundle.release, "v2026.10.07");
    assert.equal(bundle.country, country.code);
    assert.ok(bundle.globals.length > 0, `${country.code} bundle carries no global negative catalog`);
    assert.ok(bundle.categories.length > 0);
    assert.ok(Object.keys(bundle.packages).length > 0);
    // the payload must be sorted and duplicate-free per category
    for (const [category, packages] of Object.entries(bundle.packages)) {
      assert.deepEqual(packages, [...packages].sort(), `${country.code}/${category} is not sorted`);
      assert.equal(new Set(packages).size, packages.length);
    }
    // entries agree with the payload
    for (const app of bundle.entries) {
      assert.equal(app.country, country.code);
      assert.ok(bundle.packages[app.category].includes(app.package));
    }
  }
});

test("bundles are deterministic: same data and tag, byte-identical output", () => {
  const a = JSON.stringify(buildAllBundle(REPO, { release: "v2026.10.07" }));
  const b = JSON.stringify(buildAllBundle(REPO, { release: "v2026.10.07" }));
  assert.equal(a, b);
});

test("the all-countries bundle covers every folder and no phantom ones", () => {
  const bundle = buildAllBundle(REPO, { release: "v2026.10.07" });
  const folders = REPO.countries.map((c) => c.code).sort();
  assert.deepEqual(bundle.countries, folders);
  const summed = folders.reduce((n, code) => n + bundle.countries_detail[code].counts.entries, 0);
  assert.equal(summed, bundle.counts.entries);
  assert.equal(new Set(bundle.packages).size, bundle.packages.length);
});

test("legacy entries stay in the bundle but never in the bypass payload", () => {
  const repo = makeRepo({
    "ir/banking.json": {
      country: "IR",
      category: "banking",
      apps: [
        entry({ package: "ir.dead.bank", confidence: "legacy" }),
        entry({ package: "ir.live.bank" }),
      ],
    },
  });
  try {
    const loaded = loadRepo({ dataDir: repo.dir });
    const bundle = buildCountryBundle(loaded, "IR", { release: "v2026.10.07" });
    assert.deepEqual(bundle.packages.banking, ["ir.live.bank"]);
    assert.equal(bundle.entries.length, 2);
    assert.equal(bundle.counts.legacy_entries, 1);
    assert.equal(bundle.counts.active_entries, 1);
  } finally {
    repo.cleanup();
  }
});

test("checksums render in sha256sum -c format and manifest excludes itself", () => {
  const artifacts = [
    { name: "catalog-ir.json", bytes: 10, sha256: "a".repeat(64) },
    { name: "catalog-all.json", bytes: 20, sha256: "b".repeat(64) },
  ];
  const text = renderChecksums(artifacts);
  assert.match(text, /^[0-9a-f]{64}  catalog-all\.json\n[0-9a-f]{64}  catalog-ir\.json\n$/);
  const manifest = buildManifest({ release: "v2026.10.07", generatedAt: "2026-10-07T00:00:00Z", artifacts });
  assert.equal(manifest.artifact_count, 2);
  assert.equal(manifest.total_bytes, 30);
  assert.deepEqual(manifest.artifacts.map((a) => a.name), ["catalog-all.json", "catalog-ir.json"]);
});
