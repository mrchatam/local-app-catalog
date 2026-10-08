import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { REPO_ROOT } from "../tools/lib/paths.mjs";

/**
 * `tools/seed/check_seed_subset.py` is the gate behind the seed proof. The
 * old check — "gen_seed.py reproduces data/ byte-for-byte" — broke the moment
 * the nightly pipeline grew data/ beyond the seed, so the contract changed:
 * every *seeded* entry must be present, deep-equal, in the tracked tree;
 * extra entries are expected. These tests pin that contract on synthetic
 * trees, offline, through the real script.
 */

const CHECKER = path.join(REPO_ROOT, "tools/seed/check_seed_subset.py");

const SEED_APP = {
  package: "com.example.seedapp",
  label: "Seed App",
  category: "banking",
  country: "BD",
  confidence: "community",
  added_by: "@local-app-catalog",
  added_at: "2026-09-30",
  evidence: "https://play.google.com/store/apps/details?id=com.example.seedapp&gl=BD&hl=en",
};

function doc(apps, extra = {}) {
  return JSON.stringify({ country: "BD", category: "banking", apps, ...extra }, null, 2) + "\n";
}

function rig({ seedApps, trackedFiles }) {
  const dir = mkdtempSync(path.join(tmpdir(), "lac-seed-subset-"));
  const seed = path.join(dir, "seed");
  const data = path.join(dir, "data");
  mkdirSync(path.join(seed, "bd"), { recursive: true });
  writeFileSync(path.join(seed, "bd", "banking.json"), doc(seedApps));
  for (const [rel, content] of Object.entries(trackedFiles)) {
    const p = path.join(data, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return { dir, seed, data, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runChecker(seed, data) {
  return spawnSync("python3", [CHECKER, seed, data], { encoding: "utf8" });
}

test("seed subset check passes when the tracked tree contains every seeded entry unchanged", (t) => {
  const r = rig({
    seedApps: [SEED_APP],
    // The tracked tree may hold MORE than the seed: a curated extra app and a
    // whole extra file the seed never produced are both expected.
    trackedFiles: {
      "bd/banking.json": doc([SEED_APP, { ...SEED_APP, package: "com.example.curated", label: "Curated" }]),
      "bd/shopping.json": doc([{ ...SEED_APP, package: "com.example.nightly", label: "Nightly", category: "shopping" }]),
    },
  });
  t.after(r.cleanup);
  const res = runChecker(r.seed, r.data);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /seed proof OK/);
});

test("seed subset check fails when a seeded entry's fields drift", (t) => {
  const r = rig({
    seedApps: [SEED_APP],
    trackedFiles: {
      // Same package, different label: provenance is broken.
      "bd/banking.json": doc([{ ...SEED_APP, label: "Renamed App" }]),
    },
  });
  t.after(r.cleanup);
  const res = runChecker(r.seed, r.data);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /drifted from its provenance/);
  assert.match(res.stdout, /com\.example\.seedapp/);
});

test("seed subset check fails when a seeded entry is missing from the tracked tree", (t) => {
  const r = rig({
    seedApps: [SEED_APP],
    // File exists but no longer lists the seeded package.
    trackedFiles: {
      "bd/banking.json": doc([{ ...SEED_APP, package: "com.example.other" }]),
    },
  });
  t.after(r.cleanup);
  const res = runChecker(r.seed, r.data);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /is missing from data\//);
});

test("seed subset check fails when a seeded file is missing entirely", (t) => {
  const r = rig({
    seedApps: [SEED_APP],
    trackedFiles: {
      // Only an unrelated file is tracked; bd/banking.json is gone.
      "bd/shopping.json": doc([{ ...SEED_APP, package: "com.example.other" }]),
    },
  });
  t.after(r.cleanup);
  const res = runChecker(r.seed, r.data);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /seeded file is missing from data\//);
});
