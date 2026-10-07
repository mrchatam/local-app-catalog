import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { REPO_ROOT } from "../tools/lib/paths.mjs";
import { DEMOTING_CODES, readPlan } from "../tools/recheck/cli.mjs";
import { entry, makeRepo } from "./helpers.mjs";

/**
 * The command-line contracts these tests pin are load-bearing for CI:
 * `validate.yml` branches on the validator's exit code, `recheck.yml` on the
 * rechecker's, and `release.yml` builds with SOURCE_DATE_EPOCH pinned. The
 * library-level behaviour is covered elsewhere; this file exercises the real
 * entry points, on temp directories, so nothing here touches data/ or dist/.
 */

function runCli(script, args, { env = {}, cwd = REPO_ROOT } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "lac-cli-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const BUILD = "tools/build/cli.mjs";
const VALIDATE = "tools/validate/cli.mjs";
const RECHECK = "tools/recheck/cli.mjs";
const CURATE = "tools/curate/cli.mjs";

/** One `verified` entry the nightly recheck could falsify, plus one it must leave alone. */
const VERIFIED_REPO = {
  "ir/banking.json": {
    country: "IR",
    category: "banking",
    apps: [
      entry({
        package: "ir.example.bank",
        country: "IR",
        confidence: "verified",
        store: "myket",
        verified_at: "2026-10-07",
      }),
      entry({ package: "ir.example.wallet", country: "IR", confidence: "community" }),
    ],
  },
};

function demotingFinding(where, code = "VERIFIED_NOT_LOCAL", message = "myket does not list it for IR (404)") {
  return { level: "error", code, where, message };
}

/** Write a plan file the way `recheck --json` does, and hand back its path. */
function writePlanFile(dir, doc) {
  const file = path.join(dir, "recheck.json");
  writeFileSync(file, typeof doc === "string" ? doc : `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}

// ---------------------------------------------------------------- build clock

test("the build CLI omits generated_at entirely when no clock is pinned", () => {
  const out = tempDir();
  try {
    const env = { ...process.env };
    delete env.SOURCE_DATE_EPOCH;
    const result = spawnSync(process.execPath, [BUILD, "--out", out.dir, "--quiet"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(path.join(out.dir, "manifest.json"), "utf8"));
    assert.ok(!("generated_at" in manifest), "an unpinned build must not stamp a wall-clock time");
    // The tag still defaults to something valid, it just is not derived from a
    // pinned clock, so it is today's date and must be well-formed.
    assert.match(manifest.release, /^v\d{4}\.\d{2}\.\d{2}$/);
  } finally {
    out.cleanup();
  }
});

test("the build CLI derives tag and generated_at from SOURCE_DATE_EPOCH", () => {
  const out = tempDir();
  try {
    const result = runCli(BUILD, ["--out", out.dir, "--quiet"], {
      env: { SOURCE_DATE_EPOCH: "1759795200" },
    });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(path.join(out.dir, "manifest.json"), "utf8"));
    assert.equal(manifest.release, "v2025.10.07");
    assert.equal(manifest.generated_at, "2025-10-07T00:00:00Z");
  } finally {
    out.cleanup();
  }
});

test("two builds with the same pinned clock are byte-identical at the CLI level", () => {
  const a = tempDir();
  const b = tempDir();
  try {
    const env = { SOURCE_DATE_EPOCH: "1759795200" };
    assert.equal(runCli(BUILD, ["--out", a.dir, "--quiet"], { env }).status, 0);
    assert.equal(runCli(BUILD, ["--out", b.dir, "--quiet"], { env }).status, 0);
    for (const name of ["catalog-all.json", "manifest.json", "SHA256SUMS", "catalog-ir.json"]) {
      assert.equal(
        readFileSync(path.join(a.dir, name), "utf8"),
        readFileSync(path.join(b.dir, name), "utf8"),
        `${name} differs between two pinned builds`,
      );
    }
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("a non-numeric SOURCE_DATE_EPOCH is rejected rather than silently ignored", () => {
  const out = tempDir();
  try {
    const result = runCli(BUILD, ["--out", out.dir, "--quiet"], { env: { SOURCE_DATE_EPOCH: "yesterday" } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SOURCE_DATE_EPOCH/);
  } finally {
    out.cleanup();
  }
});

test("the build CLI rejects a malformed release tag as a usage error", () => {
  const out = tempDir();
  try {
    const result = runCli(BUILD, ["--tag", "2026.10.07", "--out", out.dir, "--quiet"]);
    // 3, not 1: a bad flag must never be reported as a build/data failure.
    assert.equal(result.status, 3);
    assert.match(result.stderr, /vYYYY\.MM\.DD/);
  } finally {
    out.cleanup();
  }
});

test("--validate makes the build CLI refuse a broken catalog", () => {
  const broken = makeRepo({ "xx/banking.json": { country: "XX", category: "banking", apps: [] } });
  const out = tempDir();
  try {
    // XX is not a registered country, so the repo has a real error.
    const result = runCli(BUILD, ["--out", out.dir, "--quiet", "--validate"], {
      env: { LOCAL_APP_CATALOG_DATA: broken.dir },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to build/);
  } finally {
    broken.cleanup();
    out.cleanup();
  }
});

// --------------------------------------------------------- validate exit codes

test("validate exits 0 with a clean, well-formed report on the shipped catalog", () => {
  const result = runCli(VALIDATE, ["--json", "--quiet"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.errors, 0);
  assert.equal(report.store_inconclusive, false);
  assert.ok(report.stats.totalEntries > 0);
});

test("validate exits 1 when the catalog has a semantic error", () => {
  const repo = makeRepo({
    "ir/banking.json": {
      country: "IR",
      category: "banking",
      // A global app claimed as local: GLOBAL_CONFLICT, one of the conditions a
      // PR must never be able to merge through.
      apps: [entry({ package: "com.whatsapp", country: "IR" })],
    },
  });
  try {
    const result = runCli(VALIDATE, ["--json", "--quiet"], {
      env: { LOCAL_APP_CATALOG_DATA: repo.dir },
    });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.errors > 0);
    assert.ok(report.findings.some((f) => f.code === "GLOBAL_CONFLICT"));
  } finally {
    repo.cleanup();
  }
});

test("validate exits 3 on an unknown argument instead of guessing", () => {
  const result = runCli(VALIDATE, ["--nope"]);
  // Exit 3 is reserved for "the command line was wrong", so a typo can never
  // masquerade as a catalog error (exit 1) in CI.
  assert.equal(result.status, 3);
  assert.match(result.stderr, /unknown argument/);
});

// --------------------------------------------------- flag values are not flags

/**
 * `--flag value` parsing is hand-rolled in every CLI, and the classic failure
 * is a flag eating the *next* flag as its value. Both of these used to exit 0:
 * `validate --country --json` validated the country "--json" and printed the
 * human report, and `build --out --quiet` wrote a whole release into a working
 * tree directory literally named `--quiet`.
 */
test("no CLI lets a value-taking flag swallow the next flag", () => {
  const out = tempDir();
  try {
    const cases = [
      [VALIDATE, ["--country", "--json"], /--country needs a value/],
      [VALIDATE, ["--max-messages", "--quiet"], /--max-messages needs a value/],
      [BUILD, ["--out", "--quiet"], /--out needs a value/],
      [BUILD, ["--tag", "--out", out.dir], /--tag needs a value/],
      [RECHECK, ["--country", "--json"], /--country needs a value/],
      [CURATE, ["--package", "--label"], /--package needs a value/],
    ];
    for (const [script, args, expected] of cases) {
      const result = runCli(script, args);
      assert.equal(result.status, 3, `${script} ${args.join(" ")} must be a usage error`);
      assert.match(result.stderr, expected);
    }
    assert.equal(
      existsSync(path.join(REPO_ROOT, "--quiet")),
      false,
      "the build must never create a directory named after a flag",
    );
  } finally {
    out.cleanup();
  }
});

test("an unregistered --country is a usage error, but a country with no folder is fine", () => {
  const unknown = runCli(VALIDATE, ["--country", "XX", "--quiet"]);
  assert.equal(unknown.status, 3);
  assert.match(unknown.stderr, /unknown country: XX/);
  assert.equal(runCli(RECHECK, ["--country", "XX"]).status, 3);

  // SA is registered in data/index.json and deliberately ships no data/sa/:
  // every candidate was dropped, which is a data decision, not a typo.
  assert.equal(runCli(VALIDATE, ["--country", "SA", "--quiet"]).status, 0);
});

test("a non-numeric --max-messages is a usage error, not a silently disabled cap", () => {
  const result = runCli(VALIDATE, ["--max-messages", "abc", "--quiet"]);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /--max-messages needs an integer/);
  assert.equal(runCli(VALIDATE, ["--max-messages", "10", "--quiet"]).status, 0);
});

// ---------------------------------------------------------- recheck exit codes

test("recheck exits 3 on a usage error, before any network work", () => {
  for (const args of [["--bogus"], ["--country"], ["--max-demotions", "-1"], ["--max-demotions", "many"]]) {
    const result = runCli(RECHECK, args);
    assert.equal(result.status, 3, `expected usage error for ${args.join(" ")}`);
    assert.match(result.stderr, /usage:|needs a value|needs an integer/);
  }
});

test("recheck --help documents its exit codes and exits 0", () => {
  const result = runCli(RECHECK, ["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Exit codes/);
});

test("the recheck demotion code set never includes an inconclusive verdict", () => {
  // Importable because recheck/cli.mjs guards its main() behind an entrypoint
  // check; STORE_UNVERIFIABLE is exactly the "runner was blocked" case.
  assert.ok(DEMOTING_CODES.has("VERIFIED_NOT_LOCAL"));
  assert.ok(DEMOTING_CODES.has("STORE_UNAVAILABLE"));
  assert.ok(!DEMOTING_CODES.has("STORE_UNVERIFIABLE"));
});

// --------------------------------------------------------- recheck --plan replay

/**
 * The nightly workflow probes once, then applies *that report* with `--plan`.
 * Re-probing would let a throttled second attempt apply a different set than
 * the PR body describes, so these tests pin the replay half of the contract:
 * a plan is authority to write, it fails closed when it is not a demotion
 * report, and it only ever edits the data directory it was loaded from.
 */
test("recheck --plan prints the diff and writes nothing without --apply", () => {
  const repo = makeRepo(VERIFIED_REPO);
  const plan = tempDir();
  try {
    const shipped = readFileSync(path.join(REPO_ROOT, "data/ir/banking.json"), "utf8");
    const file = writePlanFile(plan.dir, {
      ok: false,
      demotions: [{ file: "data/ir/banking.json", package: "ir.example.bank" }],
      demoting_findings: [demotingFinding("data/ir/banking.json#ir.example.bank")],
      inconclusive_count: 0,
      checked: [
        {
          country: "IR",
          packages: 1,
          summary: { available: 0, unavailable: 1, unknown: 0, error: 0 },
          authoritative_stores: ["cafe_bazaar", "myket"],
        },
      ],
    });
    const before = readFileSync(path.join(repo.dir, "ir/banking.json"), "utf8");

    const result = runCli(RECHECK, ["--plan", file], { env: { LOCAL_APP_CATALOG_DATA: repo.dir } });
    // 1 = there is a diff to open a PR for. Not 0: nothing was applied yet.
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /would demote 1 entr\(y\|ies\) in data\/ir\/banking\.json/);
    assert.ok(result.stdout.includes('-      "confidence": "verified",'), "the diff must show the old confidence");
    assert.ok(result.stdout.includes('+      "confidence": "legacy",'), "the diff must show the new confidence");
    assert.equal(readFileSync(path.join(repo.dir, "ir/banking.json"), "utf8"), before);
    // A dry run that wrote the shipped catalog would be the worst possible bug:
    // the tree under test is the temp one.
    assert.equal(readFileSync(path.join(REPO_ROOT, "data/ir/banking.json"), "utf8"), shipped);
  } finally {
    repo.cleanup();
    plan.cleanup();
  }
});

test("recheck --apply --plan demotes exactly the recorded findings", () => {
  const repo = makeRepo(VERIFIED_REPO);
  const plan = tempDir();
  try {
    const shipped = readFileSync(path.join(REPO_ROOT, "data/ir/banking.json"), "utf8");
    const file = writePlanFile(plan.dir, {
      demotions: [{ file: "data/ir/banking.json", package: "ir.example.bank" }],
      demoting_findings: [demotingFinding("data/ir/banking.json#ir.example.bank")],
      inconclusive_count: 0,
      checked: [],
    });
    const result = runCli(RECHECK, ["--apply", "--plan", file, "--quiet"], {
      env: { LOCAL_APP_CATALOG_DATA: repo.dir },
    });
    // 0 because the demoted tree still validates: a replay that broke the
    // catalog must not look like a successful night.
    assert.equal(result.status, 0, result.stderr);
    const doc = JSON.parse(readFileSync(path.join(repo.dir, "ir/banking.json"), "utf8"));
    assert.equal(doc.apps[0].confidence, "legacy");
    assert.equal("verified_at" in doc.apps[0], false);
    assert.equal(doc.apps[0].store, "myket", "provenance survives a demotion");
    assert.match(doc.apps[0].notes, /^demoted \d{4}-\d{2}-\d{2}: myket does not list it for IR \(404\)$/);
    assert.equal(doc.apps[1].confidence, "community");
    assert.equal(readFileSync(path.join(REPO_ROOT, "data/ir/banking.json"), "utf8"), shipped);
  } finally {
    repo.cleanup();
    plan.cleanup();
  }
});

test("a plan that is not a demotion report is a usage error, never a silent no-op", () => {
  const plan = tempDir();
  try {
    const cases = [
      ["not json", /is not the JSON report this tool writes/],
      [JSON.stringify({ demotions: [] }), /has no demoting_findings array/],
      [
        JSON.stringify({
          demoting_findings: [demotingFinding("data/ir/banking.json#x", "STORE_UNVERIFIABLE", "blocked")],
        }),
        /is not a demoting code \(VERIFIED_NOT_LOCAL, STORE_UNAVAILABLE\)/,
      ],
      [
        JSON.stringify({ demoting_findings: [demotingFinding("ir.banking", "VERIFIED_NOT_LOCAL", "404")] }),
        /where must be "<file>#<package>"/,
      ],
      [
        JSON.stringify({
          demoting_findings: [demotingFinding("data/ir/banking.json#x", "VERIFIED_NOT_LOCAL", "")],
        }),
        /needs a message to record as the reason/,
      ],
    ];
    for (const [text, expected] of cases) {
      const file = writePlanFile(plan.dir, text);
      const result = runCli(RECHECK, ["--plan", file]);
      // 3, not 0: reading a broken report as "nothing to demote" is exactly how
      // a takedown gets announced in a PR body and then silently dropped.
      assert.equal(result.status, 3, `expected a usage error for: ${text.slice(0, 60)}`);
      assert.match(result.stderr, expected);
    }
  } finally {
    plan.cleanup();
  }
});

test("readPlan normalizes findings so an omitted level cannot drop a demotion", () => {
  const text = JSON.stringify({
    demoting_findings: [
      { code: "STORE_UNAVAILABLE", where: "data/ru/banking.json#ru.example.bank", message: "rustore 404" },
    ],
    inconclusive_count: 2,
    checked: [{ country: "RU", packages: 1, summary: {}, authoritative_stores: ["rustore"] }],
  });
  const plan = readPlan(text, { file: "p.json" });
  assert.equal(plan.findings.length, 1);
  assert.deepEqual(plan.findings[0], {
    level: "error",
    code: "STORE_UNAVAILABLE",
    where: "data/ru/banking.json#ru.example.bank",
    message: "rustore 404",
  });
  assert.equal(plan.inconclusiveCount, 2);
  assert.equal(plan.countriesChecked.length, 1);
});

test("--plan is self-scoping and its file must exist", () => {
  const missing = runCli(RECHECK, ["--plan", path.join(tmpdir(), "lac-does-not-exist", "recheck.json")]);
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /no such file/);
  // The report already names its scope; combining the two would mean one of
  // them silently wins.
  const both = runCli(RECHECK, ["--plan", "recheck.json", "--country", "IR"]);
  assert.equal(both.status, 3);
  assert.match(both.stderr, /drop --country/);
});

test("--max-demotions guards the replay path, and a stale plan is not a diff", () => {
  const repo = makeRepo(VERIFIED_REPO);
  const plan = tempDir();
  try {
    const capped = writePlanFile(plan.dir, {
      demoting_findings: [demotingFinding("data/ir/banking.json#ir.example.bank")],
      inconclusive_count: 0,
    });
    const result = runCli(RECHECK, ["--apply", "--plan", capped, "--max-demotions", "0", "--quiet"], {
      env: { LOCAL_APP_CATALOG_DATA: repo.dir },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exceed --max-demotions 0/);

    // A finding for a package the file no longer holds (already demoted by a
    // previous PR) means there is nothing to write, not a failure.
    const stale = writePlanFile(plan.dir, {
      demoting_findings: [demotingFinding("data/ir/banking.json#ir.already.gone")],
      inconclusive_count: 0,
    });
    const noop = runCli(RECHECK, ["--apply", "--plan", stale, "--quiet"], {
      env: { LOCAL_APP_CATALOG_DATA: repo.dir },
    });
    assert.equal(noop.status, 0, noop.stderr);
  } finally {
    repo.cleanup();
    plan.cleanup();
  }
});

test("recheck --plan --json reports the plan path and its inconclusive count", () => {
  const repo = makeRepo(VERIFIED_REPO);
  const plan = tempDir();
  try {
    const file = writePlanFile(plan.dir, {
      demotions: [{ file: "data/ir/banking.json", package: "ir.example.bank" }],
      demoting_findings: [demotingFinding("data/ir/banking.json#ir.example.bank")],
      inconclusive_count: 3,
      checked: [{ country: "IR", packages: 1, summary: {}, authoritative_stores: ["myket"] }],
    });
    const result = runCli(RECHECK, ["--json", "--plan", file], { env: { LOCAL_APP_CATALOG_DATA: repo.dir } });
    const report = JSON.parse(result.stdout); // stdout must be pure JSON (npm adds no --quiet banner here)
    assert.equal(report.plan, file);
    assert.equal(report.ok, false);
    assert.equal(report.applied, false);
    assert.deepEqual(report.demotions, [{ file: "data/ir/banking.json", package: "ir.example.bank" }]);
    assert.equal(report.inconclusive_count, 3);
    // Pending demotions outrank an inconclusive count: there is still a PR to open.
    assert.equal(result.status, 1);
  } finally {
    repo.cleanup();
    plan.cleanup();
  }
});
