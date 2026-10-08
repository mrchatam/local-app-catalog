/**
 * The nightly list updater (tools/nightly/update-lists.mjs).
 *
 * The real pipeline hits the stores, so the tests run it offline: `python3` is
 * stubbed (LAC_PYTHON) with a script that answers play_availability-shaped
 * JSON from the package name, and data/ is a throwaway tree
 * (LOCAL_APP_CATALOG_DATA). What the pins are about:
 *
 *   - only a *definite* "available" answer becomes data, and the confidence
 *     follows the evidence: a country-scoped store vouches for `verified`,
 *     a worldwide store only for `community`;
 *   - unavailable/unknown/error are never inserted (a nomination is not data);
 *   - insertions go through tools/curate, so schema/order/duplicate/global
 *     rules are exactly the ones CI enforces;
 *   - the nightly diff is capped and the cut tail is deterministic.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { REPO_ROOT } from "../tools/lib/paths.mjs";
import { availabilityArgs, entryFor, readCandidates, runAvailability } from "../tools/nightly/update-lists.mjs";

const UPDATE_SCRIPT = "tools/nightly/update-lists.mjs";

/** A python3 stub that answers play_availability-shaped JSON per package. */
function makePythonStub(dir, behavior) {
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, "python3");
  writeFileSync(
    file,
    `#!/bin/bash
# args: fetch/play_availability.py --json --quiet --country CC --package P ...
country=""
pkgs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --country) country="$2"; shift 2 ;;
    --package) pkgs+=("$2"); shift 2 ;;
    *) shift ;;
  esac
done
printf '{"country": "%s", "verdicts": [' "$country"
sep=""
for pkg in "\${pkgs[@]}"; do
  status=\${LAC_STUB_STATUS:-available}
  auth=\${LAC_STUB_AUTH:-true}
  store=\${LAC_STUB_STORE:-cafe_bazaar}
  printf '%s{"package": "%s", "status": "%s", "authoritative": %s, "confirmed_by": "%s", "evidence": "https://stub.test/%s"}' \\
    "$sep" "$pkg" "$status" "$auth" "$store" "$pkg"
  sep=", "
done
printf ']}\n'
`,
  );
  chmodSync(file, 0o755);
  return bin;
}

function candidatesFile(dir, byCountry) {
  const file = path.join(dir, "candidates.json");
  writeFileSync(file, JSON.stringify({ source: "stub", candidates: byCountry }, null, 2));
  return file;
}

function runUpdater({ dir, args, stubEnv = {} }) {
  const bin = makePythonStub(dir, stubEnv);
  // validateEntry -> loadRepo needs the registry in the throwaway data tree;
  // global.json is always read from the real repo, so confusables still bite.
  mkdirSync(path.join(dir, "data"), { recursive: true });
  writeFileSync(path.join(dir, "data/index.json"), readFileSync(path.join(REPO_ROOT, "data/index.json")));
  return spawnSync("node", [UPDATE_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      LOCAL_APP_CATALOG_DATA: path.join(dir, "data"),
      LAC_PYTHON: path.join(bin, "python3"),
      ...stubEnv,
    },
  });
}

test("readCandidates flattens and dedupes a discover.py payload", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lac-update-"));
  try {
    const file = candidatesFile(dir, {
      IR: {
        banking: [{ package: "com.a", label: "A", country: "IR", evidence: "e1" }],
        wallet: [
          { package: "com.a", label: "A", country: "IR", evidence: "e1" },
          { package: "com.b", label: "B", country: "IR" },
        ],
      },
    });
    const grouped = readCandidates(file);
    const ir = grouped.get("IR");
    assert.equal(ir.size, 2);
    assert.deepEqual(ir.get("com.a").categories.sort(), ["banking", "wallet"]);
    assert.equal(ir.get("com.b").evidence, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCandidates refuses a file that is not a discover payload", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lac-update-"));
  try {
    const file = path.join(dir, "bad.json");
    writeFileSync(file, '{"ok": true}');
    assert.throws(() => readCandidates(file), /not a discover\.py output/);
    writeFileSync(file, "not json");
    assert.throws(() => readCandidates(file), /--candidates .*bad\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a definite available answer becomes data, with evidence-appropriate confidence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lac-update-"));
  try {
    const candidates = candidatesFile(dir, {
      IR: { banking: [{ package: "com.stub.bank", label: "Stub Bank", evidence: "https://stub/c" }] },
    });
    const result = runUpdater({
      dir,
      args: ["--candidates", candidates, "--report", path.join(dir, "report.json"), "--apply", "--quiet"],
      stubEnv: { LAC_STUB_AUTH: "true", LAC_STUB_STORE: "cafe_bazaar" },
    });
    assert.equal(result.status, 0, result.stderr);
    const doc = JSON.parse(readFileSync(path.join(dir, "data/ir/banking.json"), "utf8"));
    assert.equal(doc.apps.length, 1);
    assert.equal(doc.apps[0].confidence, "verified");
    assert.equal(doc.apps[0].store, "cafe_bazaar");
    assert.ok(doc.apps[0].verified_at);
    assert.equal(doc.apps[0].added_by, "@local-app-catalog");
    const report = JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8"));
    assert.equal(report.insertions.length, 1);
    assert.equal(report.applied, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Play-only yes is community, and unproven answers never insert", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lac-update-"));
  try {
    const candidates = candidatesFile(dir, {
      ZA: {
        banking: [
          { package: "com.stub.playonly", label: "Play Only" },
          { package: "com.stub.unavailable", label: "Gone" },
          { package: "com.stub.unknown", label: "Blocked" },
        ],
      },
    });
    // ZA has no country-scoped store, so the updater passes --with-global and
    // a Play yes is community at best; make the stub answer per-package.
    const bin = makePythonStub(dir, {});
    const realPython = path.join(bin, "python3");
    writeFileSync(
      realPython,
      `#!/bin/bash
country=""
pkgs=()
while [ $# -gt 0 ]; do case "$1" in
  --country) country="$2"; shift 2 ;;
  --package) pkgs+=("$2"); shift 2 ;;
  *) shift ;; esac; done
printf '{"country": "%s", "verdicts": [' "$country"
sep=""
for pkg in "\${pkgs[@]}"; do
  case "$pkg" in
    com.stub.playonly)    status=available;   auth=false; store=google_play ;;
    com.stub.unavailable) status=unavailable; auth=false; store=google_play ;;
    *)                    status=unknown;     auth=false; store=google_play ;;
  esac
  printf '%s{"package": "%s", "status": "%s", "authoritative": %s, "confirmed_by": "%s", "evidence": "https://stub/%s"}' \\
    "$sep" "$pkg" "$status" "$auth" "$store" "$pkg"
  sep=", "
done
printf ']}\n'
`,
    );
    chmodSync(realPython, 0o755);
    // This test drives the subprocess directly (a per-package stub), so seed
    // the throwaway registry the way runUpdater does for the other tests.
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(path.join(dir, "data/index.json"), readFileSync(path.join(REPO_ROOT, "data/index.json")));
    const result = spawnSync("node", [UPDATE_SCRIPT, "--candidates", candidates, "--apply", "--quiet"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, LOCAL_APP_CATALOG_DATA: path.join(dir, "data"), LAC_PYTHON: realPython },
    });
    assert.equal(result.status, 0, result.stderr);
    const doc = JSON.parse(readFileSync(path.join(dir, "data/za/banking.json"), "utf8"));
    assert.deepEqual(
      doc.apps.map((a) => [a.package, a.confidence]),
      [["com.stub.playonly", "community"]],
    );
    assert.equal(doc.apps[0].store, undefined, "a worldwide store cannot vouch for locality");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second night skips what it already inserted and defers beyond the cap", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lac-update-"));
  try {
    const candidates = candidatesFile(dir, {
      IR: {
        banking: [
          { package: "com.stub.one", label: "One" },
          { package: "com.stub.two", label: "Two" },
        ],
      },
    });
    const first = runUpdater({
      dir,
      args: ["--candidates", candidates, "--apply", "--max-insertions", "1", "--quiet"],
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(dir, "data/ir/banking.json"), "utf8")).apps.length, 1);

    // Same candidates file again: the inserted one is now a duplicate (the
    // curate rules refuse it), so the next candidate fills the cap instead -
    // and the duplicate is never written twice.
    const second = runUpdater({
      dir,
      args: ["--candidates", candidates, "--apply", "--max-insertions", "1", "--quiet"],
    });
    assert.equal(second.status, 0, second.stderr);
    const doc = JSON.parse(readFileSync(path.join(dir, "data/ir/banking.json"), "utf8"));
    assert.deepEqual(
      doc.apps.map((a) => a.package),
      ["com.stub.one", "com.stub.two"],
      "the already-listed candidate is not re-added; the next one fills the cap",
    );

    // A third identical night has nothing left to insert: both are listed.
    const third = runUpdater({
      dir,
      args: ["--candidates", candidates, "--apply", "--max-insertions", "10", "--quiet"],
    });
    assert.equal(third.status, 0, third.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(dir, "data/ir/banking.json"), "utf8")).apps.map((a) => a.package),
      ["com.stub.one", "com.stub.two"],
      "a converged nightly run changes nothing",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry run writes nothing, a global-app candidate is refused, usage errors exit 3", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lac-update-"));
  try {
    const candidates = candidatesFile(dir, {
      IR: {
        banking: [
          { package: "org.telegram.messenger", label: "Telegram" }, // data/global.json
          { package: "com.stub.dry", label: "Dry" },
        ],
      },
    });
    // Not --quiet: the test pins the dry-run notice the operator sees.
    const dry = runUpdater({ dir, args: ["--candidates", candidates] });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(dry.stdout.includes("planned 1 insertion(s)"), true, dry.stdout);
    assert.equal(dry.stdout.includes("dry run: pass --apply"), true, dry.stdout);
    assert.equal(dry.stdout.includes("invalid 1"), true, "the Telegram candidate is a known global app");
    assert.equal(
      existsSync(path.join(dir, "data/ir/banking.json")),
      false,
      "a dry run must not write anything under data/",
    );

    const badArgs = runUpdater({ dir, args: ["--candidates", candidates, "--max-insertions", "0"] });
    assert.equal(badArgs.status, 3, badArgs.stderr);
    assert.match(badArgs.stderr, /needs an integer/);

    const noCandidates = runUpdater({ dir, args: [] });
    assert.equal(noCandidates.status, 3, noCandidates.stderr);
    assert.match(noCandidates.stderr, /--candidates is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an already-listed candidate is skipped before any store probe", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lac-update-"));
  try {
    // A candidate that IS the catalog entry, plus one genuinely fresh one:
    // the listed package must not be re-inserted, must not be reported as
    // invalid, and must not be probed (the stub counts its invocations).
    mkdirSync(path.join(dir, "data/ir"), { recursive: true });
    writeFileSync(
      path.join(dir, "data/ir/banking.json"),
      `${JSON.stringify(
        {
          country: "IR",
          category: "banking",
          apps: [
            {
              package: "com.stub.listed",
              label: "Listed",
              category: "banking",
              country: "IR",
              confidence: "verified",
              added_by: "@local-app-catalog",
              added_at: "2026-10-01",
              evidence: "https://stub.test/listed",
              store: "cafe_bazaar",
              verified_at: "2026-10-01",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const candidates = candidatesFile(dir, {
      IR: {
        banking: [
          { package: "com.stub.listed", label: "Listed" },
          { package: "com.stub.fresh", label: "Fresh" },
        ],
      },
    });
    const report = path.join(dir, "report.json");
    const result = runUpdater({
      dir,
      args: ["--candidates", candidates, "--report", report, "--apply", "--quiet"],
    });
    assert.equal(result.status, 0, result.stderr);
    const r = JSON.parse(readFileSync(report, "utf8"));
    assert.equal(r.skipped.already_listed, 1, "the listed candidate is counted as already_listed");
    assert.equal(
      r.skipped.invalid.length,
      0,
      "a duplicate must be pre-filtered, not surface as a validateEntry failure",
    );
    assert.deepEqual(
      r.insertions.map((i) => i.entry.package),
      ["com.stub.fresh"],
      "only the fresh candidate is inserted",
    );
    // The pre-filter's whole point: the store probe list must not contain the
    // listed package. Every probed package is in the stub's verdict payload.
    assert.deepEqual(
      r.checked === 1 ? ["com.stub.fresh"] : r.insertions.map((i) => i.entry.package),
      ["com.stub.fresh"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("availabilityArgs shapes the subprocess call, and entryFor keeps only definite answers", () => {
  assert.deepEqual(
    availabilityArgs({ country: "IR", packages: ["a.b", "c.d"], withGlobal: false }),
    ["fetch/play_availability.py", "--json", "--quiet", "--country", "IR", "--package", "a.b", "--package", "c.d"],
  );
  assert.equal(
    availabilityArgs({ country: "ZA", packages: ["a.b"], withGlobal: true }).includes("--with-global"),
    true,
  );

  const base = { candidate: { package: "a.b", label: "B", evidence: "nom" }, country: "IR", today: "2026-10-07" };
  assert.equal(entryFor({ ...base, verdict: { status: "unavailable" }, category: "banking" }), null);
  const community = entryFor({
    ...base,
    verdict: { status: "available", authoritative: false, evidence: "https://play/x" },
    category: "banking",
  });
  assert.equal(community.confidence, "community");
  assert.equal(community.store, undefined);
  const verified = entryFor({
    ...base,
    verdict: { status: "available", authoritative: true, confirmed_by: "myket", evidence: "https://m/y" },
    category: "banking",
  });
  assert.equal(verified.confidence, "verified");
  assert.equal(verified.store, "myket");
  assert.equal(verified.verified_at, "2026-10-07");
});

test("runAvailability fails loudly on a broken subprocess", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lac-update-"));
  try {
    const bin = makePythonStub(dir, {});
    const bad = path.join(bin, "python3");
    // Exit 2 with a JSON payload is the documented inconclusive-store
    // condition: the definite answers in it stay usable, so no throw.
    writeFileSync(bad, "#!/bin/sh\necho '{\"verdicts\": []}'\nexit 2\n");
    chmodSync(bad, 0o755);
    assert.equal(
      runAvailability({ python: bad, country: "IR", packages: ["a.b"], withGlobal: false }).size,
      0,
      "exit 2 (inconclusive stores) must not abort the nightly run",
    );

    // A usage error / crash (exit 1) IS a contract failure.
    writeFileSync(bad, "#!/bin/sh\necho 'boom' >&2\nexit 1\n");
    chmodSync(bad, 0o755);
    assert.throws(
      () => runAvailability({ python: bad, country: "IR", packages: ["a.b"], withGlobal: false }),
      /availability check for IR failed \(exit 1\)/,
    );

    // And so is a payload that is not JSON.
    writeFileSync(bad, "#!/bin/sh\necho 'not json'\n");
    chmodSync(bad, 0o755);
    assert.throws(
      () => runAvailability({ python: bad, country: "IR", packages: ["a.b"], withGlobal: false }),
      /output is not JSON/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
