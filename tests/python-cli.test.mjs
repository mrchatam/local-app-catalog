/**
 * Contracts of the two Python entry points a contributor can run by hand.
 *
 * Both are exercised offline. `play_availability.py` reaches the network to do
 * its job, so its adapter is stubbed; `discover.py`'s planner is pure, and only
 * its usage validation needs a subprocess.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import path from "node:path";
import { REPO_ROOT } from "../tools/lib/paths.mjs";
import {
  pythonAvailabilitySelfTest,
  pythonDiscoverPlan,
  readJson,
} from "./helpers.mjs";

function runPython(script, args) {
  return spawnSync("python3", [path.join("fetch", script), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

// ------------------------------------------------------- play_availability.py

const AVAILABILITY = pythonAvailabilitySelfTest();

test("a definite answer resolves the check, and only inconclusive ones exit 2", () => {
  for (const result of AVAILABILITY.resolved) {
    assert.equal(
      result.exit,
      0,
      `status=${result.stub} exited ${result.exit}; a confirmed answer must resolve`,
    );
  }
  // The load-bearing half: the Node validator maps exit 2 to STORE_UNVERIFIABLE
  // (a warning). A confirmed 404 must not land there, or a throttled runner
  // could never demote a dead listing.
  for (const result of AVAILABILITY.inconclusive) {
    assert.equal(result.exit, 2, `status=${result.stub} must be reported as inconclusive`);
  }
});

test("the availability verdict mirrors what the store said", () => {
  for (const result of [...AVAILABILITY.resolved, ...AVAILABILITY.inconclusive]) {
    assert.equal(result.verdict_status, result.stub);
    assert.equal(result.country, "RU", "country codes are normalized to upper case");
    assert.equal(
      result.summary.available + result.summary.unavailable + result.summary.unknown + result.summary.error,
      1,
      "exactly one package was checked",
    );
    assert.equal(result.summary[result.stub], 1);
  }
});

test("play_availability.py rejects bad usage with exit 1, not the inconclusive code", () => {
  // 2 is meaningful here ("nothing was proven"), so argparse's default must be
  // overridden: a typo is not an inconclusive store result.
  assert.deepEqual(AVAILABILITY.usage, {
    "unknown-store": 1,
    "no-package": 1,
    "no-country": 1,
  });
});

// ------------------------------------------------------------ discover.py

const PLAN = pythonDiscoverPlan();

test("the discovery planner issues one job per country/category/query and skips the rest", () => {
  assert.deepEqual(PLAN.jobs, [
    ["TR", "banking", "banka"],
    ["TR", "banking", "banka uygulamasi"],
    ["TR", "rideshare", "taksi"],
    ["IR", "banking", "bank"],
    // IR has no rideshare queries, so no job is invented for it
  ]);
});

test("the store named as the discovery source really can search", () => {
  // discover.py --store defaults to google_play and aborts for anything without
  // search(); pin that so renaming the method cannot silently break discovery.
  assert.ok(PLAN.search_capable.includes("google_play"));
});

test("discover.py reports a usage error instead of a traceback", () => {
  const unknownStore = runPython("discover.py", ["--country", "TR", "--store", "nope"]);
  assert.equal(unknownStore.status, 2, unknownStore.stderr);
  assert.match(unknownStore.stderr, /unknown store adapter: nope/);
  assert.doesNotMatch(unknownStore.stderr, /Traceback/);

  const badWorkers = runPython("discover.py", ["--country", "TR", "--workers", "0"]);
  assert.equal(badWorkers.status, 2, badWorkers.stderr);
  assert.match(badWorkers.stderr, /--workers must be at least 1/);
  assert.doesNotMatch(badWorkers.stderr, /Traceback/);

  const nothingToDo = runPython("discover.py", []);
  assert.equal(nothingToDo.status, 2);
  assert.match(nothingToDo.stderr, /nothing to do/);
});

test("every discovery country has at least one query for the categories it claims", () => {
  const queries = readJson("fetch/queries.json").queries;
  const index = readJson("data/index.json");
  for (const code of index.countries) {
    assert.ok(queries[code], `${code} is a registered country with no discovery queries`);
  }
});
